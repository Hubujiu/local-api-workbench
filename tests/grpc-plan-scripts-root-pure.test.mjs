// Audited pure graph/context/projection helpers only; no app, VM or transport.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRepeatGraph, planOccurrences } from "../src/plan-repeat.mjs";
import { validateGrpcScriptBinding } from "../src/grpc-script-context.mjs";
import {
  assertNativeHTTPPlan,
  assertNativeHTTPResult,
} from "../src/native-mcp-http-shape.mjs";

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
            type: "grpc",
            grpcScripts: structuredClone(scripts),
            grpc: {
              definition: { target: "grpc://localhost:50051" },
              messages: [{}],
            },
          },
        ],
      },
    ],
  },
];

test("nested grpcScripts admission preserves occurrence identities without expanding other leaf capabilities", () => {
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
      ({ step }) => step.id === "rpc" && step.grpcScripts.version === 1,
    ),
  );
  assert.deepEqual(steps, before);
  for (const type of ["http", "protocol", "socketio"]) {
    const bad = graph();
    bad[0].steps[0].steps[0] =
      type === "http"
        ? {
            id: "other",
            request: { url: "http://fixture.invalid" },
            grpcScripts: scripts,
          }
        : {
            id: "other",
            type,
            [type]: { definition: {} },
            grpcScripts: scripts,
          };
    assert.throws(() => validateRepeatGraph(bad), /未知/);
  }
  for (const enabled of [true, false]) {
    const bad = graph();
    bad[0].enabled = enabled;
    bad[0].grpcScripts = scripts;
    assert.throws(() => validateRepeatGraph(bad), /未知/);
  }
});

test("gRPC host and worker binding excludes root-only collection and native task capabilities", () => {
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
  assert.doesNotThrow(() => validateGrpcScriptBinding(input, 0));
  for (const key of ["collectionId", "collection", "collectionTypes"])
    assert.throws(
      () =>
        validateGrpcScriptBinding(
          { ...input, scopes: { ...input.scopes, [key]: {} } },
          0,
        ),
      /gRPC/,
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
        () => validateGrpcScriptBinding(input, 0, { [key]: value }),
        /gRPC/,
      );
    assert.doesNotThrow(() =>
      validateGrpcScriptBinding(input, 0, { [key]: undefined }),
    );
  }
});

test("native HTTP projection rejects grpcScripts by presence without inspecting application data", () => {
  const request = {
    url: "http://fixture.invalid",
    body: '{"grpcScripts":{"version":1}}',
  };
  assert.doesNotThrow(() => assertNativeHTTPPlan({ steps: [{ request }] }));
  assert.doesNotThrow(() => assertNativeHTTPResult({ results: [{ request }] }));
  for (const value of [
    undefined,
    null,
    {},
    { version: 1, before: "", after: "" },
  ]) {
    const step = { request, grpcScripts: value };
    assert.throws(() => assertNativeHTTPPlan({ steps: [step] }), /仅支持HTTP/);
    for (const run of [
      { grpcScripts: value },
      { results: [step] },
      { snapshot: { steps: [step] } },
    ])
      assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
  }
});
