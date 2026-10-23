import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { desktopScriptProbes } from "./fixtures/desktop-script-probes.mjs";
test("failure-only probes leave the owned packaged acceptance script unchanged", () => {
  const source = readFileSync(
      new URL("./desktop-smoke.mjs", import.meta.url),
      "utf8",
    ),
    start = source.indexOf("'apt.Visualizing("),
    end = source.indexOf("\n    );", start);
  const original = Function(
    "packagedRequestURL",
    "return (" + source.slice(start, end).trim().replace(/,$/, "") + ");",
  )("http://127.0.0.1:1/mock/fixture");
  const saved = original,
    probes = desktopScriptProbes(original);
  assert.equal(original, saved);
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "b7e2f2daa567afa70edb8604525886e1e83a6750fce43bca4da1410e48a27ddc",
  );
  assert.equal(probes.length, 4);
  assert(original.includes('pm.test("packaged-schema"'));
  assert(probes[0].code.includes("jsonSchema"));
  assert(!probes[3].code.includes("jsonSchema"));
  assert(probes[3].code.includes("packaged-form-body"));
  assert(probes[3].code.includes("pm.sendRequest"));
  assert(probes.every((p) => p.code.includes("desktop-probe-ms")));
  assert.equal(desktopScriptProbes("unrelated").length, 3);
});
