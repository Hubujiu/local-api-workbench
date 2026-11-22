import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const cases = process.env.WORKSPACE_DOCUMENT_HISTORY_CASE
  ? [process.env.WORKSPACE_DOCUMENT_HISTORY_CASE]
  : ["bold", "image"];
const root = await mkdtemp("/tmp/workbench-document-history-");
const app = await createApp({ root, port: 0 });
const origin = new URL(app.launchUrl).origin;
const typed = "First typed line\nSecond typed line";
const modifier = process.platform === "darwin" ? "Meta" : "Control";
let browser;
try {
  const project = await app.store.create("默认项目");
  project.documents = [
    { id: "history-fixture", title: "History fixture", content: "" },
  ];
  await app.store.save(project);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });

  for (const action of cases) {
    assert(["bold", "image"].includes(action), "Unknown edit history fixture");
    const page = await browser.newPage();
    try {
      const writes = [];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin === origin && request.method() === "GET")
          return route.continue();
        writes.push(request.method() + " " + url.pathname);
        return route.abort();
      });
      await page.goto(app.launchUrl);
      const work = page.getByRole("region", { name: "本地 Markdown 文档" });
      const editor = work.getByRole("textbox", { name: "Markdown 正文" });
      const view = work.getByRole("article", { name: "文档预览" });
      await page.locator('[data-document-index="0"]').press("Enter");
      await work
        .getByRole("button", { name: "编辑", exact: true })
        .press("Enter");
      await editor.pressSequentially("First typed line");
      await editor.press("Enter");
      await editor.pressSequentially("Second typed line");
      assert.equal(await editor.inputValue(), typed);
      const checkPreview = async (selector, count) => {
        const matches = view.locator(selector);
        await page.waitForFunction(
          ([selector, count]) =>
            document
              .querySelector('[aria-label="文档预览"]')
              ?.querySelectorAll(selector).length === count,
          [selector, count],
        );
        assert.equal(await matches.count(), count);
        assert.match(await view.textContent(), /First typed line/);
        assert.match(await view.textContent(), /Second typed line/);
      };
      let expected, rendered;
      if (action === "bold") {
        // Select the second line as a user would, then activate the actual tool.
        for (const _ of "Second typed line")
          await editor.press("Shift+ArrowLeft");
        await work
          .getByRole("button", { name: "加粗", exact: true })
          .press("Enter");
        expected = "First typed line\n**Second typed line**";
        rendered = "strong";
      } else {
        const png = Buffer.from(
          await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 2;
            canvas.getContext("2d").fillRect(0, 0, 2, 2);
            return canvas.toDataURL("image/png").split(",")[1];
          }),
          "base64",
        );
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          work.getByRole("button", { name: "插入本地图片" }).press("Enter"),
        ]);
        await chooser.setFiles({
          name: "neutral.png",
          mimeType: "image/png",
          buffer: png,
        });
        rendered = 'img[src^="data:image/png;"]';
        expected =
          typed +
          "\n\n![图片](data:image/png;base64," +
          png.toString("base64") +
          ")";
      }
      await checkPreview(rendered, 1);
      assert.equal(await editor.inputValue(), expected);
      assert(
        await editor.evaluate(
          (element) => element.ownerDocument.activeElement === element,
        ),
      );

      await page.keyboard.press(modifier + "+z");
      assert.equal(
        await editor.inputValue(),
        typed,
        action + " undo must preserve typing",
      );
      await checkPreview(rendered, 0);
      await page.keyboard.press(modifier + "+Shift+z");
      assert.equal(
        await editor.inputValue(),
        expected,
        action + " redo must restore just the tool edit",
      );
      await checkPreview(rendered, 1);

      // As before, toolbar edits and history are local drafts, not writes.
      assert.equal((await app.store.get(project.id)).documents[0].content, "");
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      console.log(
        "WORKSPACE_DOCUMENT_HISTORY_PASS " +
          action +
          " typed/undo/redo/preview/zero-writes",
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
