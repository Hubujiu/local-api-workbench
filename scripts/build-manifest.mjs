import { desktopLayout } from "../desktop/build-layout.mjs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const layout = desktopLayout();
const root = layout.root;
const files = [path.relative(root, layout.executable)];
async function visit(directory) {
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(relative);
    else files.push(relative);
  }
}
await visit(path.relative(root, layout.app));
const checksums = [];
for (const relative of files.sort())
  checksums.push({
    path: relative.replaceAll("\\", "/"),
    sha256: createHash("sha256")
      .update(await readFile(path.join(root, relative)))
      .digest("hex"),
  });
await writeFile(
  path.join(root, "build-manifest.json"),
  JSON.stringify(
    {
      product: "Local API Workbench",
      version: "0.1.0",
      platform: process.platform,
      arch: process.arch,
      head: process.env.BUILD_HEAD || process.env.GITHUB_SHA || "local",
      builtAt: new Date().toISOString(),
      files: checksums,
    },
    null,
    2,
  ),
);
