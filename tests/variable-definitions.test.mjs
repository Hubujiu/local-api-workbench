import test from "node:test";
import assert from "node:assert/strict";
import { manageEnvironment } from "../src/environments.mjs";

const fixture = () => ({
  globalVariables: { shared: "legacy" },
  servers: [],
  environments: [
    { id: "e", name: "Environment", variables: { token: "legacy" } },
  ],
});

test("variable definitions preserve independent initial value and description when current values change", () => {
  const p = fixture();
  manageEnvironment(p, "upsert_environment_variable", {
    environmentId: "e",
    key: "token",
    initialValue: "initial",
    currentValue: "runtime",
    description: "Token description",
  });
  assert.equal(p.environments[0].variables.token, "runtime");
  assert.deepEqual(p.environments[0].variableDefinitions.token, {
    initialValue: "initial",
    description: "Token description",
  });
  manageEnvironment(p, "upsert_environment_variable", {
    environmentId: "e",
    key: "token",
    value: "legacy client update",
  });
  assert.equal(p.environments[0].variables.token, "legacy client update");
  assert.equal(
    p.environments[0].variableDefinitions.token.initialValue,
    "initial",
  );
  const read = manageEnvironment(p, "get_environment_variables", {
    environmentId: "e",
  });
  assert.equal(read.definitions.token.description, "Token description");
  manageEnvironment(p, "upsert_global_variable", {
    key: "shared",
    initialValue: 0,
    currentValue: false,
    description: "typed",
  });
  assert.equal(p.globalVariables.shared, false);
  assert.equal(p.globalVariableDefinitions.shared.initialValue, 0);
  manageEnvironment(p, "delete_global_variable", { key: "shared" });
  assert.equal(Object.hasOwn(p.globalVariableDefinitions, "shared"), false);
});

test("invalid variable-definition updates are atomic and do not silently accept ambiguous values", () => {
  const p = fixture();
  for (const args of [
    { key: "token", value: "old alias", currentValue: "ambiguous" },
    { key: "token", currentValue: "changed", description: 1 },
    { key: "token", initialValue: undefined },
  ]) {
    const before = structuredClone(p);
    assert.throws(() =>
      manageEnvironment(p, "upsert_environment_variable", {
        environmentId: "e",
        ...args,
      }),
    );
    assert.deepEqual(p, before);
  }
});

test("variable settings expose distinct environment and global editors", async () => {
  const { settingsPanel } = await import("../public/settings-view.js");
  const html = settingsPanel(
    { ...fixture(), settings: {} },
    "settings-environments",
  );
  assert.match(html, /data-edit-variable-definitions="e"/);
  assert.match(html, /id="edit-global-definitions"/);
});

test("variable rows retain typed initial values, distinguish missing current values, and reject duplicate names", async () => {
  const { variableRows, variableMapsFromRows } = await import(
    "../public/variable-definitions.js"
  );
  const initial = { items: [1] };
  const model = variableMapsFromRows([
    {
      key: "typed",
      initialValue: initial,
      currentSet: true,
      currentValue: initial,
      description: "structured",
    },
    {
      key: "unset",
      initialValue: 0,
      currentSet: false,
      description: "not inherited",
    },
  ]);
  model.values.typed.items.push(2);
  assert.deepEqual(model.definitions.typed.initialValue, { items: [1] });
  assert.equal(Object.hasOwn(model.values, "unset"), false);
  assert.equal(
    variableRows(model.values, model.definitions).find(
      (row) => row.key === "unset",
    ).currentSet,
    false,
  );
  assert.throws(
    () =>
      variableMapsFromRows([
        { key: "x", initialValue: "", currentSet: true, currentValue: "" },
        { key: "x", initialValue: "", currentSet: true, currentValue: "" },
      ]),
    /重复/,
  );
  assert.equal(variableRows({ legacy: "current" })[0].initialExplicit, false);
});
