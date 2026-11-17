import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startJourneyServer } from "./helpers/gui-journey-server.mjs";
test(
  "GUI journey fixture closes its process and restarts the same data root with fresh authorization",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gui-restart-proof-"));
    let server;
    try {
      server = await startJourneyServer(root);
      const first = server;
      const headers = {
        "x-local-token": first.launchUrl.split("#token=")[1],
        "content-type": "application/json",
      };
      const created = await fetch(first.url + "/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Restart proof" }),
      });
      assert.equal(created.status, 201);
      const project = await created.json();
      const filename = path.join(root, "fixture.sqlite");
      const db = new DatabaseSync(filename);
      db.exec("CREATE TABLE fixture(id INTEGER)");
      db.close();
      const granted = await fetch(
        first.url + `/api/projects/${project.id}/database-connections`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ type: "sqlite", filename, name: "Ephemeral" }),
        },
      );
      assert.equal(granted.status, 200);
      const before = await (
        await fetch(first.url + "/api/projects", { headers })
      ).json();
      await first.close();
      server = null;
      await assert.rejects(fetch(first.url + "/api/session"));
      server = await startJourneyServer(root);
      assert.notEqual(server.pid, first.pid);
      assert.notEqual(
        server.launchUrl.split("#token=")[1],
        first.launchUrl.split("#token=")[1],
      );
      assert.equal(
        (await fetch(server.url + "/api/session", { headers })).status,
        403,
      );
      const connections = await fetch(
        server.url + `/api/projects/${project.id}/database-connections`,
        { headers: { "x-local-token": server.launchUrl.split("#token=")[1] } },
      );
      assert.equal(connections.status, 200);
      assert.deepEqual(await connections.json(), []);
      const after = await (
        await fetch(server.url + "/api/projects", {
          headers: { "x-local-token": server.launchUrl.split("#token=")[1] },
        })
      ).json();
      assert.deepEqual(
        after.map((p) => p.id),
        before.map((p) => p.id),
      );
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
