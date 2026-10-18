import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesFieldPattern,
  createFieldSampler,
  normalizeMockFieldRules,
} from "../src/mock-fields.mjs";
import { sampleFromSchema } from "../src/core.mjs";
test("field glob matching supports bounded stars, questions, classes, negation and alternatives", () => {
  assert(matchesFieldPattern("{name,*_name}", "receiver_name"));
  assert(matchesFieldPattern("{name,*_name}", "name"));
  assert(matchesFieldPattern("item_?", "item_a"));
  assert(matchesFieldPattern("[a-c]id", "bid"));
  assert(matchesFieldPattern("[!ab]id", "cid"));
  assert(!matchesFieldPattern("[!ab]id", "aid"));
  assert(!matchesFieldPattern("*_name", "email"));
  assert.throws(() => matchesFieldPattern("[abc", "a"), /通配符/);
  assert.throws(
    () =>
      normalizeMockFieldRules([
        { pattern: "name", type: "string", mock: "@execute('bad')" },
      ]),
    /不支持/,
  );
});
test("field mock generation is seeded, type-aware and preserves explicit schema examples", () => {
  const settings = {
    mockSeed: 42,
    smartMockBuiltins: true,
    mockFieldRules: [
      {
        id: "name",
        pattern: "{name,*_name}",
        type: "string",
        mock: "@cname()",
      },
    ],
  };
  const schema = {
    type: "object",
    properties: {
      receiver_name: { type: "string" },
      email: { type: "string" },
      id: { type: "integer", minimum: 2, maximum: 10 },
      fixed_name: { type: "string", example: "keep" },
      nested: { type: "object", properties: { user_name: { type: "string" } } },
    },
  };
  const generate = () =>
    sampleFromSchema(schema, 0, schema, {
      valueForField: createFieldSampler(settings),
    });
  const first = generate();
  assert.deepEqual(generate(), first);
  assert.match(first.receiver_name, /^[\u4e00-\u9fff]{2,3}$/);
  assert(first.email.endsWith("@example.test"));
  assert(first.id >= 2 && first.id <= 10);
  assert.equal(first.fixed_name, "keep");
  assert.match(first.nested.user_name, /^[\u4e00-\u9fff]{2,3}$/);
  assert.throws(
    () =>
      sampleFromSchema(
        { type: "object", properties: { name: { type: "integer" } } },
        0,
        {},
        {
          valueForField: createFieldSampler({
            mockFieldRules: [
              { pattern: "name", type: "any", mock: "@cname()" },
            ],
          }),
        },
      ),
    /类型/,
  );
});

test("field rules are ordered, opt-in builtins and bounded data expressions never execute code", () => {
  assert(matchesFieldPattern("😀_?", "😀_a"));
  const first = createFieldSampler({
    smartMockBuiltins: true,
    mockFieldRules: [{ pattern: "name", type: "string", mock: '"fixed"' }],
  });
  assert.equal(first("name", { type: "string" }), "fixed");
  assert.equal(createFieldSampler({})("name", { type: "string" }), undefined);
  assert.equal(
    createFieldSampler({})("flag", { type: "boolean", mock: false }),
    false,
  );
  assert.equal(
    createFieldSampler({})("count", { type: "integer", mock: 0 }),
    0,
  );
  assert(
    createFieldSampler({ smartMockBuiltins: true })("avatar_url", {
      type: "string",
    }).startsWith("data:image/svg+xml,"),
  );
  assert.throws(
    () =>
      normalizeMockFieldRules([
        { pattern: "id", type: "integer", mock: '@integer("bad",10)' },
      ]),
    /参数/,
  );
  assert.throws(
    () => normalizeMockFieldRules([{ pattern: "x", mock: "@string(1000000)" }]),
    /长度/,
  );
  assert.throws(
    () => matchesFieldPattern("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}", "a"),
    /32/,
  );
});
test("schema-based Mock and request sample API share field rules while explicit responses retain priority", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    path = await import("node:path"),
    os = await import("node:os");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "api-field-mock-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("field mock");
  project.settings = {
    smartMockBuiltins: true,
    mockSeed: 42,
    mockFieldRules: [{ pattern: "*_name", type: "string", mock: "@cname()" }],
  };
  const schema = {
    type: "object",
    properties: { user_name: { type: "string" }, email: { type: "string" } },
  };
  project.requests = [
    {
      id: "auto",
      name: "auto",
      url: app.url + "/mock/" + project.id + "/auto",
      responses: [{ status: "200", contentType: "application/json", schema }],
    },
  ];
  await app.store.save(project);
  const generated = await (await fetch(project.requests[0].url)).json();
  assert.match(generated.user_name, /^[\u4e00-\u9fff]{2,3}$/);
  const preview = await (
    await fetch(app.url + "/api/projects/" + project.id + "/sample", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schema }),
    })
  ).json();
  assert.deepEqual(preview.sample, generated);
  const current = await app.store.get(project.id);
  current.requests[0].examples = [{ status: 200, body: '{"explicit":true}' }];
  await app.store.save(current);
  assert.deepEqual(await (await fetch(project.requests[0].url)).json(), {
    explicit: true,
  });
});
