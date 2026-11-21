import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { httpWorkbenchImplementationCommit } from "./helpers/http-workbench-visual-baseline.mjs";

const checkoutCommit = "5208b72aaeba977b6f29c062f779159c0188f795";
const prHead = "6159b9060eb57db426ac08a908ea84e2907fcaaf";
const unavailableGit = () => assert.fail("CI must not consult local Git");

test("browser evidence uses the actual checkout even when local Git is unavailable", () => {
  assert.equal(
    httpWorkbenchImplementationCommit(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: prHead,
        HTTP_WORKBENCH_CHECKOUT_COMMIT: checkoutCommit,
      },
      unavailableGit,
    ),
    checkoutCommit,
  );
});

test("Actions evidence fails closed on missing or invalid checkout provenance", () => {
  for (const commit of [
    undefined,
    "",
    checkoutCommit.slice(0, 7),
    checkoutCommit + "\n",
    checkoutCommit.toUpperCase(),
    "0".repeat(40),
    "z".repeat(40),
  ]) {
    assert.throws(
      () =>
        httpWorkbenchImplementationCommit(
          {
            GITHUB_ACTIONS: "true",
            GITHUB_SHA: prHead,
            HTTP_WORKBENCH_CHECKOUT_COMMIT: commit,
          },
          unavailableGit,
        ),
      /HTTP_WORKBENCH_CHECKOUT_COMMIT/,
    );
  }
});

test("local evidence resolves the checked-out source rather than a CI override", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(
    httpWorkbenchImplementationCommit({
      HTTP_WORKBENCH_CHECKOUT_COMMIT:
        head === checkoutCommit ? prHead : checkoutCommit,
    }),
    head,
  );
  assert.throws(
    () =>
      httpWorkbenchImplementationCommit({}, () => {
        throw Error("local git unavailable");
      }),
    /local git unavailable/,
  );
});

test("only browser smoke receives the browser checkout's commit output", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const browser = workflow.match(/^  browser:\n([\s\S]*?)^  desktop:/m)?.[1];
  assert.ok(browser);
  assert.match(
    browser,
    /uses: actions\/checkout@v4\n        id: browser_checkout/,
  );
  assert.match(
    browser,
    /- run: node tests\/ui-smoke\.mjs\n        env:\n          HTTP_WORKBENCH_CHECKOUT_COMMIT: \$\{\{ steps\.browser_checkout\.outputs\.commit \}\}/,
  );
  assert.equal(workflow.match(/HTTP_WORKBENCH_CHECKOUT_COMMIT/g)?.length, 1);
});
