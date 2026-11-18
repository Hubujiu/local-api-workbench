import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  archiveNativeAutomationSource as pack,
  restoreNativeAutomationSource as unpack,
  inspectNativeAutomationSource as inspect,
  nativeAutomationSourceLimit,
} from "../src/native-automation-source-archive.mjs";
import { nativeAutomationRejectionFixture } from "./fixtures/native-automation-rejection.mjs";
import { importIntoProject } from "../src/core.mjs";
const fixture = () =>
  nativeAutomationRejectionFixture("http://127.0.0.1:1/never");
const bytes = (source) => Buffer.from(JSON.stringify(source, null, 2) + "\r\n");
const run = promisify(execFile);
const cli = fileURLToPath(
  new URL("../scripts/native-automation-source.mjs", import.meta.url),
);

test("nonempty native source has an explicit inert identity and byte-exact roundtrip including unknown syntax", () => {
  const source = fixture();
  source.automated_testings[0].unknownFutureField = {
    script: "throw Error('MUST NOT EXECUTE')",
    settings: { unknown: true },
  };
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(source)]);
  const archive = pack(input);
  assert.deepEqual(unpack(JSON.parse(JSON.stringify(archive))), input);
  assert.equal(archive.execution, "unsupported");
  const report = inspect(archive);
  assert.equal(report.automationCount, 1);
  assert.equal(report.eventCount, 7);
  assert.equal(report.rootCount, 7);
  assert.deepEqual(report.issues, []);
  assert.equal(report.sourceVersion, "unverified");
  assert.equal(report.semantics, "not-validated");
  assert.equal(JSON.stringify(report).includes("MUST NOT EXECUTE"), false);
  assert.equal(JSON.stringify(report).includes(source.project_id), false);
  assert.equal(JSON.stringify(report).includes("127.0.0.1"), false);
  const project = { requests: [], environments: [], settings: {}, plans: [] };
  for (const document of [
    archive,
    { ...source, ...archive },
    { _postman_variable_scope: "environment", ...archive },
    JSON.stringify(archive),
  ]) {
    assert.throws(() => importIntoProject(project, document), /不可导入或执行/);
    assert.deepEqual(project, {
      requests: [],
      environments: [],
      settings: {},
      plans: [],
    });
  }
  assert.throws(() => importIntoProject(project, source), /automated_testings/);
});

test("static graph manifest reports broken identities references and order without fixing or executing them", () => {
  const source = fixture(),
    testing = source.automated_testings[0],
    events = testing.event_list;
  testing.project_id = "other";
  events[0].parent_event_id = events[1].event_id;
  events[1].parent_event_id = events[0].event_id;
  events[2].parent_event_id = "missing";
  events[3].data.target_id = "missing";
  events[4].sort = events[3].sort;
  events[5].type = "unknown-future-type";
  events[6].test_id = "other";
  testing.settings = null;
  const input = bytes(source),
    archive = pack(input);
  assert.deepEqual(unpack(archive), input);
  const report = inspect(archive),
    codes = report.issues.map((i) => i.code);
  for (const code of [
    "testing-project-mismatch",
    "parent-cycle",
    "parent-reference-unresolved",
    "api-reference-unresolved",
    "sibling-array-sort-not-increasing",
    "event-testing-mismatch",
    "settings-not-object",
  ])
    assert.ok(codes.includes(code), code);
  assert.equal(report.otherTypeCount, 1);
  assert.equal(report.semantics, "not-validated");
});

