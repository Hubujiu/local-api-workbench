import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { protocolDefinitionEdit } from "../public/protocol-definition-edit.js";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const base = {
  id: "saved-sse",
  name: "Existing",
  type: "sse",
  url: "http://127.0.0.1:1/events",
};
const advanced = normalizeProtocol({
  ...base,
  folder: "Synthetic",
  method: "POST",
  body: "draft {{local_fixture}}",
  templateMode: "variables",
  handshake: {
    headers: { "content-type": "text/plain" },
    requiredHeaders: ["authorization", "x-fixture"],
  },
  duration: 855,
});
const metadata = { ...base, name: "Renamed", port: 0 };
test("same-target SSE rename projects exact normalized fields but not unknown or runtime keys", () => {
  const owned = {
    ...advanced,
    headers: { authorization: "ignored" },
    tls: { key: "ignored" },
    unknown: "ignored",
  };
  const edited = protocolDefinitionEdit(owned, metadata);
  assert.deepEqual(normalizeProtocol(edited), { ...advanced, name: "Renamed" });
  assert.notEqual(edited.handshake, advanced.handshake);
  assert.equal(Object.hasOwn(edited, "headers"), false);
  assert.equal(Object.hasOwn(edited, "tls"), false);
  assert.equal(Object.hasOwn(edited, "unknown"), false);
  assert.equal(owned.name, "Existing");
});

test("changing URL or transport cannot drop nontrivial SSE metadata or expose values", () => {
  for (const beyondBasic of [
    { method: "POST" },
    { method: "POST", body: "" },
    { handshake: { headers: {}, requiredHeaders: [] } },
    { duration: 3000 },
  ]) {
    const previous = normalizeProtocol({ ...base, ...beyondBasic });
    for (const fields of [
      { ...metadata, url: "http://127.0.0.1:1/events?changed=1" },
      { ...metadata, type: "websocket", url: "ws://127.0.0.1:1/events" },
    ])
      assert.throws(
        () => protocolDefinitionEdit(previous, fields),
        /原定义已保留，请重新加载项目后从新建菜单另建连接/,
      );
  }
  assert.throws(
    () => protocolDefinitionEdit(advanced, { ...metadata, id: "elsewhere" }),
    /重新选择/,
  );
  const match = protocolDefinitionEdit(
    normalizeProtocol({ ...base, method: "GET" }),
    metadata,
  );
  assert.equal(match.method, "GET");
  const draft = { ...metadata, url: "http://127.0.0.1:1/new-events" };
  assert.deepEqual(
    protocolDefinitionEdit(
      normalizeProtocol({ ...base, method: "GET" }),
      draft,
    ),
    draft,
  );
  assert.deepEqual(protocolDefinitionEdit(undefined, draft), draft);
  assert.deepEqual(
    protocolDefinitionEdit({ ...base, type: "websocket" }, draft),
    draft,
  );
});

test("a plain foldered SSE can change target or transport without moving folders", () => {
  const previous = normalizeProtocol({ ...base, folder: "Synthetic" });
  for (const fields of [
    { ...metadata, url: "http://127.0.0.1:1/new-events" },
    { ...metadata, type: "websocket", url: "ws://127.0.0.1:1/events" },
    { ...metadata, type: "tcp", url: "127.0.0.1", port: 3000 },
  ]) {
    const changed = normalizeProtocol(protocolDefinitionEdit(previous, fields));
    assert.deepEqual(
      changed,
      normalizeProtocol({ ...fields, folder: "Synthetic" }),
    );
  }
  assert.throws(
    () =>
      protocolDefinitionEdit(
        { ...previous, method: "POST" },
        { ...metadata, url: "http://127.0.0.1:1/new-events" },
      ),
    /原定义已保留/,
  );
});

test("one real owner PUT normalizes rename and a fresh GET returns all SSE options", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-sse-metadata-owner-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Synthetic");
  project.protocols = [advanced];
  await app.store.save(project);
  const url = new URL(app.launchUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const endpoint = url.origin + "/api/projects/" + project.id;
  const headers = {
    "content-type": "application/json",
    "x-local-token": token,
  };
  const read = async () => {
    const found = await fetch(endpoint, { headers });
    assert.equal(found.status, 200);
    return found.json();
  };
  const current = await read();
  const rejected = () =>
    protocolDefinitionEdit(current.protocols[0], {
      ...metadata,
      url: base.url + "?new-target=1",
    });
  assert.throws(rejected, /原定义已保留/);
  assert.deepEqual(await read(), current);

  const edited = protocolDefinitionEdit(current.protocols[0], metadata);
  const response = await fetch(endpoint, {
    headers,
    method: "PUT",
    body: JSON.stringify({ ...current, protocols: [edited] }),
  });
  assert.equal(response.status, 200);
  const reloaded = await read();
  assert.equal(reloaded.configRevision, current.configRevision + 1);
  assert.deepEqual(reloaded.protocols, [
    { ...current.protocols[0], name: metadata.name },
  ]);
  assert.deepEqual(reloaded.history, current.history);
});
