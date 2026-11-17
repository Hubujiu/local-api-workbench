import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

test("desktop dependency audits remain mandatory before building despite bounded network waits", () => {
  const job = parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  ).jobs.desktop;
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts["audit:ci"], "node scripts/audit-dependencies.mjs");
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job["timeout-minutes"], 15);
  assert.equal(job.env.NPM_CONFIG_FETCH_TIMEOUT, "30000");
  assert.equal(job.env.NPM_CONFIG_FETCH_RETRIES, "1");
  const build = job.steps.findIndex(
    (s) => s.run === "node scripts/build-desktop.mjs",
  );
  for (const command of [
    "npm run audit:ci",
    "npm run audit:ci -- --prefix desktop",
  ]) {
    const at = job.steps.findIndex((s) => s.run === command);
    assert.ok(at >= 0 && at < build);
    assert.equal(job.steps[at]["continue-on-error"], undefined);
    assert.equal(job.steps[at].if, undefined);
  }
  assert.equal(job.env.NPM_CONFIG_AUDIT, undefined);
});
