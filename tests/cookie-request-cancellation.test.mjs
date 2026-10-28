import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { ProjectCookieJar, memoryCookieSession } from "../src/cookie-jar.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { readHttpFinalizationFailure } from "../src/http-finalization.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cookie-cancel-"));
  const jar = new ProjectCookieJar(root, "project", "dev");
  const isolated = new ProjectCookieJar(root, "project", "prod");
  const requests = [],
    releases = [];
  let handler = (_req, res) => res.end("healthy");
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie || "" });
    Promise.resolve(handler(req, res)).catch((error) => res.destroy(error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const release of releases) await release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await jar.configure({ enabled: true, expectedRevision: 0 });
  await jar.setCookie(url, "seed=before; Path=/", { expectedRevision: 1 });
  await isolated.configure({ enabled: true, expectedRevision: 0 });
  await isolated.setCookie(url, "isolated=keep; Path=/", {
    expectedRevision: 1,
  });
  const before = await readFile(jar.file),
    isolatedBefore = await readFile(isolated.file);
  async function hold() {
    const release = await acquireFileLock(jar.file + ".lock");
    releases.push(release);
    return release;
  }
  async function healthy() {
    handler = (_req, res) => res.end("healthy");
    const previous = requests.length;
    const response = await executeRequest({ url, timeout: 1000 }, undefined, {
      cookieSession: jar,
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, previous + 1);
    assert.equal(requests.at(-1).cookie, "seed=before");
    assert.equal(
      await new ProjectCookieJar(root, "project", "dev").header(url),
      "seed=before",
    );
    assert.deepEqual(await readFile(jar.file), before);
    assert.deepEqual(await readFile(isolated.file), isolatedBefore);
    await sleep(40);
    assert.deepEqual(await readFile(jar.file), before);
    assert.equal(requests.length, previous + 1);
    assert.deepEqual(
      (await readdir(jar.directory)).filter((name) =>
        /\.(tmp|lock)$/.test(name),
      ),
      [],
    );
  }
  return {
    root,
    jar,
    before,
    url,
    requests,
    hold,
    healthy,
    setHandler(value) {
      handler = value;
    },
  };
}

for (const mode of ["abort", "deadline"]) {
  test(
    `header ${mode} settles while the real local lock remains held, with zero HTTP`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t),
        release = await f.hold();
      const controller = new AbortController();
      const running = executeRequest(
        { url: f.url, timeout: mode === "deadline" ? 100 : 2000 },
        controller.signal,
        { cookieSession: f.jar },
      );
      const assertion = assert.rejects(running, {
        code: mode === "abort" ? "ABORT_ERR" : "REQUEST_TIMEOUT",
      });
      if (mode === "abort") {
        await sleep(25);
        controller.abort();
      }
      await assertion;
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await readFile(f.jar.file), f.before);
      assert.equal(
        JSON.parse(
          await readFile(path.join(f.jar.file + ".lock", "owner.json")),
        ).pid,
        process.pid,
      );
      await release();
      await f.healthy();
    },
  );

  test(
    `capture ${mode} retains real HTTP evidence, blocks late cookie publication and postprocessing`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t),
        entered = deferred();
      let release;
      const capture = f.jar.capture;
      f.jar.capture = function (...args) {
        const pending = Reflect.apply(capture, this, args);
        entered.resolve();
        return pending;
      };
      f.setHandler(async (_req, res) => {
        release = await f.hold();
        res.setHeader("Set-Cookie", "late=must-not-persist; Path=/");
        res.setHeader("X-Real-Evidence", "completed");
        res.setHeader("Content-Type", "application/json");
        res.end('{"value":42}');
      });
      const controller = new AbortController();
      const plan = snapshotPlan({
        steps: [
          {
            request: {
              url: f.url,
              timeout: mode === "deadline" ? 150 : 2000,
              before: [
                { type: "set", name: "beforeMarker", value: "already-ran" },
              ],
              assertions: [{ target: "status", op: "eq", value: 200 }],
              extract: [
                { name: "runtimeValue", path: "$.value" },
                { name: "globalValue", path: "$.value", scope: "global" },
              ],
              after: [
                { type: "set", name: "afterMarker", value: "must-not-run" },
              ],
            },
          },
          { request: { url: f.url + "/must-not-run" } },
        ],
      });
      const running = runPlan(plan, { untouched: "keep" }, executeRequest, {
        signal: controller.signal,
        cookieSession: f.jar,
      });
      await entered.promise;
      if (mode === "abort") controller.abort();
      const run = await running;
      assert.equal(run.status, mode === "abort" ? "cancelled" : "failed");
      assert.equal(run.results.length, 1);
      const step = run.results[0];
      assert.equal(step.status, "failed");
      assert.equal(step.response.status, 200);
      assert.equal(step.response.headers["x-real-evidence"], "completed");
      assert.equal(step.response.body, '{"value":42}');
      assert.deepEqual(step.failure, {
        phase: "cookie-capture",
        code: mode === "abort" ? "REQUEST_CANCELLED" : "REQUEST_TIMEOUT",
        retry_safe: false,
      });
      assert.equal(step.response.failure, step.failure);
      assert.deepEqual(step.assertions, []);
      assert.deepEqual(step.extracted, {});
      assert.equal(run.variables.untouched, "keep");
      assert.equal(run.variables.beforeMarker, "already-ran");
      for (const name of ["runtimeValue", "globalValue", "afterMarker"])
        assert.equal(run.variables[name], undefined);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await readFile(f.jar.file), f.before);
      await release();
      await f.healthy();
    },
  );
}

