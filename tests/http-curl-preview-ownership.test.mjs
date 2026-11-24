import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("  async function openCurlPreview(");
const end = source.indexOf(
  '  on("#import,#welcome-import,#project-menu-import",',
  start,
);
assert.ok(start >= 0 && end > start);
const wire = new Function("e", `with (e) { ${source.slice(start, end)} }`);

function fixture() {
  const a = { id: "same-id", url: "https://fixture.invalid/a" };
  const b = { id: "other", url: "https://fixture.invalid/b" };
  const original = { id: "owner-a", requests: [a, b] };
  const calls = [],
    shown = [],
    copies = [];
  const dialog = { open: false },
    drawer = { open: false };
  let active;
  const e = {
    project: original,
    current: a,
    environment: "empty",
    page: "apis",
    mode: "debug",
    document: null,
    editVersion: 0,
    projectOpenRequestSequence: 0,
    modalRevision: 0,
    $: (s) => {
      assert.ok(["#dialog", "#curl-preview-dialog"].includes(s));
      return s === "#dialog" ? dialog : drawer;
    },
    collect: () => {},
    request: () => e.current,
    env: () => e.environment,
    workspaceDocument: () => e.document,
    on: (s, event, handler) => {
      assert.equal(s, "#curl");
      assert.equal(event, "click");
      e.handler = handler;
    },
    api: (path, method, data) =>
      new Promise((resolve, reject) => {
        calls.push({
          path,
          method,
          data: structuredClone(data),
          resolve,
          reject,
        });
      }),
    toast: () => assert.fail("no unrelated toast"),
    curlPreview: {
      open(target, opener, owns, copy) {
        assert.equal(target, drawer);
        if (active || !owns()) return;
        const entry = (active = { copy, owns });
        drawer.open = true;
        const current = () => active === entry && owns();
        return {
          deliver(value) {
            if (current()) shown.push(value);
          },
          fail(error) {
            if (current()) shown.push(error.message);
          },
        };
      },
    },
    navigator: { clipboard: { writeText: (text) => copies.push(text) } },
  };
  wire(e);
  const opener = { isConnected: true };
  return {
    a,
    b,
    e,
    calls,
    dialog,
    drawer,
    opener,
    copies,
    shown,
    run: () => e.handler({}, opener),
    close: () => {
      active = undefined;
      drawer.open = false;
    },
  };
}

test("owned local compilation opens immediately and produces exact text without copying", async () => {
  const f = fixture(),
    pending = f.run();
  assert.equal(f.drawer.open, true);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(
    { path: f.calls[0].path, method: f.calls[0].method, data: f.calls[0].data },
    {
      path: "/projects/owner-a/curl",
      method: "POST",
      data: { request: f.a, environmentId: "empty" },
    },
  );
  const literal = "synthetic <literal>\nspacing preserved ";
  f.calls[0].resolve({ curl: literal });
  await pending;
  assert.deepEqual(f.shown, [literal]);
  assert.deepEqual(f.copies, []);
});

const transitions = {
  "another request": (f) => (f.e.current = f.b),
  "same request ID in another project": (f) => {
    f.e.current = { ...f.a };
    f.e.project = { id: "owner-b", requests: [f.e.current] };
  },
  "reload of the same project ID": (f) => {
    f.e.current = { ...f.a };
    f.e.project = { id: f.e.project.id, requests: [f.e.current] };
  },
  "a newer project open intent before adoption": (f) =>
    f.e.projectOpenRequestSequence++,
  "an environment switch": (f) => (f.e.environment = "another-empty-env"),
  "a mode switch": (f) => (f.e.mode = "design"),
  "a route switch": (f) => (f.e.page = "settings"),
  "a document": (f) => (f.e.document = { id: "doc" }),
  "an intervening edit": (f) => f.e.editVersion++,
  "a replaced opener": (f) => (f.opener.isConnected = false),
  "an intervening dialog revision": (f) => f.e.modalRevision++,
};
for (const [name, change] of Object.entries(transitions)) {
  test(`drops a receipt or error after ${name}`, async () => {
    for (const fail of [false, true]) {
      const f = fixture(),
        pending = f.run();
      change(f);
      if (fail) f.calls[0].reject(Error("synthetic compilation error"));
      else f.calls[0].resolve({ curl: "stale synthetic text" });
      await pending;
      assert.deepEqual(f.shown, []);
      assert.deepEqual(f.copies, []);
    }
  });
}

test("closing and reopening admits only the latest output or error", async () => {
  for (const fail of [false, true]) {
    const f = fixture(),
      first = f.run();
    await f.run();
    assert.equal(
      f.calls.length,
      1,
      "duplicate open cannot issue another local compile",
    );
    f.close();
    const second = f.run();
    if (fail) f.calls[1].reject(Error("synthetic latest error"));
    else f.calls[1].resolve({ curl: "new" });
    await second;
    f.calls[0].resolve({ curl: "old" });
    await first;
    assert.deepEqual(f.shown, [fail ? "synthetic latest error" : "new"]);
    assert.deepEqual(f.copies, []);
  }
});

test("detached controls and a different open dialog cannot start generation", async () => {
  const f = fixture();
  f.dialog.open = true;
  await f.run();
  f.dialog.open = false;
  f.opener.isConnected = false;
  await f.run();
  assert.deepEqual(f.calls, []);
});
