// Real packaged Electron lifecycle, without script execution or new UI.
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { WebSocketServer } from "ws";
import { desktopLayout } from "../desktop/build-layout.mjs";
import { Store } from "../src/runtime.mjs";
const root = await mkdtemp(path.join(tmpdir(), "desktop-shutdown-"));
let application,
  connections = 0,
  sends = 0;
const sockets = new Set();
const tcp = net.createServer((s) => {
  connections++;
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
  s.on("data", () => sends++);
});
const upstream = http.createServer((_req, res) => {
  connections++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: ready\n\n");
});
const ws = new WebSocketServer({ server: upstream });
ws.on("connection", (s) => {
  connections++;
  s.on("message", () => sends++);
});
await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const timer = setTimeout(() => {
  application?.process().kill();
  process.exitCode = 2;
}, 45000);
async function until(fn) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw Error("desktop shutdown fixture timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function launch() {
  application = await electron.launch({
    executablePath: desktopLayout().executable,
    env: { ...process.env, LOCAL_API_DESKTOP_DATA: root },
    timeout: 30000,
  });
  let stderr = "";
  application.process().stderr?.on("data", (b) => {
    stderr += b;
  });
  const exited = once(application.process(), "exit"),
    window = await application.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  const url = new URL(window.url());
  const token = await until(() =>
    window.evaluate(
      () =>
        sessionStorage.getItem("local-api-token") ||
        new URLSearchParams(location.hash.slice(1)).get("token"),
    ),
  );
  const api = async (pathname, body) => {
    const response = await fetch(url.origin + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-local-token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { window, api, exited, stderr: () => stderr };
}
async function quit() {
  // Return from the remote evaluation before the process closes its transport.
  await application.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 10);
  });
}
try {
  const store = new Store(path.join(root, "projects")),
    p = await store.create("desktop host"),
    other = await store.create("other"),
    otherBefore = await store.get(other.id);
  const f = await launch(),
    prefix = `/api/projects/${p.id}/protocol-sessions`,
    ids = [];
  for (const input of [
    { type: "tcp", host: "127.0.0.1", port: tcp.address().port },
    { type: "websocket", url: `ws://127.0.0.1:${upstream.address().port}` },
    { type: "sse", url: `http://127.0.0.1:${upstream.address().port}` },
  ]) {
    const { id } = await f.api(prefix, input);
    ids.push(id);
    await until(async () => (await f.api(prefix + "/" + id)).state === "open");
  }
  await f.window.evaluate(() => {
    window.onbeforeunload = () => false;
  });
  await application.evaluate(({ dialog }) => {
    globalThis.shutdownDialogs = 0;
    dialog.showMessageBoxSync = () => {
      globalThis.shutdownDialogs++;
      return 0;
    };
  });
  await quit();
  await until(() => application.evaluate(() => globalThis.shutdownDialogs > 0));
  assert.equal(
    (await f.api(prefix + "/" + ids[0])).state,
    "open",
    "cancelled renderer exit leaves backend alive",
  );
  assert.equal(
    (await new Store(path.join(root, "projects")).get(p.id)).protocolRuns
      .length,
    0,
  );
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
  });
  await quit();
  assert.deepEqual(await f.exited, [0, null]);
  assert.match(f.stderr(), /LOCAL_API_SHUTDOWN_SAVED/);
  application = undefined;
  const saved = await new Store(path.join(root, "projects")).get(p.id);
  assert.deepEqual(saved.protocolRuns.map((r) => r.id).sort(), ids.sort());
  assert.equal(connections, 3);
  assert.equal(sends, 0);
  assert.deepEqual(await store.get(other.id), otherBefore);

  const second = await launch();
  assert.equal(connections, 3, "restart never replays saved sessions");
  const { id } = await second.api(prefix, {
    type: "tcp",
    host: "127.0.0.1",
    port: tcp.address().port,
  });
  await until(
    async () => (await second.api(prefix + "/" + id)).state === "open",
  );
  const file = path.join(store.directory(p.id), "history", "requests.json"),
    before = await readFile(file, "utf8");
  await writeFile(file, '{"fictional-private-secret":');
  await second.window.evaluate(() => {
    window.onbeforeunload = null;
  });
  await quit();
  assert.deepEqual(await second.exited, [2, null]);
  assert.match(second.stderr(), /LOCAL_API_SHUTDOWN_UNCONFIRMED/);
  assert.doesNotMatch(
    second.stderr(),
    /fictional-private-secret|requests.json/,
  );
  application = undefined;
  await writeFile(file, before);
  assert.equal(
    (await new Store(path.join(root, "projects")).get(p.id)).protocolRuns
      .length,
    3,
  );
  assert.equal(connections, 4);
  assert.equal(sends, 0);
  console.log("PACKAGED_DESKTOP_SHUTDOWN_PASS");
} finally {
  clearTimeout(timer);
  if (application) {
    application.process().kill();
    await application.close().catch(() => {});
  }
  for (const s of sockets) s.destroy();
  for (const s of ws.clients) s.terminate();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise((r) => tcp.close(r)),
    new Promise((r) => ws.close(r)),
    new Promise((r) => upstream.close(r)),
  ]);
  await rm(root, { recursive: true, force: true });
}
