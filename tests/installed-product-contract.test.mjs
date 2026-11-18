import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertTargetPathBudget,
  compareMsiVersions,
  containedPath,
  inventory,
  loadProductPlan,
  validateProductPlan,
  assertRuntimeIdentity,
} from "./helpers/installed-product-contract.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const family = "11111111-1111-4111-8111-111111111111";
const plan = () => ({
  kind: "localapi-installed-product-lifecycle-v1",
  family,
  directory: "LocalAPI-Lifecycle-Candidate-Fixture-" + family,
  packages: ["0.1.0", "0.2.0"].map((version) => ({
    version,
    head: "a".repeat(40),
    msi: { file: version + "/app.msi", sha256: "a".repeat(64) },
    receipt: { file: version + "/receipt.json", sha256: "b".repeat(64) },
  })),
});
test("numeric bounded versions, not lexicographic or relabeled same version", () => {
  assert.equal(compareMsiVersions("1.9.0", "1.10.0"), -1);
  for (const invalid of [
    "01.1.0",
    "256.0.0",
    "1.256.0",
    "1.0.65536",
    "1.0.0-beta",
    "1.0",
  ])
    assert.throws(() => compareMsiVersions(invalid, "1.0.0"));
  const p = plan();
  p.packages[1].version = p.packages[0].version;
  assert.throws(() => validateProductPlan(p));
});
test("isolated namespace and pinned path constraints", () => {
  assert.deepEqual(validateProductPlan(plan()), plan());
  for (const value of [
    "../outside",
    "/absolute",
    "C:\\outside",
    "a/../b",
    "a//b",
    ".",
    "a/./b",
  ])
    assert.throws(() => containedPath("/root", value));
  for (const mutate of [
    (p) => (p.directory = "LocalAPI"),
    (p) => (p.family = "not-uuid"),
    (p) => (p.packages[0].head = "main"),
    (p) => (p.packages[0].msi.sha256 = "bad"),
    (p) => p.packages.push(p.packages[0]),
  ]) {
    const p = plan();
    mutate(p);
    assert.throws(() => validateProductPlan(p));
  }
});
test("runtime identity pins actual process, app version and isolated data", () => {
  const expected = {
    version: "0.2.0",
    executable: "/fixture/LocalAPI.exe",
    appPath: "/fixture/resources/app",
    userData: "/synthetic",
  };
  assertRuntimeIdentity(expected, expected);
  for (const key of Object.keys(expected))
    assert.throws(() =>
      assertRuntimeIdentity({ ...expected, [key]: "wrong" }, expected),
    );
});
test("inventory rejects symlinks and preserves foreign file hashes", async (t) => {
  const root = await mkdtemp(
    path.join(await realpath(tmpdir()), "product-contract-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "foreign.txt"), "keep");
  assert.deepEqual(await inventory(root), { "foreign.txt": sha("keep") });
  if (process.platform === "win32") {
    const directory = path.join(root, "files");
    await mkdir(directory);
    await symlink(directory, path.join(root, "alias"), "junction");
  } else {
    await symlink(path.join(root, "foreign.txt"), path.join(root, "alias"));
  }
  await assert.rejects(inventory(root));
});
test("plan and payload digests, receipts, identity fail closed", async (t) => {
  const root = await mkdtemp(
    path.join(await realpath(tmpdir()), "product-plan-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = plan();
  for (const [i, item] of p.packages.entries()) {
    await mkdir(path.join(root, item.version));
    const msi = Buffer.from("synthetic bytes, never executed " + i);
    item.msi.sha256 = sha(msi);
    await writeFile(path.join(root, item.msi.file), msi);
    const fileHashes = {
      "LocalAPI.exe": sha("exe"),
      "build-manifest.json": sha("manifest"),
      "resources/app/package.json": sha("pkg"),
    };
    const receipt = JSON.stringify({
      fixtureFamily: family,
      directory: p.directory,
      version: item.version,
      head: item.head,
      manifestSha256: fileHashes["build-manifest.json"],
      fileHashes,
      upgradeCode: "11111111-2222-4333-8444-555555555555",
      productCode: i
        ? "22222222-2222-4333-8444-555555555555"
        : "33333333-2222-4333-8444-555555555555",
    });
    item.receipt.sha256 = sha(receipt);
    await writeFile(path.join(root, item.receipt.file), receipt);
  }
  const file = path.join(root, "product-plan.json"),
    bytes = JSON.stringify(p);
  await writeFile(file, bytes);
  assert.equal((await loadProductPlan(file, sha(bytes))).packages.length, 2);
  await assert.rejects(
    loadProductPlan(file, "f".repeat(64)),
    /digest mismatch/,
  );
  await writeFile(path.join(root, p.packages[0].msi.file), "changed");
  await assert.rejects(loadProductPlan(file, sha(bytes)), /digest mismatch/);
});

test("runner refuses non-Windows before dependency loading or installation", async () => {
  if (process.platform === "win32") return;
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const runner = fileURLToPath(
    new URL("./desktop-installed-product-journey.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--plan",
      "does-not-exist",
      "--expected-plan-sha256",
      "a".repeat(64),
      "--execute-in-disposable-windows",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Native disposable Windows required/);
  const missingOptIn = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(missingOptIn.status, 0);
  assert.match(missingOptIn.stderr, /Use --plan/);
});

test("Win32 file budget uses UTF-16 259/260, including surrogate pairs", () => {
  const target = "C:\\Users\\synthetic\\AppData\\Local\\LocalAPI-Q-" + family;
  const check = (name) =>
    assertTargetPathBudget(target, [
      { fileHashes: { [name]: "a" }, directories: [] },
    ]);
  for (const suffix of ["x", "😀"]) {
    const name = "a".repeat(259 - target.length - 1 - suffix.length) + suffix;
    check(name);
    assert.throws(() => check(name + "x"), /path budget/);
  }
  for (const name of [
    "../escape",
    "x/../escape",
    "C:/escape",
    "x\\escape",
    "x//empty",
    "x/",
    "x.",
  ])
    assert.throws(() => check(name), /Unsafe/);
  const dir = "a".repeat(247 - target.length - 1);
  assertTargetPathBudget(target, [
    { fileHashes: { file: "a" }, directories: [dir] },
  ]);
  assert.throws(
    () =>
      assertTargetPathBudget(target, [
        { fileHashes: { file: "a" }, directories: [dir + "x"] },
      ]),
    /path budget/,
  );
});
test("observed 260-character fixture regression is rejected before MSI", () => {
  const local = "C:\\Users\\localapi17c41b29db\\AppData\\Local\\";
  const relative =
    "resources/app/node_modules/@azure/msal-browser/types/custom_auth/core/auth_flow/v2/result/AuthMethodVerificationSubmitChallengeResultV2.d.ts.map";
  const contracts = [{ fileHashes: { [relative]: "a" }, directories: [] }];
  const legacy = local + "LocalAPI-Lifecycle-Candidate-Fixture-" + family;
  assert.equal((legacy + "\\" + relative).length, 260);
  assert.throws(() => assertTargetPathBudget(legacy, contracts), /path budget/);
  assertTargetPathBudget(local + "LocalAPI-Q-" + family, contracts);
});

test("budget checks both pinned versions, empty directories and runner ordering", async () => {
  const target = "C:\\Users\\synthetic\\AppData\\Local\\LocalAPI-Q-" + family;
  const good = { fileHashes: { "ok.txt": "a" }, directories: [] };
  const bad = {
    fileHashes: { ["a".repeat(260 - target.length - 1)]: "a" },
    directories: [],
  };
  assert.throws(
    () => assertTargetPathBudget(target, [good, bad]),
    /path budget/,
  );
  assert.throws(
    () => assertTargetPathBudget(target, [{ fileHashes: good.fileHashes }]),
    /assertion|false/i,
  );
  const source = await readFile(
    new URL("./desktop-installed-product-journey.mjs", import.meta.url),
    "utf8",
  );
  const checked = source.search(/assertTargetPathBudget\(\s*target,/);
  assert.ok(checked > source.indexOf("const plan = await loadProductPlan"));
  assert.ok(checked < source.indexOf("const root = await mkdtemp"));
  assert.ok(source.includes('"Existing installation refused"'));
  assert.ok(source.includes('"Existing retained directory refused"'));
});
