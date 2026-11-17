import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, importIntoProject, toCurl } from "../src/core.mjs";
import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";
import {
  invalidReservedValues,
  versions,
  reservedDocument,
  mixedReservedDocument,
} from "./fixtures/openapi-allow-reserved.mjs";

for (const version of versions) {
  test(`${version} scalar query rejects unsupported or malformed allowReserved`, () => {
    for (const value of [
      ...invalidReservedValues,
      ...(version === "2.0" ? [true] : []),
    ]) {
      const source = reservedDocument(version, value);
      const before = structuredClone(source);
      assert.throws(() => importDocument(source), /allowReserved/);
      assert.deepEqual(source, before);
    }
  });

  test(`${version} absent and false scalar allowReserved preserve ordinary encoding`, () => {
    for (const value of [undefined, false]) {
      const source = reservedDocument(version, value);
      const before = structuredClone(source);
      const [request] = importDocument(source);
      assert.deepEqual(source, before);
      assert.equal(request.query[0].value, "a/b:c");
      assert.equal(request.query[0].querySerialization, undefined);
      assert.match(toCurl(request), /\/search\?filter=a%2Fb%3Ac/);
    }
  });

  test(`${version} invalid scalar reserved semantics reject whole mixed batch without mutation`, () => {
    const baseline = {
      requests: importDocument(reservedDocument(version, false)),
      environments: [],
      folders: ["Existing"],
      settings: {},
    };
    for (const value of [
      ...invalidReservedValues,
      ...(version === "2.0" ? [true] : []),
    ]) {
      const source = mixedReservedDocument(version, value);
      const sourceBefore = structuredClone(source);
      for (const sync of [false, true]) {
        const project = structuredClone(baseline);
        assert.throws(
          () => importIntoProject(project, source, { sync }),
          /allowReserved/,
        );
        assert.deepEqual(project, baseline);
      }
      if (version !== "2.0")
        for (const coverMode of ["url_and_folder", "url", "ignore", "both"]) {
          const project = structuredClone(baseline);
          assert.throws(
            () => syncMCPOpenAPI(project, { document: source, coverMode }),
            /allowReserved/,
          );
          assert.deepEqual(project, baseline);
        }
      assert.deepEqual(source, sourceBefore);
    }
  });
}

test("resolved and inherited scalar allowReserved cannot bypass admission", () => {
  for (const version of ["3.0.3", "3.1.0"])
    for (const inherited of [false, true]) {
      const source = reservedDocument(version, "true");
      const parameter = source.paths["/search"].get.parameters[0];
      source.components = { parameters: { Reserved: parameter } };
      source.paths["/search"].get.parameters = [
        { $ref: "#/components/parameters/Reserved" },
      ];
      if (inherited) {
        source.paths["/search"].parameters =
          source.paths["/search"].get.parameters;
        delete source.paths["/search"].get.parameters;
      }
      assert.throws(() => importDocument(source), /allowReserved/);
    }
});
