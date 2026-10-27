import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createExperimentSession } from "./runtime.mjs";
import { ActivityBudget } from "./budget.mjs";
import { LIMITS, FLAGS, fixedSource } from "./catalog.mjs";
import { verifyBundle, verifyEngine } from "./integrity.mjs";

const assets = new URL("./artifacts/", import.meta.url);
const evaluate = (session, source) =>
  session.budget.run("test-assertion", () => {
    const result = session.context.evalCode(
      source,
      "localapi:trusted/test-assertion.js",
      { type: "global" },
    );
    if (result.error) {
      const error = session.context.dump(result.error);
      result.error.dispose();
      throw Error(error.message);
    }
    try {
      return session.context.dump(result.value);
    } finally {
      result.value.dispose();
    }
  });

test("ordinary identity, ABI, source, filename, flags and truncated bytes fail before C", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", assets)));
  const engine = JSON.parse(readFileSync(new URL("engine.json", assets)));
  const bytes = Buffer.from(
    readFileSync(new URL("fixture.bytecode.b64", assets), "utf8").trim(),
    "base64",
  );
  verifyBundle(manifest, engine, "fixture", bytes);
  for (const field of [
    "sourceSha256",
    "wrapperSha256",
    "bytecodeSha256",
    "filename",
    "byteLength",
  ]) {
    const changed = structuredClone(manifest);
    changed.bundles.fixture[field] = "wrong";
    assert.throws(
      () => verifyBundle(changed, engine, "fixture", bytes),
      /identity mismatch/,
    );
  }
  for (const flags of [
    { compile: 33, write: 1, read: 1 },
    { compile: 32, write: 9, read: 1 },
    { compile: 32, write: 1, read: 3 },
  ]) {
    const changed = structuredClone(manifest);
    changed.bundles.fixture.flags = flags;
    assert.throws(
      () => verifyBundle(changed, engine, "fixture", bytes),
      /identity mismatch/,
    );
  }
  assert.throws(
    () => verifyBundle({ ...manifest, abi: "other" }, engine, "fixture", bytes),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      verifyBundle(
        manifest,
        { ...engine, wasmSha256: "other" },
        "fixture",
        bytes,
      ),
    /identity mismatch/,
  );
  assert.throws(
    () => verifyBundle(manifest, engine, "fixture", bytes.subarray(0, -1)),
    /identity mismatch/,
  );
  assert.throws(
    () => verifyBundle(manifest, engine, "../fixture", bytes),
    /Unknown/,
  );
  const wasm = Buffer.from(
    readFileSync(new URL("engine.wasm.b64", assets), "utf8").trim(),
    "base64",
  );
  const glue = readFileSync(new URL("engine.mjs", assets));
  const loader = readFileSync(new URL("./engine.mjs", import.meta.url));
  verifyEngine(engine, wasm, glue, loader);
  const productionWasm = Buffer.from(
    readFileSync(
      new URL(
        "../../src/vendor/quickjs-tracked/emscripten-module.wasm.b64",
        import.meta.url,
      ),
      "utf8",
    ).trim(),
    "base64",
  );
  assert.throws(
    () => verifyEngine(engine, productionWasm, glue, loader),
    /identity mismatch/,
  );
  for (const field of [
    "abi",
    "sourceCommit",
    "emscripten",
    "emsdkCommit",
    "wasmSha256",
    "glueSha256",
    "loaderSha256",
    "bridgeSha256",
    "interfaceBaseSha256",
    "patchedQuickJSSourceSha256",
    "patchedMakefileSha256",
    "baselinePatchSha256",
    "heapPatchSha256",
    "builderSha256",
    "inputVerifierSha256",
    "buildRecipeSha256",
    "sourceInputsSha256",
    "sdkDistributionSha256",
  ])
    assert.throws(
      () => verifyEngine({ ...engine, [field]: "other" }, wasm, glue, loader),
      /identity mismatch/,
    );
  for (const [w, g, l] of [
    [wasm.subarray(0, -1), glue, loader],
    [wasm, glue.subarray(0, -1), loader],
    [wasm, glue, loader.subarray(0, -1)],
  ])
    assert.throws(() => verifyEngine(engine, w, g, l), /identity mismatch/);
});

