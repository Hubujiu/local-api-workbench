import { desktopScriptProbes } from "./fixtures/desktop-script-probes.mjs";
import http from "node:http";
import {
  createHmac,
  generateKeyPairSync,
  verify,
  constants,
} from "node:crypto";
import { startNtlmFixture } from "./fixtures/ntlm-server.mjs";
import { desktopLayout } from "../desktop/build-layout.mjs";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(path.join(os.tmpdir(), "local-api-desktop-"));
const databaseFile = path.join(root, "desktop-fixture.db");
const database = new DatabaseSync(databaseFile);
database.exec(
  "CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(42)",
);
database.close();
const ntlmFixture = await startNtlmFixture();
const jwtSecret = "fictional-desktop-jwt-secret-".repeat(3);
const jwtRSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtEC = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwtFixture = http.createServer(async (request, response) => {
  if (request.url.split("?")[0] === "/final-body") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        body: Buffer.concat(chunks).toString(),
        signature: request.headers["x-final-signature"],
      }),
    );
    return;
  }

  try {
    const [header, payload, signature] = (request.headers.authorization || "")
      .slice(7)
      .split(".");
    const algorithm = JSON.parse(Buffer.from(header, "base64url")).alg;
    const data = Buffer.from(header + "." + payload);
    const valid =
      algorithm === "HS256"
        ? signature ===
          createHmac("sha256", jwtSecret).update(data).digest("base64url")
        : ["RS256", "PS256", "ES256"].includes(algorithm) &&
          verify(
            "sha256",
            data,
            {
              key: algorithm === "ES256" ? jwtEC.publicKey : jwtRSA.publicKey,
              ...(algorithm === "PS256"
                ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
                : {}),
              ...(algorithm === "ES256" ? { dsaEncoding: "ieee-p1363" } : {}),
            },
            Buffer.from(signature, "base64url"),
          );
    assert.equal(valid, true);
    assert.equal(
      JSON.parse(Buffer.from(payload, "base64url")).sub,
      "packaged-fixture",
    );
    if (request.url === "/asap") {
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      assert.equal(algorithm, "RS256");
      assert.equal(
        JSON.parse(Buffer.from(header, "base64url")).kid,
        "fixture-service/key-1",
      );
      assert.equal(claims.iss, "fixture-service");
      assert.equal(claims.aud, "fixture-resource");
      assert.equal(claims.exp - claims.iat, 60);
      assert(claims.iat <= Math.floor(Date.now() / 1000));
      assert(claims.exp > Math.floor(Date.now() / 1000));
      assert.match(claims.jti, /^[0-9a-f-]{36}$/);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jwt: true, algorithm }));
  } catch {
    response.statusCode = 401;
    response.end("invalid fixture signature");
  }
});
await new Promise((resolve) => jwtFixture.listen(0, "127.0.0.1", resolve));

let capturedScriptFailure = false;
let application,
  phase = "launch";