test(
  "Cookie header wait consumes network budget instead of granting a fresh timeout",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      release = await f.hold();
    f.setHandler(async (_req, res) => {
      await sleep(160);
      res.end("too late for remaining budget");
    });
    const running = executeRequest({ url: f.url, timeout: 220 }, undefined, {
      cookieSession: f.jar,
    });
    const assertion = assert.rejects(running, /超时/);
    await sleep(130);
    await release();
    await assertion;
    assert.equal(f.requests.length, 1);
    await f.healthy();
  },
);

test(
  "trusted failure preserves the same response and header objects; arbitrary error.response is ignored",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      entered = deferred();
    let release, carried;
    const original = f.jar.capture;
    f.jar.capture = function (...args) {
      const pending = Reflect.apply(original, this, args);
      entered.resolve();
      return pending;
    };
    f.setHandler(async (_req, res) => {
      release = await f.hold();
      res.setHeader("Set-Cookie", "late=1");
      res.end("complete");
    });
    const controller = new AbortController();
    const realExecute = async (...args) => {
      try {
        return await executeRequest(...args);
      } catch (error) {
        carried = readHttpFinalizationFailure(error);
        throw error;
      }
    };
    const plan = snapshotPlan({ steps: [{ request: { url: f.url } }] });
    const running = runPlan(plan, {}, realExecute, {
      cookieSession: f.jar,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    const run = await running;
    assert.equal(run.results[0].response, carried.response);
    assert.equal(run.results[0].response.headers, carried.response.headers);
    await release();
    await f.healthy();
    const forged = Object.assign(Error("forged"), {
      response: { status: 200 },
      failure: {
        phase: "cookie-capture",
        code: "REQUEST_TIMEOUT",
        retry_safe: false,
      },
    });
    assert.equal(readHttpFinalizationFailure(forged), undefined);
    const fakeRun = await runPlan(plan, {}, async () => {
      throw forged;
    });
    assert.equal(fakeRun.results[0].response, undefined);
    assert.equal(fakeRun.results[0].failure, undefined);
  },
);

test("immediate post-execute abort skips postprocessing even with no Cookie capture", async () => {
  const controller = new AbortController(),
    response = { status: 200, headers: { "x-real": "yes" }, body: '{"x":1}' };
  const run = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://127.0.0.1/unused",
            assertions: [{ target: "status", op: "eq", value: 200 }],
            extract: [{ name: "x", path: "$.x" }],
            after: [{ type: "set", name: "after", value: "wrong" }],
          },
        },
      ],
    }),
    {},
    async () => {
      controller.abort();
      return response;
    },
    { signal: controller.signal },
  );
  assert.equal(run.status, "cancelled");
  assert.equal(run.results[0].response, response);
  assert.equal(run.results[0].failure.phase, "response-finalization");
  assert.deepEqual(run.results[0].assertions, []);
  assert.deepEqual(run.results[0].extracted, {});
  assert.deepEqual(run.variables, {});
});

test(
  "ordinary capture storage failure remains a warning on real HTTP success",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const session = {
      header: (...args) => f.jar.header(...args),
      capture: async () => {
        throw Error("fixture storage denied");
      },
    };
    const response = await executeRequest({ url: f.url }, undefined, {
      cookieSession: session,
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.cookieError,
      "Cookie保存失败：fixture storage denied",
    );
    assert.equal(response.failure, undefined);
  },
);

