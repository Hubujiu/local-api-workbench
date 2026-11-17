// Build-only regression: inert validation must not pull Redis/SSH transports or
// optional native addons into template-generation and request-import bundles.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as policy from "../src/redis-commands.mjs";
import * as redis from "../src/redis.mjs";

test("inert native Redis intent and task validation bundle without transport or optional native dependencies", async () => {
  const result = await build({
    entryPoints: ["native-redis-write-intent", "script-database-tasks"].map(
      (name) =>
        fileURLToPath(new URL("../src/" + name + ".mjs", import.meta.url)),
    ),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    outdir: "unused-in-memory-build",
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).map((name) =>
    name.replaceAll("\\", "/"),
  );
  assert(inputs.some((name) => name.endsWith("/redis-commands.mjs")));
  assert.equal(
    inputs.some((name) =>
      /(?:\/redis\.mjs|\/database-ssh\.mjs|\/ssh2\/|\/cpu-features\/|\.node$)/.test(
        name,
      ),
    ),
    false,
  );
  assert.equal(result.outputFiles.length, 2);
});
test("Redis transport keeps exact command policy exports without changing validation", () => {
  for (const name of ["encodeRESP", "redisCommand", "redisWriteCommand"])
    assert.equal(redis[name], policy[name]);
  assert.deepEqual(policy.redisCommand({ command: ["get", "fixture"] }), [
    "GET",
    "fixture",
  ]);
  assert.deepEqual(
    policy.redisWriteCommand({
      allowWrite: true,
      command: ["SET", "fixture", "", "nx", "ex", "60"],
    }),
    ["SET", "fixture", "", "NX", "EX", "60"],
  );
  assert.throws(
    () => policy.redisCommand({ command: ["SET", "fixture", "v"] }),
    /只读/,
  );
  assert.throws(
    () => policy.redisWriteCommand({ command: ["SET", "fixture", "v"] }),
    /授权/,
  );
  assert.throws(
    () =>
      policy.redisWriteCommand({
        allowWrite: true,
        command: ["SET", "fixture", "v", "NX", "XX"],
      }),
    /选项/,
  );
});
