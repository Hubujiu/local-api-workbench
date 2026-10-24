import test from "node:test";
import assert from "node:assert/strict";
import { createFieldSampler } from "../src/mock-fields.mjs";
const settings = (mock) => ({
  mockSeed: 42,
  mockFieldRules: [
    {
      id: "date",
      pattern: "created",
      type: "string",
      mock,
      apipostSource: { projectId: "fixture", id: "date" },
    },
  ],
});
test("native date generators use epoch-to-clock bounds and limited numeric formats", () => {
  const now = Date.UTC(2026, 9, 24, 12);
  const sample = createFieldSampler(settings("@datetime"), { now: () => now });
  for (let i = 0; i < 12; i++) {
    const text = sample("created", { type: "string" });
    assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const time = new Date(text.replace(" ", "T")).getTime();
    assert(time >= 0 && time <= now);
  }
  assert.match(
    createFieldSampler(settings('@date("yyyyMMdd")'), { now: () => now })(
      "created",
      { type: "string" },
    ),
    /^\d{8}$/,
  );
  assert.match(
    createFieldSampler(settings("@time()"), { now: () => now })("created", {
      type: "string",
    }),
    /^\d{2}:\d{2}:\d{2}$/,
  );
  for (const mock of [
    '@date("YYYY-MM-DD")',
    '@date("ddd")',
    '@datetime("yyyy-MM-ddTHH:mm:ss")',
    "@date(1)",
    '@time("HH",1)',
  ])
    assert.throws(() => createFieldSampler(settings(mock)));
  for (const time of [-1, Infinity, NaN, 8640000000000001])
    assert.throws(
      () =>
        createFieldSampler(settings("@date"), { now: () => time })("created", {
          type: "string",
        }),
      /时钟/,
    );
});

test("native date formatting follows system timezone including non-hour offsets and DST", async () => {
  const { spawnSync } = await import("node:child_process");
  const module = new URL("../src/apipost-mock-dates.mjs", import.meta.url).href;
  const code = `import { sampleApipostMockDate } from ${JSON.stringify(module)}; console.log(JSON.stringify([sampleApipostMockDate("yyyy-MM-dd HH:mm:ss",()=>0,()=>0),sampleApipostMockDate("yyyy-MM-dd HH:mm:ss",()=>0.5,()=>2*Date.UTC(2024,6,1,12))]));`;
  for (const [TZ, expected] of [
    ["UTC", ["1970-01-01 00:00:00", "2024-07-01 12:00:00"]],
    ["Asia/Shanghai", ["1970-01-01 08:00:00", "2024-07-01 20:00:00"]],
    ["Asia/Kolkata", ["1970-01-01 05:30:00", "2024-07-01 17:30:00"]],
    ["America/New_York", ["1969-12-31 19:00:00", "2024-07-01 08:00:00"]],
  ]) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      {
        env: { ...process.env, TZ },
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 8192,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), expected);
  }
  const own = createFieldSampler(
    {
      mockFieldRules: [
        { id: "own", pattern: "created", type: "string", mock: "@date()" },
      ],
    },
    { now: () => 0 },
  );
  assert.match(own("created", { type: "string" }), /^202\d-/);
});

test("imported date rules survive storage and produce formatted strings through actual Mock HTTP", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { importIntoProject } = await import("../src/core.mjs");
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "native-date-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Date rules"),
    doc = modernApipostFixture();
  doc.global.mock_custom_rules = [
    {
      mock_custom_rule_id: "created",
      field_type: "string",
      match_type: "exact",
      match_rule: "created",
      match_case: 1,
      mock_type: 1,
      mock_rule_content: '@datetime("yyyy-MM-dd HH:mm:ss")',
      intro: "System local time",
    },
  ];
  importIntoProject(p, doc);
  const schema = {
    type: "object",
    properties: { created: { type: "string" } },
  };
  p.requests = [
    {
      id: "auto",
      name: "auto",
      url: app.url + "/mock/" + p.id + "/auto",
      responses: [{ status: "200", contentType: "application/json", schema }],
    },
  ];
  await app.store.save(p);
  assert.deepEqual(
    (await app.store.get(p.id)).settings.mockFieldRules,
    p.settings.mockFieldRules,
  );
  const response = await fetch(p.requests[0].url);
  assert.equal(response.status, 200);
  assert.match(
    (await response.json()).created,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
  const before = structuredClone(p);
  doc.global.mock_custom_rules[0].mock_rule_content = '@date("MMMM")';
  assert.throws(() => importIntoProject(p, doc), /日期/);
  assert.deepEqual(p, before);
});
