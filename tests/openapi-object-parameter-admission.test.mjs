import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
  toCurl,
  normalizeRequest,
} from "../src/core.mjs";
import { importOpenAPIHeaders } from "../src/openapi-body.mjs";
import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";
import {
  objectParameter,
  objectVariants,
  objectParameterDocument,
  mixedObjectDocument,
} from "./fixtures/openapi-object-parameters.mjs";

for (const version of ["3.0.3", "3.1.0"])
  for (const location of ["header", "cookie"]) {
    test(`${version} rejects unsupported ${location} object contracts and compound selected values`, () => {
      for (const parameter of objectVariants(location)) {
        const source = objectParameterDocument(version, parameter);
        const before = structuredClone(source);
        assert.throws(
          () => importDocument(source),
          /OpenAPI.*(对象|content|复合)/,
        );
        assert.deepEqual(source, before);
      }
    });

    test(`${version} ${location} object refusal is atomic for ordinary import and all MCP cover modes`, () => {
      const baseline = {
        requests: importDocument(
          objectParameterDocument(version, {
            in: "header",
            name: "X-Keep",
            example: "preserved",
          }),
        ),
        environments: [],
        folders: [],
        settings: {},
      };
      for (const parameter of objectVariants(location)) {
        const source = mixedObjectDocument(version, parameter);
        const beforeSource = structuredClone(source);
        for (const sync of [false, true]) {
          const project = structuredClone(baseline);
          assert.throws(
            () => importIntoProject(project, source, { sync }),
            /OpenAPI.*(对象|content|复合)/,
          );
          assert.deepEqual(project, baseline);
        }
        for (const coverMode of ["url_and_folder", "url", "ignore", "both"]) {
          const project = structuredClone(baseline);
          assert.throws(
            () => syncMCPOpenAPI(project, { document: source, coverMode }),
            /OpenAPI.*(对象|content|复合)/,
          );
          assert.deepEqual(project, baseline);
        }
        assert.deepEqual(source, beforeSource);
      }
    });
  }

test("resolved and inherited object Header/Cookie parameters cannot bypass admission", () => {
  for (const version of ["3.0.3", "3.1.0"])
    for (const location of ["header", "cookie"])
      for (const inherited of [false, true]) {
        const source = objectParameterDocument(
          version,
          objectParameter(
            location,
            location === "header"
              ? {
                  schema: {
                    type: "object",
                    properties: { nested: { type: "object" } },
                  },
                }
              : {},
          ),
        );
        source.components = {
          parameters: { Object: source.paths["/check"].get.parameters[0] },
        };
        const refs = [{ $ref: "#/components/parameters/Object" }];
        if (inherited) {
          source.paths["/check"].parameters = refs;
          delete source.paths["/check"].get.parameters;
        } else source.paths["/check"].get.parameters = refs;
        assert.throws(() => importDocument(source), /OpenAPI.*对象/);
      }
});

test("ignored OAS3 Content-Type object parameters do not block valid body media", () => {
  for (const version of ["3.0.3", "3.1.0"])
    for (const name of ["Content-Type", "CONTENT-TYPE", "content-type"]) {
      const source = objectParameterDocument(
        version,
        objectParameter("header", { name }),
      );
      source.paths["/check"].get.requestBody = {
        content: {
          "application/json": {
            schema: { type: "object" },
            example: { kept: true },
          },
        },
      };
      const [request] = importDocument(source);
      assert.deepEqual(request.headers, [
        { key: "Content-Type", value: "application/json", enabled: true },
      ]);
      assert.deepEqual(JSON.parse(request.body), { kept: true });
    }
});

test("scalar values, literal JSON text and annotations retain OpenAPI roundtrip and cURL", () => {
  for (const location of ["header", "cookie"])
    for (const [schema, value] of [
      [{ type: "boolean" }, false],
      [{ type: "integer" }, 0],
      [{ type: "string" }, ""],
      [{ type: "string", "x-literal": { type: "object" } }, '{"role":"admin"}'],
    ]) {
      const parameter = {
        in: location,
        name: location === "header" ? "X-Value" : "value",
        schema,
        examples: { selected: { value } },
      };
      const [request] = importDocument(
        objectParameterDocument("3.1.0", parameter),
      );
      const group = location === "header" ? "headers" : "cookies";
      assert.equal(request[group][0].value, value);
      const exported = exportOpenAPI({ name: "Scalar", requests: [request] });
      const [again] = importDocument(exported);
      assert.deepEqual(again[group], request[group]);
      assert.equal(toCurl(again), toCurl(request));
    }
});

test("legacy Swagger/manual rows and primitive arrays are not reinterpreted", () => {
  const parameter = objectParameter("header");
  assert.deepEqual(
    importOpenAPIHeaders([parameter], "", { oas3: false })[0].value,
    parameter.example,
  );
  const manual = normalizeRequest({
    headers: [{ key: "X-Literal", value: '{"role":"admin"}' }],
    cookies: [{ key: "prefs", value: "role,admin" }],
  });
  assert.equal(manual.headers[0].value, '{"role":"admin"}');
  assert.equal(manual.cookies[0].value, "role,admin");
  for (const location of ["header", "cookie"]) {
    const [request] = importDocument(
      objectParameterDocument("3.0.3", {
        in: location,
        name: location === "header" ? "X-List" : "list",
        schema: { type: "array", items: { type: "string" } },
        example: ["a", "b"],
      }),
    );
    assert.deepEqual(
      request[location === "header" ? "headers" : "cookies"][0].value,
      ["a", "b"],
    );
  }
});
