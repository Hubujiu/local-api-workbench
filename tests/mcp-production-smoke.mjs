// Called after the desktop build's npm ci --omit=dev production installation.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { desktopLayout } from "../desktop/build-layout.mjs";
import { Store } from "../src/runtime.mjs";

const root = await mkdtemp(path.join(tmpdir(), "localapi-production-stdio-"));
const isolated = path.join(root, "app");
const client = new Client({ name: "production-smoke", version: "1" });
try {
  // Outside the checkout: a missing production dependency cannot fall back to
  // this repository's development node_modules.
  await cp(desktopLayout().app, isolated, { recursive: true });
  const sdk = path.join(
    isolated,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(sdk, "package.json"), "utf8")).version,
    "1.32.1",
  );
  assert.match(
    await readFile(path.join(sdk, "LICENSE"), "utf8"),
    /Permission is hereby granted/,
  );
  const data = path.join(root, "data"),
    store = new Store(data);
  const p = await store.create("production isolated");
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(isolated, "src", "mcp.mjs"), "--project", p.id],
      env: { LOCAL_API_DATA: data },
      stderr: "pipe",
    }),
  );
  await client.ping();
  const result = await client.callTool({ name: "localapi_list_projects" });
  assert.notEqual(result.isError, true);
  assert.deepEqual(
    JSON.parse(result.content[0].text).map((project) => project.id),
    [p.id],
  );
  console.log("PRODUCTION_ONLY_STDIO_SDK_FRAMING_SMOKE_PASS");
} finally {
  await client.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
