import test from "node:test";
import assert from "node:assert/strict";
import { applySelectedFormFile } from "../public/form-file-selection.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const file = (name, promise) => ({ name, size: 1, arrayBuffer: () => promise });
test("late file reads cannot modify a different request or a removed form row", async () => {
  const d = deferred(),
    field = { value: "old" },
    before = { ...field };
  let current = true;
  const pending = applySelectedFormFile(
    file("old.bin", d.promise),
    field,
    () => current,
    () => assert.fail("must not render stale upload"),
  );
  current = false;
  d.resolve(new Uint8Array([1]).buffer);
  assert.equal(await pending, false);
  assert.deepEqual(field, before);
});
test("a newer selection wins even if the older file completes last", async () => {
  const a = deferred(),
    b = deferred(),
    field = {};
  let applied = 0;
  const first = applySelectedFormFile(
    file("a.bin", a.promise),
    field,
    () => true,
    () => applied++,
  );
  const second = applySelectedFormFile(
    file("b.bin", b.promise),
    field,
    () => true,
    () => applied++,
  );
  b.resolve(new Uint8Array([255]).buffer);
  assert.equal(await second, true);
  a.resolve(new Uint8Array([1]).buffer);
  assert.equal(await first, false);
  assert.equal(field.filename, "b.bin");
  assert.equal(field.value, "/w==");
  assert.equal(field.requiresFile, false);
  assert.equal(applied, 1);
});
test("oversized file reads cannot change existing data", async () => {
  const field = { value: "old" };
  await assert.rejects(
    () =>
      applySelectedFormFile(
        {
          name: "too-big",
          size: 7 * 1024 * 1024,
          arrayBuffer: () => assert.fail("must not read"),
        },
        field,
        () => true,
        () => {},
      ),
    /6 MiB/,
  );
  assert.equal(field.value, "old");
});

test("clearing a newer selection invalidates a pending read", async () => {
  const d = deferred(),
    field = { value: "saved" };
  const pending = applySelectedFormFile(
    file("old.bin", d.promise),
    field,
    () => true,
    () => assert.fail(),
  );
  assert.equal(
    await applySelectedFormFile(
      undefined,
      field,
      () => true,
      () => assert.fail(),
    ),
    false,
  );
  d.resolve(new Uint8Array([1]).buffer);
  assert.equal(await pending, false);
  assert.equal(field.value, "saved");
});
