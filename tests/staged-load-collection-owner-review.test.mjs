import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { preparePostmanCollection } from "../src/postman-collection-scopes.mjs";
import { versionPlan } from "../src/plan-version.mjs";

const schedule = {
  initialVUs: 2,
  stages: [{ durationSeconds: 10, targetVUs: 2 }],
  maxIterations: 2,
};
async function fixture(t) {
  const barriers = new Map();
  let identity = 0;
  const seen = [];
  let arrived;
  const held = new Promise((resolve) => {
    arrived = resolve;
  });
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/barrier/")) {
      const key = req.url.split("?")[0];
      const waiting = barriers.get(key) || [];
      waiting.push({ res, id: ++identity });
      barriers.set(key, waiting);
      if (waiting.length === 2) {
        barriers.delete(key);
        for (const entry of waiting) {
          entry.res.setHeader("content-type", "application/json");
          entry.res.end(JSON.stringify({ id: entry.id }));
        }
      }
      return;
    }
    if (req.url.startsWith("/hold")) return arrived();
    setTimeout(() => res.end("ok"), 15);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(
    path.join(tmpdir(), "staged-collection-owner-review-"),
  );
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all(
      [app.server, peer].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("independent collection owner review");
  p.globalVariables = { shadow: "global" };
  p.environments[0].variables = { shadow: "environment" };
  p.postmanCollections = {
    version: 1,
    items: ["a", "b"].map((id) =>
      preparePostmanCollection(
        {
          info: { name: id },
          item: [],
          variable: [
            { key: "only", value: id },
            { key: "shadow", value: "collection" },
            { key: "counter", value: 0, type: "number" },
          ],
        },
        () => id,
      ),
    ),
  };
  const base = `http://127.0.0.1:${peer.address().port}`;
  const owner = (route, method = "GET", body) =>
    fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const route = `/api/projects/${p.id}`;
  const savePlan = async (steps) => {
    p.plans = [versionPlan(undefined, { id: "plan", steps }, "manual", p)];
    await app.store.save(p);
    return app.store.get(p.id);
  };
  const run = (extra = {}) =>
    owner(route + "/staged-load", "POST", {
      planId: "plan",
      schedule,
      ...extra,
    });
  const debug = async (collection) => {
    const response = await owner(
      route +
        `/debug-variables?environmentId=${p.environments[0].id}` +
        (collection ? `&postmanCollectionId=${collection}` : ""),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  return { app, p, base, seen, held, owner, route, savePlan, run, debug };
}
function events(text) {
  return text
    .trim()
    .split("\n\n")
    .map((event) => {
      const [name, data] = event.split("\n");
      return { name: name.slice(7), value: JSON.parse(data.slice(6)) };
    });
}

test(
  "owner SSE composes A/B/unbound/A and retains environment debug precedence without publishing",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const step = (id, collection, script = "") => ({
      id,
      request: {
        ...(collection ? { postmanCollectionId: collection } : {}),
        url: f.base + `/${id}/{{shadow}}`,
        beforeScript: script,
      },
    });
    const before = await f.savePlan([
      step(
        "a1",
        "a",
        "pm.expect(pm.collectionVariables.get('counter')).to.equal(0); pm.collectionVariables.set('counter', 7); pm.environment.set('ephemeral', 'private');",
      ),
      step(
        "b",
        "b",
        "pm.expect(pm.collectionVariables.get('only')).to.equal('b'); pm.expect(pm.collectionVariables.get('counter')).to.equal(0); pm.collectionVariables.set('counter', 9);",
      ),
      step(
        "unbound",
        undefined,
        "pm.expect(pm.collectionVariables.toObject()).to.deep.equal({});",
      ),
      step(
        "a2",
        "a",
        "pm.expect(pm.collectionVariables.get('counter')).to.equal(7); pm.expect(pm.collectionVariables.get('only')).to.equal('a');",
      ),
    ]);
    const debug = await f.debug();
    const updated = {
      ...debug,
      variables: { ...debug.variables, shadow: "debug-wide" },
    };
    assert.equal(
      (await f.owner(f.route + "/debug-variables", "PUT", updated)).status,
      200,
    );
    const debugA = await f.debug("a");
    assert.equal(
      (
        await f.owner(f.route + "/debug-variables", "PUT", {
          ...debugA,
          variables: { ...debugA.variables, shadow: "debug-a" },
        })
      ).status,
      200,
    );
    const response = await f.run();
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("content-type"), /event-stream/);
    const records = events(await response.text());
    assert.equal(records[0].name, "start");
    assert.equal(records.at(-2).name, "reportEnd");
    assert.equal(records.at(-1).name, "complete");
    assert.equal(records.at(-2).value.failed, 0, JSON.stringify(records));
    assert.equal(records.at(-2).value.mainRequests, 8);
    assert.equal(f.seen.length, 8);
    assert(
      f.seen.every((url) => url.endsWith("/debug-wide")),
      JSON.stringify(f.seen),
    );
    assert.deepEqual(await f.app.store.get(f.p.id), before);
    assert.deepEqual((await f.debug()).variables, updated.variables);
    assert.deepEqual((await f.debug("a")).variables, {
      ...debugA.variables,
      shadow: "debug-a",
    });
  },
);

