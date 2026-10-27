import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { restoreProject } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const variants = [
  ["string", { type: "string", enum: ["雪😀", "not sampled"] }, "雪😀"],
  ["number", { type: "number", const: 1.25 }, "1.25"],
  ["integer", { type: "integer", const: 0 }, "0"],
  ["boolean", { type: "boolean", const: false }, "false"],
  ["null", { type: "null", const: null }, ""],
  [
    "array",
    { type: "array", const: [0, false, "雪", null] },
    '[0,false,"雪",null]',
  ],
  ["object", { type: "object", const: { ok: false } }, '{"ok":false}'],
  ...[
    "",
    "0",
    "false",
    "null",
    "雪😀 {{literal}}\n",
    " {x:'雪', /*keep*/ y:1,} \n",
  ].map((raw, i) => ["raw-" + i, {}, raw]),
];
const definition = (mock) => {
  const copy = structuredClone(mock);
  delete copy.sourceTargetId;
  return copy;
};
async function close(app) {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
}

for (const [label, schema, expected] of variants)
  test(
    `native Mock ${label} preserves two-format two-generation wire, plans and restarted isolation`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mock-media-export-"));
      let app = await createApp({ root, port: 0 });
      t.after(async () => {
        await close(app);
        await rm(root, { recursive: true, force: true });
      });
      const api = async (route, body) => {
        const r = await fetch(app.url + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await r.json();
        assert.equal(r.status, 200, JSON.stringify(value));
        return value;
      };
      const third = await app.store.create("unrelated");
      const untouched = await app.store.get(third.id);
      const records = [];
      const check = async (p, expected) => {
        for (const [query, header] of [
          ["fail", "matched"],
          ["other", "fallback"],
        ]) {
          const started = performance.now();
          const r = await fetch(
            `${app.url}/mock/${p.id}/${p.requests[0].id}?mode=${query}`,
          );
          assert.equal(r.status, 200);
          assert.equal(r.headers.get("x-native-rule"), header);
          assert.equal(await r.text(), expected);
          assert.ok(
            performance.now() - started >= 7,
            "configured 10ms delay must reach the wire",
          );
        }
        assert.equal(
          p.requests[0].nativeMock.rules[1].response.sourceStatus,
          404,
        );
        assert.equal(p.requests[0].nativeMock.fallback.delayMs, 10);
      };
      const started = performance.now();
      const { doc, config } = nativeMockFixture();
      for (const e of doc.apis[1].response.example) {
        e.expect.schema = structuredClone(schema);
        e.expect.sleep = 10;
        e.raw = Object.keys(schema).length
          ? "never sampled into raw"
          : expected;
      }
      const disabled = structuredClone(config.ai_expect.list[0]);
      disabled.id = "disabled";
      disabled.enable = -1;
      disabled.conditions = [];
      disabled.expect_id = "0";
      disabled.example = {
        ...structuredClone(doc.apis[1].response.example[0]),
        raw: "must not run",
        expect: {
          ...structuredClone(doc.apis[1].response.example[0].expect),
          schema: {},
        },
      };
      config.ai_expect.list.unshift(disabled);
      const source = nativeDirectoryFixture(doc);
      source.files.push({
        path: "settings/mock_api.json",
        text: JSON.stringify(config),
      });
      const sourceBytes = JSON.stringify(source);
      const p = await app.store.create(label);
      await api(`/api/projects/${p.id}/import`, { document: source });
      const original = await app.store.get(p.id);
      await check(original, expected);
      const base = definition(original.requests[0].nativeMock);
      for (const format of ["apipost", "apipost-directory"]) {
        let current = original;
        for (let generation = 0; generation < 2; generation++) {
          assert.equal(
            (
              await fetch(
                `${app.url}/api/projects/${current.id}/export?format=${format}`,
              )
            ).status,
            403,
          );
          const exported = await api(
            `/api/projects/${current.id}/export?format=${format}`,
          );
          const next = await app.store.create(
            `${label}-${format}-${generation}`,
          );
          await api(`/api/projects/${next.id}/import`, { document: exported });
          current = await app.store.get(next.id);
          assert.deepEqual(definition(current.requests[0].nativeMock), base);
          await check(current, expected);
        }
        const consumer = await app.store.create("consume-" + label + format);
        const plan = await api(`/api/projects/${consumer.id}/plans`, {
          name: "Mock evidence",
          statusPolicy: "strict200",
          steps: ["fail", "other"].map((mode) => ({
            request: {
              method: "GET",
              url: `${app.url}/mock/${current.id}/${current.requests[0].id}?mode=${mode}`,
            },
          })),
        });
        const run = await api(`/api/projects/${consumer.id}/run`, {
          planId: plan.id,
        });
        assert.equal(run.status, "passed");
        assert.equal(run.recordSaved, true);
        assert.equal(run.results.length, 2);
        for (const result of run.results) {
          assert.equal(result.response.body, expected);
          assert.equal(result.response.status, 200);
        }
        const disk = await new Store(root).get(consumer.id);
        assert.equal(disk.runs.length, 1);
        assert.equal(disk.runs[0].id, run.id);
        const restoredConsumer = restoreProject(disk);
        await app.store.save(restoredConsumer);
        assert.equal(
          (await new Store(root).get(restoredConsumer.id)).runs[0].id,
          run.id,
        );
        const restored = restoreProject(current);
        await app.store.save(restored);
        await check(restored, expected);
        records.push({
          project: restored,
          expected,
          consumer: restoredConsumer.id,
          runId: run.id,
        });
        current.requests[0].nativeMock.enabled = false;
        await app.store.save(current);
        assert.equal(
          (
            await fetch(
              `${app.url}/mock/${current.id}/${current.requests[0].id}?mode=fail`,
            )
          ).status,
          404,
        );
        await check(original, expected);
      }
      assert.deepEqual(await app.store.get(p.id), original);
      assert.equal(JSON.stringify(source), sourceBytes);
      assert.deepEqual(await app.store.get(third.id), untouched);
      await close(app);
      app = await createApp({ root, port: 0 });
      for (const record of records) {
        await check(await app.store.get(record.project.id), record.expected);
        const disk = await new Store(root).get(record.consumer);
        assert.equal(disk.runs[0].id, record.runId);
        assert.equal(disk.runs[0].status, "passed");
      }
      assert.deepEqual(await app.store.get(third.id), untouched);
      t.diagnostic(
        `${label}: both formats/two generations, four wire plan responses, backup records and restarted isolation completed in ${Math.round(performance.now() - started)}ms`,
      );
    },
  );