test("source and archive bounds integrity and inert marker fail closed, without getters", () => {
  const archive = pack(bytes(fixture()));
  for (const mutate of [
    (a) => (a.sha256 = "0".repeat(64)),
    (a) => a.byteLength++,
    (a) => (a.sourceBase64 += "\n"),
    (a) => (a.execution = "supported"),
    (a) => (a.version = 2),
  ]) {
    const changed = structuredClone(archive);
    mutate(changed);
    assert.throws(() => unpack(changed));
  }
  let reads = 0;
  const getter = { ...archive };
  Object.defineProperty(getter, "sourceBase64", {
    enumerable: true,
    get() {
      reads++;
      throw Error("getter");
    },
  });
  assert.throws(() => unpack(getter));
  assert.equal(reads, 0);
  assert.throws(() =>
    unpack(
      new Proxy(archive, {
        ownKeys() {
          reads++;
          return [];
        },
      }),
    ),
  );
  assert.equal(reads, 0);
  for (const input of [
    Buffer.from([0xff]),
    Buffer.alloc(nativeAutomationSourceLimit + 1),
    bytes({ format: "apipost-offline-directory-v1", files: [] }),
    bytes({ ...fixture(), automated_testings: [] }),
  ])
    assert.throws(() => pack(input));
  const deep = fixture();
  deep.extra = JSON.parse("[".repeat(70) + "0" + "]".repeat(70));
  assert.throws(() => pack(bytes(deep)), /结构/);
});

test("actual CLI packs inspects and restores source, never overwrites and never exposes source text in summaries", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "source.json"),
    archive = path.join(dir, "archive.json"),
    output = path.join(dir, "restored.json");
  const original = bytes(fixture());
  await writeFile(input, original);
  const call = (...args) => run(process.execPath, [cli, ...args]);
  const packed = await call("pack", input, archive);
  const inspected = await call("inspect", archive);
  assert.deepEqual(JSON.parse(packed.stdout), JSON.parse(inspected.stdout));
  assert.equal(packed.stdout.includes("synthetic"), false);
  await call("unpack", archive, output);
  assert.deepEqual(await readFile(output), original);
  await assert.rejects(call("unpack", archive, output), (e) =>
    /EEXIST/.test(e.stderr),
  );
  await assert.rejects(call("pack", input, input), (e) =>
    /EEXIST/.test(e.stderr),
  );
  assert.deepEqual(await readFile(input), original);
  const corrupt = JSON.parse(await readFile(archive, "utf8"));
  corrupt.sha256 = "0".repeat(64);
  await writeFile(archive, JSON.stringify(corrupt));
  await assert.rejects(call("inspect", archive), (e) =>
    /完整性/.test(e.stderr),
  );
  await assert.rejects(call("unpack", archive, path.join(dir, "bad.json")));
  await assert.rejects(readFile(path.join(dir, "bad.json")), {
    code: "ENOENT",
  });
});

test("manual preview refuses inert source archives even when given overlapping executable resource markers", async () => {
  const { prepareManualImportSource } = await import(
    "../src/manual-import-source.mjs"
  );
  const context = {
    nonce: Buffer.alloc(32, 7).toString("base64url"),
    issuedAt: 1700000000000,
    expiresAt: 1700000060000,
  };
  const archive = pack(bytes(fixture()));
  for (const document of [
    archive,
    { ...fixture(), ...archive },
    JSON.stringify(archive),
  ]) {
    const input = { format: "auto", document };
    const before = structuredClone(input);
    await assert.rejects(prepareManualImportSource(input, context), /手动导入/);
    assert.deepEqual(input, before);
  }
});

test("wrapped exports, raw numeric spelling and duplicate unknown keys survive without a semantic claim", () => {
  const source = bytes({ status: "success", data: fixture() })
    .toString("utf8")
    .replace(
      '"status": "success",',
      '"status": "success", "opaqueNumber": 9007199254740993, "opaque": 1, "opaque": 2,',
    );
  const input = Buffer.from(source),
    archive = pack(input);
  assert.deepEqual(unpack(archive), input);
  assert.equal(inspect(archive).eventCount, 7);
  assert.equal(inspect(archive).semantics, "not-validated");
  const wide = fixture();
  wide.opaque = Array(100001).fill(null);
  assert.throws(() => pack(bytes(wide)), /结构/);
});

test(
  "CLI rejects a POSIX named pipe without waiting for a writer",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "native-source-pipe-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fifo = path.join(dir, "pipe");
    await run("mkfifo", [fifo]);
    await assert.rejects(
      run(process.execPath, [cli, "inspect", fifo], { timeout: 2000 }),
      (error) => !error.killed && /普通文件/.test(error.stderr),
    );
  },
);
