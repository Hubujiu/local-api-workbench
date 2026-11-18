import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import http from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exerciseRestartJourney } from "./helpers/restart-journey-ui.mjs";
import { assertCleanDesktopExit } from "./helpers/desktop-restart-receipt.mjs";
import { hardStopDesktopProcess } from "./helpers/desktop-hard-stop.mjs";
import {
  assertRuntimeIdentity,
  inventory,
  loadProductPlan,
  noAlias,
} from "./helpers/installed-product-contract.mjs";

const args = process.argv.slice(2);
assert.equal(
  args.length,
  5,
  "Use --plan FILE --expected-plan-sha256 DIGEST --execute-in-disposable-windows",
);
assert.equal(args[0], "--plan");
assert.equal(args[2], "--expected-plan-sha256");
assert.equal(args[4], "--execute-in-disposable-windows");
assert.equal(process.platform, "win32", "Native disposable Windows required");
const plan = await loadProductPlan(path.resolve(args[1]), args[3]);
assert.ok(path.isAbsolute(process.env.LOCALAPPDATA));
await noAlias(process.env.LOCALAPPDATA);
const target = path.join(process.env.LOCALAPPDATA, plan.directory);
await assert.rejects(
  stat(target),
  { code: "ENOENT" },
  "Existing installation refused",
);
await assert.rejects(
  stat(target + ".retained-foreign"),
  { code: "ENOENT" },
  "Existing retained directory refused",
);
const root = await mkdtemp(path.join(tmpdir(), "installed-product-journey-"));
await noAlias(root);
const profile = path.join(root, "synthetic-profile");
const evidence = path.join(root, "evidence");
await mkdir(profile);
await mkdir(evidence);
const { _electron: electron } = await import(
  "../packaging/windows-msi/journey-tools/node_modules/playwright/index.mjs"
);
const hits = [],
  errors = [],
  hosts = [],
  steps = [];
