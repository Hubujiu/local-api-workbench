// CI integration only: independent loopback peers, never a vendor-runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import {
  importDocument,
  importIntoProject,
  toCurl,
  importCurl,
  exportOpenAPI,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
  runPlan,
} from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { snapshotCase } from "../src/cases.mjs";
const oauth = (fields) => ({
  type: "oauth2",
  oauth2: Object.entries(fields).map(([key, value]) => ({
    key,
    value,
    type: "string",
  })),
});
const query =
  "access_token=old&flag&raw=%2f&%61ccess_token=encoded&&ACCESS_TOKEN=upper&access_token&dup=1&dup=2";
const cleaned =
  "flag&raw=%2f&%61ccess_token=encoded&&ACCESS_TOKEN=upper&dup=1&dup=2";
const profiles = [
  {
    name: "default",
    fields: { accessToken: "{{token}}" },
    authorization: "Bearer live-token",
    query: cleaned,
  },
  {
    name: "bare",
    fields: { accessToken: "{{token}}", headerPrefix: "" },
    authorization: "live-token",
    query: cleaned,
  },
  {
    name: "custom",
    fields: {
      accessToken: "{{token}}",
      headerPrefix: "  {{prefix}}  ",
      tokenType: "BeArEr",
      addTokenTo: "",
    },
    authorization: "Custom live-token",
    query: cleaned,
  },
  {
    name: "query",
    fields: {
      accessToken: "{{queryToken}}",
      addTokenTo: "queryParams",
      headerPrefix: "{{unused}}",
    },
    authorization: undefined,
    query: cleaned + "&access_token=a+b%2f%20%26%E9%9B%AA%23=",
  },
  {
    name: "empty",
    fields: { accessToken: "", headerPrefix: "{{unused}}" },
    authorization: "Caller unchanged",
    query,
  },
  {
    name: "missing",
    fields: { headerPrefix: "{{unused}}" },
    authorization: "Caller unchanged",
    query,
  },
];
function inertMetadata(origin) {
  return {
    callBackUrl: "not a URL {{unusedCallback}}",
    authUrl: origin + "/must-not-acquire",
    accessTokenUrl: origin + "/must-not-acquire-token",
    clientId: "{{unusedClient}}",
    clientSecret: "{{unusedSecret}}",
    scope: "{{$randomUUID}}",
    requestAccessTokenLocally: "1.0",
  };
}
function collection(origin) {
  return {
    info: { name: "Postman OAuth2 saved-token subset" },
    auth: oauth({ ...inertMetadata(origin), ...profiles[0].fields }),
    item: [
      {
        name: "outer",
        item: [
          {
            name: "inner",
            item: profiles.map((profile, index) => ({
              name: profile.name,
              request: {
                method: "GET",
                url: origin + "/" + profile.name + "?" + query,
                header: [{ key: "Authorization", value: "Caller unchanged" }],
                ...(index
                  ? {
                      auth: oauth({
                        ...inertMetadata(origin),
                        ...profile.fields,
                      }),
                    }
                  : {}),
              },
            })),
          },
        ],
      },
    ],
  };
}
async function fixture(t, version) {
  const errors = [],
    seen = [],
    sessions = new Set();
  const peer = (version === "2" ? http2 : http).createServer((req, res) => {
    try {
      const at = req.url.indexOf("?"),
        name = req.url.slice(1, at),
        profile = profiles.find((p) => p.name === name);
      assert(profile, "known profile");
      assert.equal(req.headers.authorization, profile.authorization);
      assert.equal(req.url.slice(at + 1), profile.query);
      assert.equal(req.method, "GET");
      seen.push(name);
      res.end('{"ok":true}');
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 401;
      res.end("independent verifier rejected request");
    }
  });
  peer.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "postman-oauth2-owner-"));
  let app = await createApp({ root, port: 0 });
  async function stop() {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
  t.after(async () => {
    await stop();
    for (const session of sessions) session.destroy();
    peer.closeAllConnections?.();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function call(route, method = "GET", data, status = 200) {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return {
    get app() {
      return app;
    },
    call,
    errors,
    seen,
    origin: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}
for (const version of ["1.1", "2"])
  test(
    "Postman OAuth2 nested import → HTTP/" +
      version +
      " owner execution, freeze, backup/restart and isolation",
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t, version),
        p = await f.app.store.create("Postman OAuth2"),
        foreign = await f.app.store.create("Untouched"),
        foreignBefore = await f.app.store.get(foreign.id);
      const donor = collection(f.origin),
        donorBefore = structuredClone(donor);
      await f.call("/api/projects/" + p.id + "/import", "POST", {
        document: donor,
      });
      let source = await f.app.store.get(p.id);
      assert.deepEqual(donor, donorBefore);
      for (const env of source.environments)
        Object.assign(env.variables, {
          token: "live-token",
          prefix: "Custom",
          queryToken: "a+b%2f &雪#=",
        });
      for (const request of source.requests) {
        request.httpVersion = version;
        assert.equal(request.folder, "outer/inner");
        for (const [key, value] of Object.entries(inertMetadata(f.origin)))
          assert.equal(request.auth.postmanOAuth2[key], value);
      }
      await f.call("/api/projects/" + p.id, "PUT", source);
      source = await f.app.store.get(p.id);
      const environmentId = source.environments[0].id;
      for (const request of source.requests) {
        const result = await f.call(
          "/api/projects/" + p.id + "/execute",
          "POST",
          { request, environmentId },
        );
        assert.equal(
          result.status,
          200,
          JSON.stringify({ result, errors: f.errors }),
        );
        assert.equal(result.outcome, "passed");
      }
      const plan = await f.call("/api/projects/" + p.id + "/plans", "POST", {
        name: "Frozen policy",
        environmentId,
        statusPolicy: "strict200",
        steps: source.requests.map((request) => ({ request })),
      });
      const edited = await f.app.store.get(p.id);
      edited.requests[0].auth.postmanOAuth2.accessToken = "later-change";
      await f.call("/api/projects/" + p.id, "PUT", edited);
      const run = await f.call("/api/projects/" + p.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(
        run.status,
        "passed",
        JSON.stringify({ run, errors: f.errors }),
      );
      assert.equal(run.recordSaved, true);
      const backup = await f.call("/api/projects/" + p.id + "/export"),
        beforeRestore = await f.app.store.get(p.id);
      const restored = await f.call(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      await f.restart();
      const disk = await f.app.store.get(restored.id);
      assert.deepEqual(disk.plans[0].steps, plan.steps);
      for (const request of [
        ...disk.requests,
        ...disk.plans[0].steps.map((s) => s.request),
      ])
        for (const [key, value] of Object.entries(inertMetadata(f.origin)))
          assert.equal(request.auth.postmanOAuth2[key], value);
      const replay = await f.call("/api/projects/" + disk.id + "/run", "POST", {
        planId: disk.plans[0].id,
        environmentId: disk.environments[0].id,
      });
      assert.equal(
        replay.status,
        "passed",
        JSON.stringify({ replay, errors: f.errors }),
      );
      assert.equal(replay.recordSaved, true);
      await f.restart();
      const final = await f.app.store.get(disk.id);
      assert.equal(final.runs.length, 2);
      assert(final.runs.every((r) => r.status === "passed"));
      assert.deepEqual(await f.app.store.get(p.id), beforeRestore);
      assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
      assert.equal(f.seen.length, profiles.length * 3);
      assert.deepEqual(f.errors, []);
    },
  );
test("Postman import rejects ambiguity/unsupported acquisition selectors atomically and exporters never erase policy", () => {
  const donor = collection("http://127.0.0.1:1"),
    p = { requests: [], settings: {}, environments: [] },
    before = structuredClone(p);
  for (const invalid of [
    oauth({ accessToken: "ok", grant_type: "private-sentinel" }),
    oauth({ accessToken: "ok", tokenType: "MAC" }),
    oauth({ accessToken: "ok", addTokenTo: "body" }),
    {
      type: "oauth2",
      oauth2: [
        { key: "accessToken", value: "a" },
        { key: "accessToken", value: "b" },
      ],
    },
  ]) {
    const input = structuredClone(donor);
    input.item[0].item[0].item.at(-1).request.auth = invalid;
    assert.throws(
      () => importIntoProject(p, input),
      (error) =>
        /Postman OAuth2/.test(error.message) &&
        !error.message.includes("private-sentinel"),
    );
    assert.deepEqual(p, before);
  }
  const request = importDocument(donor)[0];
  assert.throws(() => exportOpenAPI({ requests: [request] }), /Postman OAuth2/);
  for (const settings of [
    { globalAuth: request.auth },
    { folderAuth: { folder: request.auth } },
  ])
    assert.throws(
      () => exportOpenAPI({ requests: [], settings }),
      /Postman OAuth2/,
    );
  assert.throws(() => toCurl(request), /Postman OAuth2/);
  const invalid = structuredClone(request);
  invalid.auth.token = "mixed";
  for (const action of [
    () => normalizeRequest(invalid),
    () => snapshotPlan({ steps: [{ request: invalid }] }),
    () =>
      snapshotCase({
        name: "case",
        sourceRequestId: "source",
        request: invalid,
      }),
    () => restoreProject({ version: 1, requests: [invalid], environments: [] }),
  ])
    assert.throws(action, /Postman OAuth2/);
});
test(
  "resolved cURL and execution share Postman policy, and negative owner imports leave disk unchanged",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "1.1"),
      project = await f.app.store.create("Atomic imports"),
      before = await f.app.store.get(project.id);
    const vars = {
      token: "live-token",
      prefix: "Custom",
      queryToken: "a+b%2f &雪#=",
    };
    for (const profile of profiles) {
      const fields = Object.fromEntries(
        Object.entries(profile.fields).map(([k, v]) => [
          k,
          v.replace(
            /\{\{(token|prefix|queryToken)\}\}/g,
            (_, key) => vars[key],
          ),
        ]),
      );
      const request = importDocument({
        info: { name: "fixture" },
        item: [
          {
            name: profile.name,
            request: {
              url: f.origin + "/" + profile.name + "?" + query,
              auth: oauth({ ...inertMetadata(f.origin), ...fields }),
              header: [{ key: "Authorization", value: "Caller unchanged" }],
            },
          },
        ],
      })[0];
      const result = await executeRequest(importCurl(toCurl(request)));
      assert.equal(
        result.status,
        200,
        JSON.stringify({ result, errors: f.errors }),
      );
    }
    for (const fields of [
      { accessToken: "a", tokenType: "MAC" },
      { accessToken: "a", id: "secret" },
      { accessToken: "bad\r\n" },
    ]) {
      const donor = collection(f.origin);
      donor.auth = oauth(fields);
      await f.call(
        "/api/projects/" + project.id + "/import",
        "POST",
        { document: donor },
        400,
      );
      assert.deepEqual(await f.app.store.get(project.id), before);
    }
    for (const fields of [
      { tokenType: "MAC" },
      { accessToken: "bad\r\n" },
      { version: 2 },
    ]) {
      const invalid = structuredClone(before);
      invalid.requests = [normalizeRequest({ url: f.origin + "/default" })];
      invalid.requests[0].auth = {
        type: "oauth2",
        postmanOAuth2: { version: 1, ...fields },
      };
      await f.call("/api/projects/" + project.id, "PUT", invalid, 400);
      assert.deepEqual(await f.app.store.get(project.id), before);
    }
    const duplicate = normalizeRequest({
      url: f.origin + "/default",
      auth: {
        type: "oauth2",
        postmanOAuth2: { version: 1, accessToken: "live-token" },
      },
      headers: [
        { key: "Authorization", value: "one" },
        { key: "authorization", value: "two" },
      ],
    });
    assert.throws(() => toCurl(duplicate), /重复/);
    await assert.rejects(executeRequest(duplicate), /重复/);
    assert.equal(f.seen.length, profiles.length);
    assert.deepEqual(f.errors, []);
  },
);

test("direct runPlan rejects marked accessors before cloning, including disabled steps", async () => {
  let getterCalls = 0,
    executions = 0;
  const marked = {
    type: "oauth2",
    postmanOAuth2: Object.defineProperty({ version: 1 }, "accessToken", {
      enumerable: true,
      get() {
        getterCalls++;
        return "live-token";
      },
    }),
  };
  const safe = normalizeRequest({
    url: "http://127.0.0.1:1",
    auth: {
      type: "oauth2",
      postmanOAuth2: { version: 1, accessToken: "safe" },
    },
  });
  const before = structuredClone(safe);
  for (const enabled of [true, false]) {
    const plan = {
      steps: [
        { request: safe },
        { enabled, request: { ...safe, auth: marked } },
      ],
    };
    await assert.rejects(
      runPlan(plan, {}, async () => {
        executions++;
        throw Error("must not execute");
      }),
      /Postman OAuth2/,
    );
    assert.deepEqual(safe, before);
  }
  assert.equal(getterCalls, 0);
  assert.equal(executions, 0);
});
