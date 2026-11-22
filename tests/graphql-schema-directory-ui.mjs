import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { pickProjectUI } from "./helpers/pick-project-ui.mjs";
import { assertGraphQLBadge } from "./helpers/graphql-badge-ui.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-graphql-schema-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const requestID = "workbench-graphql-schema";
  const body =
    '{ "query" : "query Fixture { viewer { id } }", "variables":\r\n {"long":90071992547409921,"negative":-0} }';
  const makeOwner = async (name) => {
    const project = await app.store.create(name);
    project.requests = [
      normalizeRequest({
        id: requestID,
        name: "GraphQL Schema Fixture",
        method: "POST",
        url: "",
        auth: { type: "none" },
        bodyType: "json",
        body,
        graphqlEditorVersion: 1,
      }),
    ];
    return app.store.save(project);
  };
  const a = await makeOwner("GraphQL Schema Owner A"),
    b = await makeOwner("GraphQL Schema Owner B");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin,
    forbidden = [],
    errors = [],
    metrics = {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("theme", "light");
    localStorage.setItem("response-layout", "stacked");
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name === "held-synthetic.json")
        return new Promise((resolve) => {
          const file = this;
          window.releaseSchemaFixture = async () =>
            resolve(await original.call(file));
        });
      return original.call(this);
    };
  }, a.id);
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    forbidden.push([request.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);

  const projectRow = page.locator(`#tree [data-request="${requestID}"]`);
  const directory = page.getByRole("complementary", {
    name: "GraphQL Schema 类型目录",
  });
  const open = directory.getByRole("button", {
    name: "打开本地 Schema JSON",
    exact: true,
  });
  const clear = directory.getByRole("button", { name: "清除", exact: true });
  const file = directory.locator("#graphql-schema-file");
  const filter = directory.getByRole("searchbox", { name: "筛选类型" });
  const query = page.getByRole("textbox", { name: "Query", exact: true });
  const variables = page.getByRole("textbox", {
    name: "Variables",
    exact: true,
  });
  const results = directory.getByRole("list", { name: "Schema 类型" });
  const evidence = process.env.GRAPHQL_SCHEMA_EVIDENCE;
  const box = () =>
    directory.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    });
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, name + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const choose = async (name, content) => {
    const chooser = page.waitForEvent("filechooser");
    await open.press("Enter");
    await (
      await chooser
    ).setFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.from(content),
    });
  };
  const doc = (objectName = "Viewer") =>
    JSON.stringify({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          subscriptionType: null,
          types: [
            { kind: "OBJECT", name: "Query" },
            { kind: "ENUM", name: "Role" },
            { kind: "SCALAR", name: "ID" },
            {
              kind: "OBJECT",
              name: objectName,
              description: "unshown-private-description",
            },
          ],
        },
      },
    });
  const showEditor = async () => {
    await projectRow.click();
    const tab = page.locator('.param-tabs [data-param="graphql"]');
    await tab.press("Enter");
    await directory.getByText("暂无数据", { exact: true }).waitFor();
  };
  await showEditor();
  const activeTab = page.locator(".tab.selected [data-open-tab]");
  metrics.badgesDesktop = [
    await assertGraphQLBadge(projectRow),
    await assertGraphQLBadge(activeTab),
  ];
  await page.locator('.param-tabs [data-param="graphql"]').focus();
  metrics.empty = await box();
  console.log("GRAPHQL_SCHEMA_EMPTY_GEOMETRY", JSON.stringify(metrics.empty));
  await capture("empty-desktop");
  assert.equal(metrics.empty[2], 394);
  assert(metrics.empty[3] >= 336);
  assert.equal(
    await directory.getByRole("button", { name: /获取|刷新/ }).count(),
    0,
  );
  await choose("unshown-private-basename.json", doc());
  await results.getByText("Viewer", { exact: true }).waitFor();
  await directory
    .getByRole("list", { name: "操作根类型" })
    .getByText("Query", { exact: true })
    .waitFor();
  assert.equal(await file.inputValue(), "");
  const surfaced = await directory.innerHTML();
  assert(!surfaced.includes("unshown-private-basename"));
  assert(!surfaced.includes("unshown-private-description"));
  await capture("populated-desktop");

  await filter.focus();
  assert(await filter.evaluate((el) => el === document.activeElement));
  await filter.fill("enum");
  assert.deepEqual(await results.locator("strong").allTextContents(), ["Role"]);
  await filter.fill("not here");
  await directory.getByText("没有匹配的类型", { exact: true }).waitFor();
  await filter.fill("");
  await choose("unshown-invalid.json", '{"data":{"wrong":true}}');
  await directory.getByText(/已载入的目录不变/).waitFor();
  assert.deepEqual(await results.locator("strong").allTextContents(), [
    "ID",
    "Query",
    "Role",
    "Viewer",
  ]);

  await page.locator("#graphql-variables-toggle").press("Enter");
  assert.match(await variables.inputValue(), /90071992547409921/);
  assert.equal(await query.inputValue(), "query Fixture { viewer { id } }");
  await query.fill("query Unapplied { viewer { id } }");
  await choose("second-valid.json", doc("Replacement"));
  await results.getByText("Replacement", { exact: true }).waitFor();
  assert.equal(await query.inputValue(), "query Unapplied { viewer { id } }");
  await page.locator("#graphql-discard").press("Enter");
  await results.getByText("Replacement", { exact: true }).waitFor();

  await choose("held-synthetic.json", doc("StaleAcrossOwners"));
  await page.waitForFunction(
    () => typeof window.releaseSchemaFixture === "function",
  );
  await pickProjectUI(page, b.id);
  await showEditor();
  await page.evaluate(async () => {
    const release = window.releaseSchemaFixture;
    delete window.releaseSchemaFixture;
    await release();
  });
  assert.equal(await results.count(), 0);
  assert.equal(await directory.getByText("StaleAcrossOwners").count(), 0);

  await page.setViewportSize({ width: 430, height: 830 });
  metrics.badgesNarrow = [
    await assertGraphQLBadge(projectRow),
    await assertGraphQLBadge(activeTab),
  ];
  console.log(
    "GRAPHQL_BADGE_GEOMETRY",
    JSON.stringify([metrics.badgesDesktop, metrics.badgesNarrow]),
  );
  await open.focus();
  await choose("mobile.json", doc("Mobile"));
  await results.getByText("Mobile", { exact: true }).waitFor();
  await filter.focus();
  await filter.fill("mobile");
  metrics.narrow = await box();
  assert(
    metrics.narrow[0] >= 0 && metrics.narrow[0] + metrics.narrow[2] <= 430,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("populated-narrow");
  await clear.press("Enter");
  assert(await open.evaluate((el) => el === document.activeElement));
  assert.equal(await results.count(), 0);
  assert.deepEqual(await app.store.get(a.id), a);
  assert.deepEqual(await app.store.get(b.id), b);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "metrics.json"),
      JSON.stringify(metrics, null, 2),
    );
  console.log(
    "GRAPHQL_SCHEMA_DIRECTORY_UI_PASS local-file/owned-search/stale/no-writes/no-dispatch/1363+430",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
