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
    (p) => {
      p.environments = [{ id: "prod", name: "Production", variables: {} }];
    },
    (p) => {
      p.environments = [
        {
          id: "default",
          name: "默认环境",
          variables: { baseUrl: "http://127.0.0.1:4318" },
          description: "owned metadata",
        },
      ];
    },
    (p) => {
      p.environments = [{ id: "default", name: "默认环境", variables: {} }];
    },
    (p) => {
      p.currentEnvironmentId = "missing";
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
  const preserved = empty();
  importIntoProject(preserved, source(), { inheritanceMode: "preserve" });
  const snapshot = structuredClone(preserved);
  for (const mode of [undefined, "flatten", "preserve"])
    assert.throws(
      () => importIntoProject(preserved, source(), { inheritanceMode: mode }),
      /追加导入/,
    );
  assert.deepEqual(preserved, snapshot);
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

test("nested graph keeps absent/inherit/noauth/own and disabled child intentions, rejecting unsupported source graphs atomically", async () => {
  const { exportApipost } = await import("../src/apipost-export.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  const d = source();
  d.apis.push({
    target_id: "nested",
    target_type: "folder",
    name: "Nested",
    parent_id: "folder",
    request: {
      auth: {
        type: "basic",
        basic: { username: "fictional", password: "not-real" },
      },
      query: { parameter: [{ key: "q", value: "parent", is_checked: 1 }] },
    },
  });
  const api = structuredClone(d.apis[1]);
  d.apis[1].parent_id = "nested";
  d.apis[1].request.query.parameter[0].is_checked = -1;
  for (const [target_id, auth] of [
    ["absent", undefined],
    ["none", { type: "noauth" }],
    ["own", { type: "bearer", bearer: { key: "own-token" } }],
  ]) {
    const r = structuredClone(api);
    r.target_id = target_id;
    r.name = target_id;
    r.parent_id = "nested";
    if (auth) r.request.auth = auth;
    else delete r.request.auth;
    d.apis.push(r);
  }
  const p = empty();
  importIntoProject(p, d, { inheritanceMode: "preserve" });
  assert.deepEqual(p.folders, ["Group", "Group/Nested"]);
  const effective = p.requests.map((r) => freezeServiceBinding(p, r));
  assert.deepEqual(
    effective.map((r) => r.auth.type),
    ["basic", "basic", "none", "bearer"],
  );
  assert(
    effective[0].query.some(
      (r) => r.key === "q" && r.value === "parent" && r.enabled,
    ),
  );
  assert(
    effective[0].query.some(
      (r) => r.key === "q" && r.value === "one" && !r.enabled,
    ),
  );
  for (const encode of [exportApipost, exportApipostDirectory]) {
    const next = empty("next");
    importIntoProject(next, encode(p), { inheritanceMode: "preserve" });
    assert.deepEqual(
      next.requests.map((r) => r.nativeInheritance.authMode),
      ["inherit", "absent", "none", "own"],
    );
    assert.deepEqual(
      next.requests.map((r) => freezeServiceBinding(next, r).auth),
      effective.map((r) => r.auth),
    );
  }
  for (const change of [
    (x) => {
      x.apis[0].parent_id = "nested";
    },
    (x) => {
      x.apis[1].project_id = "foreign";
    },
    (x) => {
      x.apis[1].request.body = {
        mode: "form-data",
        parameter: [
          {
            key: "file",
            value: "fictional.bin",
            field_type: "file",
            type: "file",
          },
        ],
      };
    },
    (x) => {
      x.apis[0].variables = { invented: "not supported" };
    },
    (x) => {
      x.apis[1].target_id = "folder";
    },
    (x) => {
      x.apis[1].request.header.parameter.push({
        key: "x-shared",
        value: "ambiguous",
      });
    },
    (x) => {
      x.global.global_param.body = { mode: "json", raw: "{}" };
    },
    (x) => {
      x.apis[0].request.pre_tasks = [
        { id: "task", type: "customScript", data: "not executed" },
      ];
    },
    (x) => {
      x.apis[0].request.header.parameter[0].is_system = 1;
    },
  ]) {
    const invalid = structuredClone(d);
    change(invalid);
    const target = empty(),
      before = structuredClone(target);
    assert.throws(() =>
      importIntoProject(target, invalid, { inheritanceMode: "preserve" }),
    );
    assert.deepEqual(target, before);
  }
});
