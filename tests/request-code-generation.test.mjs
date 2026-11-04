import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { generateRequestCode } from "../src/request-code-generation.mjs";

const base = {
  url: "http://127.0.0.1:1/a?flag&x=%2f&x=2",
  method: "POST",
  bodyType: "raw",
  body: `{"n":9007199254740993,"x":1,"x":2}`,
};

test("generation preserves literal raw bodies and encoded URLs without running a request", () => {
  for (const [target, client] of [
    ["node", "fetch"],
    ["python", "python3"],
    ["go", "native"],
  ]) {
    const result = generateRequestCode(base, target, client);
    assert.equal(typeof result.code, "string");
    assert(result.code.includes("flag&x=%2f&x=2"));
    assert(result.code.includes("9007199254740993"));
    assert(result.warnings.length);
  }
});

test("Node generated example sends the intended query, headers and literal body to a local fixture", async (t) => {
  let resolveSeen;
  const seen = new Promise((resolve) => {
    resolveSeen = resolve;
  });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (x) => chunks.push(x));
    req.on("end", () => {
      resolveSeen({
        url: req.url,
        method: req.method,
        header: req.headers["x-check"],
        body: Buffer.concat(chunks).toString(),
      });
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = {
    ...base,
    url: `http://127.0.0.1:${server.address().port}/a?flag&x=%2f&x=2`,
    headers: [{ key: "x-check", value: "it's \\ test" }],
  };
  const { code } = generateRequestCode(request, "node", "fetch");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `await ${code}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (x) => {
    stderr += x;
  });
  const status = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(status, 0, stderr);
  assert.deepEqual(await seen, {
    url: "/a?flag&x=%2f&x=2",
    method: "POST",
    header: "it's \\ test",
    body: request.body,
  });
});

test("rejects unsupported or unsafe inputs instead of silently changing them", () => {
  assert.throws(() => generateRequestCode(base, "node", "missing"), /不支持/);
  assert.throws(
    () =>
      generateRequestCode(
        { ...base, url: "http://example.test/path?" },
        "python",
        "python3",
      ),
    /查询分隔符/,
  );
  assert.throws(
    () => generateRequestCode({ ...base, body: "\ud800" }, "go", "native"),
    /Unicode/,
  );
  assert.throws(
    () =>
      generateRequestCode(
        {
          ...base,
          headers: [{ key: "x-context", value: '{"enabled": true,"n": 1}' }],
        },
        "python",
        "python3",
      ),
    /保真/,
  );
  for (const [key, value] of [
    ["x-\ud800", "v"],
    ["x-key", "v\r\nInjected: x"],
  ]) {
    assert.throws(() =>
      generateRequestCode(
        { ...base, auth: { type: "apiKey", in: "header", key, value } },
        "go",
        "native",
      ),
    );
  }
  const code = generateRequestCode(
    {
      ...base,
      auth: { type: "apiKey", in: "header", key: "x-key", value: 123 },
    },
    "go",
    "native",
  ).code;
  assert(code.includes('req.Header.Add("x-key", "123")'));
  assert.throws(
    () =>
      generateRequestCode(
        { ...base, url: "http://alice:secret@example.test/a" },
        "node",
        "fetch",
      ),
    /认证/,
  );
  for (const key of ["__proto__", "constructor"]) {
    assert.throws(
      () =>
        generateRequestCode(
          { ...base, headers: [{ key, value: "x" }] },
          "node",
          "fetch",
        ),
      /请求头/,
    );
  }
  assert.throws(
    () =>
      generateRequestCode(
        { ...base, url: "http://example.com/a'b" },
        "node",
        "fetch",
      ),
    /安全/,
  );
  assert.throws(
    () =>
      generateRequestCode(
        { ...base, proxy: "http://127.0.0.1:10" },
        "node",
        "fetch",
      ),
    /代理/,
  );
  assert.throws(
    () => generateRequestCode({ ...base, httpVersion: "2" }, "node", "fetch"),
    /HTTP\/2/,
  );
  assert.throws(
    () => generateRequestCode({ ...base, body: "你好" }, "python", "python3"),
    /ASCII/,
  );
});

test("Python standard-library example preserves raw JSON bytes on the wire", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const binary = process.platform === "win32" ? "python" : "python3";
  if (spawnSync(binary, ["--version"]).error)
    return t.skip("Python is not installed on this host");
  let resolveSeen;
  const seen = new Promise((resolve) => {
    resolveSeen = resolve;
  });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (x) => chunks.push(x));
    req.on("end", () => {
      resolveSeen({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { code } = generateRequestCode(
    {
      ...base,
      url: `http://127.0.0.1:${server.address().port}/a?flag&x=%2f&x=2`,
    },
    "python",
    "python3",
  );
  const child = spawn(binary, ["-c", code], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (x) => {
    stderr += x;
  });
  const status = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(status, 0, stderr);
  assert.deepEqual(await seen, { url: "/a?flag&x=%2f&x=2", body: base.body });
});

test("HTTP generation resolves the project environment without mutating the project", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "request-code-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Code");
  project.globalVariables = { value: "abc" };
  await app.store.save(project);
  const before = await app.store.get(project.id);
  const call = (data, headers = {}) =>
    fetch(`${app.url}/api/projects/${project.id}/code-generation`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(data),
    });
  const input = {
    request: { url: "http://example.test/{{value}}", method: "GET" },
    target: "node",
    client: "fetch",
  };
  const response = await call(input);
  assert.equal(response.status, 200);
  assert((await response.json()).code.includes("http://example.test/abc"));
  assert.deepEqual(await app.store.get(project.id), before);
  assert.equal(
    (await call(input, { Origin: "https://untrusted.example" })).status,
    403,
  );
  assert.equal((await call({ ...input, client: "other" })).status, 400);
});

test("Go example sends the intended literal request on the local wire", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const version = spawnSync("go", ["version"], { encoding: "utf8" });
  if (
    version.error ||
    version.status !== 0 ||
    !/^go version go/.test(version.stdout)
  )
    return t.skip("Go toolchain is not available on this host");
  const dir = await mkdtemp(join(tmpdir(), "codegen-go-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let resolveSeen;
  const seen = new Promise((resolve) => {
    resolveSeen = resolve;
  });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (x) => chunks.push(x));
    req.on("end", () => {
      resolveSeen({
        url: req.url,
        body: Buffer.concat(chunks).toString(),
        header: req.headers["x-key"],
      });
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { code } = generateRequestCode(
    {
      ...base,
      url: `http://127.0.0.1:${server.address().port}/a?flag&x=%2f&x=2`,
      auth: { type: "apiKey", in: "header", key: "x-key", value: 123 },
    },
    "go",
    "native",
  );
  const source = join(dir, "main.go");
  await writeFile(source, code);
  const child = spawn("go", ["run", source], {
    env: { ...process.env, GO111MODULE: "off" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (x) => {
    stderr += x;
  });
  const status = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(status, 0, stderr);
  assert.deepEqual(await seen, {
    url: "/a?flag&x=%2f&x=2",
    body: base.body,
    header: "123",
  });
});
