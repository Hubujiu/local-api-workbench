import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
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

const checkoutEnv = "HTTP_WORKBENCH_CHECKOUT_COMMIT";
const checkoutOutput = "${{ steps.browser_checkout.outputs.commit }}";
const workflowText = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
function assertBrowserCheckoutWiring(workflow) {
  const { jobs } = workflow;
  const steps = jobs.browser.steps;
  const checkout = steps.findIndex((step) => step.id === "browser_checkout");
  const smoke = steps.findIndex(
    (step) => step.run === "node tests/ui-smoke.mjs",
  );
  assert.ok(
    checkout >= 0 && checkout < smoke,
    "Checkout must precede browser smoke",
  );
  assert.equal(steps[checkout].uses, "actions/checkout@v4");
  assert.equal(steps[smoke].env?.[checkoutEnv], checkoutOutput);
  const scopes = [
    workflow,
    ...Object.values(jobs).flatMap((job) => [job, ...(job.steps || [])]),
  ];
  assert.deepEqual(
    scopes.filter((scope) => Object.hasOwn(scope.env ?? {}, checkoutEnv)),
    [steps[smoke]],
    "Only browser smoke may receive this provenance environment variable",
  );
}

test("only browser smoke receives its checkout output on LF or CRLF checkouts", () => {
  const lf = workflowText.replaceAll("\r\n", "\n");
  for (const source of [lf, lf.replaceAll("\n", "\r\n")]) {
    assertBrowserCheckoutWiring(parse(source));
  }
});

test("workflow provenance rejects a wrong source, ordering or broader scope", () => {
  for (const mutate of [
    (workflow, steps, smoke) => {
      smoke.env[checkoutEnv] = "${{ github.event.pull_request.head.sha }}";
    },
    (workflow, steps, smoke) => {
      steps.splice(steps.indexOf(smoke), 1);
      steps.unshift(smoke);
    },
    (workflow) => {
      workflow.env = { ...workflow.env, [checkoutEnv]: checkoutOutput };
    },
  ]) {
    const workflow = parse(workflowText);
    const steps = workflow.jobs.browser.steps;
    mutate(
      workflow,
      steps,
      steps.find((step) => step.run === "node tests/ui-smoke.mjs"),
    );
    assert.throws(
      () => assertBrowserCheckoutWiring(workflow),
      assert.AssertionError,
    );
  }
});
