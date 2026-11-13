import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Server } from "socket.io";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
import { readPreviewProject } from "./preview-draft-ownership-ui.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "Socket.IO browser fixture did not reach its expected phase",
              ),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function exerciseSocketIOUI(page) {
  const server = http.createServer();
  const io = new Server(server, { path: "/browser-events/" });
  const namespace = io.of("/browser");
  const secret = "fictional-socketio-browser-runtime-only";
  const connected = deferred();
  let peer,
    incomingReplies = 0;
  let connections = 0,
    echoCalls = 0,
    unknownCalls = 0;
  namespace.use((socket, next) => {
    if (
      socket.handshake.auth.token !== secret ||
      socket.handshake.query.fixture !== secret ||
      socket.handshake.headers["x-fixture-runtime"] !== secret
    )
      return next(Error("fixture-credentials-rejected"));
    next();
  });
  namespace.on("connection", (socket) => {
    peer = socket;
    connections++;
    connected.resolve();
    socket.on("echo", (value, ack) => {
      echoCalls++;
      if (typeof ack === "function") ack({ echoed: value });
      socket.emit("reply", value);
    });
    socket.on("no-ack", () => {
      unknownCalls++;
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${server.address().port}/browser`;
  let startRequests = 0,
    sendRequests = 0;
  const observe = (request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/socketio-sessions")) startRequests++;
    if (/\/socketio-sessions\/[^/]+\/send$/.test(pathname)) sendRequests++;
  };
  page.on("request", observe);
  const clickResponse = async (button, suffix, method = "POST") => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname.endsWith(suffix) &&
          r.request().method() === method,
      ),
      page.locator(button).click(),
    ]);
    assert(
      response.ok(),
      "Socket.IO browser operation must return HTTP success",
    );
    return response.json();
  };
  try {
    const idle = () => page.locator("#socketio-list:not([disabled])").waitFor();
    await createImportOwnershipFixture(page);
    const owner = await page.locator("#project-select").inputValue();
    const projectURL = new URL(`/api/projects/${owner}`, page.url()).href;
    await page.locator('.rail [data-page="socketio"]').click();
    await page.locator("#socketio-name").fill("Browser Socket.IO fixture");
    await page.locator("#socketio-url").fill(target);
    await page.locator("#socketio-path").fill("/browser-events/");
    await page.locator("#socketio-events").fill('["reply","question"]');
    await page.locator("#socketio-workbench details summary").first().click();
    const fillCredentials = async () => {
      await page
        .locator("#socketio-auth")
        .fill(JSON.stringify({ token: secret }));
      await page
        .locator("#socketio-query")
        .fill(JSON.stringify({ fixture: secret }));
      await page
        .locator("#socketio-headers")
        .fill(JSON.stringify({ "x-fixture-runtime": secret }));
    };
    await fillCredentials();
    await clickResponse("#socketio-save", `/api/projects/${owner}`, "PUT");
    await idle();
    await page
      .locator("#socketio-notice")
      .getByText("定义已保存", { exact: false })
      .waitFor();
    let saved = await readPreviewProject(page, projectURL);
    const definitionId = saved.settings.socketioDefinitions.find(
      (d) => d.name === "Browser Socket.IO fixture",
    )?.id;
    assert(definitionId, "Socket.IO definition must save through the UI");
    assert(
      !JSON.stringify(saved).includes(secret),
      "runtime connection credentials must not enter saved project",
    );
    assert.equal(connections, 0, "save must not connect");
    assert.equal(startRequests, 0);
    await clickResponse(
      "#socketio-project-reload",
      `/api/projects/${owner}`,
      "GET",
    );
    await idle();
    await page.locator("#socketio-definition").selectOption(definitionId);
    assert.equal(await page.locator("#socketio-url").inputValue(), target);
    assert.equal(
      await page.locator("#socketio-path").inputValue(),
      "/browser-events/",
    );
    assert.equal(
      await page.locator("#socketio-events").inputValue(),
      '["reply","question"]',
    );
    assert.equal(await page.locator("#socketio-auth").inputValue(), "{}");
    assert.equal(startRequests, 0, "reload and selection must not connect");
    await page.locator("#socketio-workbench details summary").first().click();
    await fillCredentials();
    const created = await clickResponse(
      "#socketio-connect",
      "/socketio-sessions",
    );
    assert.equal(created.type, "socketio");
    assert.equal(typeof created.id, "string");
    await bounded(connected.promise);
    await idle();
    const refreshUntil = async (predicate) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const value = await clickResponse(
          "#socketio-refresh",
          `/socketio-sessions/${created.id}`,
          "GET",
        );
        await idle();
        if (predicate(value)) return value;
        await page.waitForTimeout(25);
      }
      throw Error("Socket.IO expected observation did not arrive");
    };
    let session = await refreshUntil((value) => value.state === "open");
    assert.equal(connections, 1);
    assert.equal(startRequests, 1);
    await page.locator("#socketio-event").fill("echo");
    await page.locator("#socketio-args").fill('[{"text":"browser-echo"}]');
    const acknowledged = await clickResponse(
      "#socketio-send",
      `/socketio-sessions/${created.id}/send`,
    );
    await idle();
    assert.equal(acknowledged.status, "acknowledged");
    assert.equal(acknowledged.remoteOutcome, "acknowledged");
    const result = JSON.parse(
      await page.locator("#socketio-result").textContent(),
    );
    assert.equal(result.args[0].echoed.text, "browser-echo");
    assert.equal(echoCalls, 1);
    session = await refreshUntil((value) =>
      value.events.some(
        (e) => e.direction === "received" && e.event === "reply",
      ),
    );
    assert(
      session.events.some(
        (e) =>
          e.direction === "received" &&
          e.event === "reply" &&
          e.args[0]?.text === "browser-echo",
      ),
      "real inbound event must be observed",
    );
    assert(
      JSON.parse(
        await page.locator("#socketio-events-result").textContent(),
      ).some((e) => e.event === "reply"),
    );

    const answered = deferred();
    peer.emit("question", { prompt: "fixture" }, (...args) => {
      incomingReplies++;
      answered.resolve(args);
    });
    session = await refreshUntil((value) =>
      value.events.some((e) => e.event === "question" && e.ackId),
    );
    const question = session.events.find(
      (e) => e.event === "question" && e.ackId,
    );
    await page.locator("#socketio-incomingAckId").selectOption(question.ackId);
    await page.locator("#socketio-incomingAckArgs").fill('[{"answer":42}]');
    const incomingReceipt = await clickResponse(
      "#socketio-ack",
      `/socketio-sessions/${created.id}/ack`,
    );
    await idle();
    assert.equal(incomingReceipt.acknowledged, true);
    assert.deepEqual(await bounded(answered.promise), [{ answer: 42 }]);
    assert.equal(incomingReplies, 1);
    assert.equal(
      JSON.parse(await page.locator("#socketio-result").textContent())
        .remoteOutcome,
      "unknown",
    );
    await page.locator("#socketio-ack").click();
    await page
      .locator("#socketio-notice")
      .getByText("尚未回应", { exact: false })
      .waitFor();
    assert.equal(incomingReplies, 1);
    session = await refreshUntil((value) =>
      value.events.some(
        (e) => e.direction === "ack-sent" && e.ackId === question.ackId,
      ),
    );
    console.log(
      "SOCKETIO_INCOMING_ACK_BROWSER_PASS explicit-response/local-receipt/no-replay",
    );

    // Hold a genuine list response, leave its owning panel, then deliver it.
    // The stale result must not populate the replacement panel's session picker.
    const held = deferred(),
      release = deferred();
    const listRoute = async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      held.resolve();
      await release.promise;
      await route.fulfill({ response });
    };
    const listPattern = `**/api/projects/${owner}/socketio-sessions`;
    await page.route(listPattern, listRoute);
    try {
      await page.locator("#socketio-list").click();
      await bounded(held.promise);
      await page.locator('.rail [data-page="apis"]').click();
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            `/api/projects/${owner}/socketio-sessions` &&
          r.request().method() === "GET",
      );
      release.resolve();
      await response;
      await page.locator('.rail [data-page="socketio"]').click();
      await idle();
      assert.equal(
        await page.locator("#socketio-session option").count(),
        1,
        "late list must not repopulate picker after leaving panel",
      );
      assert.equal(await page.locator("#socketio-auth").inputValue(), "{}");
      assert.equal(await page.locator("#socketio-query").inputValue(), "{}");
      assert.equal(await page.locator("#socketio-headers").inputValue(), "{}");
    } finally {
      release.resolve();
      await page.unroute(listPattern, listRoute);
    }
    await clickResponse("#socketio-list", "/socketio-sessions", "GET");
    await idle();
    await page.locator("#socketio-session").selectOption(created.id);
    assert.equal(
      startRequests,
      1,
      "choosing existing session must not reconnect",
    );
    await page.locator("#socketio-event").fill("no-ack");
    await page.locator("#socketio-args").fill('["one-attempt"]');
    await page.locator("#socketio-ackTimeoutMs").fill("200");
    const noAckResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith(
          `/socketio-sessions/${created.id}/send`,
        ) && r.request().method() === "POST",
    );
    await page.locator("#socketio-send").evaluate((button) => {
      button.click();
      button.click();
    });
    const noAck = await (await noAckResponse).json();
    await idle();
    assert.equal(noAck.status, "ack-timeout");
    assert.equal(noAck.remoteOutcome, "unknown");
    assert.equal(
      unknownCalls,
      1,
      "duplicate button activation must cause only one remote event",
    );
    assert.equal(sendRequests, 2);
    assert(
      await page.locator("#socketio-send").isDisabled(),
      "unknown send must prevent blind resend",
    );
    await clickResponse(
      "#socketio-refresh",
      `/socketio-sessions/${created.id}`,
      "GET",
    );
    await idle();
    assert(
      await page.locator("#socketio-send").isDisabled(),
      "read-only refresh must not clear unknown send",
    );
    // A hard browser reload must retain the noncredential uncertainty marker,
    // without automatically reconnecting or replaying the timed-out event.
    await page.reload();
    await page.locator("#project-select").waitFor();
    assert.equal(await page.locator("#project-select").inputValue(), owner);
    await page.locator('.rail [data-page="socketio"]').click();
    await idle();
    assert.equal(startRequests, 1, "hard reload must not reconnect");
    assert.equal(sendRequests, 2, "hard reload must not replay events");
    assert(
      await page.locator("#socketio-send").isDisabled(),
      "hard reload must preserve unknown-send gate",
    );
    await page.locator("#socketio-definition").selectOption(definitionId);
    await clickResponse(
      "#socketio-refresh",
      `/socketio-sessions/${created.id}`,
      "GET",
    );
    await idle();
    assert(
      await page.locator("#socketio-send").isDisabled(),
      "restored snapshot must not erase unknown-send evidence",
    );
    const stopped = await clickResponse(
      "#socketio-stop",
      `/socketio-sessions/${created.id}/stop`,
    );
    await idle();
    assert.equal(stopped.state, "closed");
    assert.equal(stopped.recordSaved, true);
    assert.equal(
      JSON.parse(await page.locator("#socketio-stop-result").textContent())
        .recordSaved,
      true,
      "actual stop persistence receipt must remain visible",
    );
    assert(
      await page.locator("#socketio-send").isDisabled(),
      "stop must not erase unknown remote result",
    );
    saved = await readPreviewProject(page, projectURL);
    assert(
      saved.protocolRuns.some((r) => r.type === "socketio"),
      "explicit stop must persist protocol evidence",
    );
    assert(
      !JSON.stringify(saved).includes(secret),
      "auth/query/header runtime credentials must not enter saved evidence",
    );
    assert(
      saved.protocolRuns.some(
        (r) =>
          r.type === "socketio" &&
          r.result.events.some(
            (e) =>
              e.direction === "ack-sent" &&
              e.ackId === question.ackId &&
              e.args[0]?.answer === 42,
          ),
      ),
      "incoming ack response must survive explicit stop and project readback",
    );
    await page.locator('.rail [data-page="history"]').click();
    await clickResponse(
      "#history-project-reload",
      `/api/projects/${owner}`,
      "GET",
    );
    await page.locator("#history-project-reload:not([disabled])").waitFor();
    await page.locator("#protocol-history").waitFor();
    const historyIndex = saved.protocolRuns.findIndex(
      (r) =>
        r.type === "socketio" &&
        r.result.events.some(
          (e) => e.direction === "ack-sent" && e.ackId === question.ackId,
        ),
    );
    assert(historyIndex >= 0);
    const historyRecord = saved.protocolRuns[historyIndex];
    const historyId = historyRecord.id || historyRecord.runId;
    const historyButton = page.locator(
      `[data-protocol-history=${JSON.stringify(historyId)}]`,
    );
    await historyButton.waitFor();
    await page
      .locator("#protocol-history-query")
      .fill("no-such-history-record-unique-sentinel");
    await page
      .locator('#protocol-history-filter button[type="submit"]')
      .click();
    assert.equal(await historyButton.isVisible(), false);
    assert.equal(
      await page.locator("#protocol-history-empty").isVisible(),
      true,
    );
    await page.locator("#protocol-history-filter-clear").click();
    assert.equal(await historyButton.isVisible(), true);
    await page.locator("#protocol-history-type").selectOption("socketio");
    const savedStatus = historyRecord.status ?? historyRecord.result?.status;
    const statusLabel =
      typeof savedStatus === "string" || typeof savedStatus === "number"
        ? String(savedStatus)
        : typeof savedStatus?.code === "number"
          ? `gRPC 状态码 ${savedStatus.code}`
          : typeof (historyRecord.state ?? historyRecord.result?.state) ===
              "string"
            ? `会话状态 ${historyRecord.state ?? historyRecord.result.state}`
            : "未提供状态";
    await page.locator("#protocol-history-status").selectOption(statusLabel);
    await page.locator("#protocol-history-query").fill(historyId);
    await page
      .locator('#protocol-history-filter button[type="submit"]')
      .click();
    assert.equal(await historyButton.isVisible(), true);
    assert.match(
      await page.locator("#protocol-history-count").textContent(),
      /显示 1 \/ /,
    );
    console.log(
      "PROTOCOL_HISTORY_FILTER_BROWSER_PASS loaded-records/no-network/stable-identity",
    );
    await historyButton.click();
    const historyText = await page
      .locator("#protocol-history-detail")
      .textContent();
    assert.deepEqual(JSON.parse(historyText), saved.protocolRuns[historyIndex]);
    await page.locator("#dialog-save").click();
    let recordDownloads = 0;
    const observeRecordDownload = () => recordDownloads++;
    page.on("download", observeRecordDownload);
    const exportButton = page.locator(
      `[data-protocol-history-export=${JSON.stringify(historyId)}]`,
    );
    await exportButton.click();
    await page.locator('#dialog footer button[value="cancel"]').click();
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(recordDownloads, 0, "canceling preview must not download");
    await exportButton.click();
    assert.match(await page.locator("#dialog-content").textContent(), /未脱敏/);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#dialog-save").click();
    const downloaded = await downloadPromise;
    assert.equal(downloaded.suggestedFilename(), "protocol-record.json");
    assert.deepEqual(
      JSON.parse(await readFile(await downloaded.path(), "utf8")),
      historyRecord,
    );
    assert.equal(recordDownloads, 1, "only explicit confirmation downloads");
    page.off("download", observeRecordDownload);
    console.log(
      "PROTOCOL_HISTORY_EXPORT_BROWSER_PASS exact-record/explicit-download/no-replay",
    );
    await page.locator('.rail [data-page="socketio"]').click();
    console.log(
      "PROTOCOL_HISTORY_BROWSER_PASS saved-evidence/read-only/full-detail",
    );
    assert.equal(connections, 1);
    assert.equal(startRequests, 1);
    assert.equal(sendRequests, 2);
    await page.locator("#socketio-workbench details summary").first().click();
    await page
      .locator("#socketio-key")
      .fill("fictional-socketio-private-key-panel-only");
    await page.locator('.rail [data-page="apis"]').click();
    await page.locator('.rail [data-page="socketio"]').click();
    assert.equal(await page.locator("#socketio-key").inputValue(), "");
    saved = await readPreviewProject(page, projectURL);
    assert(
      !JSON.stringify(saved).includes(
        "fictional-socketio-private-key-panel-only",
      ),
    );
    await page.locator('.rail [data-page="apis"]').click();
    console.log(
      "SOCKETIO_BROWSER_PASS definition/save/reload/connect/receive/ack/unknown-no-replay/reload-recovery/stop-record/runtime-isolation/stale-list",
    );
  } finally {
    page.off("request", observe);
    await new Promise((resolve) => io.close(resolve));
  }
}
