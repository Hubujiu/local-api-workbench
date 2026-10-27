import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";

test("native identity ambiguity is rejected before persisted import, including after server restart", async (t) => {
  let connections = 0;
  const peer = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "protocol-identities-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const source = extendedProtocolFixture({
    grpc: `127.0.0.1:${peer.address().port}`,
  });
  const a = source.apis[1],
    b = structuredClone(a);
  a.target_id = "a:b";
  b.target_id = "a";
  for (const node of [a, b])
    node.protos[0].services[0].methods =
      node.protos[0].services[0].methods.slice(0, 1);
  a.protos[0].services[0].methods[0].grpc_method_id = "c";
  b.protos[0].services[0].methods[0].grpc_method_id = "b:c";
  source.apis = [a, b];
  const original = structuredClone(source);
  const p = await app.store.create("collision"),
    other = await app.store.create("isolated");
  async function send(id, nodes, status) {
    const response = await fetch(`${app.url}/api/projects/${id}/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify({ document: { ...source, apis: nodes } }),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    if (status === 400) assert.match(body.error, /身份拼接歧义/);
    return body;
  }
  const empty = await new Store(root).get(p.id);
  await send(p.id, [a, b], 400);
  assert.deepEqual(await new Store(root).get(p.id), empty);
  await send(p.id, [a], 200);
  const saved = await new Store(root).get(p.id);
  assert.equal(saved.plans.length, 1);
  assert.equal(saved.settings.grpcDefinitions.length, 1);
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  await send(p.id, [b], 400);
  assert.deepEqual(await new Store(root).get(p.id), saved);
  await send(other.id, [b], 200);
  assert.equal((await new Store(root).get(other.id)).plans.length, 1);
  assert.deepEqual(await new Store(root).get(p.id), saved);
  assert.equal(
    connections,
    0,
    "imports and restarts must never connect to protocol endpoints",
  );
  assert.deepEqual(source, original);
});