test(
  "transaction checks controls before callback and before publishing; memory sessions share the contract",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      controller = new AbortController();
    let calls = 0;
    controller.abort();
    await assert.rejects(
      f.jar.transact(
        () => {
          calls++;
        },
        { write: true, signal: controller.signal },
      ),
      { code: "ABORT_ERR" },
    );
    assert.equal(calls, 0);
    const later = new AbortController();
    await assert.rejects(
      f.jar.transact(
        async (state) => {
          state.enabled = false;
          later.abort();
        },
        { write: true, signal: later.signal },
      ),
      { code: "ABORT_ERR" },
    );
    assert.deepEqual(await readFile(f.jar.file), f.before);
    for (const deadline of [NaN, Infinity, -Infinity, "soon"]) {
      await assert.rejects(f.jar.header(f.url, { deadline }), TypeError);
      await assert.rejects(
        acquireFileLock(f.jar.file + ".lock", { deadline }),
        TypeError,
      );
    }
    const memory = memoryCookieSession(await f.jar.inspect());
    await assert.rejects(
      memory.capture(f.url, ["late=1"], { signal: controller.signal }),
      { code: "ABORT_ERR" },
    );
    await assert.rejects(
      memory.capture(f.url, undefined, { deadline: performance.now() - 1 }),
      { code: "REQUEST_TIMEOUT" },
    );
    await assert.rejects(memory.header(f.url, { signal: controller.signal }), {
      code: "ABORT_ERR",
    });
    assert.equal(await memory.header(f.url), "seed=before");
    await f.healthy();
  },
);

test(
  "Digest replay shares the absolute deadline including the initial Cookie wait",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      release = await f.hold(),
      deadlines = [];
    const original = f.jar.header;
    f.jar.header = function (...args) {
      deadlines.push(args[1].deadline);
      return Reflect.apply(original, this, args);
    };
    f.setHandler(async (req, res) => {
      if (!req.headers.authorization) {
        await sleep(140);
        res.writeHead(401, {
          "WWW-Authenticate":
            'Digest realm="fixture", nonce="abc", qop="auth", algorithm=SHA-256',
        });
        res.end("challenge");
      } else {
        await sleep(220);
        res.end("authenticated too late");
      }
    });
    const running = executeRequest(
      {
        url: f.url,
        timeout: 400,
        auth: { type: "digest", username: "tester", password: "fixture" },
      },
      undefined,
      { cookieSession: f.jar },
    );
    const assertion = assert.rejects(running, /超时/);
    await sleep(100);
    await release();
    await assertion;
    assert.equal(f.requests.length, 2);
    assert.equal(deadlines.length, 2);
    assert.equal(deadlines[0], deadlines[1]);
    await f.healthy();
  },
);

test(
  "Digest replay Cookie wait abort retains the completed challenge, without another request",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      replay = deferred();
    let headers = 0,
      release;
    const original = f.jar.header;
    f.jar.header = function (...args) {
      const pending = Reflect.apply(original, this, args);
      if (++headers === 2) replay.resolve();
      return pending;
    };
    f.setHandler(async (_req, res) => {
      release = await f.hold();
      res.writeHead(401, {
        "WWW-Authenticate":
          'Digest realm="fixture", nonce="abc", qop="auth", algorithm=SHA-256',
      });
      res.end("actual challenge");
    });
    const controller = new AbortController();
    const running = executeRequest(
      {
        url: f.url,
        auth: { type: "digest", username: "tester", password: "fixture" },
      },
      controller.signal,
      { cookieSession: f.jar },
    );
    const assertion = assert.rejects(running, (error) => {
      const completed = readHttpFinalizationFailure(error);
      assert.equal(completed.response.status, 401);
      assert.equal(completed.response.body, "actual challenge");
      assert.equal(completed.failure.phase, "auth-cookie");
      assert.equal(completed.failure.code, "REQUEST_CANCELLED");
      return true;
    });
    await replay.promise;
    controller.abort();
    await assertion;
    assert.equal(f.requests.length, 1);
    await release();
    await f.healthy();
  },
);

