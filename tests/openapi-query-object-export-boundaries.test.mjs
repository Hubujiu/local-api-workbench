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
  id: "query-object-project",
  name: "Query object export boundary",
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
  key: "filter",
  value: '{"role":"admin"}',
  schema: {
    type: "object",
    properties: { role: { type: "string" } },
    additionalProperties: false,
  },
  queryObjectSerialization: { version: 1, style: "form", explode: true },
  enabled,
});
const reject = (encode, p) => {
  const before = structuredClone(p);
  assert.throws(
    () => encode(p),
    /queryObjectSerialization|参数未知字段|OpenAPI Query对象/,
  );
  assert.deepEqual(p, before);
};
test("native JSON and directory refuse Query object contracts including disabled live definitions", () => {
  for (const encode of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => encode(project()));
    for (const enabled of [true, false]) {
      const p = project();
      p.requests[0].query = [row(enabled)];
      assert.doesNotThrow(() => normalizeRequest(p.requests[0]));
      reject(encode, p);
    }
  }
});
test("native serializers reject own Query object marker presence even with malformed or undefined metadata", () => {
  for (const encode of [exportApipost, exportApipostDirectory])
    for (const marker of [
      undefined,
      null,
      {},
      { version: 99, style: "form", explode: true },
    ])
      for (const enabled of [true, false]) {
        const p = project();
        p.requests[0].query = [
          {
            key: "q",
            value: "ordinary",
            schema: { type: "string" },
            enabled,
            queryObjectSerialization: marker,
          },
        ];
        reject(encode, p);
      }
});
test("native frozen samples and independent frozen plans refuse Query object contracts without losing them through plain live APIs", () => {
  const sample = project();
  sample.requests = [];
  importIntoProject(sample, nativeSampleExportFixture());
  for (const encode of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => encode(sample));
    for (const enabled of [true, false]) {
      const p = structuredClone(sample);
      p.cases[0].request.query = [row(enabled)];
      reject(encode, p);
    }
  }
  const plain = project();
  plain.environments = [{ id: "env", name: "Environment", variables: {} }];
  plain.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen query object",
      environmentId: "env",
      statusPolicy: "strict200",
      steps: [{ request: plain.requests[0] }],
    }),
  ];
  assert.doesNotThrow(() => exportApipostDirectory(plain));
  for (const enabled of [true, false]) {
    const p = structuredClone(plain);
    p.plans[0].steps[0].request.query = [row(enabled)];
    reject(exportApipostDirectory, p);
  }
});
