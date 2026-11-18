import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareMsiVersions(first, second) {
  for (const version of [first, second]) {
    assert.match(version, versionPattern);
    const [major, minor, build] = version.split(".").map(Number);
    assert.ok(major <= 255 && minor <= 255 && build <= 65535);
  }
  const a = first.split(".").map(Number),
    b = second.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
export function containedPath(root, relative) {
  assert.equal(typeof relative, "string");
  assert.ok(relative.length > 0 && !path.isAbsolute(relative));
  assert.ok(
    relative
      .split("/")
      .every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== ".."),
  );
  return path.join(root, ...relative.split("/"));
}
export async function noAlias(file) {
  assert.equal(
    (await lstat(file)).isSymbolicLink(),
    false,
    "Symlink/junction refused",
  );
  const expected = path.resolve(file),
    actual = await realpath(file);
  assert.equal(
    process.platform === "win32" ? actual.toLowerCase() : actual,
    process.platform === "win32" ? expected.toLowerCase() : expected,
    "Aliased path refused",
  );
}
export async function inventory(root) {
  await noAlias(root);
  const result = {};
  async function visit(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name),
        name = prefix + entry.name;
      await noAlias(file);
      if (entry.isDirectory()) await visit(file, name + "/");
      else {
        assert.ok(entry.isFile(), "Only ordinary files allowed");
        result[name] = sha(await readFile(file));
      }
    }
  }
  await visit(root, "");
  return result;
}
export function validateProductPlan(plan) {
  assert.equal(plan.kind, "localapi-installed-product-lifecycle-v1");
  assert.match(
    plan.family,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.ok(
    ["LocalAPI-Q-", "LocalAPI-Lifecycle-Candidate-Fixture-"].some(
      (prefix) => plan.directory === prefix + plan.family,
    ),
    "Wrong isolated installation directory",
  );
  assert.ok(Array.isArray(plan.packages));
  assert.equal(plan.packages.length, 2);
  assert.equal(
    compareMsiVersions(plan.packages[0].version, plan.packages[1].version),
    -1,
    "An actual higher version is required",
  );
  for (const item of plan.packages) {
    assert.match(item.head, /^[0-9a-f]{40}$/);
    for (const key of ["msi", "receipt"]) {
      assert.match(item[key].sha256, digestPattern);
      containedPath("/validation-root", item[key].file);
    }
  }
  return plan;
}
export async function loadProductPlan(filename, expectedSha) {
  assert.match(expectedSha, digestPattern);
  await noAlias(filename);
  const bytes = await readFile(filename);
  assert.ok(bytes.length <= 65536);
  assert.equal(sha(bytes), expectedSha, "Independent plan digest mismatch");
  const plan = validateProductPlan(JSON.parse(bytes));
  const root = path.dirname(path.resolve(filename));
  for (const item of plan.packages) {
    for (const key of ["msi", "receipt"]) {
      const file = containedPath(root, item[key].file);
      await noAlias(file);
      const bytes = await readFile(file);
      assert.equal(sha(bytes), item[key].sha256, key + " digest mismatch");
      item[key].path = file;
      if (key === "receipt") item.contract = JSON.parse(bytes);
    }
    const c = item.contract;
    for (const key of ["productCode", "upgradeCode"])
      assert.match(
        c[key],
        /^[{]?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[}]?$/,
      );
    assert.equal(c.fixtureFamily, plan.family);
    assert.equal(c.directory, plan.directory);
    assert.equal(c.version, item.version);
    assert.equal(c.head, item.head);
    assert.equal(c.manifestSha256, c.fileHashes["build-manifest.json"]);
    for (const name of [
      "LocalAPI.exe",
      "build-manifest.json",
      "resources/app/package.json",
    ])
      assert.match(c.fileHashes[name], digestPattern);
    for (const name of Object.keys(c.fileHashes)) {
      // Inventory paths may have spaces/Unicode; never use them as write targets.
      assert.ok(
        !name.startsWith("/") &&
          !name.includes("\\") &&
          !name.split("/").includes(".."),
      );
      assert.match(c.fileHashes[name], digestPattern);
    }
  }
  assert.equal(
    plan.packages[0].contract.upgradeCode,
    plan.packages[1].contract.upgradeCode,
  );
  assert.notEqual(
    plan.packages[0].contract.productCode,
    plan.packages[1].contract.productCode,
  );
  if (plan.rollbackFixture !== undefined) {
    const fixture = plan.rollbackFixture;
    assert.equal(fixture.kind, "localapi-product-rollback-fixture-v1");
    for (const key of ["msi", "receipt"]) {
      assert.match(fixture[key].sha256, digestPattern);
      assert.ok(
        fixture[key].file.startsWith("faults/"),
        "Fault must be in dedicated test-only directory",
      );
      const file = containedPath(root, fixture[key].file);
      await noAlias(file);
      const bytes = await readFile(file);
      assert.equal(
        sha(bytes),
        fixture[key].sha256,
        "Fault artifact digest mismatch",
      );
      fixture[key].path = file;
      if (key === "receipt") fixture.contract = JSON.parse(bytes);
    }
    validateRollbackReceipt(
      fixture.contract,
      fixture,
      plan.packages[1],
      plan.family,
    );
  }
  return plan;
}
export function assertRuntimeIdentity(actual, expected) {
  assert.equal(actual.version, expected.version);
  assert.equal(
    path.resolve(actual.executable).toLowerCase(),
    path.resolve(expected.executable).toLowerCase(),
  );
  assert.equal(
    path.resolve(actual.userData).toLowerCase(),
    path.resolve(expected.userData).toLowerCase(),
  );
  assert.equal(
    path.resolve(actual.appPath).toLowerCase(),
    path.resolve(expected.appPath).toLowerCase(),
  );
}

export function validateRollbackReceipt(receipt, fixture, next, family) {
  assert.equal(receipt.kind, "localapi-product-rollback-fixture-v1");
  assert.equal(receipt.sourceMsiSha256, next.msi.sha256);
  assert.equal(fixture.sourceMsiSha256, next.msi.sha256);
  assert.equal(receipt.sourceReceiptSha256, next.receipt.sha256);
  assert.equal(receipt.msiSha256, fixture.msi.sha256);
  assert.equal(receipt.family, family);
  assert.equal(receipt.version, next.version);
  assert.equal(receipt.head, next.head);
  assert.equal(receipt.productCode, next.contract.productCode);
  assert.equal(receipt.allOtherTablesUnchanged, true);
  assert.equal(receipt.payloadUnchanged, true);
  assert.equal(receipt.nativeRollbackVerified, false);
  assert.match(receipt.cabinetSha256, digestPattern);
  assert.notEqual(receipt.originalPackageCode, receipt.faultPackageCode);
  for (const code of [receipt.originalPackageCode, receipt.faultPackageCode])
    assert.match(
      code,
      /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/,
    );
  assert.deepEqual(receipt.fault, {
    action: "ProductRollbackProbe",
    type: 19,
    condition: "OLDERPRODUCTS",
    sequence: 4001,
    message: "Deliberate full-product rollback probe after old product removal",
  });
}
export function assertProductRollbackLog(text) {
  const removal = text.search(
    /^Action ended [^\r\n]+: RemoveExistingProducts\. Return value 1\./m,
  );
  const faultStart = text.search(
    /^Action start [^\r\n]+: ProductRollbackProbe\./m,
  );
  const faultEnd = text.search(
    /^Action ended [^\r\n]+: ProductRollbackProbe\. Return value 3\./m,
  );
  assert.ok(
    removal >= 0 && faultStart > removal && faultEnd > faultStart,
    "Fault must occur after completed old-product removal",
  );
  assert.ok(
    text.includes(
      "Deliberate full-product rollback probe after old product removal",
    ),
    "Expected test-only failure message required",
  );
  assert.match(
    text.slice(faultEnd),
    /Executing op: RollbackInfo\(/,
    "Rollback activity evidence required",
  );
}

// Legacy Win32 budget, measured in UTF-16 code units (JS string length).
// Do not enable OS long paths or depend on an elevated/shorter user profile.
export function assertTargetPathBudget(target, contracts) {
  assert.match(target, /^[A-Za-z]:\\/);
  assert.ok(!target.includes("/"));
  const check = (name, directory = false) => {
    const parts = name.split("/");
    assert.ok(
      parts.every(
        (p) =>
          p.length &&
          p !== "." &&
          p !== ".." &&
          !/[\\:\x00-\x1f<>"|?*]/.test(p) &&
          !/[. ]$/.test(p),
      ),
      "Unsafe inventory path",
    );
    const destination = target + "\\" + parts.join("\\");
    assert.ok(
      destination.length <= (directory ? 247 : 259),
      "MSI target exceeds conservative Win32 UTF-16 path budget",
    );
    for (let i = 1; i < parts.length; i++)
      assert.ok(
        (target + "\\" + parts.slice(0, i).join("\\")).length <= 247,
        "MSI target directory exceeds conservative Win32 path budget",
      );
  };
  assert.ok(
    (target + ".retained-foreign").length <= 247,
    "Fixture root path too long",
  );
  for (const contract of contracts) {
    assert.ok(contract.fileHashes && Object.keys(contract.fileHashes).length);
    for (const name of Object.keys(contract.fileHashes)) check(name);
    assert.ok(Array.isArray(contract.directories));
    for (const name of contract.directories) check(name, true);
  }
  check("foreign-product-journey-sentinel.txt");
  assert.ok(
    (target + ".retained-foreign\\foreign-product-journey-sentinel.txt")
      .length <= 259,
    "Retained sentinel path exceeds Win32 budget",
  );
}
