import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

export async function captureHTTPWorkbenchBaseline(
  page,
  {
    viewport = { width: 1188, height: 848 },
    prefix = "/tmp/local-api-http-workbench",
  } = {},
) {
  const priorViewport = page.viewportSize();
  const priorDark = await page
    .locator("body")
    .evaluate((el) => el.classList.contains("dark"));
  const expected = {
    name: await page.locator("#request-name").inputValue(),
    url: await page.locator("#url").inputValue(),
    body: await page.locator("#body-code").inputValue(),
  };
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const manifest = {
    schemaVersion: 1,
    implementationCommit: commit,
    fixtureDigest: createHash("sha256")
      .update(JSON.stringify(expected))
      .digest("hex"),
    capturedAt: new Date().toISOString(),
    viewport,
    state:
      "HTTP request / raw JSON body / empty response; same untouched draft in both themes",
    reference: null,
    fidelityStatus:
      "uncompared; this is an implementation baseline, not an Apipost-equivalence claim",
    captures: [],
  };
  try {
    await page.setViewportSize(viewport);
    assert(
      await page.locator(".empty-symbol svg").isVisible(),
      "baseline must start before any response",
    );
    assert.equal(await page.locator("#body-code").isVisible(), true);
    for (const theme of ["light", "dark"]) {
      const dark = await page
        .locator("body")
        .evaluate((el) => el.classList.contains("dark"));
      if (dark !== (theme === "dark")) await page.locator("#theme").click();
      await page.evaluate(async () => {
        document.activeElement?.blur();
        for (const selector of [
          "#body-code",
          "#code-highlight",
          "#code-gutter",
        ]) {
          const element = document.querySelector(selector);
          element.scrollTop = 0;
          element.scrollLeft = 0;
        }
        await document.fonts.ready;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
      assert.equal(
        await page.locator("#request-name").inputValue(),
        expected.name,
      );
      assert.equal(await page.locator("#url").inputValue(), expected.url);
      assert.equal(
        await page.locator("#body-code").inputValue(),
        expected.body,
      );
      assert(await page.locator(".empty-symbol svg").isVisible());
      const metrics = await page.evaluate(() => {
        const selectors = [
          ".rail",
          ".tabs",
          ".param-tabs",
          ".body-actions",
          ".sidebar",
          ".project-group",
          ".urlbar",
          ".request-panel",
          ".body-editor-shell",
          "#body-code",
          "#code-highlight",
          "#code-gutter",
          ".response-tabs",
          ".response",
        ];
        return {
          deviceScaleFactor: devicePixelRatio,
          viewport: { width: innerWidth, height: innerHeight },
          elements: selectors.map((selector) => {
            const element = document.querySelector(selector);
            if (!element)
              throw Error("Missing visual baseline element: " + selector);
            const rect = element.getBoundingClientRect(),
              style = getComputedStyle(element);
            return {
              selector,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
              color: style.color,
              backgroundColor: style.backgroundColor,
            };
          }),
        };
      });
      assert.equal(metrics.viewport.width, viewport.width);
      assert.equal(metrics.viewport.height, viewport.height);
      if (viewport.width >= 1000) {
        const bySelector = Object.fromEntries(
          metrics.elements.map((element) => [element.selector, element]),
        );
        for (const selector of [
          "#body-code",
          "#code-highlight",
          "#code-gutter",
        ]) {
          assert.equal(
            bySelector[selector].fontSize,
            "12px",
            `${theme} ${selector} font size`,
          );
          assert.equal(
            bySelector[selector].lineHeight,
            "16px",
            `${theme} ${selector} native row pitch`,
          );
        }
        for (const [selector, key, expected] of [
          [".rail", "width", 50],
          [".sidebar", "width", 263],
          [".tabs", "height", 38],
          [".urlbar", "y", 138],
          [".urlbar", "height", 40],
          [".param-tabs", "y", 178],
          [".param-tabs", "height", 43],
          [".body-actions", "y", 273],
          [".response", "y", 495],
          [".response-tabs", "height", 44],
        ]) {
          assert(
            Math.abs(bySelector[selector][key] - expected) <= 1,
            `${theme} ${selector}.${key}: expected ${expected}, got ${bySelector[selector][key]}`,
          );
        }
      }
      const file = prefix + "-" + theme + ".png";
      await page.screenshot({
        path: file,
        animations: "disabled",
        caret: "hide",
      });
      manifest.captures.push({ theme, file, metrics });
    }
    await writeFile(prefix + ".json", JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } finally {
    const dark = await page
      .locator("body")
      .evaluate((el) => el.classList.contains("dark"));
    if (dark !== priorDark) await page.locator("#theme").click();
    if (priorViewport) await page.setViewportSize(priorViewport);
  }
}
