// Audited pure graph/context/projection helpers only; no app, VM or transport.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRepeatGraph, planOccurrences } from "../src/plan-repeat.mjs";
import { validateWireScriptBinding } from "../src/wire-script-context.mjs";
import {
  assertNativeHTTPPlan,
  assertNativeHTTPResult,
} from "../src/native-mcp-http-shape.mjs";

import { validatePlanProtocolScripts } from "../src/wire-script-context.mjs";

const scripts = { version: 1, before: "apt.setVar('value',1);", after: "" };
const graph = () => [
  {
    id: "outer",
    type: "repeat",
    count: 2,
    steps: [
      {
        id: "inner",
        type: "repeat",
        count: 2,
        steps: [
          {
            id: "rpc",
            type: "protocol",
            protocolScripts: structuredClone(scripts),
            protocol: {
              definition: { type: "tcp", url: "127.0.0.1", port: 50051 },
              message: "fixture",
            },
          },
        ],
      },
    ],
  },
];

test("nested protocolScripts admission preserves occurrence identities without expanding other leaf capabilities", () => {
  const steps = graph(),
    before = structuredClone(steps);
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  const occurrences = planOccurrences(steps);
  assert.equal(occurrences.length, 4);
  assert.equal(
    new Set(occurrences.map(({ repeat }) => repeat.occurrenceId)).size,
    4,
  );
  assert(
    occurrences.every(
      ({ step }) => step.id === "rpc" && step.protocolScripts.version === 1,
    ),
  );
  assert.deepEqual(steps, before);
  for (const type of ["http", "grpc", "socketio"]) {
    const bad = graph();
    bad[0].steps[0].steps[0] =
      type === "http"
        ? {
            id: "other",
            request: { url: "http://fixture.invalid" },
            protocolScripts: scripts,
          }
        : {
            id: "other",
            type,
            [type]: { definition: {} },
            protocolScripts: scripts,
          };
    assert.throws(() => validateRepeatGraph(bad), /未知/);
  }
  for (const enabled of [true, false]) {
    const bad = graph();
    bad[0].enabled = enabled;
    bad[0].protocolScripts = scripts;
    assert.throws(() => validateRepeatGraph(bad), /未知/);
  }
});

test("wire host and worker binding excludes root-only collection and native task capabilities", () => {
  const input = {
    allowNetwork: false,
    request: { id: "rpc", name: "rpc" },
    scopes: {
      globals: {},
      environment: {},
      runtime: {},
      hidden: [],
    },
  };
  assert.doesNotThrow(() => validateWireScriptBinding(input, 0));
  for (const key of ["collectionId", "collection", "collectionTypes"])
    assert.throws(
      () =>
        validateWireScriptBinding(
          { ...input, scopes: { ...input.scopes, [key]: {} } },
          0,
        ),
      /协议/,
    );
  for (const key of [
    "cookieSession",
    "databaseQuery",
    "nativeWrite",
    "nativePhase",
    "databaseOrdinals",
    "nativeWaits",
    "responseAssertions",
    "responseExtractions",
    "requestSnapshot",
    "databaseOperations",
    "databaseTaskCount",
    "responseHeaderEvidence",
    "responseCookieEvidence",
  ]) {
    for (const value of [null, 0, [], {}])
      assert.throws(
        () => validateWireScriptBinding(input, 0, { [key]: value }),
        /协议/,
      );
    assert.doesNotThrow(() =>
      validateWireScriptBinding(input, 0, { [key]: undefined }),
    );
  }
});

test("native HTTP projection rejects protocolScripts by presence without inspecting application data", () => {
  const request = {
    url: "http://fixture.invalid",
    body: '{"protocolScripts":{"version":1}}',
  };
  assert.doesNotThrow(() => assertNativeHTTPPlan({ steps: [{ request }] }));
  assert.doesNotThrow(() => assertNativeHTTPResult({ results: [{ request }] }));
  for (const value of [
    undefined,
    null,
    {},
    { version: 1, before: "", after: "" },
  ]) {
    const step = { request, protocolScripts: value };
    assert.throws(() => assertNativeHTTPPlan({ steps: [step] }), /仅支持HTTP/);
    for (const run of [
      { protocolScripts: value },
      { results: [step] },
      { snapshot: { steps: [step] } },
    ])
      assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
  }
});

test("scripted wire authority preflight is active-only without skipping disabled static validation", () => {
  const steps = graph();
  assert.equal(validatePlanProtocolScripts(steps), true);
  steps[0].enabled = false;
  assert.equal(validatePlanProtocolScripts(steps), false);
  steps[0].steps[0].steps[0].protocolScripts.version = 2;
  assert.throws(() => validatePlanProtocolScripts(steps), /version/);
  for (const field of [undefined, null, {}, scripts]) {
    const wrong = graph();
    wrong[0].enabled = false;
    wrong[0].protocolScripts = field;
    assert.throws(() => validatePlanProtocolScripts(wrong), /仅可用于/);
  }
});
