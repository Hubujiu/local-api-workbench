import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startJourneyServer } from "./helpers/gui-journey-server.mjs";

test(
  "first-use invalid import preserves the project and a corrected import survives restart",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "first-use-import-"));
    let server;
    try {
      server = await startJourneyServer(root);
      const headers = () => ({
        "x-local-token": server.launchUrl.split("#token=")[1],
        "content-type": "application/json",
      });
      const created = await fetch(server.url + "/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: "First use recovery" }),
      });
      assert.equal(created.status, 201);
      const { id } = await created.json();
      const read = async () => {
        const response = await fetch(
          server.url + `/api/projects/${id}/export?format=native`,
          { headers: headers() },
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const before = await read();
      const invalid = await fetch(server.url + `/api/projects/${id}/import`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ document: '{"openapi":' }),
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await read(), before);
      const corrected = await fetch(server.url + `/api/projects/${id}/import`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          document: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Corrected", version: "1" },
            paths: {
              "/example": {
                get: {
                  summary: "Recovered request",
                  responses: { 200: { description: "OK" } },
                },
              },
            },
          }),
        }),
      });
      assert.equal(corrected.status, 200);
      const saved = await read();
      assert.equal(saved.requests.length, before.requests.length + 1);
      assert.equal(saved.requests.at(-1).name, "Recovered request");
      const oldPID = server.pid;
      await server.close();
      server = await startJourneyServer(root);
      assert.notEqual(server.pid, oldPID);
      assert.deepEqual(await read(), saved);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
