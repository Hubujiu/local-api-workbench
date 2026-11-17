import { assertProtocolDraftBlocksReload } from "./protocol-draft-unload-ui.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
import { readPreviewProject } from "./preview-draft-ownership-ui.mjs";

export async function exerciseGrpcUnaryUI(page) {
  const protoPath = fileURLToPath(
    new URL("../fixtures/grpc.proto", import.meta.url),
  );
  const proto = await readFile(protoPath, "utf8");
  const definition = loader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    bytes: String,
    enums: String,
    defaults: true,
  });
  const server = new grpc.Server();
  let businessCalls = 0,
    slowStarted;
  const slow = new Promise((resolve) => {
    slowStarted = resolve;
  });
  const metadataSecret = "fictional-grpc-browser-runtime-only";
  server.addService(
    grpc.loadPackageDefinition(definition).fixture.Echo.service,
    {
      Unary(call, done) {
        businessCalls++;
        done(null, call.request);
      },
      Fail(call, done) {
        businessCalls++;
        done({
          code: grpc.status.PERMISSION_DENIED,
          details: "fixture-denied",
        });
      },
      Slow(call) {
        businessCalls++;
        slowStarted();
        call.on("cancelled", () => {});
      },
    },
  );
  new ReflectionService(definition).addToServer(server);
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  const target = `grpc://127.0.0.1:${port}`;
  let runRequests = 0,
    reflectionRequests = 0;
  const observe = (request) => {
    if (request.url().endsWith("/grpc-run")) runRequests++;
    if (request.url().endsWith("/grpc-reflection")) reflectionRequests++;
  };
  page.on("request", observe);
  const clickResponse = async (button, suffix, method = "POST") => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(suffix) && r.request().method() === method,
      ),
      page.locator(button).click(),
    ]);
    assert(response.ok(), "gRPC browser operation must return HTTP success");
    return response.json();
  };
  const idle = () => page.locator("#grpc-inspect:not([disabled])").waitFor();
  try {
    await createImportOwnershipFixture(page);
    const owner = await page.locator("#project-select").inputValue();
    const projectURL = new URL(`/api/projects/${owner}`, page.url()).href;
    await page.locator('.rail [data-page="grpc"]').click();
    await page.locator("#grpc-name").fill("Browser unary fixture");
    await assertProtocolDraftBlocksReload(
      page,
      "#grpc-name",
      "Browser unary fixture",
    );
    await page.locator("#grpc-target").fill(target);
    await page.locator("#grpc-proto").fill(proto);
    await clickResponse("#grpc-inspect", "/grpc-schema");
    await idle();
    await page.locator("#grpc-service").selectOption("fixture.Echo");
    await page.locator("#grpc-method").selectOption("Unary");
    await clickResponse("#grpc-example", "/grpc-request-example");
    await idle();
    assert.equal(
      businessCalls,
      0,
      "schema/example must not execute a business call",
    );
    assert.equal(
      reflectionRequests,
      0,
      "proto inspection must not reflect implicitly",
    );
    await page.locator("#grpc-message").fill(
      JSON.stringify({
        text: "browser-unary",
        big: "9007199254740993",
        blob: "AAEC",
      }),
    );
    await page.locator("#grpc-unary-workbench details summary").first().click();
    await page
      .locator("#grpc-metadata")
      .fill(
        JSON.stringify([{ key: "x-fixture-runtime", value: metadataSecret }]),
      );
    await clickResponse("#grpc-save", `/api/projects/${owner}`, "PUT");
    await page
      .locator("#grpc-notice")
      .getByText("定义已保存", { exact: false })
      .waitFor();
    let saved = await readPreviewProject(page, projectURL);
    const id = saved.settings.grpcDefinitions.find(
      (d) => d.name === "Browser unary fixture",
    )?.id;
    assert(id, "saved definition must exist");
    assert(
      !JSON.stringify(saved).includes(metadataSecret),
      "runtime metadata must not enter saved project",
    );
    await clickResponse("#grpc-run", "/grpc-run");
    await idle();
    let result = JSON.parse(await page.locator("#grpc-result").textContent());
    assert.equal(result.status.code, 0);
    assert.equal(result.recordSaved, true);
    assert.equal(result.messages[0].text, "browser-unary");
    assert.equal(result.messages[0].big, "9007199254740993");
    assert.equal(result.messages[0].blob, "AAEC");
    assert.equal(runRequests, 1);
    saved = await readPreviewProject(page, projectURL);
    assert(
      !JSON.stringify(saved).includes(metadataSecret),
      "runtime metadata must not enter execution history",
    );
    assert(
      saved.protocolRuns.some((r) => r.type === "grpc"),
      "real execution history must persist",
    );
    await clickResponse(
      "#grpc-project-reload",
      `/api/projects/${owner}`,
      "GET",
    );
    await idle();
    await page.locator("#grpc-definition").selectOption(id);
    assert.equal(await page.locator("#grpc-proto").inputValue(), proto);
    assert.equal(await page.locator("#grpc-target").inputValue(), target);
    assert.equal(await page.locator("#grpc-metadata").inputValue(), "[]");
    assert.equal(runRequests, 1, "reload must not replay business calls");
    await clickResponse("#grpc-inspect", "/grpc-schema");
    await idle();
    await page.locator("#grpc-method").selectOption("Watch");
    assert(
      await page.locator("#grpc-run").isDisabled(),
      "streaming method must remain unsendable",
    );
    await page.locator("#grpc-method").selectOption("Fail");
    await clickResponse("#grpc-save", `/api/projects/${owner}`, "PUT");
    await idle();
    await clickResponse("#grpc-run", "/grpc-run");
    await idle();
    result = JSON.parse(await page.locator("#grpc-result").textContent());
    assert.equal(result.status.code, 7);
    assert.equal(result.status.details, "fixture-denied");
    await page.locator("#grpc-method").selectOption("Slow");
    await clickResponse("#grpc-save", `/api/projects/${owner}`, "PUT");
    await idle();
    const terminal = page.waitForResponse((r) => r.url().endsWith("/grpc-run"));
    await page.locator("#grpc-run").click();
    let slowTimer;
    try {
      await Promise.race([
        slow,
        new Promise((_, reject) => {
          slowTimer = setTimeout(
            () => reject(Error("slow fixture was never called")),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(slowTimer);
    }
    await clickResponse("#grpc-cancel", "/api/cancel");
    await terminal;
    await idle();
    result = JSON.parse(await page.locator("#grpc-result").textContent());
    assert.equal(
      result.status.code,
      1,
      "original run must report actual local cancellation",
    );
    assert.equal(runRequests, 3);
    await clickResponse("#grpc-reflect-list", "/grpc-reflection");
    await idle();
    await page.locator("#grpc-reflectionService").selectOption("fixture.Echo");
    await clickResponse("#grpc-reflect-schema", "/grpc-reflection");
    await idle();
    assert.equal(reflectionRequests, 2);
    assert.equal(runRequests, 3, "reflection must not run business methods");
    await page.locator("#grpc-method").selectOption("Unary");
    await clickResponse("#grpc-save", `/api/projects/${owner}`, "PUT");
    await idle();
    saved = await readPreviewProject(page, projectURL);
    assert(
      saved.settings.grpcDefinitions.find((d) => d.id === id)?.schema,
      "reflected descriptor must be saved",
    );
    await page.locator("#grpc-unary-workbench details summary").first().click();
    await page.locator("#grpc-key").fill("fictional-private-key-panel-only");
    await page
      .locator("#grpc-metadata")
      .fill(
        JSON.stringify([{ key: "x-fixture-runtime", value: metadataSecret }]),
      );
    await page.locator('.rail [data-page="apis"]').click();
    await page.locator('.rail [data-page="grpc"]').click();
    assert.equal(await page.locator("#grpc-key").inputValue(), "");
    assert.equal(await page.locator("#grpc-metadata").inputValue(), "[]");
    saved = await readPreviewProject(page, projectURL);
    assert(!JSON.stringify(saved).includes("fictional-private-key-panel-only"));
    assert.equal(runRequests, 3, "navigation must not send or replay calls");
    // Hold a real schema response, edit the draft, then deliver the obsolete
    // response. It must not resurrect schema/method state for the newer input.
    let held, release;
    const reached = new Promise((resolve) => {
      held = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const schemaRoute = async (route) => {
      const response = await route.fetch();
      held();
      await gate;
      await route.fulfill({ response });
    };
    await page.route("**/grpc-schema", schemaRoute);
    try {
      await page.locator("#grpc-inspect").click();
      await reached;
      await page
        .locator("#grpc-proto")
        .fill('syntax = "proto3"; // newer unsaved input');
      release();
      await idle();
      assert.equal(
        await page.locator("#grpc-proto").inputValue(),
        'syntax = "proto3"; // newer unsaved input',
      );
      assert.equal(
        await page.locator("#grpc-method option").count(),
        1,
        "late schema must not restore stale methods",
      );
      assert(await page.locator("#grpc-run").isDisabled());
      assert.equal(runRequests, 3);
    } finally {
      release();
      await page.unroute("**/grpc-schema", schemaRoute);
    }
    // Fixture intentionally discards only its own unsaved schema edit.
    page.once("dialog", (dialog) => dialog.accept());
    await clickResponse(
      "#grpc-project-reload",
      `/api/projects/${owner}`,
      "GET",
    );
    await idle();
    await page.locator('.rail [data-page="apis"]').click();
    console.log(
      "GRPC_UNARY_BROWSER_PASS proto/save/reload/unary/error/cancel/reflection/stream-rejection/runtime-isolation/stale-schema",
    );
  } finally {
    page.off("request", observe);
    server.forceShutdown();
  }
}
