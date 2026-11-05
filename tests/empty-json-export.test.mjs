import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeRequest,
  prepareLiteralHTTPExport,
  toCurl,
  importCurl,
  runPlan,
  snapshotPlan,
} from "../src/core.mjs";
import { generateRequestCode } from "../src/request-code-generation.mjs";
import { executeRequest } from "../src/runtime.mjs";

const targets = [
  ["node", "fetch"],
  ["python", "python3"],
  ["go", "native"],
];
const base = {
  url: "http://127.0.0.1:1/",
  method: "POST",
  bodyType: "json",
  body: "",
};

test("empty JSON fallback belongs only to the ephemeral literal export copy", () => {
  for (const input of [base, { ...base, body: undefined }]) {
    const before = structuredClone(input);
    assert.equal(normalizeRequest(input).body, "");
    assert.equal(prepareLiteralHTTPExport(input).request.body, "{}");
    assert.match(toCurl(input), /--data-raw '\{\}'/);
    for (const [target, client] of targets)
      assert(generateRequestCode(input, target, client).code.includes("{}"));
    assert.deepEqual(input, before);
  }
  for (const body of [
    " ",
    "\r\n\t",
    ' {"中文":"😀", "n":9007199254740993,"n":2} \n',
    "null",
    "false",
    "0",
    "not JSON",
  ]) {
    assert.equal(
      prepareLiteralHTTPExport({ ...base, body }).request.body,
      body,
    );
    for (const [target, client] of targets)
      generateRequestCode({ ...base, body }, target, client);
  }
  for (const bodyType of ["raw", "none", "urlencoded"]) {
    assert.equal(
      prepareLiteralHTTPExport({ ...base, bodyType }).request.body,
      "",
    );
  }
  const raw = importCurl("curl --json '' http://127.0.0.1:1/");
  assert.equal(raw.bodyType, "raw");
  assert.equal(prepareLiteralHTTPExport(raw).request.body, "");
  assert.equal(
    prepareLiteralHTTPExport({
      ...base,
      bodyType: "raw",
      headers: [{ key: "Content-Type", value: "application/json" }],
    }).request.body,
    "",
  );
  for (const method of [undefined, "GET", "HEAD"]) {
    assert.match(toCurl({ ...base, method }), /--data-raw '\{\}'/);
    for (const [target, client] of targets)
      assert.throws(
        () => generateRequestCode({ ...base, method }, target, client),
        /GET.*HEAD/,
      );
  }
});

function run(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      if (status === 0) resolve();
      else reject(Error(`${binary}: ${status}: ${stderr}`));
    });
  });
}

