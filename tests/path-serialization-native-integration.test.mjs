// Root-only exporter combinations. Authored with syntax/format checks only;
// ordinary CI exercises actual project/native exporter modules.
import test from "node:test";
import assert from "node:assert/strict";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";

const row = (style = "matrix", value = "blue", explode = false) => ({
  key: "color",
  value,
  required: true,
  enabled: true,
  schema: { type: "string" },
  pathSerialization: { version: 1, style, explode },
});
const project = () => ({
  id: "path-scalar-native",
  name: "Path serialization native boundary",
  requests: [
    normalizeRequest({
      id: "api",
      name: "Plain HTTP",
      url: "http://127.0.0.1:1/object/{color}",
      path: [
        {
          key: "color",
          value: "blue",
          required: true,
          enabled: true,
          schema: { type: "string" },
        },
      ],
    }),
  ],
  environments: [],
  folders: [],
  servers: [],
  settings: {},
  cases: [],
  caseFolders: [],
  plans: [],
});
const formats = [exportApipost, exportApipostDirectory];
const validRows = () => [
  ...["simple", "label", "matrix"].flatMap((style) => [
    row(style),
    row(style, "blue", true),
  ]),
  // Empty stored value is the feature's unbound definition, not a wire value.
  row("matrix", ""),
];
const rejectedRows = () => [
  ...[
    undefined,
    null,
    false,
    0,
    "",
    [],
    {},
    { version: 2, style: "matrix", explode: false },
  ].map((marker) => ({
    ...row(),
    pathSerialization: marker,
  })),
  // Disabled required path parameters are excluded by the feature admission
  // contract; direct nonpersisted input must not slip through native export.
  { ...row(), enabled: false },
];
function rejectsWithoutMutation(encode, input, valid = false) {
  const before = structuredClone(input);
  assert.throws(
    () => encode(input),
    valid ? /pathSerialization|path serialization|参数未知字段/i : Error,
  );
  assert.deepEqual(input, before);
}

test("native JSON and directory reject valid scalar path markers, including unbound definitions, while unmarked rows remain exportable", () => {
  for (const encode of formats) {
    assert.doesNotThrow(() => encode(project()));
    for (const value of validRows()) {
      const input = project();
      input.requests[0].path = [value];
      assert.doesNotThrow(() => normalizeRequest(input.requests[0]));
      rejectsWithoutMutation(encode, input, true);
    }
  }
});

test("native JSON and directory reject own path marker presence even when undefined, malformed, disabled or misplaced", () => {
  for (const encode of formats) {
    for (const value of rejectedRows()) {
      assert.equal(Object.hasOwn(value, "pathSerialization"), true);
      const input = project();
      input.requests[0].path = [value];
      rejectsWithoutMutation(encode, input);
    }
    const input = project();
    input.requests[0].query = [row()];
    rejectsWithoutMutation(encode, input);
  }
});

test("native JSON and directory reject scalar path markers confined to frozen samples, not only live API rows", () => {
  const baseline = project();
  baseline.requests = [];
  importIntoProject(baseline, nativeSampleExportFixture());
  for (const encode of formats) {
    assert.doesNotThrow(() => encode(baseline));
    for (const value of [...validRows(), ...rejectedRows()]) {
      const input = structuredClone(baseline);
      const snapshot = input.cases[0].request;
      snapshot.url += "/{color}";
      snapshot.path = [value];
      const valid =
        value.enabled !== false && value.pathSerialization?.version === 1;
      if (valid) assert.doesNotThrow(() => normalizeRequest(snapshot));
      assert.equal(
        input.requests.some((request) =>
          request.path.some((item) => Object.hasOwn(item, "pathSerialization")),
        ),
        false,
      );
      rejectsWithoutMutation(encode, input, valid);
    }
  }
});

test("native directory rejects scalar path markers confined to independent frozen plan snapshots", () => {
  const baseline = project();
  baseline.environments = [{ id: "env", name: "Environment", variables: {} }];
  baseline.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen path native boundary",
      environmentId: "env",
      statusPolicy: "strict200",
      steps: [{ request: baseline.requests[0] }],
    }),
  ];
  assert.doesNotThrow(() => exportApipostDirectory(baseline));
  for (const value of [...validRows(), ...rejectedRows()]) {
    const input = structuredClone(baseline);
    input.plans[0].steps[0].request.path = [value];
    const valid =
      value.enabled !== false && value.pathSerialization?.version === 1;
    if (valid)
      assert.doesNotThrow(() =>
        normalizeRequest(input.plans[0].steps[0].request),
      );
    assert.equal(
      Object.hasOwn(input.requests[0].path[0], "pathSerialization"),
      false,
    );
    rejectsWithoutMutation(exportApipostDirectory, input, valid);
  }
});
