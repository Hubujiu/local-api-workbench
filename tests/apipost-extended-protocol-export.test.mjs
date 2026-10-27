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
