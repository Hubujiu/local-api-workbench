import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
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
