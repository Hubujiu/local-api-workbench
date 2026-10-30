import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest, snapshotPlan, runPlan } from "../src/core.mjs";
const policy = () => ({
  placement: "auto",
  includeBodyHash: true,
  includeEmptyParams: true,
  headerEncoding: "percent",
});
const auth = () => ({
  type: "oauth1",
  consumerKey: "key",
  consumerSecret: "secret",
  parameterPolicy: policy(),
});
test("OAuth1 normalization and raw plan gates reject owned-data violations before cloning, scripts or execution", async () => {
  let reads = 0,
    prepared = 0,
    executed = 0;
  const factories = [
    () => {
      const a = auth();
      Object.defineProperty(a, "consumerKey", {
        enumerable: true,
        get() {
          reads++;
          return "key";
        },
      });
      return a;
    },
    () => {
      const a = auth();
      Object.defineProperty(a, "consumerSecret", {
        enumerable: false,
        value: "hidden",
      });
      return a;
    },
    () =>
      Object.assign(Object.create({ consumerSecret: "inherited" }), {
        type: "oauth1",
        consumerKey: "key",
        parameterPolicy: policy(),
      }),
    () => ({
      ...auth(),
      parameterPolicy: { ...policy(), placement: "{{placement}}" },
    }),
    () => {
      const a = auth();
      Object.defineProperty(a, "parameterPolicy", {
        enumerable: false,
        value: policy(),
      });
      return a;
    },
  ];
  for (const make of factories) {
    const request = {
      url: "https://fixture.invalid",
      auth: make(),
      beforeScript: 'throw Error("script must not execute")',
    };
    assert.throws(
      () => normalizeRequest(request),
      /OAuth1 parameterPolicy 定义无效/,
    );
    assert.throws(
      () => snapshotPlan({ steps: [{ request }] }),
      /OAuth1 parameterPolicy 定义无效/,
    );
    for (const enabled of [true, false])
      await assert.rejects(
        runPlan(
          { steps: [{ request, enabled }] },
          { placement: "header" },
          async () => {
            executed++;
            throw Error("execute must not run");
          },
          {
            prepareRequest: () => {
              prepared++;
              throw Error("prepare must not run");
            },
          },
        ),
        /OAuth1 parameterPolicy 定义无效/,
      );
  }
  assert.equal(reads, 0);
  assert.equal(prepared, 0);
  assert.equal(executed, 0);
});
test("OAuth1 installed normalization source matches the pinned public tag", async () => {
  const { createRequire } = await import("node:module"),
    { readFile } = await import("node:fs/promises"),
    { createHash } = await import("node:crypto");
  const require = createRequire(import.meta.url);
  const file = require.resolve("node-oauth1"),
    bytes = await readFile(file);
  assert.equal(
    createHash("sha1")
      .update(Buffer.from("blob " + bytes.length + "\0"))
      .update(bytes)
      .digest("hex"),
    "73f6dfe1e81e43d30a360f995826bc471d0d1db9",
  );
  const metadata = JSON.parse(
    await readFile(require.resolve("node-oauth1/package.json"), "utf8"),
  );
  assert.equal(metadata.version, "1.3.0");
  assert.equal(metadata.license, "Apache-2.0");
  assert.deepEqual(metadata.dependencies || {}, {});
});
