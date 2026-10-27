import test from "node:test";
import assert from "node:assert/strict";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";
const blank = (id = "target") => ({
  id,
  name: id,
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  settings: {},
  globalVariables: {},
  plans: [],
});
const exporters = [exportApipost, exportApipostDirectory];
function semantic(p) {
  const copy = structuredClone(p);
  const plans = copy.plans.map(
    ({ id, createdAt, updatedAt, steps, ...rest }) => ({
      ...rest,
      steps: steps.map(({ id, ...step }) => {
        const payload = step.grpc ?? step.socketio;
        delete payload.definition.id;
        return step;
      }),
    }),
  );
  const defs = (key) =>
    (copy.settings[key] ?? []).map(({ id, ...rest }) => rest);
  return {
    grpc: defs("grpcDefinitions"),
    socketio: defs("socketioDefinitions"),
    plans,
  };
}
test("native extended protocol graph and exact derived messages roundtrip both formats twice", () => {
  const source = extendedProtocolFixture(),
    original = structuredClone(source),
    p = blank();
  importIntoProject(p, source);
  const before = structuredClone(p);
  for (const encode of exporters) {
    const output = encode(p),
      target = blank("second");
    importIntoProject(target, output);
    assert.deepEqual(semantic(target), semantic(p));
    const third = blank("third");
    importIntoProject(third, encode(target));
    assert.deepEqual(semantic(third), semantic(p));
  }
  assert.deepEqual(source, original);
  assert.deepEqual(p, before);
});

test("extended source ambiguity and all unrepresentable mutations reject without changing state", () => {
  const source = extendedProtocolFixture(),
    base = blank();
  importIntoProject(base, source);
  const mutations = [
    (p) => p.plans.pop(),
    (p) => p.plans.push({ ...structuredClone(p.plans[0]), id: "extra" }),
    (p) => (p.plans[0].steps[0].enabled = false),
    (p) => (p.plans[0].environmentId = "changed"),
    (p) => (p.plans[0].source = "ai"),
    (p) => (p.plans[0].steps[0].socketio.commands[0].args = ["changed"]),
    (p) => (p.settings.grpcDefinitions[0].target = "grpc://127.0.0.1:9"),
    (p) => (p.settings.apipostProtocolSources[0].source.parent_id = "unknown"),
    (p) =>
      (p.settings.apipostProtocolSources[0].source.url = "https://localhost/"),
    (p) => p.settings.apipostProtocolSources[0].notes.push("edited"),
    (p) =>
      p.settings.apipostProtocolSources[1].source.protos[0].services[0].methods[0].request.metadata.parameter.push(
        { key: "authorization", is_checked: -1 },
      ),
  ];
  for (const change of mutations)
    for (const encode of exporters) {
      const p = structuredClone(base);
      change(p);
      const before = structuredClone(p);
      assert.throws(() => encode(p));
      assert.deepEqual(p, before);
    }
  const a = structuredClone(source.apis[1]),
    b = structuredClone(a);
  a.target_id = "a:b";
  a.protos[0].services[0].methods[0].grpc_method_id = "c";
  b.target_id = "a";
  b.protos[0].services[0].methods[0].grpc_method_id = "b:c";
  const collision = blank();
  importIntoProject(collision, { ...source, apis: [a, b] });
  assert.equal(collision.settings.grpcDefinitions.length, 1);
  for (const encode of exporters)
    assert.throws(() => encode(collision), /身份冲突/);
});

test("source and plan accessors reject before invocation", () => {
  for (const target of ["source", "steps", "type"]) {
    const p = blank();
    importIntoProject(p, extendedProtocolFixture());
    let calls = 0;
    const object =
      target === "source"
        ? p.settings.apipostProtocolSources[0]
        : target === "steps"
          ? p.plans[0]
          : p.plans[0].steps[0];
    const value = object[target];
    Object.defineProperty(object, target, {
      enumerable: true,
      get() {
        calls++;
        return value;
      },
    });
    for (const encode of exporters) assert.throws(() => encode(p));
    assert.equal(calls, 0);
  }
});

