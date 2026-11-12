import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { hardStopDesktopProcess } from "./helpers/desktop-hard-stop.mjs";
import { desktopLayout } from "../desktop/build-layout.mjs";
import { exerciseRestartJourney } from "./helpers/restart-journey-ui.mjs";
import {
  assertCleanDesktopExit,
  assertCrashDesktopExit,
} from "./helpers/desktop-restart-receipt.mjs";
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--crash"),
  "Unknown journey option",
);
const crash = process.argv.includes("--crash");
const root = await mkdtemp(path.join(tmpdir(), "packaged-restart-journey-"));
const evidence = path.resolve(
  crash ? "dist/desktop-crash-evidence" : "dist/desktop-restart-evidence",
  process.platform,
);
const databaseFile = path.join(root, "journey.sqlite");
const hits = [],
  errors = [],
  hosts = [];
let failed = false,
  phase = "setup";
const mark = (value) => {
  phase = value;
  console.log("DESKTOP_RESTART_STAGE", value);
};
const peer = http.createServer((req, res) => {
  hits.push({
    authorization: req.headers.authorization,
    database: req.headers["x-journey-db"],
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ value: "journey-response" }));
});
async function bounded(promise, label, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function launch(generation) {
  const application = await electron.launch({
    executablePath: desktopLayout().executable,
    // Electron does not enable Playwright download events by default.
    acceptDownloads: true,
    env: { ...process.env, LOCAL_API_DESKTOP_DATA: root },
    timeout: 30000,
  });
  const child = application.process(),
    exit = once(child, "exit"),
    closed = once(child, "close");
  let saved = false,
    forced = false,
    stopped = false,
    tracing = false,
    tail = "";
  child.stderr?.on("data", (chunk) => {
    // Retain only a boolean receipt, not raw stderr or launch tokens.
    tail = (tail + String(chunk)).slice(-512);
    if (tail.includes("LOCAL_API_SHUTDOWN_SAVED")) saved = true;
  });
  const host = {
    application,
    child,
    pid: child.pid,
    async endTrace() {
      if (tracing) {
        tracing = false;
        await application.context().tracing.stop({
          path: path.join(evidence, `generation-${generation}.zip`),
        });
      }
    },
    async quit() {
      await host.endTrace();
      // Do not dismiss native dirty-state prompts or call app.exit/kill on success.
      await application.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 10);
      });
      const [code, signal] = await bounded(exit, "Desktop clean exit timeout");
      await bounded(closed, "Desktop process close timeout");
      stopped = true;
      assertCleanDesktopExit({ code, signal, closed: true, saved, forced });
      console.log("DESKTOP_RESTART_CLEAN_EXIT", generation);
    },
    async crash() {
      await host.endTrace();
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      // OS hard stop (owned tree on Windows); no app.quit, app.exit or save hook.
      forced = true;
      const sent = await hardStopDesktopProcess(child);
      const [code, signal] = await bounded(exit, "Desktop hard-stop timeout");
      await bounded(closed, "Desktop hard-stop close timeout");
      stopped = true;
      assertCrashDesktopExit({
        code,
        signal,
        closed: true,
        saved,
        forced,
        sent,
        platform: process.platform,
      });
      console.log("DESKTOP_CRASH_EXIT", generation);
    },
    async cleanup() {
      const failures = [];
      try {
        await host.endTrace();
      } catch {
        failures.push(Error("Desktop trace cleanup failed"));
      }
      if (!stopped) {
        forced = true;
        if (child.exitCode === null && child.signalCode === null)
          await hardStopDesktopProcess(child);
        try {
          await bounded(closed, "Desktop cleanup close timeout");
          stopped = true;
        } catch {
          failures.push(Error("Desktop cleanup did not settle"));
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Desktop cleanup failed");
    },
  };
  hosts.push(host);
  const page = await application.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#new-project").waitFor();
  await application
    .context()
    .tracing.start({ screenshots: true, snapshots: true, sources: true });
  tracing = true;
  const url = new URL(page.url());
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem("local-api-token") ||
      new URLSearchParams(location.hash.slice(1)).get("token"),
  );
  assert.ok(token);
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      nodeIntegration: p.nodeIntegration,
      contextIsolation: p.contextIsolation,
      sandbox: p.sandbox,
    };
  });
  assert.deepEqual(preferences, {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  return Object.assign(host, { page, url: url.origin, token });
}
try {
  await mkdir(evidence, { recursive: true });
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(
      "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('journey-db')",
    );
  } finally {
    db.close();
  }
  await new Promise((resolve, reject) => {
    peer.once("error", reject);
    peer.listen(0, "127.0.0.1", resolve);
  });
  let host = await launch(1);
  await exerciseRestartJourney({
    initialPage: host.page,
    databaseFile,
    hits,
    peerURL: `http://127.0.0.1:${peer.address().port}`,
    screenshotPath: (name) => path.join(evidence, name),
    mark,
    restart: async () => {
      const first = host,
        before = hits.length;
      assert.equal(
        await first.page.locator("#saved-state").innerText(),
        "✓ 已保存",
      );
      if (crash) await first.crash();
      else await first.quit();
      await assert.rejects(fetch(first.url + "/api/session"));
      host = await launch(2);
      assert.notEqual(host.pid, first.pid);
      assert.notEqual(host.token, first.token);
      const rejected = await fetch(host.url + "/api/session", {
        headers: { "x-local-token": first.token },
      });
      assert.equal(rejected.status, 403);
      assert.equal(
        hits.length,
        before,
        "Electron restart must not replay requests",
      );
      return host.page;
    },
  });
  assert.deepEqual(errors, []);
  const beforeQuit = hits.length;
  await host.quit();
  assert.equal(hits.length, beforeQuit);
  console.log(
    crash
      ? "PACKAGED_DESKTOP_CRASH_JOURNEY_PASS"
      : "PACKAGED_DESKTOP_RESTART_JOURNEY_PASS",
  );
} catch (error) {
  failed = true;
  console.error("DESKTOP_RESTART_JOURNEY_FAILED", phase);
  throw error;
} finally {
  const failures = [];
  for (const host of hosts) {
    try {
      await host.cleanup();
    } catch {
      failures.push(Error("Desktop host cleanup failed"));
    }
  }
  try {
    if (peer.listening) {
      peer.closeAllConnections();
      await new Promise((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } catch {
    failures.push(Error("Desktop peer cleanup failed"));
  }
  if (!failures.length) {
    try {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      failures.push(Error("Desktop root cleanup failed"));
    }
  }
  if (failures.length) {
    console.error("DESKTOP_RESTART_CLEANUP_FAILED", failures.length);
    if (!failed) throw new AggregateError(failures, "Desktop cleanup failed");
  }
}