test(
  "owner collection cancellation terminates SSE without admitting next step or persisting writes",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.savePlan([
      {
        id: "hold",
        request: {
          postmanCollectionId: "a",
          url: f.base + "/hold",
          beforeScript:
            "pm.collectionVariables.set('counter', 5); pm.environment.set('ephemeral', 'private');",
        },
      },
      {
        id: "after",
        request: { postmanCollectionId: "b", url: f.base + "/after" },
      },
    ]);
    const debug = await f.debug();
    const response = await f.run({
      runId: "review-cancel",
      schedule: { ...schedule, initialVUs: 1, maxIterations: 1 },
    });
    assert.equal(response.status, 200);
    await f.held;
    assert.equal(
      (await f.owner("/api/cancel", "POST", { id: "review-cancel" })).status,
      200,
    );
    const records = events(await response.text());
    assert.equal(records.at(-2).value.stopReason, "cancelled");
    assert.equal(records.at(-2).value.mainRequests, 1);
    assert.equal(records.at(-1).name, "complete");
    assert.deepEqual(f.seen, ["/hold"]);
    assert.deepEqual(await f.app.store.get(f.p.id), before);
    assert.deepEqual((await f.debug()).variables, debug.variables);
  },
);

test(
  "owner admission rejects over-budget collection plans before SSE or network effects",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.savePlan([
      { id: "a", request: { postmanCollectionId: "a", url: f.base + "/a" } },
      { id: "b", request: { postmanCollectionId: "b", url: f.base + "/b" } },
    ]);
    const response = await f.run({
      schedule: { ...schedule, maxIterations: 51 },
    });
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(response.headers.get("content-type"), /event-stream/);
    assert.match(await response.text(), /100/);
    assert.deepEqual(f.seen, []);
    assert.deepEqual(await f.app.store.get(f.p.id), before);
  },
);

test(
  "owner concurrent iterations retain distinct collection writes and reset reused VU sessions",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.savePlan([
      {
        id: "seed",
        request: {
          postmanCollectionId: "a",
          url: f.base + "/barrier/seed",
          beforeScript:
            "pm.expect(pm.collectionVariables.get('counter')).to.equal(0); pm.expect(pm.environment.has('ownId')).to.equal(false);",
          afterScript:
            "const id = pm.response.json().id; pm.environment.set('ownId', id); pm.collectionVariables.set('counter', id);",
        },
      },
      {
        id: "overlap",
        request: {
          postmanCollectionId: "a",
          url: f.base + "/barrier/overlap?counter={{counter}}",
        },
      },
      {
        id: "verify",
        request: {
          postmanCollectionId: "a",
          url: f.base + "/verify/{{counter}}",
          beforeScript:
            "pm.expect(pm.collectionVariables.get('counter')).to.equal(pm.environment.get('ownId'));",
        },
      },
    ]);
    const response = await f.run({
      schedule: { ...schedule, maxIterations: 4 },
    });
    assert.equal(response.status, 200);
    const records = events(await response.text());
    const report = records.at(-2).value;
    assert.equal(report.stopReason, "iteration-limit");
    assert.equal(report.started, 4);
    assert.equal(report.completed, 4);
    assert.equal(report.failed, 0, JSON.stringify(records));
    assert.equal(report.mainRequests, 12);
    const values = f.seen
      .filter((url) => url.startsWith("/verify/"))
      .map((url) => url.split("/").at(-1));
    assert.equal(new Set(values).size, 4, JSON.stringify(f.seen));
    assert.deepEqual(await f.app.store.get(f.p.id), before);
  },
);

test(
  "owner script failure keeps collection writes private and errors out of reports",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.savePlan([
      {
        id: "failure",
        request: {
          postmanCollectionId: "a",
          url: f.base + "/must-not-send",
          beforeScript:
            "pm.collectionVariables.set('counter', 99); pm.environment.set('ephemeral', 'private'); throw Error('secret-collection-value');",
        },
      },
    ]);
    const debug = await f.debug();
    const response = await f.run();
    assert.equal(response.status, 200);
    const body = await response.text();
    const records = events(body);
    assert.equal(records.at(-2).value.failed, 2);
    assert.equal(records.at(-1).name, "complete");
    assert.doesNotMatch(
      body,
      /secret-collection-value|ephemeral|must-not-send/,
    );
    assert.deepEqual(f.seen, []);
    assert.deepEqual(await f.app.store.get(f.p.id), before);
    assert.deepEqual((await f.debug()).variables, debug.variables);
  },
);
