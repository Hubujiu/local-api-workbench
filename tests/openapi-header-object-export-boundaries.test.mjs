import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequest,
  snapshotPlan,
  importIntoProject,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";
const project = () => ({
  id: "header-object-project",
  name: "Header object export boundary",
  requests: [
    normalizeRequest({
      id: "api",
      name: "Request",
      url: "http://127.0.0.1:1/check",
    }),
  ],
  environments: [],
  settings: {},
  plans: [],
  cases: [],
});
const row = (enabled = true) => ({
  key: "X-Object",
  value: '{"role":"admin"}',
  schema: { type: "object" },
  headerSerialization: { version: 1, style: "simple", explode: true },
  enabled,
});
const reject = (encode, project) => {
  const before = structuredClone(project);
  assert.throws(() => encode(project), /headerSerialization|参数未知字段/);
  assert.deepEqual(project, before);
};
test("native JSON and directory cannot silently erase Header object wire metadata in live or disabled rows", () => {
  for (const encode of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => encode(project()));
    for (const enabled of [true, false]) {
      const p = project();
      p.requests[0].headers = [row(enabled)];
      assert.doesNotThrow(() => normalizeRequest(p.requests[0]));
      reject(encode, p);
    }
  }
});
test("native frozen samples and independent plans cannot lose Header object metadata through an unmarked live API", () => {
  const sample = project();
  sample.requests = [];
  importIntoProject(sample, nativeSampleExportFixture());
  for (const encode of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => encode(sample));
    const p = structuredClone(sample);
    p.cases[0].request.headers = [row()];
    reject(encode, p);
  }
  const p = project();
  p.environments = [{ id: "env", name: "Environment", variables: {} }];
  p.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen header object",
      environmentId: "env",
      statusPolicy: "strict200",
      steps: [{ request: p.requests[0] }],
    }),
  ];
  assert.doesNotThrow(() => exportApipostDirectory(p));
  p.plans[0].steps[0].request.headers = [row()];
  reject(exportApipostDirectory, p);
});
