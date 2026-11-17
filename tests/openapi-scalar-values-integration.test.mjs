// Root-only combinations. Application/native/SDK imports run in ordinary CI;
// local authoring checks this file's syntax only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
  normalizeRequest,
  snapshotPlan,
  toCurl,
} from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";

const named = (name, type, value, location = "query") => ({
  name,
  in: location,
  schema: { type },
  examples: { only: { value } },
});
function document(parameters, origin = "http://127.0.0.1:1") {
  return {
    openapi: "3.0.3",
    servers: [{ url: origin }],
    paths: {
      "/mixed": {
        get: { parameters, responses: { 200: { description: "Echo" } } },
      },
    },
  };
}
function project() {
  return {
    id: "scalar-values-native",
    name: "Scalar values native boundary",
    requests: [
      normalizeRequest({
        id: "api",
        name: "Plain",
        url: "http://127.0.0.1:1/mixed",
      }),
    ],
    environments: [],
    folders: [],
    servers: [],
    settings: {},
    cases: [],
    caseFolders: [],
    plans: [],
  };
}
function unchangedRejection(encode, input) {
  const before = structuredClone(input);
  assert.throws(() => encode(input), /参数名和值须为文本/);
  assert.deepEqual(input, before);
}

test("root scalar selection coexists with exploded CSV and empty query arrays through actual wire and OpenAPI roundtrip", async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ url: request.url, zero: request.headers["x-zero"] }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const array = (name, value, explode) => ({
    ...named(name, "array", value),
    schema: { type: "array", items: { type: "string" } },
    explode,
  });
  const source = document(
    [
      named("flag", "boolean", false),
      array("multi", ["a,b", "c&d"], true),
      named("zero", "integer", 0),
      array("csv", ["a,b", "c&d"], false),
      array("omitted", [], true),
      { ...named("empty", "string", ""), allowEmptyValue: true },
      named("X-Zero", "integer", 0, "header"),
    ],
    origin,
  );
  const before = structuredClone(source),
    [request] = importDocument(source);
  assert.deepEqual(source, before);
  assert.deepEqual(
    request.query
      .filter((row) => row.querySerialization)
      .map((row) => JSON.parse(row.value)),
    [["a,b", "c&d"], ["a,b", "c&d"], []],
  );
  assert.equal(request.query[0].value, false);
  assert.equal(request.query[2].value, 0);
  const expected =
    "/mixed?flag=false&multi=a%2Cb&multi=c%26d&zero=0&csv=a%2Cb,c%26d&empty=";
  for (const item of [
    request,
    importDocument(exportOpenAPI({ name: "Mixed", requests: [request] }))[0],
  ]) {
    assert.equal(item.query[0].value, false);
    assert.equal(item.query[2].value, 0);
    assert.deepEqual(JSON.parse((await executeRequest(item)).body), {
      url: expected,
      zero: "0",
    });
    assert(toCurl(item).includes(origin + expected));
  }
  // Existing marked-array/SDK and CSV/presign boundaries must remain intact.
  assert.throws(
    () => normalizeRequest({ ...request, scriptURLMode: "sdk" }),
    /SDK/,
  );
  assert.throws(
    () =>
      normalizeRequest({
        ...request,
        auth: {
          type: "aws",
          accessKey: "FICTIONAL",
          secretKey: "FICTIONAL",
          region: "region",
          service: "service",
          addAuthDataToQuery: true,
        },
      }),
    /CSV/,
  );
});

test("native JSON and directory keep their text-only scalar-row boundary without coercing newly selected booleans or zero", () => {
  for (const location of ["query", "header", "cookie"])
    for (const value of [false, 0]) {
      const group =
        location === "query"
          ? "query"
          : location === "header"
            ? "headers"
            : "cookies";
      const [imported] = importDocument(
        document([
          named(
            "value",
            typeof value === "boolean" ? "boolean" : "integer",
            value,
            location,
          ),
        ]),
      );
      const row = imported[group][0];
      assert.equal(row.value, value);
      // Remove unrelated original-operation metadata by projecting just the row
      // onto a proven native baseline, so the actual text-only guard is tested.
      const baseline = project();
      baseline.requests[0].cookieEncoding = "apipost";
      baseline.requests[0][group] = [
        { ...structuredClone(row), value: String(value) },
      ];
      for (const encode of [exportApipost, exportApipostDirectory]) {
        assert.doesNotThrow(() => encode(baseline));
        for (const enabled of [true, false]) {
          const input = structuredClone(baseline);
          input.requests[0][group][0] = { ...structuredClone(row), enabled };
          unchangedRejection(encode, input);
        }
      }
    }
});

test("native sample and independent frozen-plan exporters cannot silently stringify selected scalar values", () => {
  const baseline = project();
  baseline.requests = [];
  importIntoProject(baseline, nativeSampleExportFixture());
  for (const encode of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => encode(baseline));
    for (const value of [false, 0]) {
      const input = structuredClone(baseline);
      input.cases[0].request.query = [
        {
          key: "value",
          value,
          enabled: true,
          schema: { type: typeof value === "boolean" ? "boolean" : "integer" },
        },
      ];
      unchangedRejection(encode, input);
    }
  }
  const frozen = project();
  frozen.environments = [{ id: "env", name: "Environment", variables: {} }];
  frozen.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen",
      environmentId: "env",
      statusPolicy: "strict200",
      steps: [{ request: frozen.requests[0] }],
    }),
  ];
  assert.doesNotThrow(() => exportApipostDirectory(frozen));
  for (const value of [false, 0]) {
    const input = structuredClone(frozen);
    input.plans[0].steps[0].request.query = [
      {
        key: "value",
        value,
        enabled: true,
        schema: { type: typeof value === "boolean" ? "boolean" : "integer" },
      },
    ];
    unchangedRejection(exportApipostDirectory, input);
  }
});
