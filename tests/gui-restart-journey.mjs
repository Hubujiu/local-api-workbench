// Independent browser acceptance: real product child-process restart, not reload.
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { exerciseRestartJourney } from "./helpers/restart-journey-ui.mjs";
import { startJourneyServer } from "./helpers/gui-journey-server.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = await mkdtemp(path.join(tmpdir(), "gui-full-journey-"));
const databaseFile = path.join(root, "journey.sqlite");
const hits = [];
const peer = http.createServer((req, res) => {
  hits.push({
    authorization: req.headers.authorization,
    database: req.headers["x-journey-db"],
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ value: "journey-response" }));
});
let server,
  browser,
  context,
  page,
  phase = "startup";
const errors = [];
let failed = false;
const mark = (value) => {
  phase = value;
  console.log("GUI_JOURNEY_STAGE", value);
};
try {
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(
      "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('journey-db')",
    );
  } finally {
    database.close();
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    peer.once("error", onError);
    peer.listen(0, "127.0.0.1", () => {
      peer.off("error", onError);
      resolve();
    });
  });
  server = await startJourneyServer(root);
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_BUNDLED
      ? undefined
      : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.launchUrl);
  await exerciseRestartJourney({
    initialPage: page,
    databaseFile,
    hits,
    peerURL: `http://127.0.0.1:${peer.address().port}`,
    screenshotPath: (name) => `/tmp/local-api-restart-${name}`,
    mark,
    restart: async () => {
      const first = server;
      await page.goto("about:blank");
      await first.close();
      server = null;
      await assert.rejects(fetch(first.url + "/api/session"));
      server = await startJourneyServer(root);
      assert.notEqual(server.pid, first.pid);
      assert.notEqual(
        server.launchUrl.split("#token=")[1],
        first.launchUrl.split("#token=")[1],
      );
      await page.goto(server.launchUrl);
      return page;
    },
  });
  assert.deepEqual(errors, []);
  console.log("GUI_RESTART_JOURNEY_PASS");
} catch (error) {
  failed = true;
  console.error("GUI_RESTART_JOURNEY_FAILED", phase);
  throw error;
} finally {
  // Every cleanup runs even if trace finalization or browser shutdown rejects.
  const cleanupErrors = [];
  for (const cleanup of [
    () =>
      context?.tracing.stop({
        path: "/tmp/local-api-restart-journey-trace.zip",
      }),
    () => browser?.close(),
    () => server?.close(),
    async () => {
      if (!peer.listening) return;
      peer.closeAllConnections();
      await new Promise((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  ]) {
    try {
      await cleanup();
    } catch {
      cleanupErrors.push(Error("Journey cleanup failed"));
    }
  }
  // Preserve the isolated root if shutdown could not be verified.
  if (!cleanupErrors.length) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      cleanupErrors.push(Error("Journey root cleanup failed"));
    }
  }
  if (cleanupErrors.length) {
    console.error("GUI_RESTART_JOURNEY_CLEANUP_FAILED", cleanupErrors.length);
    if (!failed)
      throw new AggregateError(cleanupErrors, "Journey cleanup failed");
  }
}
