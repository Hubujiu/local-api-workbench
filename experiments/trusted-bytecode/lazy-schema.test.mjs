import test from "node:test";
import assert from "node:assert/strict";
import { createLazySchemaSession } from "./lazy-schema.mjs";
import { LIMITS } from "./catalog.mjs";
import {
  evaluateGuest as evaluate,
  installActualSchemaAPI,
} from "./lazy-fixture.mjs";

async function withSession(mode, check, { api = true } = {}) {
  const session = await createLazySchemaSession(mode);
  try {
    if (api) installActualSchemaAPI(session);
    await check(session);
  } finally {
    let disposed = false;
    try {
      session.budget.run("lazy-schema-test-dispose", () => {
        disposed = true;
        session.dispose();
      });
    } finally {
      // Disposal is still mandatory if the budget is already exhausted.
      if (!disposed) session.dispose();
      session.dispose();
      assert.equal(session.context.alive, false);
      assert.equal(session.runtime.alive, false);
    }
  }
}

const schema = `({
  type: 'object', required: ['name', 'enabled'],
  properties: { name: { type: 'string' }, enabled: { type: 'boolean' } },
  additionalProperties: false
})`;

for (const mode of ["bytecode", "source"]) {
  test(`${mode}: ordinary response APIs do not load or call the schema adapter`, async () => {
    await withSession(mode, (session) => {
      assert.equal(
        evaluate(
          session,
          `pm.response.to.have.status(200).and.header('X-Fixture', 'yes');
           apt.response.to.be.ok.and.jsonBody('name', 'Ada');
           pm.expect({ name: 'Ada' }).to.deep.equal({ name: 'Ada' });
           apt.expect(apt.response.text()).to.contain('Ada');
           true;`,
        ),
        true,
      );
      assert.equal(session.lazy.state, "unloaded");
      assert.equal(session.lazy.loads, 0);
      assert.equal(session.lazy.callbacks, 0);
      assert.equal(Object.hasOwn(session.budget.metrics, "load-source"), false);
      assert.equal(
        Object.hasOwn(session.budget.metrics, "lazy-schema-callback"),
        false,
      );
    });
  });

  test(`${mode}: three actual schema API paths share one same-VM lazy cache`, async () => {
    await withSession(mode, (session) => {
      assert.equal(session.lazy.state, "unloaded");
      assert.equal(
        evaluate(
          session,
          `pm.response.to.have.jsonSchema(${schema});
           apt.response.to.have.jsonSchema(${schema});
           pm.expect({ name: 'Ada', enabled: true }).to.have.jsonSchema(${schema});
           true;`,
        ),
        true,
      );
      assert.equal(session.lazy.state, "ready");
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 3);
      assert.equal(
        evaluate(session, "typeof globalThis.__boundedJSONSchema"),
        "undefined",
      );
    });
  });

  test(`${mode}: invalid schema and options do not poison a successfully loaded validator`, async () => {
    await withSession(mode, (session) => {
      const messages = evaluate(
        session,
        `(() => {
          const errors = [];
          for (const invoke of [
            () => pm.response.to.have.jsonSchema({ type: 7 }),
            () => apt.response.to.have.jsonSchema({}, { allErrors: 'yes' }),
            () => pm.expect({ name: 1 }).to.have.jsonSchema(${schema})
          ]) {
            try { invoke(); errors.push(null); }
            catch (error) { errors.push(String(error.message)); }
          }
          pm.response.to.have.jsonSchema(${schema});
          return errors;
        })()`,
      );
      assert.equal(messages.length, 3);
      for (const message of messages) assert.equal(typeof message, "string");
      assert.match(messages[0], /schema is invalid/);
      assert.match(messages[1], /jsonSchema option/);
      assert.equal(session.lazy.state, "ready");
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 4);
    });
  });

  test(`${mode}: poisoned factory accessors cannot replace the private export or gain capabilities`, async () => {
    await withSession(mode, (session) => {
      const result = evaluate(
        session,
        `(() => {
          let touches = 0, fakeCalls = 0, argumentCalls = 0;
          const fake = () => { fakeCalls++; return { valid: true, message: 'fake' }; };
          for (const target of [globalThis, Object.prototype]) {
            Object.defineProperty(target, '__boundedJSONSchema', {
              get() { touches++; return fake; },
              set() { touches++; }
            });
          }
          const before = JSON.stringify(Object.getOwnPropertyNames(globalThis).sort());
          pm.response.to.have.jsonSchema(${schema});
          let rejected = false;
          try { pm.expect({ name: 7 }).to.have.jsonSchema(${schema}); }
          catch { rejected = true; }
          const getter = Object.getOwnPropertyDescriptor(globalThis, '__validateJSONSchema').get;
          const unwanted = { toString() { argumentCalls++; throw Error('must not coerce'); } };
          const validator = getter.call(unwanted, unwanted, '/guest/module', new Uint8Array([1, 2]));
          return {
            touches, fakeCalls, argumentCalls, rejected,
            callable: typeof validator,
            same: validator === globalThis.__validateJSONSchema,
            globalsUnchanged: before === JSON.stringify(Object.getOwnPropertyNames(globalThis).sort()),
            capabilities: [typeof process, typeof require, typeof WebAssembly,
              typeof QTS_TrustedBytecodeReadEval, typeof QTS_TrustedBytecodeReadEvalInto,
              typeof __schemaSource, typeof __loadSchema, typeof __schemaHolder]
          };
        })()`,
      );
      assert.deepEqual(result, {
        touches: 0,
        fakeCalls: 0,
        argumentCalls: 0,
        rejected: true,
        callable: "function",
        same: true,
        globalsUnchanged: true,
        capabilities: Array(8).fill("undefined"),
      });
      assert.equal(session.lazy.state, "ready");
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 4);
    });
  });

  test(`${mode}: a guest-caught recursive load latches failure without retry or cross-session effects`, async () => {
    await withSession(mode, (session) => {
      const result = evaluate(
        session,
        `(() => {
          const original = Object.create;
          let entered = false, caught = 0, outerFailed = 0;
          Object.create = function(...args) {
            if (!entered) {
              entered = true;
              try { void globalThis.__validateJSONSchema; }
              catch { caught++; }
            }
            return original(...args);
          };
          try { void globalThis.__validateJSONSchema; }
          catch { outerFailed++; }
          finally { Object.create = original; }
          for (let i = 0; i < 3; i++) {
            try { void globalThis.__validateJSONSchema; }
            catch { outerFailed++; }
          }
          return { entered, caught, outerFailed };
        })()`,
      );
      assert.deepEqual(result, { entered: true, caught: 1, outerFailed: 4 });
      assert.equal(session.lazy.state, "failed");
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 5);
    });
    await withSession(mode, (fresh) => {
      assert.equal(fresh.lazy.state, "unloaded");
      assert.equal(fresh.lazy.loads, 0);
      assert.equal(
        evaluate(fresh, `pm.response.to.have.jsonSchema(${schema}); true;`),
        true,
      );
      assert.equal(fresh.lazy.state, "ready");
      assert.equal(fresh.lazy.loads, 1);
    });
  });

  test(`${mode}: repeated getters retain the same validator without accumulating heap or owners`, async () => {
    await withSession(mode, (session) => {
      const repeated = `(() => {
        const validator = globalThis.__validateJSONSchema;
        for (let i = 0; i < 256; i++)
          if (validator !== globalThis.__validateJSONSchema) throw Error('cache changed');
        return true;
      })()`;
      assert.equal(evaluate(session, repeated), true);
      const before = session.raw.mallocSize(session.runtime.rt.value);
      for (let index = 0; index < 4; index++)
        assert.equal(evaluate(session, repeated), true);
      const after = session.raw.mallocSize(session.runtime.rt.value);
      assert.equal(after, before);
      assert(before < LIMITS.memory);
      assert.equal(session.lazy.state, "ready");
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 5 * 257);
    });
  });

  test(`${mode}: ordinary guest heap pressure rejects lazy load and releases its temporary allocations`, async () => {
    await withSession(mode, (session) => {
      // These are separate pressure points, not an equivalence benchmark.
      // Source compilation needs more temporary heap than fixed-bytecode read.
      // A distinct 13 MiB source-parser abort was reported separately; this
      // clean-rejection case does not establish all source OOM paths are safe.
      const pressureMiB = mode === "bytecode" ? 13 : 12;
      assert.equal(
        evaluate(
          session,
          `globalThis.__pressure = new Uint8Array(${pressureMiB} * 1024 * 1024);
           __pressure.length;`,
        ),
        pressureMiB * 1024 * 1024,
      );
      const before = session.raw.mallocSize(session.runtime.rt.value);
      assert(before < LIMITS.memory);
      assert.throws(
        () => evaluate(session, "void globalThis.__validateJSONSchema"),
        /Trusted lazy schema load failed/,
      );
      assert.equal(session.lazy.state, "failed");
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 1);
      assert.equal(session.raw.mallocSize(session.runtime.rt.value), before);
      assert.equal(
        evaluate(session, "delete globalThis.__pressure; 6 * 7;"),
        42,
      );
      assert(
        session.raw.mallocSize(session.runtime.rt.value) <
          before - pressureMiB * 1024 * 1024,
      );
      assert.throws(
        () => evaluate(session, "void globalThis.__validateJSONSchema"),
        /Trusted lazy schema load failed/,
      );
      assert.equal(session.lazy.loads, 1);
      assert.equal(session.lazy.callbacks, 2);
    });
  });
}
