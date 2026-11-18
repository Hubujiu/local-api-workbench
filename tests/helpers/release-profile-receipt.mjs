import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inventory } from "./installed-product-contract.mjs";

export async function recordReleaseProjects(root, receipt) {
  const projects = path.join(root, "projects");
  const files = await inventory(projects);
  assert.ok(Object.keys(files).length, "Saved project files required");
  await writeFile(receipt, JSON.stringify({ projects, files }), { flag: "wx" });
}

export async function verifyReleaseProjects(receipt) {
  const { projects, files } = JSON.parse(await readFile(receipt, "utf8"));
  assert.ok(Object.keys(files).length, "Empty project receipt");
  assert.deepEqual(
    await inventory(projects),
    files,
    "Installer changed saved project files",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(process.argv.length, 3, "Expected one project receipt path");
  await verifyReleaseProjects(process.argv[2]);
}
