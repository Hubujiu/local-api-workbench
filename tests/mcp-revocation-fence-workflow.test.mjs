import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { MCPConfigPublication } from "../src/mcp-config-publication.mjs";

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
}

test(
  "owner disable denies new MCP work while actual project lock delays publication",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-revocation-fence-"));
    const app = await createApp({ root, port: 0 });
    let release, update, older;
    t.after(async () => {
      await release?.();
      await update?.catch(() => {});
      await older?.catch(() => {});
      app.server.closeAllConnections();
      await new Promise((done) => app.server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (url, method = "GET", body) => {
      const response = await fetch(app.url + url, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    };
    const project = (
      await owner("/api/projects", "POST", { name: "Synthetic fence target" })
    ).value;
    const config = {
      enabled: true,
      remember: true,
      projects: [project.id],
      write: true,
      execute: true,
    };
    const granted = await owner("/api/mcp/config", "POST", config);
    assert.equal(granted.status, 200);
    const before = await readFile(path.join(root, ".mcp-config.json"));
    release = await acquireFileLock(app.store.lockFile(project.id));
    let firstEntered, entered;
    const firstAdmitted = new Promise((resolve) => {
      firstEntered = resolve;
    });
    const admitted = new Promise((resolve) => {
      entered = resolve;
    });
    let admissions = 0;
    const originalRun = MCPConfigPublication.prototype.run;
    t.mock.method(MCPConfigPublication.prototype, "run", function (operation) {
      const task = originalRun.call(this, operation);
      if (++admissions === 1) firstEntered();
      else entered();
      return task;
    });
    older = owner("/api/mcp/config", "POST", config);
    await bounded(firstAdmitted, "older owner publication was not admitted");
    let replied = false;
    update = owner("/api/mcp/config", "POST", {
      ...config,
      enabled: false,
    }).finally(() => {
      replied = true;
    });
    await bounded(admitted, "owner publication was not admitted");
    assert.equal(replied, false, "no success before persistence confirmation");
    const rpc = await fetch(app.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + granted.value.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(
      rpc.status,
      403,
      "valid owner disable must fence admission before project-lock wait",
    );
    assert.equal(
      (await readFile(path.join(root, ".mcp-config.json"))).equals(before),
      true,
    );
    await release();
    release = null;
    const settled = await bounded(
      update,
      "owner publication did not settle after lock release",
    );
    assert.equal(
      (await older).status,
      400,
      "pre-fence owner cannot republish grants",
    );
    assert.equal(settled.status, 200);
    assert.equal(settled.value.enabled, false);
    assert.equal(
      JSON.parse(await readFile(path.join(root, ".mcp-config.json"), "utf8"))
        .enabled,
      false,
    );
  },
);