test("hash/copy/read/eval wall time is cumulative and late success cannot pass", () => {
  let now = 0;
  const budget = new ActivityBudget(() => now);
  assert.equal(
    budget.run("hash", () => {
      now += 40;
      return 1;
    }),
    1,
  );
  budget.run("copy", () => {
    now += 30;
  });
  budget.run("read", () => {
    now += 100;
  });
  assert.throws(
    () =>
      budget.run("eval", () => {
        now += 81;
        return "success";
      }),
    /wall-time budget/,
  );
  assert.equal(budget.used, 251);
  assert.throws(() => budget.run("late", () => 1), /wall-time budget/);
  let nestedTime = 0;
  const nested = new ActivityBudget(() => nestedTime);
  nested.run("outer", () => {
    nestedTime += 10;
    nested.run("inner", () => {
      nestedTime += 20;
    });
    nestedTime += 30;
  });
  assert.equal(nested.used, 60); // reentrant first-use load is not double charged
});

test("fresh instances, memories, runtimes and contexts never share guest globals", async () => {
  const a = await createExperimentSession(),
    b = await createExperimentSession();
  try {
    assert.notEqual(a.raw.module, b.raw.module);
    assert.notEqual(a.raw.memory, b.raw.memory);
    assert.notEqual(a.runtime, b.runtime);
    assert.notEqual(a.context, b.context);
    assert.equal(Object.hasOwn(a.budget.metrics, "verify-bundle"), false);
    assert.equal(Object.hasOwn(b.budget.metrics, "verify-bundle"), false);
    a.load("fixture");
    a.load("fixture");
    assert.equal(evaluate(a, "__trustedFixture"), 2);
    assert.equal(evaluate(b, "typeof __trustedFixture"), "undefined");
    for (const session of [a, b])
      assert.equal(
        evaluate(
          session,
          "[typeof process,typeof require,typeof QTS_TrustedBytecodeReadEval,typeof __boundedJSONSchema]",
        ).join(","),
        "undefined,undefined,undefined,undefined",
      );
    const original = a.raw.readEval;
    let cCalls = 0;
    a.raw.readEval = (...args) => {
      cCalls++;
      return original(...args);
    };
    for (const [id, mode] of [
      ["../schema"],
      [Buffer.from("fixture")],
      ["schema", "module"],
      ["schema", { flags: 3 }],
    ])
      assert.throws(() => a.load(id, mode), /Unknown/);
    assert.equal(cCalls, 0);
    a.raw.readEval = original;
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("temporary staging is actually charged; allocation OOM leaves no pending exception", async () => {
  const session = await createExperimentSession();
  const { raw, context, runtime } = session;
  try {
    const before = raw.mallocSize(runtime.rt.value);
    const pointer = raw.alloc(context.ctx.value, 1024 * 1024);
    assert(pointer);
    try {
      assert(raw.mallocSize(runtime.rt.value) - before >= 1024 * 1024);
    } finally {
      raw.free(context.ctx.value, pointer);
    }
    assert.equal(raw.mallocSize(runtime.rt.value), before);
    assert.equal(raw.alloc(context.ctx.value, LIMITS.memory), 0);
    session.load("fixture");
    assert.equal(evaluate(session, "__trustedFixture"), 1);
  } finally {
    session.dispose();
  }
});

test("borrowed compile handle and writer buffer are released exactly once", async () => {
  const session = await createExperimentSession();
  const { raw, context, runtime } = session;
  const source = fixedSource("fixture");
  try {
    const before = raw.mallocSize(runtime.rt.value);
    for (let index = 0; index < 20; index++) {
      const handle = context.unwrapResult(
        context.evalCode(source.source, source.filename, FLAGS.compile),
      );
      const size = raw.alloc(context.ctx.value, 4);
      let pointer = 0;
      try {
        assert(size);
        pointer = raw.write(context.ctx.value, handle.value, size);
        assert(pointer);
      } finally {
        if (pointer) raw.free(context.ctx.value, pointer);
        if (size) raw.free(context.ctx.value, size);
        handle.dispose();
      }
    }
    assert.equal(raw.mallocSize(runtime.rt.value), before);
    assert.equal(evaluate(session, "typeof __trustedFixture"), "undefined");
  } finally {
    session.dispose();
  }
});

test("writer refuses ordinary non-bytecode handles without consuming them", async () => {
  const session = await createExperimentSession();
  const { raw, context, runtime } = session;
  try {
    const before = raw.mallocSize(runtime.rt.value);
    const value = context.newNumber(7);
    let size = 0;
    try {
      size = raw.alloc(context.ctx.value, 4);
      assert(size);
      assert.equal(raw.write(context.ctx.value, value.value, size), 0);
      assert.equal(new DataView(raw.memory.buffer).getUint32(size, true), 0);
      assert.equal(context.getNumber(value), 7);
    } finally {
      if (size) raw.free(context.ctx.value, size);
      value.dispose();
    }
    assert.equal(raw.mallocSize(runtime.rt.value), before);
    session.load("fixture");
    assert.equal(evaluate(session, "__trustedFixture"), 1);
  } finally {
    session.dispose();
  }
});

test("successful object results and thrown errors do not leak or leave pending exceptions", async () => {
  const session = await createExperimentSession();
  try {
    session.load("fixture");
    assert.throws(() => session.load("throwing"), /evaluation failed: -3/);
    const before = session.raw.mallocSize(session.runtime.rt.value);
    for (let index = 0; index < 30; index++) {
      session.load("fixture");
      assert.throws(() => session.load("throwing"), /evaluation failed: -3/);
    }
    assert.equal(session.raw.mallocSize(session.runtime.rt.value), before);
    assert.equal(evaluate(session, "__trustedFixture"), 31);
  } finally {
    session.dispose();
  }
});

test("ordinary 16MiB guest allocation failure is closed and cleanup permits subsequent fixed evaluation", async () => {
  const session = await createExperimentSession();
  try {
    assert.throws(() => session.load("allocating"), /evaluation failed: -3/);
    session.load("fixture");
    assert.equal(evaluate(session, "__trustedFixture"), 1);
  } finally {
    session.dispose();
  }
});

test("same fixed schema bytecode and text retain validity, error and option semantics", async () => {
  const outputs = [];
  for (const mode of ["source", "bytecode"]) {
    const session = await createExperimentSession();
    try {
      assert.equal(
        evaluate(session, "typeof __boundedJSONSchema"),
        "undefined",
      );
      session.load("schema", mode);
      outputs.push(
        evaluate(
          session,
          `(()=>{
        const cases=[
          [{type:'integer',minimum:2},3], [{type:'integer',minimum:2},1],
          [false,1], [true,null],
          [{type:'object',properties:{name:{$ref:'#/definitions/n'}},definitions:{n:{type:'string',minLength:2}},required:['name']},{name:'Ada'}],
          [{type:'string',format:'email'},'bad'], [{type:'unknown'},1],
          [{$ref:'https://example.invalid/schema'},1],
          [{type:'number'},'2',{coerceTypes:true}],
          [{minLength:-1},'x']
        ]; return cases.map(args=>{try{return __boundedJSONSchema(...args)}catch(e){return {error:e.message}}});
      })()`,
        ),
      );
    } finally {
      session.dispose();
    }
  }
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(
    outputs[0].slice(0, 5).map((x) => x.valid),
    [true, false, false, true, true],
  );
  assert(outputs[0].slice(6).every((x) => x.error));
});

test("same fixed script-libraries bytecode and text retain ordinary library semantics", async () => {
  const outputs = [];
  for (const mode of ["source", "bytecode"]) {
    const session = await createExperimentSession();
    try {
      session.load("library-prelude", mode);
      session.load("libraries", mode);
      outputs.push(
        evaluate(
          session,
          "[_.chunk([1,2,3],2), moment.utc('2026-01-02').format('YYYY-MM-DD'), CryptoJS.SHA256('abc').toString(), typeof chai.expect, typeof process, typeof require]",
        ),
      );
    } finally {
      session.dispose();
    }
  }
  assert.deepEqual(outputs[1], outputs[0]);
});

// WorkerData carries only fixed enum selections; never source, bytes or paths.
const workerRun = (operation, cancel = false) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false;
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { operation },
    });
    const timer = setTimeout(() => {
      settled = true;
      worker.terminate();
      reject(Error("2s worker wall deadline"));
    }, LIMITS.wallMs);
    worker.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(Error("Worker exited without result: " + code));
      }
    });
    worker.on("message", async (message) => {
      if (settled) return;
      if (cancel && message.kind === "ready") {
        settled = true;
        clearTimeout(timer);
        await worker.terminate();
        resolve({ canceled: true });
      }
      if (message.kind === "result") {
        settled = true;
        clearTimeout(timer);
        const late = performance.now() - started >= LIMITS.wallMs;
        await worker.terminate();
        if (late) reject(Error("2s worker wall deadline"));
        else resolve(message);
      }
    });
  });

test("interruptible ordinary loop fails within unchanged active/worker budgets", async () => {
  const result = await workerRun("loop");
  assert.equal(result.ok, false);
  assert.match(result.error, /budget/);
  assert(result.elapsed < LIMITS.wallMs);
});

test("cancellation terminates its isolated worker and does not contaminate a fresh run", async () => {
  assert.deepEqual(await workerRun("loop", true), { canceled: true });
  const result = await workerRun("fixture");
  assert.equal(result.ok, true);
});
