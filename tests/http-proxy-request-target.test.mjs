import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeRequest } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const exec = promisify(execFile);
const key = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
);
const cert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
async function listen(server, t) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return "127.0.0.1:" + server.address().port;
}
async function fixture(t, secure = false) {
  const seen = [],
    originSeen = [];
  const origin = http.createServer((req, res) => {
    originSeen.push({ url: req.url, headers: req.headers });
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () =>
      res.end(
        JSON.stringify({
          url: req.url,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          body: Buffer.concat(chunks).toString("base64"),
        }),
      ),
    );
  });
  const originURL = "http://" + (await listen(origin, t));
  const handler = (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url.includes("#")) {
      res.writeHead(400);
      res.end("fragment in request-target");
      return;
    }
    const target = new URL(req.url);
    assert.equal(
      target.origin,
      originURL,
      "fixture only forwards its owned origin",
    );
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const upstream = http.request(
      target,
      { method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };
  const proxy = secure
    ? https.createServer({ key, cert }, handler)
    : http.createServer(handler);
  const proxyURL =
    (secure ? "https" : "http") +
    "://proxy-user:proxy-pass@" +
    (await listen(proxy, t));
  return { originURL, proxyURL, seen, originSeen };
}
for (const secure of [false, true]) {
  test(`${secure ? "HTTPS" : "HTTP"} forward proxy omits fragments without changing encoded path/query, authentication or definitions`, async (t) => {
    const f = await fixture(t, secure);
    for (const suffix of [
      "/a%23b?x=%23kept&x=2&&flag=#private-marker",
      "/empty?#",
      "/plain#one#two",
    ]) {
      const definition = {
        url: f.originURL + suffix,
        method: "POST",
        bodyType: "raw",
        body: "literal body",
        auth: { type: "bearer", token: "origin-token" },
        cookies: [{ key: "session", value: "owned" }],
      };
      const before = structuredClone(definition);
      const direct = await executeRequest(definition);
      const proxied = await executeRequest({
        ...definition,
        proxy: f.proxyURL,
        tls: secure ? { proxyCa: cert } : {},
      });
      assert.equal(proxied.status, 200, JSON.stringify(f.seen.at(-1)));
      assert.equal(proxied.body, direct.body);
      assert.equal(f.seen.at(-1).url, definition.url.split("#")[0]);
      assert.equal(
        f.seen.at(-1).headers["proxy-authorization"],
        "Basic " + Buffer.from("proxy-user:proxy-pass").toString("base64"),
      );
      assert.equal(
        f.originSeen.at(-1).headers["proxy-authorization"],
        undefined,
      );
      assert.deepEqual(definition, before);
    }
    const count = f.seen.length;
    await assert.rejects(
      executeRequest({
        url: f.originURL.replace("http://", "http://user:pass@") + "/#secret",
        proxy: f.proxyURL,
      }),
      /认证面板/,
    );
    assert.equal(
      f.seen.length,
      count,
      "userinfo rejected before any connection",
    );
    if (secure) {
      await assert.rejects(
        executeRequest({ url: f.originURL + "/#secret", proxy: f.proxyURL }),
        /certificate|self.signed/i,
      );
      assert.equal(
        f.seen.length,
        count,
        "untrusted proxy certificate never reaches HTTP",
      );
    }
  });
}

test("IPv6 authority, non-default port and empty query survive forward serialization", async (t) => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("captured");
  });
  const address = await listen(proxy, t);
  // The owned proxy only captures absolute-form, never resolves/connects this target.
  for (const url of [
    "http://[::1]:43210/a%23b?x=1&x=2#hidden",
    "http://[::1]:43210/?#",
  ]) {
    await executeRequest({ url, proxy: "http://" + address });
    assert.equal(seen.at(-1), url.split("#")[0]);
  }
});

