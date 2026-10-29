import { desktopLayout } from "../desktop/build-layout.mjs";
import { writeFile } from "node:fs/promises";
import { portableChecksums } from "./portable-integrity.mjs";
import path from "node:path";
const layout = desktopLayout();
const root = layout.root;
const checksums = await portableChecksums(root);
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
      files: checksums.files,
      links: checksums.links,
      integrityVersion: 1,
    },
    null,
    2,
  ),
);
