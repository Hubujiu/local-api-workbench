import test from "node:test";
import assert from "node:assert/strict";
import { executeNativeEnvironmentTool } from "../src/native-mcp-environments.mjs";

// Inspected pure module closure only; fake save captures JSON state, without
// Store, application, transport, database or script-runtime imports.
function fixture(scope) {
  const project = {
    id: "project",
    environments: [{ id: "env", name: "Env", variables: {} }],
  };
  let saved,
    saves = 0;
  const store = {
    save: async (value) => {
      saved = structuredClone(value);
      saves++;
    },
  };
  const upsert = (args) =>
    executeNativeEnvironmentTool(
      store,
      project,
      "upsert_" + scope + "_variable",
      {
        ...(scope === "environment" ? { environment_id: "env" } : {}),
        ...args,
      },
    );
  const state = () =>
    scope === "global"
      ? {
          values: saved.globalVariables,
          definitions: saved.globalVariableDefinitions,
        }
      : {
          values: saved.environments[0].variables,
          definitions: saved.environments[0].variableDefinitions,
        };
  return { project, upsert, state, count: () => saves };
}

for (const scope of ["global", "environment"])
  test(`native ${scope} omitted variable fields preserve explicit JSON null and other falsy values`, async () => {
    const f = fixture(scope);
    for (const [initial, current] of [
      [null, null],
      ["initial", null],
      [null, "current"],
      [false, 0],
      ["", ""],
    ]) {
      const key = "value";
      await f.upsert({ key, value: initial, current_value: current });
      for (const patch of [{ description: "metadata only" }, {}]) {
        const result = await f.upsert({ key, ...patch });
        assert.deepEqual(f.state().values[key], current);
        assert.deepEqual(f.state().definitions[key].initialValue, initial);
        assert.deepEqual(result.variable.value, initial ?? "");
        assert.deepEqual(result.variable.current_value, current ?? "");
      }
      await f.upsert({ key, value: null });
      assert.equal(f.state().definitions[key].initialValue, null);
      assert.deepEqual(f.state().values[key], current);
      await f.upsert({ key, current_value: null });
      assert.equal(f.state().values[key], null);
      assert.equal(f.state().definitions[key].initialValue, null);
    }
  });

test("native variable absent/new/legacy fallback and null rendering remain unchanged", async () => {
  const f = fixture("global");
  await f.upsert({ key: "new", value: "initial only" });
  assert.equal(f.state().values.new, "");
  f.project.globalVariables.legacy = null;
  await f.upsert({ key: "legacy", description: "no initial value inferred" });
  assert.equal(f.state().definitions.legacy.initialValue, "");
  assert.equal(f.state().values.legacy, null);
  f.project.globalVariableDefinitions.unset = {
    initialValue: "existing fallback",
    description: "",
  };
  await f.upsert({ key: "unset", description: "retain legacy unset policy" });
  assert.equal(f.state().values.unset, "existing fallback");
  f.project.globalVariableDefinitions.unsetNull = {
    initialValue: null,
    description: "",
  };
  await f.upsert({
    key: "unsetNull",
    description: "retain null fallback policy",
  });
  assert.equal(f.state().definitions.unsetNull.initialValue, null);
  assert.equal(f.state().values.unsetNull, "");
});

test("invalid native partial updates never publish changed variable state", async () => {
  for (const scope of ["global", "environment"]) {
    const f = fixture(scope);
    await f.upsert({ key: "value", value: null, current_value: null });
    const before = structuredClone(f.state()),
      count = f.count();
    for (const args of [
      { key: "value", value: "must not save", description: 5 },
      { key: "value", current_value: undefined },
      { key: " __proto__ ", value: "must not save" },
    ]) {
      await assert.rejects(f.upsert(args));
      assert.deepEqual(f.state(), before);
      assert.equal(f.count(), count);
    }
  }
});