test("saved owner request and frozen plan retain fragments through CLI, backup, restore and restart without sending them", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "proxy-target-project-"));
  let app = await createApp({ root, port: 0 });
  const close = () => new Promise((resolve) => app.server.close(resolve));
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", data) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  };
  let project = await call("/api/projects", "POST", { name: "proxy-target" });
  const url =
    f.originURL + "/frozen%23path?x=1&x=%23keep&&flag=#private-fragment";
  const request = {
    id: "saved",
    name: "Saved",
    method: "GET",
    url,
    proxy: f.proxyURL,
    auth: { type: "bearer", token: "origin-token" },
    cookies: [{ key: "session", value: "persisted" }],
  };
  project.requests = [request];
  project = await call("/api/projects/" + project.id, "PUT", project);
  const route = "/api/projects/" + project.id;
  const owner = await call(route + "/execute", "POST", {
    request: project.requests[0],
  });
  assert.equal(owner.status, 200);
  const plan = await call(route + "/plans", "POST", {
    name: "Frozen",
    steps: [{ request: project.requests[0] }],
  });
  project = await call(route);
  project.requests[0].url = f.originURL + "/changed#new-fragment";
  await call(route, "PUT", project);
  const run = await call(route + "/run", "POST", { planId: plan.id });
  assert.equal(run.status, "passed");
  assert.equal(
    f.seen.at(-1).url,
    url.split("#")[0],
    "frozen plan is isolated from live edit",
  );
  const cli = await exec(
    process.execPath,
    ["scripts/run-plan.mjs", "--project", project.id, "--plan", plan.id],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, LOCAL_API_DATA: root },
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(JSON.parse(cli.stdout).status, "passed");
  assert.equal(f.seen.at(-1).url, url.split("#")[0]);
  const backup = await call(route + "/export");
  assert.equal(backup.plans[0].steps[0].request.url, url);
  assert.equal(backup.requests[0].url, f.originURL + "/changed#new-fragment");
  await close();
  app = await createApp({ root, port: 0 });
  const persisted = await call(route);
  assert.equal(persisted.plans[0].steps[0].request.url, url);
  assert.equal(persisted.runs.length, 2);
  const restored = await call("/api/restore", "POST", { document: backup });
  assert.equal(restored.plans[0].steps[0].request.url, url);
  const restoredRun = await call(
    "/api/projects/" + restored.id + "/run",
    "POST",
    { planId: plan.id },
  );
  assert.equal(restoredRun.status, "passed");
  assert.equal(f.seen.at(-1).url, url.split("#")[0]);
  assert.equal(
    f.seen.length,
    4,
    "no hidden replay from persistence, restart or restore",
  );
  assert.equal(
    f.seen.every((entry) => !entry.url.includes("#")),
    true,
  );
  assert.equal(
    (await call("/api/projects/" + restored.id)).plans[0].steps[0].request.url,
    url,
  );
});

test(
  "official MCP HTTP and stdio execute saved proxy definitions with grants and history isolation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, true);
    const root = await mkdtemp(path.join(os.tmpdir(), "proxy-target-sdk-"));
    const app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((client) => client.close()));
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("SDK proxy target"),
      denied = await app.store.create("Denied");
    const url = f.originURL + "/sdk%23route?x=one&x=two#private-fragment";
    project.requests = [
      {
        id: "sdk",
        url,
        proxy: f.proxyURL,
        tls: { proxyCa: cert },
        auth: { type: "bearer", token: "owned" },
      },
    ];
    await app.store.save(project);
    const configResponse = await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        projects: [project.id],
        write: true,
        execute: true,
        remember: false,
      }),
    });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    for (const transport of [
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.resolve(import.meta.dirname, "../src/mcp.mjs"),
          "--project",
          project.id,
          "--write",
          "--execute",
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    ]) {
      const client = new Client(
        { name: "proxy-target-fixture", version: "1.0.0" },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(transport);
      const count = f.seen.length;
      const refused = await client.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: denied.id, apiId: "sdk" },
      });
      assert.equal(refused.isError, true);
      assert.equal(f.seen.length, count);
      const result = await client.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: project.id, apiId: "sdk" },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const run = JSON.parse(result.content[0].text);
      assert.equal(run.status, "passed");
      assert.equal(f.seen.at(-1).url, url.split("#")[0]);
      const saved = await app.store.get(project.id);
      assert.equal(saved.requests[0].url, url);
      assert.equal(saved.history[0].id, run.id);
      assert.equal(saved.history[0].source, "mcp");
    }
    assert.equal(f.seen.length, 2);
    assert.equal((await app.store.get(project.id)).history.length, 2);
    assert.equal((await app.store.get(denied.id)).history.length, 0);
  },
);

test("signed OAuth1 query and exact form body remain equivalent through a forward proxy", async (t) => {
  const f = await fixture(t);
  const definition = {
    url:
      f.originURL +
      "/signed%23path?x=one&x=two&escaped=%23kept#private-fragment",
    method: "POST",
    bodyType: "urlencoded",
    form: [
      { key: "space", value: "a b+c" },
      { key: "repeat", value: "one" },
      { key: "repeat", value: "two" },
    ],
    auth: {
      type: "oauth1",
      consumerKey: "owned-consumer",
      consumerSecret: "owned-secret",
      accessToken: "owned-token",
      tokenSecret: "owned-token-secret",
      nonce: "fixed-fixture",
      timestamp: "1700000000",
    },
  };
  const direct = await executeRequest(definition);
  const proxied = await executeRequest({ ...definition, proxy: f.proxyURL });
  assert.equal(proxied.status, 200);
  assert.deepEqual(JSON.parse(proxied.body), JSON.parse(direct.body));
  const actual = JSON.parse(proxied.body);
  assert.match(actual.authorization, /^OAuth /);
  assert.equal(
    Buffer.from(actual.body, "base64").toString(),
    "space=a+b%2Bc&repeat=one&repeat=two",
  );
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].url, definition.url.split("#")[0]);
});
