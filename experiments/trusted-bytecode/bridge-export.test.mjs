import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createExperimentSession } from "./runtime.mjs";
import { verifyBundle } from "./integrity.mjs";
import { fixedSource, hash } from "./catalog.mjs";

const assets = new URL("./artifacts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", assets)));
const engine = JSON.parse(readFileSync(new URL("engine.json", assets)));
function into(session, id, holder) {
  return session.budget.run("fixed-export-test", () => {
    const bytes = Buffer.from(
      readFileSync(new URL(id + ".bytecode.b64", assets), "utf8").trim(),
      "base64",
    );
    verifyBundle(manifest, engine, id, bytes);
    const pointer = session.raw.alloc(session.context.ctx.value, bytes.length);
    assert(pointer);
    try {
      new Uint8Array(session.raw.memory.buffer, pointer, bytes.length).set(
        bytes,
      );
      return session.raw.readEvalInto(
        session.context.ctx.value,
        pointer,
        bytes.length,
        holder.value,
      );
    } finally {
      session.raw.free(session.context.ctx.value, pointer);
    }
  });
}

function ordinaryCall(session, handle) {
  const input = session.context.newNumber(7);
  let result;
  try {
    result = session.context.callFunction(
      handle,
      session.context.undefined,
      input,
    );
    assert.equal(result.error, undefined);
    assert.equal(session.context.getNumber(result.value), 8);
  } finally {
    (result?.error || result?.value)?.dispose();
    input.dispose();
  }
}

test("private wrapper preserves every original schema byte and has no public export target", () => {
  const raw = readFileSync(
    new URL("../../src/vendor/schema-library.js", import.meta.url),
  );
  const normal = fixedSource("schema"),
    wrapped = fixedSource("schema-private");
  assert.equal(wrapped.sourceSha256, hash(raw));
  assert.equal(wrapped.sourceSha256, normal.sourceSha256);
  assert.notEqual(wrapped.wrapperSha256, normal.wrapperSha256);
  assert.equal(wrapped.wrapperSha256, hash(wrapped.source));
  assert.equal(
    wrapped.source,
    "(function(globalThis){\n" +
      raw.toString() +
      "\nreturn globalThis.__boundedJSONSchema;\n})({__proto__:null});",
  );
});

test("C callable result, private holder and separately owned handles free exactly once", async () => {
  const s = await createExperimentSession();
  try {
    const probe = () => {
      const holder = s.context.newObject(s.context.null);
      let fn;
      try {
        assert.equal(into(s, "callable", holder), 0);
        fn = s.context.getProp(holder, "value");
        ordinaryCall(s, fn);
      } finally {
        fn?.dispose();
        holder.dispose();
      }
    };
    s.budget.run("warm-export", probe);
    const before = s.raw.mallocSize(s.runtime.rt.value);
    s.budget.run("repeated-exports", () => {
      for (let i = 0; i < 30; i++) probe();
    });
    assert.equal(s.raw.mallocSize(s.runtime.rt.value), before);
  } finally {
    s.dispose();
  }
});

test("C noncallable and thrown results are released and leave no pending exception", async () => {
  const s = await createExperimentSession();
  try {
    const probe = () => {
      const holder = s.context.newObject(s.context.null);
      try {
        assert.equal(into(s, "fixture", holder), -4);
        assert.equal(into(s, "throwing", holder), -3);
        assert.equal(into(s, "callable", holder), 0);
      } finally {
        holder.dispose();
      }
    };
    s.budget.run("warm-rejections", probe);
    const before = s.raw.mallocSize(s.runtime.rt.value);
    s.budget.run("repeat-rejections", () => {
      for (let i = 0; i < 20; i++) probe();
    });
    assert.equal(s.raw.mallocSize(s.runtime.rt.value), before);
  } finally {
    s.dispose();
  }
});

test("C failed own-property definition consumes its function result without invoking setters", async () => {
  const s = await createExperimentSession();
  let holder;
  try {
    s.budget.run("holder-setup", () => {
      holder = s.context.unwrapResult(
        s.context.evalCode("Object.preventExtensions(Object.create(null))"),
      );
    });
    assert.equal(into(s, "callable", holder), -5);
    const before = s.raw.mallocSize(s.runtime.rt.value);
    s.budget.run("repeated-property-failure", () => {
      for (let i = 0; i < 20; i++)
        assert.equal(into(s, "callable", holder), -5);
    });
    assert.equal(s.raw.mallocSize(s.runtime.rt.value), before);
    const good = s.context.newObject(s.context.null);
    try {
      assert.equal(into(s, "callable", good), 0);
    } finally {
      good.dispose();
    }
  } finally {
    holder?.dispose();
    s.dispose();
  }
});