test("empty protocol messages and multiple source namespaces remain complete; TLS and stripped credentials reject", () => {
  for (const alter of [
    (s) => {
      s.apis[0].message = [];
      s.apis[1].protos[0].services[0].methods[0].request.message = [];
    },
    (s) => {
      s.project_id = "other-source";
      for (const n of s.apis) n.project_id = s.project_id;
    },
  ]) {
    const source = extendedProtocolFixture();
    alter(source);
    const p = blank();
    if (source.project_id === "other-source")
      importIntoProject(p, extendedProtocolFixture());
    importIntoProject(p, source);
    for (const encode of exporters) {
      const q = blank();
      importIntoProject(q, encode(p));
      assert.deepEqual(semantic(q), semantic(p));
    }
  }
  for (const alter of [
    (s) => {
      s.apis[0].url = "https://localhost";
    },
    (s) => {
      const m = s.apis[1].protos[0].services[0].methods[0];
      m.tls = 1;
      m.ssl = 1;
    },
    (s) =>
      s.apis[0].request.header.parameter.push({
        key: "authorization",
        value: "fictional-secret",
        is_checked: 1,
      }),
    (s) =>
      s.apis[1].protos[0].services[0].methods[0].request.metadata.parameter.push(
        { key: "authorization", value: "fictional-secret", is_checked: -1 },
      ),
  ]) {
    const source = extendedProtocolFixture();
    alter(source);
    const p = blank();
    importIntoProject(p, source);
    for (const encode of exporters) assert.throws(() => encode(p));
  }
});

test("directory keeps ordinary HTTP flows separate from exact protocol message plans", () => {
  const p = blank("mixed");
  importIntoProject(p, extendedProtocolFixture());
  p.environments.push({
    id: "env-one",
    name: "one",
    variables: {},
    serviceUrls: {},
  });
  const request = normalizeRequest({
    id: "http-one",
    name: "HTTP remains",
    method: "GET",
    url: "http://127.0.0.1:8/path",
    auth: { type: "none" },
  });
  p.requests.push(request);
  p.plans.push(
    snapshotPlan({
      id: "flow-one",
      name: "ordinary HTTP",
      environmentId: "env-one",
      statusPolicy: "strict200",
      steps: [{ id: "http-step", request }],
    }),
  );
  const before = structuredClone(p);
  assert.throws(() => exportApipost(p), /plans/);
  const next = blank();
  importIntoProject(next, exportApipostDirectory(p));
  assert.equal(next.plans.length, 3);
  assert.deepEqual(next.plans.map((p) => p.steps[0].type ?? "http").sort(), [
    "grpc",
    "http",
    "socketio",
  ]);
  assert.equal(
    next.plans.find((p) => !p.steps[0].type).steps[0].request.url,
    request.url,
  );
  assert.deepEqual(p, before);
});

test("projects without extended protocols retain the original absent-plan default", () => {
  const p = blank();
  delete p.plans;
  for (const encode of exporters) {
    const q = blank();
    importIntoProject(q, encode(p));
    assert.equal(q.plans.length, 0);
  }
  assert.equal(Object.hasOwn(p, "plans"), false);
});

test("extended collection and ordinary-plan identity accessors are not invoked", () => {
  for (const key of [
    "apipostProtocolSources",
    "grpcDefinitions",
    "socketioDefinitions",
    "id",
  ]) {
    const p = blank();
    importIntoProject(p, extendedProtocolFixture());
    let calls = 0;
    let object = p.settings;
    if (key === "id") {
      const flow = snapshotPlan({
        id: "ordinary",
        steps: [{ request: normalizeRequest({ url: "http://localhost" }) }],
      });
      p.plans.push(flow);
      object = flow;
    }
    const value = object[key];
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        calls++;
        return value;
      },
    });
    for (const encode of exporters) assert.throws(() => encode(p));
    assert.equal(calls, 0);
  }
});
