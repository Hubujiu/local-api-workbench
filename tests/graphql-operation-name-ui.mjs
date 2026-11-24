import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const storage = await mkdtemp(
  join(tmpdir(), "workbench-graphql-operation-name-"),
);
const app = await createApp({ root: storage, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  writes = [],
  errors = [];
const lexical = '{ "n":9007199254740993, "m":1e-2 }';
const initial = {
  lexical:
    '{"query":"query DoNotInfer { fixture }", "variables": ' + lexical + "}",
  empty: '{"query":"query Fixture { item }","operationName":""}',
  "null-vars":
    '{"query":"query Unrelated { item }","operationName":"Old_Name","variables":null}',
  opaque: '{"query":"query Opaque { item }","operationName":null}',
};
let browser;
try {
  let owner = await app.store.create("GraphQL operation name fixture");
  owner.requests = Object.entries(initial).map(([id, body]) =>
    normalizeRequest({
      id,
      name: id,
      method: "POST",
      url: "",
      bodyType: "json",
      body,
      graphqlEditorVersion: 1,
    }),
  );
  owner = await app.store.save(owner);
  const original = structuredClone(await app.store.get(owner.id));
  const path = "/api/projects/" + owner.id;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
  });
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("response-layout", "stacked");
  }, owner.id);
  let accepting = false;
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      accepting &&
      !writes.length &&
      url.origin === origin &&
      url.pathname === path &&
      request.method() === "PUT"
    ) {
      writes.push(request.postDataJSON());
      return route.continue();
    }
    forbidden.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const pane = page.getByRole("region", {
    name: "GraphQL 请求编辑",
    exact: true,
  });
  const details = pane.locator("details.graphql-operation-name");
  const summary = details.locator("summary");
  const include = pane.getByRole("checkbox", {
    name: "包含 operationName",
    exact: true,
  });
  const name = pane.getByRole("textbox", { name: "操作名称", exact: true });
  const query = pane.getByRole("textbox", { name: "Query", exact: true });
  const apply = pane.getByRole("button", { name: "应用到正文", exact: true });
  const discard = pane.getByRole("button", { name: "放弃", exact: true });
  const save = page.locator("#save-project");
  const toast = page.locator("#toast");
  const active = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const select = (id) => page.locator(`[data-request="${id}"]`).click();
  const show = async () => {
    if (!(await details.evaluate((node) => node.open)))
      await summary.press("Enter");
  };
  const evidence = process.env.GRAPHQL_OPERATION_NAME_EVIDENCE;
  const capture = async (filename) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, filename),
      caret: "hide",
      animations: "disabled",
    });
  };
  await query.waitFor();
  assert.equal(await details.evaluate((node) => node.open), false);
  await show();
  assert.equal(await active(summary), true);
  assert.equal(await include.isChecked(), false);
  assert.equal(await name.isDisabled(), true);
  assert.equal(await apply.isVisible(), false);
  assert.equal(await query.inputValue(), "query DoNotInfer { fixture }");
  await include.press("Space");
  assert.equal(await include.isChecked(), true);
  await include.press("Tab");
  assert.equal(await active(name), true);
  assert.equal(await name.inputValue(), "");
  await apply.press("Enter");
  assert.match(await pane.getByRole("alert").textContent(), /操作名称须/);
  await name.fill("invalid-name");
  await apply.press("Enter");
  assert.match(await pane.getByRole("alert").textContent(), /操作名称须/);
  await name.fill("User_Chooses17");
  await capture("operation-name-desktop.png");
  await name.press("Control+Enter");
  assert.match(await toast.textContent(), /未应用/);
  await save.press("Enter");
  assert.match(await toast.textContent(), /未应用/);

  await select("empty");
  await show();
  assert.equal(await include.isChecked(), true);
  assert.equal(await name.inputValue(), "");
  assert.equal(await apply.isVisible(), false);
  await query.fill("query Updated { item }");
  await apply.press("Enter");

  await select("lexical");
  await show();
  assert.equal(await include.isChecked(), true);
  assert.equal(await name.inputValue(), "User_Chooses17");
  await include.press("Space");
  assert.equal(await include.isChecked(), false);
  await include.press("Space");
  assert.equal(await name.inputValue(), "User_Chooses17");
  await apply.press("Enter");
  assert.equal(await active(query), true);

  await select("null-vars");
  await show();
  assert.equal(await name.inputValue(), "Old_Name");
  await include.press("Space");
  assert.equal(await name.isDisabled(), true);
  await discard.press("Enter");
  await show();
  assert.equal(await include.isChecked(), true);
  assert.equal(await name.inputValue(), "Old_Name");
  await include.press("Space");
  await apply.press("Enter");
  assert.equal(await include.isChecked(), false);
  assert.deepEqual(await app.store.get(owner.id), original);

  accepting = true;
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "PUT",
    ),
    save.press("Enter"),
  ]);
  assert.equal(saved.status(), 200);
  await page.getByText("✓ 已保存", { exact: true }).waitFor();
  accepting = false;
  assert.equal(writes.length, 1);
  const result = Object.fromEntries(
    (await app.store.get(owner.id)).requests.map((request) => [
      request.id,
      request.body,
    ]),
  );
  assert.equal(JSON.parse(result.lexical).operationName, "User_Chooses17");
  assert.equal(
    JSON.parse(result.lexical).query,
    "query DoNotInfer { fixture }",
  );
  assert(result.lexical.includes(lexical));
  assert.equal(JSON.parse(result.empty).operationName, "");
  assert.equal(Object.hasOwn(JSON.parse(result.empty), "variables"), false);
  assert.equal(
    Object.hasOwn(JSON.parse(result["null-vars"]), "operationName"),
    false,
  );
  assert.equal(JSON.parse(result["null-vars"]).variables, null);
  assert.equal(result.opaque, initial.opaque);

  await page.reload();
  await select("lexical");
  await page.setViewportSize({ width: 430, height: 830 });
  await show();
  assert.equal(await include.isChecked(), true);
  assert.equal(await name.inputValue(), "User_Chooses17");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("operation-name-narrow.png");
  // The tree lives in its own existing narrow scroll area; restore desktop for the Raw case.
  await page.setViewportSize({ width: 1363, height: 1023 });
  await select("opaque");
  assert.equal(await summary.count(), 0);
  assert.match(await pane.textContent(), /无法用 Query/);
  await pane
    .getByRole("button", { name: "使用原始 HTTP 正文", exact: true })
    .press("Enter");
  assert.equal(await page.locator("#body-code").inputValue(), initial.opaque);
  assert.deepEqual(forbidden, [], "local interaction did not dispatch");
  assert.deepEqual(errors, []);
  console.log(
    "GRAPHQL_OPERATION_NAME_UI_PASS explicit inclusion and omission, shared draft, exact lexical and null coverage, one deliberate save, zero sends",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(storage, { recursive: true, force: true });
}
