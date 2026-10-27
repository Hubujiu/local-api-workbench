import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

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
function source() {
  const d = modernApipostFixture();
  d.global.marks = [];
  delete d.apis[1].mark_id;
  d.apis[1].response = { example: [] };
  d.global.global_param.auth = {
    type: "bearer",
    bearer: { key: "{{token}}" },
    basic: { username: "inactive", password: "must-not-retain" },
  };
  d.global.global_param.header.parameter = [
    { key: "X-Shared", value: "project", is_checked: 1 },
  ];
  d.apis[0].request.header = {
    parameter: [{ key: "X-Folder", value: "folder", is_checked: 1 }],
  };
  d.apis[1].request.header.parameter = [
    { key: "X-Shared", value: "disabled-child", is_checked: -1 },
  ];
  return d;
}

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
