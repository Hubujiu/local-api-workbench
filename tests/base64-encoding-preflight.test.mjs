import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { base64EncodingPreflight } from "../src/base64-encoding-preflight.mjs";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";

const boundaryInputs = [
  "x".repeat(49148),
  "x".repeat(49149),
  "x".repeat(49150),
  "x".repeat(49151),
  "中".repeat(16383),
  "中".repeat(16383) + "x",
  "中".repeat(16383) + "xx",
  "😀".repeat(12287) + "x",
  "😀".repeat(12287) + "xx",
  "😀".repeat(12287) + "xxx",
  "é".repeat(24574) + "x",
  "é".repeat(24575),
  "é".repeat(24575) + "x",
  "",
  "\u0000",
  '"\\\n',
  "a中文😀é",
];
test("encoding preflight matches independent UTF-8/Base64 JSON byte counts at every expansion boundary", () => {
  for (const input of boundaryInputs) {
    const bytes = Buffer.byteLength(
      JSON.stringify(Buffer.from(input).toString("base64")),
      "utf8",
    );
    if (bytes > 65536)
      assert.throws(() => base64EncodingPreflight(input), /64KiB/);
    else assert.equal(base64EncodingPreflight(input), undefined);
  }
  // Repeat the function's exact serialized source shape used by the QuickJS caller.
  const source = base64EncodingPreflight.toString();
  for (const input of [
    "x".repeat(49149),
    "x".repeat(49150),
    "中".repeat(16383) + "x",
  ])
    if (
      Buffer.byteLength(JSON.stringify(Buffer.from(input).toString("base64"))) >
      65536
    )
      assert.throws(
        () =>
          runInNewContext(`(${source})(input)`, { input }, { timeout: 1000 }),
        /64KiB/,
      );
    else runInNewContext(`(${source})(input)`, { input }, { timeout: 1000 });
});

test("preflight preserves malformed UTF-16 precedence even after an already oversized prefix", () => {
  for (const input of [
    "\ud800",
    "\udc00",
    "a\ud800b",
    "\ud800\ud800",
    "x".repeat(50000) + "\ud800",
    "中".repeat(17000) + "\udc00",
  ])
    assert.throws(() => base64EncodingPreflight(input), /有效Unicode/);
  for (const input of [null, false, 1, {}, []])
    assert.throws(() => base64EncodingPreflight(input), /文本输入/);
});

test("negative quota mutant loses the exact reject while the real preflight still rejects before encoding", () => {
  const original = base64EncodingPreflight.toString();
  const mutant = original.replace("+ 2 > 65536", "+ 2 > 999999");
  assert.notEqual(mutant, original);
  const input = "x".repeat(49150);
  assert.throws(
    () => runInNewContext(`(${original})(input)`, { input }, { timeout: 1000 }),
    /64KiB/,
  );
  assert.equal(
    runInNewContext(`(${mutant})(input)`, { input }, { timeout: 1000 }),
    undefined,
  );
});

test("real Base64 pipelines retain the encoder, intermediate/final JSON cap and exact rejection messages", async () => {
  for (const token of ["a中文😀é", "\u0000a", "".padEnd(49149, "x")])
    assert.equal(
      await resolveApipostFunctionTemplate("{{token|base64}}", [], "body", {
        token,
      }),
      Buffer.from(token).toString("base64"),
    );
  for (const token of [
    "x".repeat(49150),
    "中".repeat(16383) + "x",
    "😀".repeat(12287) + "xx",
  ])
    await assert.rejects(
      resolveApipostFunctionTemplate("{{token|base64|length}}", [], "body", {
        token,
      }),
      /64KiB/,
    );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|base64|length}}", [], "body", {
      token: "x".repeat(50000) + "\ud800",
    }),
    /有效Unicode/,
  );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|base64}}", [], "body", {
      token: '"'.repeat(32768),
    }),
    /初值超过64KiB/,
  );
  // A valid stage result can still exceed the unchanged final field JSON cap.
  await assert.rejects(
    resolveApipostFunctionTemplate("X{{token|base64}}XXX", [], "body", {
      token: "x".repeat(49149),
    }),
    /64KiB/,
  );
  // unbase64 remains on the original validation and UTF-8 decoding path.
  assert.equal(
    await resolveApipostFunctionTemplate("{{token|unbase64}}", [], "body", {
      token: "8J-YgA",
    }),
    "😀",
  );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|unbase64}}", [], "body", {
      token: "/w==",
    }),
    /有效Unicode/,
  );
});

test("generated pipeline invokes preflight before UTF-8 allocation and encoder, with a removed-call mutant", async () => {
  const { build } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const { default: CryptoJS } = await import("crypto-js");
  const { default: lodash } = await import("lodash");
  // Capture only the worker boundary, not the generator or the production guard.
  // Real QuickJS execution and its quotas are exercised by the tests above.
  const bundle = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../src/apipost-function-templates.mjs", import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "iife",
    globalName: "Templates",
    plugins: [
      {
        name: "capture-generated-worker-code",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/scripts\.mjs$/ }, () => ({
            path: "worker-boundary",
            namespace: "test",
          }));
          builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents:
              "export const runScript=(...args)=>globalThis.capture(...args);",
            loader: "js",
          }));
        },
      },
    ],
  });
  let utf8Calls = 0,
    encoderCalls = 0,
    removeCall = false;
  const context = {
    Buffer,
    TextEncoder,
    capture: async (code, _input, options) => {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), {
        requestLimit: 0,
        timerLimit: 0,
        jobLimit: 0,
      });
      if (removeCall) {
        const mutant = code.replace(
          "if(!decode)__apipostEncodingPreflight(input);",
          "",
        );
        assert.notEqual(mutant, code);
        code = mutant;
      }
      const variables = {};
      runInNewContext(
        code,
        {
          apt: { setVar: (name, value) => (variables[name] = value) },
          require: (name) => {
            if (name === "lodash") return lodash;
            assert.equal(name, "crypto-js");
            return {
              enc: {
                Utf8: {
                  ...CryptoJS.enc.Utf8,
                  parse(input) {
                    utf8Calls++;
                    return CryptoJS.enc.Utf8.parse(input);
                  },
                },
                Base64: {
                  ...CryptoJS.enc.Base64,
                  stringify(bytes) {
                    encoderCalls++;
                    return CryptoJS.enc.Base64.stringify(bytes);
                  },
                },
              },
            };
          },
        },
        { timeout: 1000 },
      );
      return { variables };
    },
  };
  runInNewContext(bundle.outputFiles[0].text, context, { timeout: 1000 });
  const resolve = context.Templates.resolveApipostFunctionTemplate;
  await assert.rejects(
    resolve("{{token|base64|length}}", [], "body", {
      token: "x".repeat(50000),
    }),
    /64KiB/,
  );
  assert.equal(utf8Calls, 0);
  assert.equal(encoderCalls, 0);
  removeCall = true;
  await assert.rejects(
    resolve("{{token|base64|length}}", [], "body", {
      token: "x".repeat(50000),
    }),
    /64KiB/,
  );
  // The retained post-stage check still rejects; the mutant loses early rejection.
  assert.equal(utf8Calls, 1);
  assert.equal(encoderCalls, 1);
  removeCall = false;
  assert.equal(
    await resolve("{{token|base64}}", [], "body", { token: "中文 😀" }),
    Buffer.from("中文 😀").toString("base64"),
  );
  assert.equal(utf8Calls, 2);
  assert.equal(encoderCalls, 2);
});