const watchdog = setTimeout(() => {
  console.error("DESKTOP_WATCHDOG_TIMEOUT", phase);
  application?.process().kill();
  process.exitCode = 1;
}, 90000);
try {
  application = await electron.launch({
    executablePath: desktopLayout().executable,
    env: { ...process.env, LOCAL_API_DESKTOP_DATA: root },
    timeout: 30000,
  });
  application.process().stderr?.on("data", (chunk) => {
    const text = String(chunk).replace(
      /([?&#](?:token|key|code|state)=)[^\s&#]+/gi,
      "$1[redacted]",
    );
    console.error("DESKTOP_STDERR", text.slice(0, 4000));
  });
  const window = await application.firstWindow();
  window.on("pageerror", (error) =>
    console.error("DESKTOP_PAGE_ERROR", error.message),
  );
  window.on("requestfailed", (request) => {
    const url = new URL(request.url());
    console.error(
      "DESKTOP_REQUEST_FAILED",
      url.origin + url.pathname,
      request.failure()?.errorText,
    );
  });
  window.on("response", (response) => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      console.error(
        "DESKTOP_HTTP_ERROR",
        response.status(),
        url.origin + url.pathname,
      );
    }
  });
  phase = "request";
  console.log("DESKTOP_PHASE", phase);
  await window.getByRole("button", { name: "发 送", exact: true }).waitFor();
  await window.getByRole("button", { name: "发 送", exact: true }).click();
  await window
    .getByText("欢迎使用 Local API", { exact: false })
    .last()
    .waitFor();
  assert(await window.getByText("200", { exact: true }).isVisible());
  phase = "script";
  console.log("DESKTOP_PHASE", phase);
  await window.locator('[data-param="after"]').click();
  window.once("dialog", (dialog) => dialog.accept());
  await window.locator("#script-dialect").selectOption("apipost8");
  const packagedRequestURL = await window.locator("#url").inputValue();
  await window.locator('[data-param="after"]').click();
  await window
    .locator("#script-code")
    .fill(
      'apt.Visualizing("<p>{{marker}}</p>",{marker:"packaged-visualizing"});' +
        'pm.request.addQueryParams("packaged-batch={{packaged+&=%query}}");apt.request.removeQueryParams([{key:"packaged-batch"}]);' +
        'apt.setRequestHeader("x-packaged-shortcut",null);pm.setRequestQuery("packaged-shortcut",false);pm.removeRequestQuery("packaged-shortcut");pm.removeRequestHeader("x-packaged-shortcut");' +
        'pm.test.skip("packaged-pending",()=>{throw Error("not executed")});pm.test("packaged-test-index",()=>{pm.expect(pm.test.index()).to.equal(2);pm.expect(pm.request.getHeaders({enabled:true,ignoreCase:true})).to.be.an("object");});' +
        'pm.test("packaged-json5",()=>pm.expect(require("json5").parse("{unquoted:1,}").unquoted).to.equal(1));' +
        'pm.test("packaged-schema",()=>pm.response.to.have.jsonSchema({type:"object",properties:{message:{type:"string"}},required:["message"]}));' +
        'apt.variables.set("packagedPrivate","local"); apt.test("packaged-dialect",()=>{apt.expect(apt.response.json()).to.deep.equal(pm.response.json());apt.expect(typeof apt.response.headers.get).to.equal("function");});await Promise.resolve();pm.test("packaged-utilities",()=>{pm.expect(_.sum([1,2,3])).to.equal(6);pm.expect(apt.environment.getName()).to.be.a("string").and.not.empty;pm.expect(pm.environment.id).to.be.a("string").and.not.empty;pm.expect(apt.info.eventName).to.equal("test");pm.expect(apt.info.iteration).to.equal(0);pm.expect(apt.info.iterationCount).to.equal(1);pm.expect(pm.iterationData.toObject()).to.deep.equal({});pm.expect(csv2array("name,age")[0]).to.deep.equal(["name","age"]);apt.expect(xml2Json("<a>ok</a>").a).to.equal("ok");pm.expect(moment.utc("2024-02-28").add(1,"day").format("YYYY-MM-DD")).to.equal("2024-02-29");pm.expect(uuid.validate(uuid.v4())).to.equal(true)});console.log("packaged-script-ok"); pm.test("packaged-crypto",()=>pm.expect(CryptoJS.SHA256("abc").toString()).to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));' +
        `const reply=await pm.sendRequest(${JSON.stringify(packagedRequestURL)});pm.test('packaged-http',async()=>{await new Promise(resolve=>setTimeout(resolve,5));pm.expect(reply.code).to.equal(200);pm.expect(reply).to.have.jsonSchema({type:'object',properties:{message:{type:'string'}},required:['message']});});` +
        'pm.response.setBody({packagedView:0}); apt.response.setCode(201); pm.test("packaged-response-view", () => { pm.expect(apt.response.json()).to.deep.equal({packagedView:0}); pm.expect(pm.response.originalCode()).to.equal(200); });' +
        'pm.request.headers.add({key:"x-live-entry",value:"before",description:"retained description"});const iteratorContext={value:"after",seen:0};pm.request.headers.each(function(e){this.seen++;return false;},iteratorContext);pm.request.headers.find(e=>e.key==="x-live-entry").value=iteratorContext.value;pm.test("packaged-live-header",()=>{pm.expect(pm.request.headers.get("x-live-entry")).to.equal("after");pm.expect(iteratorContext.seen).to.equal(1);pm.expect(pm.request.headers.one("x-live-entry").description).to.equal("retained description");const held=pm.request.headers.one("x-live-entry");pm.expect(pm.request.headers.upsert({key:"x-live-entry",value:"after"})).to.equal(false);pm.expect(pm.request.headers.one("x-live-entry")).to.equal(held);pm.expect(pm.request.headers.map(e=>e.key).includes("x-live-entry")).to.equal(true);pm.expect(pm.request.headers.reduce(n=>n+1,0)).to.equal(pm.request.headers.count());});pm.request.headers.remove(pm.request.headers.one("x-live-entry"));pm.expect(pm.request.headers.indexOf("x-live-entry")).to.equal(-1);pm.request.headers.add({key:"x-disabled-reader",value:"hidden",disabled:true});pm.test("packaged-disabled-reader",()=>{pm.expect(pm.request.headers.get("X-DISABLED-READER")).to.equal("hidden");pm.expect(pm.request.headers.toObject(true)["x-disabled-reader"]).to.equal(undefined);});pm.request.headers.remove("x-disabled-reader");const savedURL=pm.request.url;pm.request.url="http://{{host?part#x}}/p?drop=1&q={{v&x}}";pm.request.removeQueryParams("drop");pm.test("packaged-url-template",()=>pm.expect(pm.request.url).to.equal("http://{{host?part#x}}/p?q={{v&x}}"));pm.request.url=savedURL;' +
        'pm.setRequestBody({packaged:{value:1}});apt.setRequestBody("packaged.value",2);pm.test("packaged-modern-body",()=>pm.expect(JSON.parse(pm.request.body.raw).packaged.value).to.equal(2));pm.removeRequestBody("packaged.value");' +
        'pm.request.body.update({mode:"urlencoded",urlencoded:[{key:"packaged",value:"old"}]}); const packagedForm=pm.request.body.urlencoded,formContext={seen:0};packagedForm.each(function(e){this.seen++;return false;},formContext);packagedForm.find(e=>e.key==="packaged").value="new";packagedForm.add({key:"temporary",value:"remove"});packagedForm.remove(packagedForm.one("temporary")); pm.test("packaged-form-body", () => {pm.expect(pm.request.body.urlencoded.get("packaged")).to.equal("new");pm.expect(formContext.seen).to.equal(1);pm.expect(packagedForm.indexOf("packaged")).to.equal(0);pm.expect(packagedForm.has(packagedForm.one("packaged"))).to.equal(true);pm.expect(packagedForm.filter(e=>e.key==="packaged").length).to.equal(1);pm.expect(packagedForm.map(e=>e.value)).to.deep.equal(["new"]);pm.expect(packagedForm.reduce(n=>n+1,0)).to.equal(1);});',
    );
  const scriptResponse = window.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/execute"),
  );
  await window.locator("#send").click();
  const scriptPayload = await (await scriptResponse).json();
  if (scriptPayload.outcome !== "passed") {
    console.error(
      "DESKTOP_ORIGINAL_SCRIPT_FAILURE",
      JSON.stringify(scriptPayload),
    );
    const original = await window.locator("#script-code").inputValue();
    await window
      .screenshot({ path: "dist/desktop-failure.png" })
      .then(() => {
        capturedScriptFailure = true;
      })
      .catch(() => {});
    phase = "script-diagnostics";
    try {
      for (const probe of desktopScriptProbes(original)) {
        await window.locator("#send:not([disabled])").waitFor();
        await window.locator("#script-code").fill(probe.code);
        const reply = window.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/execute"),
        );
        await window.locator("#send").click();
        const result = await (await reply).json();
        console.error(
          "DESKTOP_SCRIPT_PROBE",
          JSON.stringify({
            name: probe.name,
            outcome: result.outcome,
            error: result.error,
            stage: result.scriptStage,
            diagnostics: result.scriptDiagnostics,
            logs: result.logs,
            assertions: result.assertions?.map((a) => ({
              name: a.name,
              passed: a.passed,
            })),
          }),
        );
      }
    } catch (probeError) {
      console.error("DESKTOP_SCRIPT_PROBE_FAILED", String(probeError));
    } finally {
      await window
        .locator("#script-code")
        .fill(original)
        .catch(() => {});
      phase = "script";
    }
  }
  assert.equal(scriptPayload.outcome, "passed", JSON.stringify(scriptPayload));
  assert.equal(scriptPayload.extracted.packagedPrivate, undefined);
  assert(
    scriptPayload.assertions.some(
      (item) => item.name === "packaged-pending" && item.skipped === true,
    ),
  );
  assert(
    scriptPayload.assertions.some(
      (item) => item.name === "packaged-test-index" && item.passed === true,
    ),
  );

  assert.equal(scriptPayload.status, 200);
  assert(
    scriptPayload.assertions.some(
      (item) => item.name === "packaged-url-template" && item.passed,
    ),
  );
  assert(
    scriptPayload.assertions.some(
      (item) => item.name === "packaged-modern-body" && item.passed,
    ),
  );
  assert.equal(scriptPayload.visualization, "<p>packaged-visualizing</p>");
  assert(
    scriptPayload.assertions.some(
      (item) => item.name === "packaged-form-body" && item.passed,
    ),
  );
  assert.deepEqual(scriptPayload.scriptResponse, {
    body: '{"packagedView":0}',
    status: 201,
  });
  assert(
    scriptPayload.assertions.some(
      (item) => item.name === "packaged-response-view" && item.passed,
    ),
  );
  assert.equal(scriptPayload.subrequests[0].response.status, 200);
  await window.locator('[data-response="logs"]').click();
  await window
    .locator(".response-body")
    .getByText("packaged-script-ok", { exact: false })
    .waitFor();
  phase = "sdk-url";
  console.log("DESKTOP_PHASE", phase);
  await window.locator('[data-param="after"]').click();
  const sdkOriginalAfter = await window.locator("#script-code").inputValue();
  window.once("dialog", (dialog) => dialog.accept());
  await window.locator("#script-url-mode").selectOption("sdk");
  await window
    .locator("#script-code")
    .fill(
      "pm.test('packaged-sdk-url',()=>{pm.expect(typeof pm.request.url).to.equal('object');pm.expect(pm.request.url.query.get('packaged-sdk')).to.equal('one&two');});",
    );
  await window.locator('[data-param="before"]').click();
  const sdkOriginalBefore = await window.locator("#script-code").inputValue();
  await window
    .locator("#script-code")
    .fill("pm.request.url.query.upsert({key:'packaged-sdk',value:'one&two'});");
  const sdkResponse = window.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/execute"),
  );
  await window.locator("#send").click();
  const sdkPayload = await (await sdkResponse).json();
  assert.equal(sdkPayload.outcome, "passed", JSON.stringify(sdkPayload));
  assert.equal(
    new URL(sdkPayload.request.url).searchParams.get("packaged-sdk"),
    "one&two",
  );
  assert(
    sdkPayload.assertions.some(
      (item) => item.name === "packaged-sdk-url" && item.passed,
    ),
  );
  await window.locator("#script-code").fill(sdkOriginalBefore);
  window.once("dialog", (dialog) => dialog.accept());
  await window.locator("#script-url-mode").selectOption("string");
  await window.locator('[data-param="after"]').click();
  await window.locator("#script-code").fill(sdkOriginalAfter);
  phase = "final-body";
  console.log("DESKTOP_PHASE", phase);
  const beforeFinalBody = await window
    .locator(".tab.selected [data-open-tab]")
    .getAttribute("data-open-tab");
  await window.getByRole("button", { name: "新建接口", exact: true }).click();
  await window.locator("#request-name").fill("Final body packaged fixture");
  await window.locator("#method").selectOption("POST");
  await window
    .locator("#url")
    .fill("http://127.0.0.1:" + jwtFixture.address().port + "/final-body");
  await window.locator('[data-param="body"]').click();
  await window.locator('input[name="body-type"][value="raw"]').check();
  await window.locator("#raw-format").selectOption("raw");
  await window.locator("#body-code").fill("{{payload}}");
  await window.locator('[data-param="before"]').click();
  await window
    .locator("#script-code")
    .fill(
      "pm.variables.set('payload','{{literal}}+&');const bytes=pm.getFinalRequestRawBody();pm.setRequestHeader('x-final-signature',CryptoJS.HmacSHA256(bytes,'fixture-key').toString());",
    );
  await window.locator('[data-param="after"]').click();
  await window
    .locator("#script-code")
    .fill(
      "pm.test('final-body-wire',()=>{pm.expect(pm.response.json().body).to.equal('{{literal}}+&');pm.expect(typeof pm.getFinalRequestRawBody).to.equal('undefined');});",
    );
  const finalBodyResponse = window.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/execute"),
  );
  await window.locator("#send").click();
  const finalBodyPayload = await (await finalBodyResponse).json();
  assert.equal(
    finalBodyPayload.outcome,
    "passed",
    JSON.stringify(finalBodyPayload),
  );
  const finalBodyEcho = JSON.parse(finalBodyPayload.body);
  assert.equal(finalBodyEcho.body, "{{literal}}+&");
  assert.equal(
    finalBodyEcho.signature,
    createHmac("sha256", "fixture-key").update("{{literal}}+&").digest("hex"),
  );
  await window.locator('[data-open-tab="' + beforeFinalBody + '"]').click();
  phase = "ntlm";
  await window.locator("#url").fill(ntlmFixture.url);
  await window.locator('[data-param="auth"]').click();
  await window.locator("#auth-type").selectOption("ntlm");
  for (const [key, value] of Object.entries({
    username: "User",
    password: "Password",
    domain: "Domain",
    workstation: "COMPUTER",
  }))
    await window.locator('[data-auth="' + key + '"]').fill(value);
  const ntlmResponse = window.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await window.locator("#send").click();
  const ntlmResult = await (await ntlmResponse).json();
  assert.equal(ntlmResult.status, 200, JSON.stringify(ntlmResult));
  assert.equal(JSON.parse(ntlmResult.body).ntlm, true);
  assert.equal(ntlmFixture.stats.sockets.size, 1);
  phase = "jwt";
  console.log("DESKTOP_PHASE", phase);
  const beforeJWTRequest = await window
    .locator(".tab.selected [data-open-tab]")
    .getAttribute("data-open-tab");
  await window.getByRole("button", { name: "新建接口", exact: true }).click();
  await window.locator("#request-name").fill("JWT packaged fixture");
  await window.locator('[data-param="auth"]').click();
  await window
    .locator("#url")
    .fill("http://127.0.0.1:" + jwtFixture.address().port);
  await window.locator("#auth-type").selectOption("jwt");
  await window
    .locator('[data-auth="payload"]')
    .fill('{"sub":"packaged-fixture"}');
  for (const algorithm of ["HS256", "RS256", "PS256", "ES256"]) {
    const secret =
      algorithm === "HS256"
        ? jwtSecret
        : (algorithm === "ES256" ? jwtEC : jwtRSA).privateKey.export({
            type: "pkcs8",
            format: "pem",
          });
    await window.locator('[data-auth="algorithm"]').selectOption(algorithm);
    await window.locator('[data-auth="secret"]').fill(secret);
    const reply = window.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    );
    await window.locator("#send").click();
    const result = await (await reply).json();
    assert.equal(result.status, 200);
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.body), { jwt: true, algorithm });
    await window.locator("#send:not([disabled])").waitFor();
  }

  phase = "asap";
  console.log("DESKTOP_PHASE", phase);
  await window
    .locator("#url")
    .fill("http://127.0.0.1:" + jwtFixture.address().port + "/asap");
  await window.locator("#auth-type").selectOption("asap");
  for (const [key, value] of Object.entries({
    iss: "fixture-service",
    aud: "fixture-resource",
    kid: "fixture-service/key-1",
    sub: "packaged-fixture",
    privateKey: jwtRSA.privateKey.export({ type: "pkcs8", format: "pem" }),
  }))
    await window.locator('[data-auth="' + key + '"]').fill(value);
  const asapReply = window.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await window.locator("#send").click();
  const asapResult = await (await asapReply).json();
  assert.equal(asapResult.status, 200);
  assert.equal(asapResult.outcome, "passed", JSON.stringify(asapResult));
  assert.deepEqual(JSON.parse(asapResult.body), {
    jwt: true,
    algorithm: "RS256",
  });
  phase = "json-body-assertions";
  console.log("DESKTOP_PHASE", phase);
  await window.locator('[data-param="after"]').click();
  await window
    .locator("#script-code")
    .fill(
      'apt.test("packaged JSON",()=>{apt.response.to.have.jsonBody();apt.response.to.have.jsonBody("algorithm","RS256");pm.response.to.have.jsonBody({algorithm:"RS256",jwt:true});apt.response.to.not.have.jsonBody("error");});',
    );
  const jsonReply = window.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await window.locator("#send").click();
  const jsonResult = await (await jsonReply).json();
  assert.equal(jsonResult.status, 200);
  assert.equal(jsonResult.outcome, "passed", JSON.stringify(jsonResult));
  await window.locator("#send:not([disabled])").waitFor();
  await window.locator('[data-open-tab="' + beforeJWTRequest + '"]').click();
  await window.locator('[data-param="auth"]').click();
  await window.locator("#auth-type").selectOption("none");
  await window.locator("#url").fill(packagedRequestURL);
  phase = "xml";
  console.log("DESKTOP_PHASE", phase);
  await window.locator('[data-mode="mock"]').click();
  await window.locator("#edit-mock-rules").click();
  await window.locator("#modal-json").fill(
    JSON.stringify([
      {
        name: "XML fixture",
        conditions: [],
        response: {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: '<root xmlns="urn:fixture"><value>packaged-xml</value></root>',
        },
      },
    ]),
  );
  await window.locator("#dialog-save").click();
  await window.locator("#dialog").waitFor({ state: "hidden" });
  await window.locator('[data-mode="debug"]').click();
  await window.locator('[data-param="extract"]').click();
  await window.locator("#add-extract").click();
  await window.locator('[data-extract="0:name"]').fill("xmlValue");
  await window.locator('[data-extract="0:source"]').selectOption("xml");
  await window
    .locator('[data-extract="0:path"]')
    .fill("/x:root/x:value/text()");
  await window.locator("#edit-operations").click();
  const extractionRules = JSON.parse(
    await window.locator("#modal-json").inputValue(),
  );
  extractionRules[0].namespaces = { x: "urn:fixture" };
  await window.locator("#modal-json").fill(JSON.stringify(extractionRules));
  await window.locator("#dialog-save").click();
  await window.locator("#send").click();
  await window.locator('[data-response="extracted"]').click();
  await window
    .locator(".response-body")
    .getByText('"xmlValue": "packaged-xml"', { exact: false })
    .waitFor();
  phase = "save";
  console.log("DESKTOP_PHASE", phase);
  await Promise.all([
    window.waitForResponse(
      (response) =>
        response.request().method() === "PUT" && response.status() === 200,
    ),
    window.locator("#save-project").click(),
  ]);
  await window.getByText("✓ 已保存", { exact: true }).waitFor();
  phase = "database";
  console.log("DESKTOP_PHASE", phase);
  await window.locator('.rail [data-page="settings"]').click();
  await window.locator('[data-page="database"]').click();
  await window.locator("#db-path").fill(databaseFile);
  await window.locator("#db-sql").fill("SELECT id FROM fixture");
  await window.locator("#db-query").click();
  await window
    .locator("#db-result")
    .getByText("42", { exact: false })
    .waitFor();
  phase = "database-write";
  console.log("DESKTOP_PHASE", phase);
  await window
    .locator("#db-sql")
    .fill("INSERT INTO fixture(id) VALUES (?) RETURNING id");
  await window.locator("#db-params").fill("[43]");
  await window.locator("#db-write").check();
  window.once("dialog", (dialog) => dialog.accept());
  await window.locator("#db-query").click();
  await window
    .locator("#db-result")
    .getByText('"committed": true', { exact: false })
    .waitFor();
  assert.equal(await window.locator("#db-write").isChecked(), false);
  const writtenDatabase = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(
      writtenDatabase
        .prepare("SELECT count(*) AS n FROM fixture WHERE id=43")
        .get().n,
      1,
    );
  } finally {
    writtenDatabase.close();
  }
  const settings = await application.evaluate(({ BrowserWindow }) => {
    const preferences =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
      sandbox: preferences.sandbox,
    };
  });
  assert.equal(settings.nodeIntegration, false);
  assert.equal(settings.contextIsolation, true);
  assert.equal(settings.sandbox, true);
  console.log("PACKAGED_DESKTOP_SMOKE_PASS");
} catch (error) {
  console.error("DESKTOP_FAILURE_PHASE", phase);
  if (application) {
    const window = application.windows()[0];
    console.error(
      "DESKTOP_WINDOWS",
      await application
        .evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((win) => ({
            id: win.id,
            destroyed: win.isDestroyed(),
            loading: win.webContents.isLoading(),
            crashed: win.webContents.isCrashed(),
            url: win.webContents.getURL().split(/[?#]/)[0],
          })),
        )
        .catch(() => "unavailable"),
    );
    if (!capturedScriptFailure)
      await window
        ?.screenshot({ path: "dist/desktop-failure.png" })
        .catch(() => {});
    if (window)
      console.error(
        "DESKTOP_FAILURE_STATE",
        await window
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      );
  }
  throw error;
} finally {
  phase = "shutdown";
  // Test-owned process only. Never let a failed test's unsaved dialog hang CI indefinitely.
  if (application) {
    application.process().kill();
    await application.close().catch(() => {});
  }
  await ntlmFixture.close();
  jwtFixture.closeAllConnections();
  await new Promise((resolve) => jwtFixture.close(resolve));
  clearTimeout(watchdog);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