const result = {
  kind: "installed-product-lifecycle",
  planSha256: args[3],
  sourceHeads: plan.packages.map((p) => p.head),
  root,
  target,
  steps,
  nativeProductJourneyPassed: false,
  signatureVerified: false,
  iceValidated: false,
};
console.log("INSTALLED_PRODUCT_EVIDENCE", evidence);
const peer = http.createServer((req, res) => {
  hits.push({
    authorization: req.headers.authorization,
    database: req.headers["x-journey-db"],
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ value: "journey-response" }));
});
const foreignName = "foreign-product-journey-sentinel.txt";
const foreignBytes = "Retain foreign application-directory file";
const foreignDigest = createHash("sha256").update(foreignBytes).digest("hex");
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
async function packageInventory(item, foreign) {
  assert.deepEqual(await inventory(target), {
    ...(item?.contract.fileHashes ?? {}),
    ...(foreign ? { [foreignName]: foreignDigest } : {}),
  });
}
async function registration(expected) {
  const script = fileURLToPath(
    new URL(
      "../scripts/check_installed_product_registration.ps1",
      import.meta.url,
    ),
  );
  const { stdout } = await promisify(execFile)(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-Plan",
      path.resolve(args[1]),
      "-Expected",
      expected,
    ],
    { timeout: 30000, windowsHide: true, shell: false },
  );
  steps.push({
    label: "registration-" + expected,
    observations: JSON.parse(stdout),
  });
}
async function install(item, label, remove = false) {
  // Recheck pinned bytes immediately before the external installer invocation.
  assert.equal(
    createHash("sha256")
      .update(await readFile(item.msi.path))
      .digest("hex"),
    item.msi.sha256,
  );
  const before = await inventory(profile);
  const command = path.join(process.env.SystemRoot, "System32", "msiexec.exe");
  const child = spawn(
    command,
    [
      remove ? "/x" : "/i",
      item.msi.path,
      "/qn",
      "/norestart",
      "REBOOT=ReallySuppress",
      "/L*v",
      path.join(evidence, label + ".log"),
    ],
    { shell: false, windowsHide: true, stdio: "ignore" },
  );
  const exited = once(child, "exit");
  let code, signal;
  try {
    [code, signal] = await bounded(
      exited,
      "MSI timeout: service state uncertain; do not retry or clean up",
      120000,
    );
  } catch (error) {
    child.unref();
    throw error;
  }
  assert.equal(signal, null);
  assert.equal(code, 0, "MSI operation failed: " + label);
  assert.deepEqual(
    await inventory(profile),
    before,
    "Installer must not mutate profile/project files",
  );
  steps.push({ label, exitCode: code, profilePreserved: true });
}
async function launch(item, generation, foreign) {
  await packageInventory(item, foreign);
  const pkg = JSON.parse(
    await readFile(path.join(target, "resources/app/package.json"), "utf8"),
  );
  assert.equal(pkg.version, item.version);
  const executable = path.join(target, "LocalAPI.exe");
  const application = await electron.launch({
    executablePath: executable,
    acceptDownloads: true,
    env: { ...process.env, LOCAL_API_DESKTOP_DATA: profile },
    timeout: 30000,
  });
  const child = application.process(),
    exit = once(child, "exit"),
    closed = once(child, "close");
  let saved = false,
    stopped = false,
    tail = "",
    tracing = false;
  child.stderr?.on("data", (chunk) => {
    tail = (tail + String(chunk)).slice(-512);
    if (tail.includes("LOCAL_API_SHUTDOWN_SAVED")) saved = true;
  });
  const host = {
    application,
    child,
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
      await application.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 10);
      });
      const [code, signal] = await bounded(
        exit,
        "Clean application exit timed out",
      );
      await bounded(closed, "Application pipes did not close");
      stopped = true;
      assertCleanDesktopExit({
        code,
        signal,
        saved,
        forced: false,
        closed: true,
      });
    },
    async cleanup() {
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        await host.endTrace().catch(() => {});
        await hardStopDesktopProcess(child);
        await bounded(closed, "Owned desktop cleanup timed out");
        stopped = true;
      }
    },
  };
  hosts.push(host);
  const actual = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    executable: process.execPath,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
  }));
  assertRuntimeIdentity(actual, {
    version: item.version,
    executable,
    appPath: path.join(target, "resources/app"),
    userData: profile,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#new-project").waitFor();
  await application
    .context()
    .tracing.start({ screenshots: true, snapshots: true, sources: true });
  tracing = true;
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem("local-api-token") ||
      new URLSearchParams(location.hash.slice(1)).get("token"),
  );
  assert.ok(token);
  steps.push({
    label: "launch-" + generation,
    version: actual.version,
    executable: actual.executable,
    isolatedProfile: true,
  });
  return Object.assign(host, { page, token, url: new URL(page.url()).origin });
}
async function exportAll(host) {
  const values = await host.page.evaluate(async () => {
    const headers = {
      "x-local-token": sessionStorage.getItem("local-api-token"),
    };
    const list = await fetch("/api/projects", { headers });
    if (!list.ok) throw Error("Project list read failed");
    const exports = [];
    for (const project of await list.json()) {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(project.id)}/export?format=native`,
        { headers },
      );
      if (!response.ok) throw Error("Project export read failed");
      exports.push(await response.json());
    }
    return exports.sort((a, b) => a.id.localeCompare(b.id));
  });
  assert.ok(
    values.length >= 2 && values.some((p) => p.runs?.length > 0),
    "Retained original/restored project and history required",
  );
  return values;
}
try {
  const databaseFile = path.join(root, "journey.sqlite");
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
  const [old, next] = plan.packages;
  await registration("absent");
  await install(old, "first-install");
  await registration("old");
  let host = await launch(old, 1, false);
  await writeFile(path.join(target, foreignName), foreignBytes, { flag: "wx" });
  await exerciseRestartJourney({
    initialPage: host.page,
    databaseFile,
    hits,
    peerURL: `http://127.0.0.1:${peer.address().port}`,
    screenshotPath: (name) => path.join(evidence, name),
    mark: (label) => steps.push({ label }),
    restart: async () => {
      const previous = host,
        count = hits.length;
      await previous.quit();
      await assert.rejects(
        fetch(previous.url + "/api/session", {
          signal: AbortSignal.timeout(5000),
        }),
      );
      await install(next, "upgrade");
      await registration("new");
      host = await launch(next, 2, true);
      assert.notEqual(host.child.pid, previous.child.pid);
      assert.notEqual(host.token, previous.token);
      assert.equal(
        (
          await fetch(host.url + "/api/session", {
            headers: { "x-local-token": previous.token },
            signal: AbortSignal.timeout(5000),
          })
        ).status,
        403,
      );
      assert.equal(hits.length, count, "Upgrade must not replay traffic");
      return host.page;
    },
  });
  const before = await exportAll(host),
    count = hits.length;
  await writeFile(
    path.join(evidence, "before-uninstall-exports.json"),
    JSON.stringify(before, null, 2),
  );
  await host.quit();
  const dataBefore = await inventory(profile);
  await install(next, "uninstall", true);
  await registration("absent");
  await packageInventory(null, true);
  assert.deepEqual(await inventory(profile), dataBefore);
  // Keep the foreign sentinel directory. Never recursively delete it to permit reinstall.
  await rename(target, target + ".retained-foreign");
  await install(next, "reinstall");
  await registration("new");
  const preUninstallHost = host;
  host = await launch(next, 3, false);
  assert.notEqual(host.token, preUninstallHost.token);
  assert.equal(
    (
      await fetch(host.url + "/api/session", {
        headers: { "x-local-token": preUninstallHost.token },
        signal: AbortSignal.timeout(5000),
      })
    ).status,
    403,
  );
  assert.equal(hits.length, count, "Reinstall must not replay traffic");
  const after = await exportAll(host);
  assert.deepEqual(
    after,
    before,
    "Reinstall must retain complete exports and execution history",
  );
  await writeFile(
    path.join(evidence, "after-reinstall-exports.json"),
    JSON.stringify(after, null, 2),
  );
  assert.deepEqual(errors, []);
  await host.quit();
  await install(next, "final-uninstall", true);
  await registration("absent");
  // Empty directories are permitted by this candidate's native component contract.
  try {
    assert.deepEqual(await inventory(target), {});
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.equal(hits.length, count);
  result.nativeProductJourneyPassed = true;
} catch (error) {
  result.error = error.message;
  throw error;
} finally {
  const cleanupErrors = [];
  for (const host of hosts) {
    try {
      await host.cleanup();
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  }
  try {
    if (peer.listening) {
      peer.closeAllConnections();
      await bounded(
        new Promise((resolve) => peer.close(resolve)),
        "Synthetic peer cleanup timed out",
      );
    }
  } catch (error) {
    cleanupErrors.push(error.message);
  }
  if (cleanupErrors.length) {
    result.cleanupErrors = cleanupErrors;
    result.nativeProductJourneyPassed = false;
    process.exitCode = 1;
  }
  // Keep synthetic profile, exports, traces, logs and uncertain MSI state for inspection.
  await writeFile(
    path.join(evidence, "product-lifecycle-result.json"),
    JSON.stringify(result, null, 2),
  );
}
