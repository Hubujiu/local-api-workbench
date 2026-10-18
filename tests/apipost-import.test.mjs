import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importDocument } from "../src/core.mjs";
test("imports an actual official swagger2apipost0.1.89 conversion fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/apipost-converter-0.1.89.json", import.meta.url),
      "utf8",
    ),
  );
  const [request] = importDocument(fixture);
  assert.equal(request.name, "Read user");
  assert.equal(request.folder, "Users");
  assert.equal(request.url, "https://fixture.example.test/v1/users/{id}");
  assert.match(request.importNotes[0], /HTTPS/);
  assert.equal(request.path[0].value, 7);
  assert.equal(request.path[0].required, true);
  assert.equal(request.query[0].value, "search");
  assert.equal(request.headers[0].key, "X-Test");
  assert.equal(request.bodyType, "none");
  assert.equal(request.examples[0].status, 200);
  assert.equal(
    request.responses[0].content["application/json"].schema.properties.id.type,
    "integer",
  );
});
test("legacy import preserves flags and basic auth, requires file reselection and resolves flat folders", () => {
  const [request] = importDocument({
    apis: [
      { target_type: "folder", target_id: "folder", name: "Parent" },
      {
        target_type: "api",
        target_id: 0,
        parent_id: "folder",
        name: "Upload",
        url: "https://example.test",
        method: "POST",
        request: {
          auth: { type: "basic", basic: { username: "u", password: "p" } },
          query: [
            { key: "zero", value: 0, is_checked: "0", field_type: "integer" },
          ],
          body: {
            mode: "form-data",
            parameter: [
              {
                key: "file",
                type: "File",
                value: "C:\\private\\secret.txt",
                is_checked: "1",
              },
            ],
          },
        },
      },
    ],
  });
  assert.equal(request.folder, "Parent");
  assert.equal(request.auth.username, "u");
  assert.equal(request.query[0].value, 0);
  assert.equal(request.query[0].enabled, false);
  assert.equal(request.form[0].value, "");
  assert.equal(request.form[0].requiresFile, true);
  assert.equal(request.form[0].filename, "secret.txt");
  assert.equal(request.sourceOperationId, "apipost:0");
});
test("unsupported legacy dependencies and cycles fail instead of silently dropping data", () => {
  const api = { target_type: "api", url: "https://example.test", request: {} };
  assert.throws(
    () => importDocument({ apis: [api], env: [{ name: "depends" }] }),
    /环境/,
  );
  assert.throws(
    () =>
      importDocument({
        apis: [{ ...api, script: { pre_script: "console.log(1)" } }],
      }),
    /脚本/,
  );
  assert.throws(
    () =>
      importDocument({
        apis: [
          {
            target_type: "folder",
            target_id: "a",
            parent_id: "a",
            name: "loop",
          },
          { ...api, parent_id: "a" },
        ],
      }),
    /成环/,
  );
  assert.throws(
    () =>
      importDocument({
        apis: [{ ...api, request: { auth: { type: "unsupported" } } }],
      }),
    /认证/,
  );
});
test("legacy metadata import preserves empty folders and rejects dependencies before mutating project", async () => {
  const { importIntoProject } = await import("../src/core.mjs");
  const project = { requests: [], folders: [], environments: [] };
  importIntoProject(project, {
    apis: [{ target_type: "folder", name: "Empty" }],
  });
  assert.deepEqual(project.folders, ["Empty"]);
  const before = structuredClone(project);
  assert.throws(
    () =>
      importIntoProject(project, {
        apis: [],
        project: { script: { pre_script: "danger" } },
      }),
    /全局脚本/,
  );
  assert.deepEqual(project, before);
});
