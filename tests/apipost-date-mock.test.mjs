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
    '@datetime("yyyy-MM-ddZHH:mm:ss")',
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
  const code = `import { sampleApipostMockDate, sampleApipostMockNow, sampleApipostIsoTimestamp } from ${JSON.stringify(module)}; console.log(JSON.stringify([sampleApipostMockDate("yyyy-MM-dd HH:mm:ss",()=>0,()=>0),sampleApipostMockDate("yyyy-MM-dd HH:mm:ss",()=>0.5,()=>2*Date.UTC(2024,6,1,12)),sampleApipostMockNow(["","yyyy-MM-dd HH:mm:ss"],()=>Date.UTC(2024,6,3,12)),sampleApipostMockNow(["week","yyyy-MM-dd HH:mm:ss"],()=>Date.UTC(2024,6,3,12)),sampleApipostIsoTimestamp(()=>Date.UTC(2024,6,3,12,4,5,7))]));`;
  for (const [TZ, expected] of [
    [
      "UTC",
      [
        "1970-01-01 00:00:00",
        "2024-07-01 12:00:00",
        "2024-07-03 12:00:00",
        "2024-06-30 00:00:00",
      ],
    ],
    [
      "Asia/Shanghai",
      [
        "1970-01-01 08:00:00",
        "2024-07-01 20:00:00",
        "2024-07-03 20:00:00",
        "2024-06-30 00:00:00",
      ],
    ],
    [
      "Asia/Kolkata",
      [
        "1970-01-01 05:30:00",
        "2024-07-01 17:30:00",
        "2024-07-03 17:30:00",
        "2024-06-30 00:00:00",
      ],
    ],
    [
      "America/New_York",
      [
        "1969-12-31 19:00:00",
        "2024-07-01 08:00:00",
        "2024-07-03 08:00:00",
        "2024-06-30 00:00:00",
      ],
    ],
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
    assert.deepEqual(JSON.parse(child.stdout), [
      ...expected,
      "2024-07-03T12:04:05.007Z",
    ]);
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
  doc.global.mock_custom_rules.push({
    ...doc.global.mock_custom_rules[0],
    mock_custom_rule_id: "updated",
    match_rule: "updated",
    mock_rule_content: '@now("yyyy")',
  });
  doc.global.mock_custom_rules.push({
    ...doc.global.mock_custom_rules[0],
    mock_custom_rule_id: "stamp",
    match_rule: "stamp",
    mock_rule_content: '@now("second","T")',
  });
  doc.global.mock_custom_rules.push({
    ...doc.global.mock_custom_rules[0],
    mock_custom_rule_id: "iso",
    match_rule: "iso",
    mock_rule_content: "@isoTimestamp()",
  });
  importIntoProject(p, doc);
  const schema = {
    type: "object",
    properties: {
      created: { type: "string" },
      updated: { type: "string" },
      stamp: { type: "string" },
      iso: { type: "string" },
    },
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
  const clockBefore = Date.now();
  const yearBefore = String(new Date().getFullYear());
  const response = await fetch(p.requests[0].url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert([yearBefore, String(new Date().getFullYear())].includes(body.updated));
  assert.equal(new Date(body.iso).toISOString(), body.iso);
  assert(
    Date.parse(body.iso) >= clockBefore && Date.parse(body.iso) <= Date.now(),
  );
  assert.match(body.stamp, /^\d+$/);
  assert.equal(Number(body.stamp) % 1000, 0);
  assert(Number(body.stamp) >= Math.floor(clockBefore / 1000) * 1000);
  assert(Number(body.stamp) <= Date.now());
  assert.match(body.created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const before = structuredClone(p);
  doc.global.mock_custom_rules[0].mock_rule_content = '@date("MMMM")';
  assert.throws(() => importIntoProject(p, doc), /日期/);
  assert.deepEqual(p, before);
});

test("native now preserves local calendar truncation and Sunday-based weeks", () => {
  const clock = new Date(2024, 6, 3, 12, 34, 56, 789).getTime();
  const value = (mock) =>
    createFieldSampler(settings(mock), { now: () => clock })("created", {
      type: "string",
    });
  assert.equal(value("@now"), "2024-07-03 12:34:56");
  assert.equal(value("@now()"), "2024-07-03 12:34:56");
  for (const [unit, expected] of [
    ["year", "2024-01-01 00:00:00"],
    ["month", "2024-07-01 00:00:00"],
    ["week", "2024-06-30 00:00:00"],
    ["day", "2024-07-03 00:00:00"],
    ["hour", "2024-07-03 12:00:00"],
    ["minute", "2024-07-03 12:34:00"],
    ["second", "2024-07-03 12:34:56"],
  ])
    assert.equal(value("@now(" + JSON.stringify(unit) + ")"), expected);
  assert.equal(value('@now("yyyy")'), "2024");
  assert.equal(
    value('@now("DAY","yyyy-MM-dd HH:mm:ss")'),
    "2024-07-03 00:00:00",
  );
  const rollover = createFieldSampler(settings('@now("week")'), {
    now: () => new Date(2024, 0, 1, 12).getTime(),
  });
  assert.equal(rollover("created", { type: "string" }), "2023-12-31 00:00:00");
  for (const mock of [
    '@now("DAY")',
    '@now("days")',
    '@now("invalid","yyyy")',
    "@now(1)",
    '@now("day","yyyy",1)',
  ])
    assert.throws(() => createFieldSampler(settings(mock)));
  const config = settings("@now");
  config.mockFieldRules.push({
    id: "n",
    pattern: "n",
    type: "integer",
    mock: "@integer(1,1000)",
  });
  const a = createFieldSampler(config, { now: () => clock }),
    b = createFieldSampler(config, { now: () => clock });
  b("created", { type: "string" });
  assert.equal(
    a("n", { type: "integer" }),
    b("n", { type: "integer" }),
    "now must not consume random samples",
  );
});

test("native date tokens preserve original twelve-hour, millisecond and timestamp meanings", () => {
  const clock = new Date(2024, 6, 3, 0, 4, 5, 7).getTime();
  const value = (mock) =>
    createFieldSampler(settings(mock), { now: () => clock })("created", {
      type: "string",
    });
  assert.equal(
    value('@now("y yy yyyy hh h HH H SS S A a T")'),
    `24 24 2024 00 0 00 0 007 7 AM am ${clock}`,
  );
  assert.equal(
    value('@now("second","SS/S/T")'),
    `000/0/${Math.floor(clock / 1000) * 1000}`,
  );
  assert.equal(
    value('@now("yyyy-MM-ddTHH:mm:ss")'),
    `2024-07-03${clock}00:04:05`,
    "T is a timestamp token, not a literal ISO separator",
  );
  const noon = createFieldSampler(settings('@now("hh h A a")'), {
    now: () => new Date(2024, 6, 3, 12).getTime(),
  });
  assert.equal(noon("created", { type: "string" }), "00 0 PM pm");
  assert.equal(
    createFieldSampler(settings('@date("T")'), { now: () => 0 })("created", {
      type: "string",
    }),
    "0",
  );
  for (const mock of [
    '@date("SSS")',
    '@date("YYYY")',
    '@time("Z")',
    '@now("days")',
  ])
    assert.throws(() => createFieldSampler(settings(mock)));
});

test("native isoTimestamp is current UTC time rather than random local datetime", () => {
  const clock = Date.UTC(2024, 6, 3, 12, 4, 5, 7);
  for (const expression of ["@isoTimestamp", "@isoTimestamp()"]) {
    const value = createFieldSampler(settings(expression), {
      now: () => clock,
    })("created", { type: "string" });
    assert.equal(value, "2024-07-03T12:04:05.007Z");
  }
  for (const expression of ['@isoTimestamp("yyyy")', "@isoTimestamp(1)"])
    assert.throws(() => createFieldSampler(settings(expression)));
});
