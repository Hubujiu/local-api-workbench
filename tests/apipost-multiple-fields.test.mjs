import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate as resolve } from "../src/apipost-function-templates.mjs";
import {
  parseApipostFunctionTemplate,
  apipostTemplateStages,
  validateApipostTemplateRequest,
} from "../public/apipost-function-template.js";

const request = (values) => ({
  headers: values.map((value, index) => ({
    key: `x-${index}`,
    value: "",
    dynamic: { source: "apipost-header-function", value, functions: [] },
  })),
});

test("multiple fields preserve original ordered matches, including duplicate occurrences", async () => {
  const field = "A{{x|upper}}B{{x|upper}}C{{y|lower}}D";
  assert.deepEqual(apipostTemplateStages(parseApipostFunctionTemplate(field)), [
    "upper",
    "upper",
    "lower",
  ]);
  for (const group of ["headers", "form", "body"])
    assert.equal(
      await resolve(field, [], group, { x: "hi", y: "BYE" }),
      "AHIBHICbyeD",
    );
});

test("each original occurrence replaces the first match in accumulated text, not its original position", async () => {
  const field = "{{x|lower}}/{{y|upper}}";
  // x inserts a fresh copy of the second original match. That copy wins first-match replacement.
  assert.equal(
    await resolve(field, [], "body", { x: "{{y|upper}}", y: "ok" }),
    "OK/{{y|upper}}",
  );
  // A new match absent from the original list is never evaluated.
  assert.equal(
    await resolve(field, [], "body", {
      x: "{{z|lower}}",
      y: "ok",
      z: "SECRET",
    }),
    "{{z|lower}}/OK",
  );
});

test("multiple fields use native JS dollar, whole-match, prefix and suffix replacement semantics", async () => {
  const expressions = ["{{x|lower}}", "{{y|lower}}"];
  for (const replacement of ["$$", "$&", "$`", "$'", "$$$&$`$'"]) {
    const field = `pre${expressions[0]}mid${expressions[1]}post`;
    const expected = field
      .replace(expressions[0], replacement)
      .replace(expressions[1], "done");
    assert.equal(
      await resolve(field, [], "body", { x: replacement, y: "DONE" }),
      expected,
    );
  }
  const repeated = "{{x|lower}}/{{x|lower}}";
  assert.equal(
    await resolve(repeated, [], "body", { x: "$&!" }),
    repeated.replace("{{x|lower}}", "$&!").replace("{{x|lower}}", "$&!"),
  );
});

test("multiple fields reject Query and all custom-function stages before evaluating variable getters", async () => {
  let reads = 0;
  const variables = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      reads++;
      return "bad";
    },
  });
  for (const field of [
    "{{x|upper}}/{{$function.fn_side(x)}}",
    "{{x|upper}}/{{y|fn_side}}",
  ])
    await assert.rejects(resolve(field, [], "body", variables));
  await assert.rejects(
    resolve("{{x|upper}}/{{y|lower}}", [], "query", variables),
  );
  assert.equal(reads, 0);
  await assert.rejects(
    resolve("{{x|upper}}/{{y|lower}}", [], "body", variables),
    /访问器/,
  );
  assert.equal(reads, 0);
});

test("multiple fields share request stage budgets and reject oversized accumulated output", async () => {
  const ten = "{{x" + "|upper".repeat(10) + "}}";
  assert.doesNotThrow(() =>
    validateApipostTemplateRequest(request([ten + ten])),
  );
  assert.throws(
    () => validateApipostTemplateRequest(request([ten + ten, "{{x|upper}}"])),
    /20/,
  );
  assert.throws(
    () => validateApipostTemplateRequest(request([ten + ten + "{{x|upper}}"])),
    /20/,
  );
  await assert.rejects(
    resolve("{{x|lower}}{{y|lower}}", [], "body", {
      x: "a".repeat(40000),
      y: "b".repeat(40000),
    }),
    /64KiB/,
  );
  await assert.rejects(
    resolve("{{x|lower}}{{y|lower}}", [], "body", {
      x: "a".repeat(65537),
      y: "b",
    }),
    /64KiB/,
  );
});

test("synchronous builtin failure retains its prior value and later original expressions still run", async () => {
  assert.equal(
    await resolve("A{{x|decodeuricomponent}}B{{y|upper}}C", [], "body", {
      x: "%zz",
      y: "ok",
    }),
    "A%zzBOKC",
  );
  assert.equal(
    await resolve("{{missing|lower}}/{{y|upper}}", [], "body", { y: "ok" }),
    "{{missing}}/OK",
  );
});

test("multiple expressions honor an already exhausted shared deadline before reading variables", async () => {
  let reads = 0;
  const variables = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      reads++;
      return "bad";
    },
  });
  await assert.rejects(
    resolve("{{x|upper}}/{{y|lower}}", [], "body", variables, -1),
    /5秒总预算/,
  );
  assert.equal(reads, 0);
});

test("dynamic editor accepts multiple Header expressions but rejects Query and custom mixtures without changing prior metadata", async () => {
  const { parseDynamicEdits } = await import("../public/dynamic-editor.js");
  const previous = {
    source: "fixed",
    value: "old",
    functions: [],
    retained: { note: "source" },
  };
  const before = structuredClone(previous);
  const fields = {
    enabled: true,
    source: "apipost-header-function",
    value: "pre{{x|upper}}mid{{y|lower}}post",
    functions: "",
  };
  const next = parseDynamicEdits(fields, previous);
  assert.equal(next.source, fields.source);
  assert.equal(next.value, fields.value);
  assert.deepEqual(next.functions, []);
  assert.deepEqual(next.retained, previous.retained);
  assert.notEqual(next.retained, previous.retained);
  assert.throws(
    () =>
      parseDynamicEdits({ ...fields, source: "apipost-function" }, previous),
    /Query/,
  );
  for (const value of [
    "{{x|upper}}/{{$function.fn_side(x)}}",
    "{{x|upper}}/{{y|fn_side}}",
  ])
    assert.throws(
      () => parseDynamicEdits({ ...fields, value }, previous),
      /自定义函数/,
    );
  assert.deepEqual(previous, before);
});
