import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source hash stages match independent standard string vectors", async () => {
  for (const algorithm of [
    "md5",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
  ])
    for (const value of ["", "abc", "中文 😀"])
      assert.equal(
        await resolveApipostFunctionTemplate(
          "{{token|" + algorithm + "}}",
          [],
          "body",
          { token: value },
        ),
        createHash(algorithm).update(value).digest("hex"),
      );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{'abc'|sha256()|upper}}",
      [],
      "query",
    ),
    createHash("sha256").update("abc").digest("hex").toUpperCase(),
  );
});

test("hash stages reject unsupported input and custom-code mixtures before execution", async () => {
  for (const token of [null, false, 1])
    await assert.rejects(
      resolveApipostFunctionTemplate("{{token|md5}}", [], "body", { token }),
      /文本/,
    );
  assert.throws(() => parseApipostFunctionTemplate("{{'abc'|sha256(secret)}}"));
  const functions = [
    {
      name: "fn_seed",
      kind: "transform",
      body: "while(true){}",
      apipostSource: { projectId: "fixture", id: "seed", description: "" },
    },
  ];
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|sha256}}",
      functions,
      "body",
    ),
    /共享函数/,
  );
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "{{'abc'|sha256|fn_seed}}",
      functions,
      "body",
    ),
    /共享函数/,
  );
  assert.equal(
    await resolveApipostFunctionTemplate("{{token|md5|length}}", [], "body", {
      token: "\ud800",
    }),
    1,
  );
});

test("modern string hash templates import passively and unsupported mixtures fail atomically", () => {
  return Promise.all([
    import("./fixtures/apipost-modern.mjs"),
    import("../src/core.mjs"),
  ]).then(([{ modernApipostFixture }, { importIntoProject }]) => {
    const doc = modernApipostFixture();
    doc.global.custom_func = [];
    doc.apis[1].request.query.parameter[0].value = "{{'abc'|sha256}}";
    const project = {
      requests: [],
      folders: [],
      environments: [],
      servers: [],
      globalVariables: {},
      settings: { statuses: [] },
    };
    importIntoProject(project, doc);
    assert.equal(
      project.requests[0].query[0].dynamic.value,
      "{{'abc'|sha256}}",
    );
    const before = structuredClone(project);
    doc.apis[1].request.query.parameter[0].value =
      "{{$function.fn_seed(abc)|sha256}}";
    assert.throws(() => importIntoProject(project, doc));
    assert.deepEqual(project, before);
  });
});
