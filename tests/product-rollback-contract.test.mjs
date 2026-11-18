import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProductRollbackLog,
  validateRollbackReceipt,
} from "./helpers/installed-product-contract.mjs";
const next = {
  version: "0.1.1",
  head: "a".repeat(40),
  msi: { sha256: "b".repeat(64) },
  receipt: { sha256: "c".repeat(64) },
  contract: { productCode: "new-product" },
};
const fixture = {
  sourceMsiSha256: next.msi.sha256,
  msi: { sha256: "d".repeat(64) },
};
const family = "11111111-1111-4111-8111-111111111111";
const receipt = () => ({
  kind: "localapi-product-rollback-fixture-v1",
  sourceMsiSha256: next.msi.sha256,
  sourceReceiptSha256: next.receipt.sha256,
  msiSha256: fixture.msi.sha256,
  family,
  version: next.version,
  head: next.head,
  productCode: next.contract.productCode,
  allOtherTablesUnchanged: true,
  payloadUnchanged: true,
  nativeRollbackVerified: false,
  cabinetSha256: "e".repeat(64),
  originalPackageCode: "{11111111-1111-4111-8111-111111111111}",
  faultPackageCode: "{22222222-2222-4222-8222-222222222222}",
  fault: {
    action: "ProductRollbackProbe",
    type: 19,
    condition: "OLDERPRODUCTS",
    sequence: 4001,
    message: "Deliberate full-product rollback probe after old product removal",
  },
});
test("fault receipt binds exact new MSI/payload/identity with distinct cache identity", () =>
  validateRollbackReceipt(receipt(), fixture, next, family));
for (const [name, value] of Object.entries({
  sourceMsiSha256: "f".repeat(64),
  sourceReceiptSha256: "f".repeat(64),
  msiSha256: "f".repeat(64),
  family: "other",
  version: "0.1.0",
  head: "f".repeat(40),
  productCode: "old",
  allOtherTablesUnchanged: false,
  payloadUnchanged: false,
  nativeRollbackVerified: true,
  cabinetSha256: "invalid",
}))
  test("reject changed " + name, () =>
    assert.throws(() =>
      validateRollbackReceipt(
        { ...receipt(), [name]: value },
        fixture,
        next,
        family,
      ),
    ),
  );
test("reject different fault boundary or cache identity", () => {
  const r = receipt();
  r.fault.sequence = 1500;
  assert.throws(() => validateRollbackReceipt(r, fixture, next, family));
  const cached = receipt();
  cached.faultPackageCode = cached.originalPackageCode;
  assert.throws(() => validateRollbackReceipt(cached, fixture, next, family));
});
const removed = "Action ended 3:21:00: RemoveExistingProducts. Return value 1.";
const start = "Action start 3:21:00: ProductRollbackProbe.";
const end = "Action ended 3:21:00: ProductRollbackProbe. Return value 3.";
const message =
  "Deliberate full-product rollback probe after old product removal";
const rolling =
  "MSI (s): Executing op: RollbackInfo(,RollbackAction=Rollback,)";
test("require actual post-removal failure and rollback execution, not policy text", () => {
  assertProductRollbackLog([removed, start, message, end, rolling].join("\n"));
  for (const text of [
    [start, removed, message, end, rolling],
    [removed, start, message, end, "DisableRollback=0"],
    [removed, start, end, rolling],
    [removed, start, message, end.replace("3.", "1."), rolling],
    [start, message, end, rolling],
  ])
    assert.throws(() => assertProductRollbackLog(text.join("\n")));
});
