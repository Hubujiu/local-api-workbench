import { chooseProjectSwitch } from "./helpers/project-switch-confirmation-ui.mjs";
import assert from "node:assert/strict";
import { pickProjectUI } from "./helpers/pick-project-ui.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-switch-aftermath-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const seed = async (owner, name) => {
    const fixture = await app.store.create(name);
    fixture.requests = [
      normalizeRequest({
        id: "shared-request-id",
        name: owner + " 默认接口",
        method: owner === "A" ? "GET" : "POST",
        url: "http://127.0.0.1:1/" + owner + "/never-send",
      }),
      normalizeRequest({
        id: owner + "-second",
        name: owner + " 另一个接口",
        method: "PUT",
        folder: owner + " 目录",
        url: "http://127.0.0.1:1/" + owner + "/second",
      }),
    ];
    fixture.documents = [
      {
        id: "shared-document-id",
        title: owner + " 设计文档",
        content: "# " + owner + " 已保存正文",
      },
    ];
    fixture.environments = [
      {
        id: owner === "A" ? "A-env-first" : "shared-environment-id",
        name: owner + " 第一个环境",
        variables: {},
      },
      {
        id: owner === "A" ? "shared-environment-id" : "B-env-selected",
        name: owner + " 已选环境",
        variables: {},
      },
    ];
    fixture.currentEnvironmentId = fixture.environments[1].id;
    await app.store.save(fixture);
    return app.store.get(fixture.id);
  };
  const a = await seed(
    "A",
    process.env.SWITCH_SOURCE_PROJECT_NAME || "项目切换 A",
  );
  const b = await seed(
    "B",
    process.env.SWITCH_DESTINATION_PROJECT_NAME || "项目切换 B",
  );
  const empty = await app.store.create("Switch Visual Fixture B");
  assert.equal(a.currentEnvironmentId, "shared-environment-id");
  assert.equal(b.currentEnvironmentId, "B-env-selected");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    read = [],
    observations = {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("theme", "light");
  }, a.id);
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === "GET" && url.origin === origin) {
      if (url.pathname.startsWith("/api/projects/")) read.push(url.pathname);
      return route.continue();
    }
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const trigger = page.getByRole("button", { name: "搜索项目", exact: true });
  const popup = page.getByRole("dialog", { name: "搜索项目", exact: true });
  const name = page.locator("#request-name");
  const tabs = page.locator(".tab-scroll .tab-switch");
  const env = page.locator("#env");
  const search = page.locator("#search");
  const direct = page.locator("#project-select");
  const activeOwner = () =>
    direct.locator("option[selected]").getAttribute("value");
  const selectedTab = () =>
    page.locator(".tab-scroll .tab.selected").innerText();
  const selectedLeaf = page.locator("#tree .tree-item[aria-current=true]");
  const sidebarPage = () =>
    page.locator(".sidebar").getAttribute("data-sidebar-page");
  const doc = page.locator('[data-document-index="0"]');
  const docEditor = page.locator("#workspace-document-text");
  const docTitle = page.locator("#workspace-document-title");
  const prefix = process.env.PROJECT_SWITCH_AFTERMATH_PREFIX;
  const capture = async (label) => {
    if (!prefix) return;
    await page.mouse.move(1150, 84);
    await page.screenshot({
      path: prefix + "-" + label + ".png",
      animations: "disabled",
      caret: "hide",
      clip: { x: 0, y: 0, width: 1363, height: 980 },
    });
  };
  const switchTo = async (fixture, decision) => {
    await trigger.click();
    const choice = popup.getByRole("button", {
      name: fixture.name,
      exact: true,
    });
    if (decision === undefined) {
      await choice.click();
    } else {
      await chooseProjectSwitch(page, decision ? "discard" : "cancel", () =>
        choice.click(),
      );
    }
    if (decision !== false)
      await direct
        .locator(`option[value="${fixture.id}"][selected]`)
        .waitFor({ state: "attached" });
    await popup.waitFor({ state: "hidden" });
  };
  const exactProjectReads = (fixture) =>
    read.filter((path) => path === "/api/projects/" + fixture.id).length;
  const assertWelcome = async (fixture) => {
    await page.locator("#welcome-add").waitFor();
    assert.equal(await activeOwner(), fixture.id);
    assert.equal(await sidebarPage(), "apis");
    assert.equal(await tabs.count(), 0);
    assert.equal(await selectedLeaf.count(), 0);
    assert.equal(await name.count(), 0);
    assert.equal(await docEditor.count(), 0);
    assert.equal(await search.inputValue(), "");
    assert.equal(await page.locator("#tree-type").inputValue(), "all");
  };

  await name.waitFor();
  assert.equal(await activeOwner(), a.id);
  assert.equal(await name.inputValue(), "A 默认接口");
  assert.equal(await env.inputValue(), a.currentEnvironmentId);
  await page.locator('[data-request="A-second"]').click();
  assert.equal(await name.inputValue(), "A 另一个接口");
  await page.locator('[data-param="query"]').click();
  await doc.click();
  await page.locator("#workspace-document-toggle").click();
  await docTitle.fill("A 未保存文档");
  await docEditor.fill("# A 未保存正文");
  assert.equal(await tabs.count(), 3);
  await search.fill("A 未保存文档");
  await page.locator("#tree-type").selectOption("document");
  await capture("source-draft");
  await switchTo(b, false);
  assert.equal(exactProjectReads(b), 0);
  assert.equal(await activeOwner(), a.id);
  assert.equal(await docTitle.inputValue(), "A 未保存文档");
  assert.equal(await docEditor.inputValue(), "# A 未保存正文");
  assert.match(await selectedTab(), /A 未保存文档/);
  assert.equal(await tabs.count(), 3);
  await capture("cancelled-unchanged");

  await switchTo(b, true);
  assert.equal(exactProjectReads(b), 1);
  await assertWelcome(b);
  assert.equal(await env.inputValue(), b.currentEnvironmentId);
  const matchingEnvironment = env.locator("option:checked");
  assert.equal(await matchingEnvironment.textContent(), "B 已选环境");
  assert.match(
    await page.locator('#tree [data-request="shared-request-id"]').innerText(),
    /POST\s+B 默认接口/,
  );
  observations.destination = {
    route: await sidebarPage(),
    openTabs: await tabs.count(),
    search: await search.inputValue(),
    displayedEnvironment: await env.inputValue(),
    savedEnvironment: b.currentEnvironmentId,
  };
  await capture("destination-welcome");
  await page.keyboard.press("Control+Enter");
  assert.deepEqual(blocked, []);
  await page.locator('#tree [data-request="shared-request-id"]').click();
  assert.equal(await name.inputValue(), "B 默认接口");
  assert.equal(await page.locator("#method").inputValue(), "POST");
  assert.equal(
    await page.locator("#url").inputValue(),
    "http://127.0.0.1:1/B/never-send",
  );
  assert.match(await selectedTab(), /B 默认接口/);
  assert.match(await selectedLeaf.innerText(), /B 默认接口/);
  assert.equal(
    await page
      .locator('.param-tabs [aria-pressed="true"]')
      .getAttribute("data-param"),
    "body",
  );
  await capture("destination-explicit-leaf");
  await doc.click();
  assert.equal(await docEditor.count(), 0);
  assert.equal(
    await page.locator("#workspace-document-toggle").innerText(),
    "编辑",
  );
  assert.equal(
    await page.locator("#workspace-document-preview h1").innerText(),
    "B 已保存正文",
  );

  await page.locator('.rail [data-page="history"]').click();
  await page.locator("#recent-saved-tab").click();
  await page
    .locator("#recent-saved-list")
    .getByText("B 默认接口", { exact: true })
    .waitFor();
  await switchTo(a);
  await assertWelcome(a);
  assert.equal(await env.inputValue(), a.currentEnvironmentId);
  assert.equal(await env.locator("option:checked").textContent(), "A 已选环境");
  await capture("source-from-recent-welcome");
  await page.locator('.rail [data-page="history"]').click();
  await page.locator("#recent-saved-tab").click();
  const saved = page.locator("#recent-saved-list");
  await saved.getByText("A 默认接口", { exact: true }).waitFor();
  assert.equal(await saved.getByText("B 默认接口", { exact: true }).count(), 0);
  assert.equal(
    await saved.getByText("A 未保存文档", { exact: true }).count(),
    0,
  );
  await page.locator('.rail [data-page="apis"]').click();
  await doc.click();
  assert.equal(
    await page.locator("#workspace-document-preview h1").innerText(),
    "A 已保存正文",
  );
  assert.equal(await docEditor.count(), 0);

  // The second visible picker adopts the same blank workspace. Returning does
  // not reopen the prior project’s document or API.
  await pickProjectUI(page, empty.id);
  await assertWelcome(empty);
  assert.equal(await page.locator("#tree .tree-item").count(), 0);
  await capture("empty-welcome");
  await pickProjectUI(page, a.id);
  await assertWelcome(a);
  assert.equal(await env.inputValue(), a.currentEnvironmentId);
  await capture("source-return-welcome");
  assert.deepEqual(await app.store.get(a.id), a);
  assert.deepEqual(await app.store.get(b.id), b);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);

  console.log("PROJECT_SWITCH_AFTERMATH", JSON.stringify(observations));
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify(
        {
          observations,
          blocked,
          errors,
        },
        null,
        2,
      ) + "\n",
    );
  console.log(
    "PROJECT_SWITCH_AFTERMATH_UI_PASS draft/cancel/explicit-adoption/colliding-ids/active-leaf/route/isolation/both-pickers/owner-env/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
