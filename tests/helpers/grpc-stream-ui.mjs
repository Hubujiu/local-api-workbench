import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
import { readPreviewProject } from "./preview-draft-ownership-ui.mjs";

export async function exerciseGrpcStreamUI(page) {
  const protoPath = fileURLToPath(
    new URL("../fixtures/grpc.proto", import.meta.url),
  );
  const proto = await readFile(protoPath, "utf8");
  const definitions = loader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    bytes: String,
    enums: String,
    defaults: true,
  });
  const peer = new grpc.Server();
  const received = [],
    calls = [];
  const secret = "fictional-stream-runtime-metadata";
  peer.addService(
    grpc.loadPackageDefinition(definitions).fixture.Echo.service,
    {
      Watch(call) {
        calls.push("Watch");
        assert.equal(call.metadata.get("x-fixture")[0], secret);
        call.write({ text: "watch-one" });
        call.write({ text: "watch-two" });
        call.end();
      },
      Collect(call, done) {
        calls.push("Collect");
        let count = 0;
        call.on("data", (message) => {
          received.push(message.text);
          count += message.count;
        });
        call.on("end", () => done(null, { text: "collected", count }));
      },
      Chat(call) {
        calls.push("Chat");
        call.on("data", (message) => {
          received.push(message.text);
          call.write(message);
        });
        call.on("end", () => call.end());
      },
    },
  );
  const port = await new Promise((resolve, reject) =>
    peer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  const click = async (id, suffix, method = "POST") => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(suffix) && r.request().method() === method,
      ),
      page.locator(id).click(),
    ]);
    assert(response.ok(), "stream browser operation must return HTTP success");
    return response.json();
  };
  const idle = () =>
    page.locator("#grpc-stream-refresh:not([disabled])").waitFor();
  const snapshot = async () =>
    JSON.parse(await page.locator("#grpc-stream-result").textContent());
  const waitSnapshot = async (predicate) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      await idle();
      const id = await page.locator("#grpc-stream-sessionId").inputValue();
      await click("#grpc-stream-refresh", "/grpc-sessions/" + id, "GET");
      await idle();
      const value = await snapshot();
      if (predicate(value)) return value;
      await page.waitForTimeout(30);
    }
    throw Error("stream browser snapshot condition was not reached");
  };
  try {
    await createImportOwnershipFixture(page);
    const owner = await page.locator("#project-select").inputValue();
    const projectURL = new URL(`/api/projects/${owner}`, page.url()).href;
    await page.locator('.rail [data-page="grpc"]').click();
    await page.locator("#grpc-name").fill("Browser stream fixture");
    await page.locator("#grpc-target").fill(`grpc://127.0.0.1:${port}`);
    await page.locator("#grpc-timeoutMs").fill("30000");
    await page.locator("#grpc-proto").fill(proto);
    await click("#grpc-inspect", "/grpc-schema");
    await page.locator("#grpc-inspect:not([disabled])").waitFor();
    await page.locator("#grpc-service").selectOption("fixture.Echo");
    const saveMethod = async (method) => {
      await page.locator("#grpc-method").selectOption(method);
      await click("#grpc-save", `/api/projects/${owner}`, "PUT");
      await page.locator("#grpc-inspect:not([disabled])").waitFor();
      const saved = await readPreviewProject(page, projectURL);
      const id = saved.settings.grpcDefinitions.find(
        (d) => d.name === "Browser stream fixture",
      ).id;
      await page.locator("#grpc-stream-definition").selectOption(id);
      return id;
    };
    const definitionId = await saveMethod("Watch");
    await page.locator("#grpc-stream-initialEnabled").check();
    await page.locator("#grpc-stream-initialMessage").fill('{"text":"watch"}');
    await page
      .locator("#grpc-stream-workbench details summary")
      .first()
      .click();
    await page
      .locator("#grpc-stream-metadata")
      .fill(JSON.stringify([{ key: "x-fixture", value: secret }]));
    await click("#grpc-stream-start", "/grpc-sessions");
    let result = await waitSnapshot(
      (x) => x.lifecycle === "terminal" && x.recordSaved === true,
    );
    assert.equal(result.status.code, 0);
    assert.deepEqual(
      result.messages.map((x) => x.text),
      ["watch-one", "watch-two"],
    );
    let saved = await readPreviewProject(page, projectURL);
    assert(
      !JSON.stringify(saved).includes(secret),
      "runtime metadata must not enter history or definition",
    );
    assert(saved.settings.grpcDefinitions.some((x) => x.id === definitionId));

    await saveMethod("Collect");
    await page.locator("#grpc-stream-initialEnabled").uncheck();
    await click("#grpc-stream-start", "/grpc-sessions");
    await idle();
    let sessionId = await page.locator("#grpc-stream-sessionId").inputValue();
    await page
      .locator("#grpc-stream-message")
      .fill('{"text":"client-one","count":2}');
    await click("#grpc-stream-send", `/grpc-sessions/${sessionId}/send`);
    await waitSnapshot((x) =>
      x.requestMessages.every((m) => m.sendState === "accepted"),
    );
    await page
      .locator("#grpc-stream-message")
      .fill('{"text":"client-two","count":3}');
    await click("#grpc-stream-send", `/grpc-sessions/${sessionId}/send`);
    await waitSnapshot((x) =>
      x.requestMessages.every((m) => m.sendState === "accepted"),
    );
    await click(
      "#grpc-stream-half-close",
      `/grpc-sessions/${sessionId}/half-close`,
    );
    result = await waitSnapshot(
      (x) => x.lifecycle === "terminal" && x.recordSaved === true,
    );
    assert.equal(result.messages[0].count, 5);
    assert.equal(result.status.code, 0);

    await saveMethod("Chat");
    await click("#grpc-stream-start", "/grpc-sessions");
    await idle();
    sessionId = await page.locator("#grpc-stream-sessionId").inputValue();
    await page.locator("#grpc-stream-message").fill('{"text":"bidi-one"}');
    await click("#grpc-stream-send", `/grpc-sessions/${sessionId}/send`);
    result = await waitSnapshot(
      (x) =>
        x.messages.length === 1 &&
        x.requestMessages.every((m) => m.sendState === "accepted"),
    );
    assert.equal(result.messages[0].text, "bidi-one");
    await click(
      "#grpc-stream-half-close",
      `/grpc-sessions/${sessionId}/half-close`,
    );
    result = await waitSnapshot(
      (x) => x.lifecycle === "terminal" && x.recordSaved === true,
    );
    assert.equal(result.status.code, 0);

    await click("#grpc-stream-start", "/grpc-sessions");
    await idle();
    sessionId = await page.locator("#grpc-stream-sessionId").inputValue();
    await page.locator("#grpc-stream-message").fill('{"text":"unknown-once"}');
    let intercepted = 0;
    const sendRoute = async (route) => {
      intercepted++;
      await route.fetch();
      const end = Date.now() + 5000;
      while (!received.includes("unknown-once") && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(
        received.includes("unknown-once"),
        "fixture must actually receive the message before its HTTP receipt is lost",
      );
      await route.abort("failed");
    };
    await page.route(`**/grpc-sessions/${sessionId}/send`, sendRoute);
    try {
      await page.locator("#grpc-stream-send").click();
      await idle();
      assert.equal(intercepted, 1);
      assert(await page.locator("#grpc-stream-send").isDisabled());
      const callsBefore = calls.length;
      await page.reload();
      await page.locator("#project-select").waitFor();
      await page.locator('.rail [data-page="grpc"]').click();
      assert.equal(
        await page.locator("#grpc-stream-sessionId").inputValue(),
        sessionId,
      );
      assert(await page.locator("#grpc-stream-send").isDisabled());
      assert.equal(
        calls.length,
        callsBefore,
        "hard refresh must not restart a stream",
      );
      assert.equal(intercepted, 1, "hard refresh must not replay a send");
      await click("#grpc-stream-cancel", `/grpc-sessions/${sessionId}/cancel`);
      result = await waitSnapshot(
        (x) => x.lifecycle === "terminal" && x.recordSaved === true,
      );
      assert.equal(result.status.code, 1);
      assert.equal(received.filter((x) => x === "unknown-once").length, 1);
    } finally {
      await page.unroute(`**/grpc-sessions/${sessionId}/send`, sendRoute);
    }
    await page
      .locator("#grpc-stream-workbench details summary")
      .first()
      .click();
    await page.locator("#grpc-stream-key").fill("fictional-stream-private-key");
    await page.locator('.rail [data-page="apis"]').click();
    await page.locator('.rail [data-page="grpc"]').click();
    assert.equal(await page.locator("#grpc-stream-key").inputValue(), "");
    assert.equal(
      await page.locator("#grpc-stream-metadata").inputValue(),
      "[]",
    );
    saved = await readPreviewProject(page, projectURL);
    assert(!JSON.stringify(saved).includes("fictional-stream-private-key"));
    assert(!JSON.stringify(saved).includes(secret));
    assert.deepEqual(calls, ["Watch", "Collect", "Chat", "Chat"]);
    await page.locator('.rail [data-page="apis"]').click();
    console.log(
      "GRPC_STREAM_BROWSER_PASS server/client/bidi/half-close/cancel/record/unknown-no-replay/reload-recovery/runtime-isolation",
    );
  } finally {
    peer.forceShutdown();
  }
}
