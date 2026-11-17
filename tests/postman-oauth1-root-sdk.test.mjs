// Current-root composition, not a Postman runtime oracle. Official HTTP SDK,
// independent peer signatures and an owned held Redis READ. CI executes these
// owner cases; local syntax/format checks do not constitute runtime acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { parseRESP } from "../src/redis.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";
import { observeToolCall } from "./helpers/mcp-cancellation-observation.mjs";
import { storedJSON } from "./helpers/stored-json.mjs";

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function waitFor(read, predicate, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw Error(label);
}
async function bytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await bytes(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const query = "?dup=one&dup=two&text=a%2Bb";
const ordinaryQuery = [
  ["dup", "one"],
  ["dup", "two"],
  ["text", "a+b"],
];
const effect = "accepted-before-revocation";
const jsonBody = '{"text":"雪+a","number":1}';
const literalToken = "literal/token+percent%";
const sourceAuth = (token, flags) => ({
  type: "oauth1",
  oauth1: Object.entries({
    consumerKey: "owned-consumer",
    consumerSecret: "fictional-consumer-secret",
    token,
    tokenSecret: "fictional-token-secret",
    signatureMethod: "HMAC-SHA1",
    nonce: "owned-fixed-nonce",
    timestamp: "1700000000",
    version: "",
    ...flags,
  }).map(([key, value]) => ({ key, value, type: typeof value })),
});
// These expected semantics are explicit, never derived from the importer or
// production signer. The oracle uses independent Node crypto and wire bytes.
const expectedAuth = (header) => ({
  type: "oauth1",
  consumerKey: "owned-consumer",
  consumerSecret: "fictional-consumer-secret",
  accessToken: header ? literalToken : "folder/form+token%",
  tokenSecret: "fictional-token-secret",
  signatureMethod: "HMAC-SHA1",
  nonce: "owned-fixed-nonce",
  timestamp: "1700000000",
  version: header ? "1.0" : "",
  parameterPolicy: {
    placement: header ? "header" : "auto",
    includeBodyHash: header,
    includeEmptyParams: header,
    headerEncoding: header ? "raw" : "percent",
  },
});
function document(origin) {
  const auth = (header) =>
    sourceAuth(header ? literalToken : "folder/form+token%", {
      version: header ? "1.0" : "",
      addParamsToHeader: header,
      includeBodyHash: header,
      addEmptyParamsToSign: header,
      disableHeaderEncoding: header,
    });
  return {
    info: {
      name: "Postman OAuth1 root composition",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    auth: auth(true),
    item: [
      {
        name: "signed-header",
        request: {
          method: "POST",
          url: origin + "/signed-header" + query,
          body: {
            mode: "raw",
            raw: jsonBody,
            options: { raw: { language: "json" } },
          },
        },
      },
      {
        name: "Folder",
        auth: auth(false),
        item: [
          {
            name: "signed-form",
            request: {
              method: "POST",
              url: origin + "/signed-form" + query,
              body: {
                mode: "urlencoded",
                urlencoded: [
                  { key: "x", value: "first" },
                  { key: "x", value: "雪+second" },
                  { key: "empty", value: "" },
                ],
              },
            },
          },
          {
            name: "noauth",
            request: {
              method: "GET",
              url: origin + "/noauth" + query,
              auth: { type: "noauth" },
            },
          },
        ],
      },
    ],
  };
}
const gate = (id, steps) => ({
  id,
  type: "if",
  condition: {
    op: "eq",
    left: { scope: "environment", name: "acceptedEffect" },
    right: { literal: effect },
  },
  steps,
});

// Grant-only failure is recoverable under omitted policy; policy revocation and
// caller cancellation stop the whole execution, even with failurePolicy: stop.
const cases = [
  { change: "revoke" },
  { change: "revoke", failurePolicy: "stop" },
  { change: "disable-execute" },
  { change: "rotate", failurePolicy: "stop" },
  { change: "sdk-cancel", failurePolicy: "stop" },
];
for (const { change, failurePolicy } of cases) {
  test(
    `imported OAuth1 official SDK IF/repeat ${change}, ${failurePolicy ?? "omitted continue"}: signed effects survive and noauth stays isolated`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "postman-oauth1-root-sdk-"),
      );
      const entered = Promise.withResolvers(),
        closed = Promise.withResolvers(),
        appendTerminal = Promise.withResolvers();
      const seen = [],
        errors = [],
        commands = [],
        sockets = [],
        clients = [],
        attempts = [];
      const abort = new AbortController();
      let app, peer, redis, observation, originalAppend;
      let appendSettled = false,
        effects = 0;
      const closeApp = async () => {
        if (!app) return;
        const current = app;
        app = undefined;
        // close() synchronously aborts the real execution registry before any
        // held transport is touched. It is not a join of the SDK promise.
        const closing = current.close();
        current.server.closeIdleConnections();
        try {
          await bounded(closing, "owned app did not close");
        } catch (error) {
          current.server.closeAllConnections();
          throw error;
        }
      };
      t.after(async () => {
        const failures = [];
        const capture = async (fn) => {
          try {
            await fn();
          } catch (error) {
            failures.push(error);
          }
        };
        const closing = closeApp().then(
          () => undefined,
          (error) => error,
        );
        abort.abort();
        await capture(() =>
          Promise.all(clients.splice(0).map((c) => c.close())),
        );
        if (observation) {
          await capture(() =>
            bounded(observation.completion, "SDK cleanup did not settle"),
          );
          if (!appendSettled)
            await capture(() =>
              bounded(
                appendTerminal.promise,
                "real append cleanup did not settle",
              ),
            );
        }
        const closeError = await closing;
        if (closeError) failures.push(closeError);
        for (const socket of sockets) socket.destroy();
        if (redis?.listening)
          await capture(() => new Promise((resolve) => redis.close(resolve)));
        if (peer?.listening) {
          peer.closeAllConnections();
          await capture(() => new Promise((resolve) => peer.close(resolve)));
        }
        // Preserve the owned files if a handler did not actually finish.
        if (!failures.length) await rm(root, { recursive: true, force: true });
        assert.deepEqual(failures, []);
        assert.deepEqual(errors, []);
      });
      peer = http.createServer(async (request, response) => {
        const target = new URL(
          request.url,
          `http://127.0.0.1:${peer.address().port}`,
        );
        seen.push(target.pathname);
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          if (["/signed-header", "/signed-form"].includes(target.pathname)) {
            const header = target.pathname === "/signed-header";
            assert.equal(request.method, "POST");
            const checked = verifyOAuth1Policy({
              url: target.href,
              method: request.method,
              headers: request.headers,
              body,
              auth: expectedAuth(header),
              bodyType: header ? "json" : "urlencoded",
            });
            assert.deepEqual(checked.ordinaryQuery, ordinaryQuery);
            assert.equal(checked.placement, header ? "header" : "form");
            if (header) assert.equal(body.toString(), jsonBody);
            else
              assert.deepEqual(checked.ordinaryForm, [
                ["x", "first"],
                ["x", "雪+second"],
                ["empty", ""],
              ]);
            effects++;
          } else {
            assert(
              ["/noauth", "/inner-tail", "/tail"].includes(target.pathname),
              "unexpected HTTP dispatch",
            );
            assert.equal(request.method, "GET");
            assert.equal(
              request.headers.authorization,
              undefined,
              "explicit noauth must not inherit shared or source OAuth1",
            );
            assert.deepEqual([...target.searchParams], ordinaryQuery);
            assert.equal(body.length, 0);
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ verified: true, effect }));
        } catch (error) {
          errors.push(error.message);
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"verified":false}');
        }
      });
      redis = net.createServer((socket) => {
        sockets.push(socket);
        socket.on("error", () => {});
        socket.once("close", closed.resolve);
        let pending = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          try {
            pending = Buffer.concat([pending, chunk]);
            for (;;) {
              const parsed = parseRESP(pending);
              if (!parsed) break;
              pending = pending.subarray(parsed.bytes);
              const args = parsed.value.map((v) => v.toString());
              commands.push(args);
              assert.deepEqual(args, ["GET", "held-read"]);
              // Hold the actual read, not authentication or connection setup.
              entered.resolve();
            }
          } catch (error) {
            errors.push(error.message);
            socket.destroy();
          }
        });
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      await new Promise((resolve) => redis.listen(0, "127.0.0.1", resolve));
      app = await createApp({ root, port: 0 });
      const origin = `http://127.0.0.1:${peer.address().port}`;
      const owner = async (route, body, method = "POST") => {
        const response = await fetch(app.url + "/api/" + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
      let project = await app.store.create("Postman OAuth1 interrupted flow");
      const other = await app.store.create("Unrelated project");
      const otherBefore = await app.store.get(other.id),
        otherBytes = await bytes(app.store.directory(other.id));
      project.settings.globalAuth = {
        type: "bearer",
        token: "fictional-shared-must-not-leak",
      };
      await app.store.save(project);
      const source = document(origin),
        sourceBefore = structuredClone(source);
      await owner(`projects/${project.id}/import`, { document: source });
      assert.deepEqual(source, sourceBefore);
      project = await app.store.get(project.id);
      assert.equal(project.requests.length, 3);
      const [signed, form, noauth] = project.requests;
      for (const [request, header] of [
        [signed, true],
        [form, false],
      ]) {
        assert.deepEqual(request.auth, expectedAuth(header));
        assert.equal(Object.hasOwn(request.auth, "token"), false);
      }
      assert.equal(noauth.auth.type, "none");
      assert.equal(noauth.inheritAuth, false);
      assert.equal(Object.hasOwn(noauth.auth, "parameterPolicy"), false);
      signed.extract = [
        {
          name: "acceptedEffect",
          source: "json",
          path: "$.effect",
          scope: "environment",
        },
      ];
      const policy = {
        enabled: true,
        projects: [project.id, other.id],
        write: true,
        execute: true,
        remember: false,
      };
      const enabled = await owner("mcp/config", policy);
      const connect = async (token) => {
        const client = new Client({
          name: "postman-oauth1-root-sdk",
          version: "1",
        });
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: { headers: { Authorization: "Bearer " + token } },
          }),
          { timeout: 5000 },
        );
        return client;
      };
      const client = await connect(enabled.token);
      const endpoint = `projects/${project.id}/mcp-database-connections`;
      const connection = await owner(endpoint, {
        type: "redis",
        host: "127.0.0.1",
        port: redis.address().port,
        name: "owned read only",
      });
      const operation = (key, name) => ({
        type: "database",
        connectionId: connection.id,
        sql: JSON.stringify(["GET", key]),
        parameters: [],
        name,
        path: "$.rows[0].value",
      });
      const leaf = (id, request, suffix) => ({
        id,
        request: {
          ...structuredClone(request),
          ...(suffix ? { url: origin + suffix + query } : {}),
        },
      });
      const database = leaf("database", signed, "/never-database-http");
      database.request.extract = [];
      database.request.before = [
        operation("held-read", "dbValue"),
        operation("must-not-follow", "laterDb"),
      ];
      database.request.afterScript =
        'pm.environment.set("afterDb", "must-not-persist");';
      project.plans = [
        snapshotPlan({
          id: "oauth1-root-plan",
          ...(failurePolicy === undefined ? {} : { failurePolicy }),
          steps: [
            leaf("signed", signed),
            leaf("form", form),
            leaf("noauth", noauth),
            gate("outer", [
              {
                id: "repeat",
                type: "repeat",
                count: 2,
                steps: [database, leaf("inner-tail", noauth, "/inner-tail")],
              },
            ]),
            gate("later", [leaf("tail", noauth, "/tail")]),
          ],
        }),
      ];
      await app.store.save(project);
      originalAppend = app.store.append;
      app.store.append = async function (id, field, record, ...rest) {
        const observed = id === project.id && field === "runs";
        if (observed) attempts.push(structuredClone(record));
        try {
          return await originalAppend.call(this, id, field, record, ...rest);
        } finally {
          if (observed) {
            appendSettled = true;
            appendTerminal.resolve();
          }
        }
      };
      observation = observeToolCall(
        client.callTool(
          {
            name: "localapi_run_plan",
            arguments: { projectId: project.id, planId: project.plans[0].id },
          },
          undefined,
          { signal: abort.signal, timeout: 15000 },
        ),
      );
      await bounded(
        entered.promise,
        "actual Redis GET did not reach owned peer",
      );
      observation.assertPending();
      assert.deepEqual(errors, []);
      assert.deepEqual(seen, ["/signed-header", "/signed-form", "/noauth"]);
      assert.deepEqual(commands, [["GET", "held-read"]]);
      assert.equal(effects, 2);
      const committed = await app.store.get(project.id);
      assert.equal(committed.environments[0].variables.acceptedEffect, effect);
      assert.equal(committed.runs.length, 0);
      if (change === "revoke")
        await owner(endpoint, { id: connection.id }, "DELETE");
      else if (change === "sdk-cancel") abort.abort();
      else
        await owner("mcp/config", {
          ...policy,
          ...(change === "rotate" ? { rotate: true } : { execute: false }),
        });
      const terminal = await bounded(
        observation.completion,
        "SDK operation did not settle",
      );
      const cancelled = change !== "revoke",
        continues = !cancelled && failurePolicy !== "stop";
      let returned;
      if (cancelled) {
        assert.equal(terminal.kind, "rejected");
        assert.match(
          terminal.reason.message,
          change === "sdk-cancel"
            ? /abort|cancel/i
            : /MCP authorization changed; inspect authorized history for operation outcome/,
        );
        if (change !== "sdk-cancel") assert.equal(terminal.reason.code, -32000);
      } else {
        assert.equal(terminal.kind, "fulfilled", terminal.reason?.message);
        returned = decode(terminal.value);
        assert.equal(returned.status, "failed");
        assert.equal(returned.recordSaved, true);
      }
      // Client rejection alone proves neither server completion nor cleanup.
      await bounded(closed.promise, "owned Redis read socket did not close");
      await bounded(
        appendTerminal.promise,
        "actual Store.append did not finish",
      );
      const state = await waitFor(
        () => owner("mcp/config", undefined, "GET"),
        (value) =>
          value.activities.some(
            (row) =>
              row.projectId === project.id &&
              row.tool === "localapi_run_plan" &&
              row.status !== "running",
          ),
        "terminal server activity was not published",
      );
      const activity = state.activities.find(
        (row) =>
          row.projectId === project.id && row.tool === "localapi_run_plan",
      );
      assert.equal(activity.status, cancelled ? "cancelled" : "failed");
      assert.equal(
        activity.executionStatus,
        cancelled ? "cancelled" : "failed",
      );
      assert.equal(activity.recordSaved, true);
      assert.equal(attempts.length, 1);
      const run = attempts[0];
      assert.equal(run.status, cancelled ? "cancelled" : "failed");
      assert.equal(
        Object.hasOwn(run.snapshot, "failurePolicy"),
        failurePolicy === "stop",
      );
      assert.equal(run.snapshot.failurePolicy, failurePolicy);
      const ids = continues
        ? [
            "signed",
            "form",
            "noauth",
            "database",
            "inner-tail",
            "database",
            "inner-tail",
            "tail",
          ]
        : ["signed", "form", "noauth", "database"];
      const paths = continues
        ? [
            "/signed-header",
            "/signed-form",
            "/noauth",
            "/inner-tail",
            "/inner-tail",
            "/tail",
          ]
        : ["/signed-header", "/signed-form", "/noauth"];
      assert.deepEqual(
        run.results.map((row) => row.stepId),
        ids,
      );
      assert.deepEqual(seen, paths);
      assert.deepEqual(
        run.conditionResults.map((row) => [
          row.stepId,
          row.status,
          row.matched,
        ]),
        continues
          ? [
              ["outer", "passed", true],
              ["later", "passed", true],
            ]
          : [["outer", "passed", true]],
      );
      for (const row of run.results.slice(0, 3)) {
        assert.equal(row.status, "passed");
        assert.equal(row.response.status, 200);
        assert.deepEqual(JSON.parse(row.response.body), {
          verified: true,
          effect,
        });
        assert.equal(row.error, undefined);
        assert.equal(row.failure, undefined);
      }
      assert.equal(run.results[2].request.inheritAuth, false);
      assert.equal(run.results[2].request.auth.type, "none");
      const failures = run.results.filter((row) => row.stepId === "database");
      assert.equal(failures.length, continues ? 2 : 1);
      failures.forEach((row, iteration) => {
        assert.equal(row.status, "failed");
        assert.equal(row.response, undefined);
        assert.deepEqual(row.repeat, {
          groupId: "repeat",
          childId: "database",
          iteration,
          occurrenceId: JSON.stringify(["repeat", "database", iteration]),
        });
        if (!cancelled) assert.match(row.error, /权限.*撤销|未授权/);
      });
      if (!cancelled && failurePolicy === "stop") {
        assert.equal(run.stopReason, "step-failure");
        assert.deepEqual(run.failureStop, {
          stepId: "database",
          repeat: failures[0].repeat,
        });
      } else {
        assert.equal(
          run.stopReason,
          undefined,
          "caller/global cancellation takes precedence over fail-fast",
        );
        assert.equal(Object.hasOwn(run, "failureStop"), false);
      }
      assert.equal(run.variables.acceptedEffect, effect);
      for (const name of ["dbValue", "laterDb", "afterDb"])
        assert.equal(Object.hasOwn(run.variables, name), false);
      if (returned) {
        assert.equal(returned.recordId, run.id);
        assert.deepEqual(returned.results, storedJSON(run.results));
      }
      const reopened = await new Store(root).get(project.id);
      assert.deepEqual(reopened.runs, [storedJSON(run)]);
      assert.equal(
        reopened.history.length,
        0,
        "flow has one run record, not invented per-API retries",
      );
      assert.equal(reopened.environments[0].variables.acceptedEffect, effect);
      for (const name of ["dbValue", "laterDb", "afterDb"])
        assert.equal(
          Object.hasOwn(reopened.environments[0].variables, name),
          false,
        );
      // Use a fresh real SDK session after policy changes to reconcile saved
      // evidence; never automatically retry the interrupted signed operation.
      const reader = await connect(state.token);
      const history = decode(
        await reader.callTool({
          name: "localapi_get_run",
          arguments: { projectId: project.id, runId: run.id },
        }),
      );
      assert.deepEqual(history, storedJSON(run));
      const wrongProject = await reader.callTool({
        name: "localapi_get_run",
        arguments: { projectId: other.id, runId: run.id },
      });
      assert.equal(wrongProject.isError, true);
      assert.match(wrongProject.content[0].text, /记录不存在/);
      assert.deepEqual(await app.store.get(other.id), otherBefore);
      assert.deepEqual(await bytes(app.store.directory(other.id)), otherBytes);
      assert.equal(sockets.length, 1);
      assert(sockets.every((socket) => socket.destroyed));
      assert.deepEqual(
        commands,
        [["GET", "held-read"]],
        "neither subsequent operation nor repeat may send a new DB command",
      );
      await Promise.all(clients.splice(0).map((c) => c.close()));
      app.store.append = originalAppend;
      await closeApp();
      app = await createApp({ root, port: 0 });
      assert.deepEqual(await new Store(root).get(project.id), reopened);
      assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      assert.deepEqual(await bytes(app.store.directory(other.id)), otherBytes);
      assert.equal(
        effects,
        2,
        "restart does not roll back or replay accepted signed POSTs",
      );
      assert.deepEqual(seen, paths);
      assert.deepEqual(commands, [["GET", "held-read"]]);
      assert.deepEqual(errors, []);
    },
  );
}