test(
  "abort after a real Cookie commit reports failed finalization without promising rollback",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      controller = new AbortController();
    const original = f.jar.capture;
    let committed = false;
    f.jar.capture = async function (...args) {
      const result = await Reflect.apply(original, this, args);
      if (args[1] !== undefined) {
        committed = true;
        controller.abort();
      }
      return result;
    };
    f.setHandler((_req, res) => {
      res.setHeader("Set-Cookie", "committed=stays; Path=/");
      res.end("complete");
    });
    const run = await runPlan(
      snapshotPlan({ steps: [{ request: { url: f.url } }] }),
      {},
      executeRequest,
      { signal: controller.signal, cookieSession: f.jar },
    );
    assert.equal(committed, true);
    assert.equal(run.status, "cancelled");
    assert.equal(run.results[0].response.status, 200);
    assert.equal(run.results[0].failure.retry_safe, false);
    const after = await readFile(f.jar.file);
    assert.equal(JSON.parse(after).revision, 3);
    assert.equal(
      await new ProjectCookieJar(f.root, "project", "dev").header(f.url),
      "seed=before; committed=stays",
    );
    await sleep(40);
    assert.deepEqual(await readFile(f.jar.file), after);
    assert.deepEqual(
      (await readdir(f.jar.directory)).filter((name) =>
        /\.(tmp|lock)$/.test(name),
      ),
      [],
    );
    f.setHandler((_req, res) => res.end("healthy"));
    assert.equal(
      (
        await executeRequest({ url: f.url }, undefined, {
          cookieSession: f.jar,
        })
      ).status,
      200,
    );
    assert.equal(f.requests.at(-1).cookie, "seed=before; committed=stays");
  },
);

test(
  "Digest native replay abort preserves the completed challenge without accepting forged error metadata",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      replay = deferred();
    f.setHandler((req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(401, {
          "WWW-Authenticate":
            'Digest realm="fixture", nonce="abc", qop="auth", algorithm=SHA-256',
        });
        res.end("actual challenge");
      } else replay.resolve();
    });
    const controller = new AbortController();
    const running = executeRequest(
      {
        url: f.url,
        auth: { type: "digest", username: "tester", password: "fixture" },
      },
      controller.signal,
      { cookieSession: f.jar },
    );
    const assertion = assert.rejects(running, (error) => {
      const completed = readHttpFinalizationFailure(error);
      assert.equal(completed.response.status, 401);
      assert.equal(completed.response.body, "actual challenge");
      assert.equal(completed.failure.code, "REQUEST_CANCELLED");
      return true;
    });
    await replay.promise;
    controller.abort({ response: { status: 299 }, code: "forged" });
    await assertion;
    assert.equal(f.requests.length, 2);
    await f.healthy();
  },
);

for (const mode of ["abort", "deadline"]) {
  test(
    `request header ${mode} interrupts a real cross-process Cookie owner before any HTTP`,
    { timeout: 6000 },
    async (t) => {
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      const { createInterface } = await import("node:readline");
      const f = await fixture(t);
      const source = `import {acquireFileLock} from ${JSON.stringify(new URL("../src/file-lock.mjs", import.meta.url).href)};
      const release = await acquireFileLock(process.argv[1]);
      const failSafe = setTimeout(async () => { await release(); process.exit(2); }, 4000);
      process.stdin.once('data', async () => { clearTimeout(failSafe); await release(); process.exit(0); });
      console.log('held');`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", source, f.jar.file + ".lock"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      t.after(async () => {
        if (child.exitCode === null) child.stdin.end("release\n");
        await exited;
      });
      const lines = createInterface({ input: child.stdout });
      assert.equal((await once(lines, "line"))[0], "held");
      const owner = await readFile(
        path.join(f.jar.file + ".lock", "owner.json"),
      );
      const controller = new AbortController();
      const running = executeRequest(
        { url: f.url, timeout: mode === "deadline" ? 100 : 2000 },
        controller.signal,
        { cookieSession: f.jar },
      );
      const assertion = assert.rejects(running, {
        code: mode === "abort" ? "ABORT_ERR" : "REQUEST_TIMEOUT",
      });
      if (mode === "abort") {
        await sleep(25);
        controller.abort();
      }
      await assertion;
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await readFile(f.jar.file), f.before);
      assert.deepEqual(
        await readFile(path.join(f.jar.file + ".lock", "owner.json")),
        owner,
      );
      child.stdin.end("release\n");
      assert.equal((await exited)[0], 0);
      await f.healthy();
    },
  );
}
