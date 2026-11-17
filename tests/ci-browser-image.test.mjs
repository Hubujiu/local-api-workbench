import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

test("browser CI pins the official browser image and matching npm package without removing verification gates", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const browser = workflow.jobs.browser;
  const image = browser.container?.image || "";
  const version = image.match(
    /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[a-f0-9]{64}$/,
  )?.[1];
  assert.ok(
    version,
    "official image must have an exact version and immutable digest",
  );
  const commands = browser.steps.map((step) => step.run).filter(Boolean);
  assert.ok(
    commands.includes(
      `npm install --no-save --ignore-scripts playwright@${version}`,
    ),
  );
  assert.ok(commands.includes("node tests/curl-http2.mjs"));
  assert.ok(commands.includes("node tests/ui-smoke.mjs"));
  assert.ok(
    !commands.some((command) =>
      /playwright install|ci-ubuntu-mirror/.test(command),
    ),
  );
  assert.equal(browser["timeout-minutes"], 10);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(
    browser.steps.find((step) => step.uses === "actions/upload-artifact@v4")
      ?.if,
    "always()",
  );
  assert.doesNotMatch(
    browser.container.options || "",
    /privileged|cap-add|security-opt|ipc=host/,
  );
});
