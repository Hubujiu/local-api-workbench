import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectCookieJar } from "../src/cookie-jar.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { readHttpRedirectFailure } from "../src/http-redirect.mjs";
for (const phase of ["capture", "next-header"])
  for (const action of ["cancelled", "timeout"])
    test(
      `redirect ${phase} real Cookie lock ${action} stops while lock held without later network or Cookie publication`,
      { timeout: 10000 },
      async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "redirect-cookie-"));
        const jar = new ProjectCookieJar(root, "project", "selected");
        const other = new ProjectCookieJar(root, "project", "other");
        let requests = 0,
          release,
          notify,
          phaseTimer;
        const reached = new Promise((resolve) => (notify = resolve));
        const server = http.createServer((_req, res) => {
          requests++;
          res.writeHead(302, {
            location: "/next",
            "set-cookie": "next=yes; Path=/",
          });
          res.end("actual-first");
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        t.after(async () => {
          clearTimeout(phaseTimer);
          await release?.();
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          await rm(root, { recursive: true, force: true });
        });
        await jar.configure({ enabled: true, expectedRevision: 0 });
        await other.configure({ enabled: true, expectedRevision: 0 });
        const before = await readFile(jar.file),
          otherBefore = await readFile(other.file);
        let headers = 0,
          captures = 0;
        async function hold() {
          release = await acquireFileLock(jar.file + ".lock");
          notify();
        }
        const session = {
          async header(...args) {
            headers++;
            if (phase === "next-header" && headers === 2) await hold();
            return jar.header(...args);
          },
          async capture(...args) {
            captures++;
            if (phase === "capture" && captures === 1) await hold();
            return jar.capture(...args);
          },
        };
        const controller = new AbortController();
        const pending = executeRequest(
          {
            url,
            timeout: action === "timeout" ? 700 : 3000,
            redirect: { mode: "same-origin" },
          },
          controller.signal,
          { cookieSession: session },
        );
        pending.catch(() => {});
        await Promise.race([
          reached,
          new Promise(
            (_, reject) =>
              (phaseTimer = setTimeout(
                () => reject(Error("fixture never reached lock phase")),
                4000,
              )),
          ),
        ]);
        clearTimeout(phaseTimer);
        const locked = await readFile(jar.file);
        if (action === "cancelled") controller.abort();
        let error;
        try {
          await pending;
        } catch (e) {
          error = e;
        }
        const evidence = readHttpRedirectFailure(error);
        assert.ok(evidence);
        assert.equal(evidence.failure.reason, action);
        assert.equal(evidence.response.status, 302);
        assert.equal(evidence.failure.responseComplete, true);
        assert.equal(requests, 1);
        assert.equal(evidence.failure.requestStarted, phase === "capture");
        assert.deepEqual(await readFile(jar.file), locked);
        if (phase === "capture") assert.deepEqual(locked, before);
        else assert.notDeepEqual(locked, before);
        await release();
        release = undefined;
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.deepEqual(await readFile(jar.file), locked);
        assert.deepEqual(await readFile(other.file), otherBefore);
        assert.equal(requests, 1);
        assert.equal(
          await new ProjectCookieJar(root, "project", "selected").header(url),
          phase === "capture" ? "" : "next=yes",
        );
      },
    );