test(
  "ordinary JSON and empty-body controls match runtime bytes on loopback",
  { timeout: 180000 },
  async (t) => {
    const seen = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          body: Buffer.concat(chunks).toString("hex"),
          type: req.headers["content-type"],
          length: req.headers["content-length"],
        });
        res.end("ok");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = await mkdtemp(join(tmpdir(), "empty-json-export-"));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const fixtures = [
      { method: "POST", bodyType: "json", body: "" },
      { method: "PUT", bodyType: "json" },
      {
        method: "PATCH",
        bodyType: "json",
        body: "",
        headers: [
          { key: "Content-Type", value: "application/vnd.example+json" },
        ],
      },
      { method: "DELETE", bodyType: "json", body: "" },
      {
        method: "POST",
        bodyType: "json",
        body: ' {"中文":"😀", "n":9007199254740993,"n":2} \n',
      },
      {
        method: "POST",
        bodyType: "raw",
        body: "",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
      { method: "POST", bodyType: "none", body: "" },
      { method: "POST", bodyType: "urlencoded", body: "", form: [] },
    ];
    for (const fixture of fixtures) {
      const request = { ...fixture, url };
      const before = structuredClone(request);
      const expectedText =
        fixture.bodyType === "json" ? fixture.body || "{}" : "";
      await executeRequest(request);
      const expected = seen.pop();
      assert.equal(expected.body, Buffer.from(expectedText).toString("hex"));
      assert.equal(expected.length, String(Buffer.byteLength(expectedText)));
      for (const target of ["curl", "node", "python", "go"]) {
        await t.test(
          `${fixture.method} ${fixture.bodyType} ${JSON.stringify(fixture.body)} ${target}`,
          async (st) => {
            const binary = {
              curl: "curl",
              node: process.execPath,
              python: "python3",
              go: "go",
            }[target];
            if (
              target !== "node" &&
              spawnSync(binary, [target === "go" ? "version" : "--version"])
                .status !== 0
            )
              return st.skip(`${target} unavailable`);
            if (
              target === "curl" &&
              spawnSync("/bin/sh", ["-c", "exit 0"]).status !== 0
            )
              return st.skip(
                "POSIX /bin/sh unavailable; cURL wire execution requires it",
              );
            const count = seen.length;
            let code;
            if (target === "curl") code = toCurl(request);
            else
              code = generateRequestCode(
                request,
                target,
                { node: "fetch", python: "python3", go: "native" }[target],
              ).code;
            assert.equal(
              seen.length,
              count,
              "generation must not send requests",
            );
            assert.deepEqual(request, before);
            // Only code generated from these fixed local fixtures is executed.
            if (target === "curl") await run("/bin/sh", ["-c", code]);
            else if (target === "node")
              await run(binary, ["--input-type=module", "-e", `await ${code}`]);
            else if (target === "python") await run(binary, ["-c", code]);
            else {
              const source = join(dir, "main.go");
              await writeFile(source, code);
              await run(binary, ["run", source], {
                ...process.env,
                GO111MODULE: "off",
                GOPROXY: "off",
              });
            }
            const actual = seen.pop();
            // A body-less cURL POST omits Content-Length; other clients send zero.
            assert.deepEqual(
              actual,
              fixture.bodyType === "none" && target === "curl"
                ? { ...expected, length: undefined }
                : expected,
            );
          },
        );
      }
    }
    const count = seen.length;
    await assert.rejects(
      executeRequest({ ...base, url, body: " \r\n\t" }),
      SyntaxError,
    );
    assert.equal(
      seen.length,
      count,
      "whitespace JSON remains invalid at runtime",
    );
  },
);

test("HTTP export resolves inherited headers and empty environment text without side effects", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "empty-json-api-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const observed = [];
  const probe = createServer((req, res) => {
    observed.push(req.url);
    req.resume();
    res.end("ok");
  });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    probe.closeAllConnections();
    await new Promise((resolve) => probe.close(resolve));
  });
  const probeURL = `http://127.0.0.1:${probe.address().port}`;
  const markerScript = (phase) =>
    `pm.sendRequest(${JSON.stringify(probeURL)} + "/MUST_NOT_RUN-" + ${JSON.stringify(phase)}, (error) => { if (error) throw error; });`;
  const project = await app.store.create("Empty JSON");
  project.globalVariables = { empty: "" };
  project.settings.globalParameters = {
    headers: [
      {
        key: "Content-Type",
        value: "application/vnd.inherited+json",
        enabled: true,
      },
    ],
  };
  await app.store.save(project);
  const before = await app.store.get(project.id);
  const request = {
    ...base,
    body: "{{empty}}",
    url: probeURL + "/main",
    beforeScript: markerScript("before"),
    afterScript: markerScript("after"),
  };
  for (const action of ["curl", ...targets]) {
    const [target, client] = Array.isArray(action) ? action : [];
    const response = await fetch(
      `${app.url}/api/projects/${project.id}/${target ? "code-generation" : "curl"}`,
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request, target, client }),
      },
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const code = result.code || result.curl;
    assert(code.includes("application/vnd.inherited+json"));
    assert(code.includes("{}"));
    assert(!code.includes("MUST_NOT_RUN"));
    assert.deepEqual(
      observed,
      [],
      "export must not send the request or run either script",
    );
    assert.deepEqual(await app.store.get(project.id), before);
  }
  assert.equal(request.body, "{{empty}}");
  // Positive control: these exact, authored fixture scripts have observable
  // effects through the real before/after execution fields, unlike export.
  const run = await runPlan(
    snapshotPlan({ steps: [{ request }] }),
    { empty: "" },
    executeRequest,
  );
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.deepEqual(observed, [
    "/MUST_NOT_RUN-before",
    "/main",
    "/MUST_NOT_RUN-after",
  ]);
});
