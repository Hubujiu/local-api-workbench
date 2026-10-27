import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { nativeInheritanceFixture as source } from "./fixtures/native-inheritance.mjs";

const empty = (id = "target") => ({
  id,
  name: id,
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: {},
  plans: [],
  cases: [],
  documents: [],
});

test("preserve imports own definitions and resolves the active graph without changing default flatten", () => {
  const d = source(),
    before = structuredClone(d),
    p = empty(),
    old = empty("old");
  importIntoProject(old, d);
  assert.equal(old.settings.nativeInheritance, undefined);
  assert(old.requests[0].headers.some((r) => r.key === "X-Folder"));
  importIntoProject(p, d, { inheritanceMode: "preserve" });
  assert.equal(p.settings.nativeInheritance.version, 1);
  assert.equal(p.requests[0].nativeInheritance.authMode, "inherit");
  assert.deepEqual(
    p.requests[0].headers.map((r) => r.key),
    ["X-Shared"],
  );
  const effective = freezeServiceBinding(p, p.requests[0]);
  assert.equal(effective.nativeInheritance, undefined);
  assert.equal(effective.auth.type, "bearer");
  assert(effective.headers.some((r) => r.key === "X-Folder"));
  assert(
    effective.headers.some(
      (r) => r.key === "X-Shared" && r.value === "project" && r.enabled,
    ),
  );
  assert.equal(JSON.stringify(p).includes("must-not-retain"), false);
  assert.deepEqual(d, before);
});

test("preserve refuses nonempty targets and unknown modes without partial import", () => {
  for (const update of [
    (p) => {
      p.globalVariables.existing = "value";
    },
    (p) => {
      p.settings.globalAuth = { type: "bearer", token: "fictional" };
    },
    (p) => {
      p.folders = ["existing"];
    },
  ]) {
    const p = empty();
    update(p);
    const before = structuredClone(p);
    assert.throws(
      () => importIntoProject(p, source(), { inheritanceMode: "preserve" }),
      /空项目/,
    );
    assert.deepEqual(p, before);
  }
  assert.throws(
    () => importIntoProject(empty(), source(), { inheritanceMode: "guess" }),
    /inheritanceMode/,
  );
});

// The graph's source identities are deliberately rebased by each native export.
// Compare the editable layers and effective definitions, not those generated IDs.
test("both native formats preserve layered intent over two generations", async () => {
  const { exportApipost } = await import("../src/apipost-export.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  for (const encode of [exportApipost, exportApipostDirectory]) {
    let p = empty("first");
    importIntoProject(p, source(), { inheritanceMode: "preserve" });
    for (let i = 0; i < 2; i++) {
      const original = structuredClone(p);
      const document = encode(p);
      assert.deepEqual(p, original);
      const next = empty("generation" + i);
      importIntoProject(next, document, { inheritanceMode: "preserve" });
      assert.deepEqual(
        next.settings.nativeInheritance.projectLayer,
        p.settings.nativeInheritance.projectLayer,
      );
      assert.deepEqual(
        next.settings.nativeInheritance.folders.map((f) => f.layer),
        p.settings.nativeInheritance.folders.map((f) => f.layer),
      );
      assert.equal(next.requests[0].nativeInheritance.authMode, "inherit");
      assert.deepEqual(next.requests[0].headers, p.requests[0].headers);
      assert.equal(
        freezeServiceBinding(next, next.requests[0]).auth.type,
        "bearer",
      );
      p = next;
    }
  }
});
