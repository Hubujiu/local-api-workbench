import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
import {
  runFixtureProcess,
  buildGoFixtures,
  createWireObservations,
  fixtureToolAvailable,
  goFixtureEnvironment,
} from "./helpers/codegen-fixture-process.mjs";

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

test(
  "ordinary JSON and empty-body controls match runtime bytes on loopback",
  { timeout: 180000 },
  async (t) => {
    const observations = createWireObservations();
    const active = new Set();
    const runOwned = (...args) => {
      const promise = runFixtureProcess(...args);
      active.add(promise);
      promise.then(
        () => active.delete(promise),
        () => active.delete(promise),
      );
      return promise;
    };
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        observations.record(req.url, {
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
      await Promise.allSettled([...active]);
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
    // Version probes are bounded and timeout/error is failure, never a skip.
    const available = {
      go: fixtureToolAvailable("go", ["version"], {
        fixture: "tool-go",
        pattern: /^go version go/,
        env: goFixtureEnvironment(),
      }),
      python: fixtureToolAvailable("python3", ["--version"], {
        fixture: "tool-python",
        pattern: /^Python 3/,
      }),
      curl: fixtureToolAvailable("curl", ["--version"], {
        fixture: "tool-curl",
        pattern: /^curl /,
      }),
      shell: fixtureToolAvailable("/bin/sh", ["-c", "exit 0"], {
        fixture: "tool-shell",
      }),
    };
    const goAvailable = available.go;
    const goSources = fixtures.map((fixture, index) => {
      const request = { ...fixture, url: `${url}go/fixture-${index}` };
      const before = structuredClone(request);
      const code = generateRequestCode(request, "go", "native").code;
      assert.deepEqual(request, before);
      return code;
    });
    assert.equal(observations.count, 0, "generation must not send requests");
    const binaries = goAvailable
      ? await buildGoFixtures(dir, goSources, {
          signal: t.signal,
          run: runOwned,
        })
      : [];
    assert.equal(
      observations.count,
      0,
      "build must not execute generated programs",
    );
    for (const [index, fixture] of fixtures.entries()) {
      const runtimePath = `/runtime/fixture-${index}`;
      const expectedText =
        fixture.bodyType === "json" ? fixture.body || "{}" : "";
      await executeRequest({ ...fixture, url: url + runtimePath.slice(1) });
      const expected = observations.takeOnly(runtimePath);
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
            if (target !== "node" && !available[target])
              return st.skip(
                `${target} unavailable (version probe did not identify the tool)`,
              );
            if (target === "curl" && !available.shell)
              return st.skip(
                "POSIX /bin/sh unavailable; cURL wire execution requires it",
              );
            const path = `/${target}/fixture-${index}`;
            const request = { ...fixture, url: url + path.slice(1) };
            const before = structuredClone(request);
            const count = observations.count;
            const code =
              target === "curl"
                ? toCurl(request)
                : generateRequestCode(
                    request,
                    target,
                    { node: "fetch", python: "python3", go: "native" }[target],
                  ).code;
            assert.equal(
              observations.count,
              count,
              "generation must not send requests",
            );
            assert.deepEqual(request, before);
            observations.assertUnseen(path);
            const options = {
              phase: "execute",
              fixture: `fixture-${index}-${target}`,
              timeoutMs: 60000,
              signal: st.signal,
            };
            if (target === "curl")
              await runOwned("/bin/sh", ["-c", code], options);
            else if (target === "node")
              await runOwned(
                binary,
                ["--input-type=module", "-e", `await ${code}`],
                options,
              );
            else if (target === "python")
              await runOwned(binary, ["-c", code], options);
            else {
              assert.equal(
                code,
                goSources[index],
                "execute the binary built from this exact generated source",
              );
              await runOwned(binaries[index], [], options);
            }
            const actual = observations.takeOnly(path);
            // Body-less cURL POST omits Content-Length; other clients send zero.
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
    const count = observations.count;
    await assert.rejects(
      executeRequest({ ...base, url, body: " \r\n\t" }),
      SyntaxError,
    );
    assert.equal(
      observations.count,
      count,
      "whitespace JSON remains invalid at runtime",
    );
    observations.assertSingleArrivals();
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
