import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// No engine or guest is created here. The caller charges the complete read,
// manifest parsing and digest elapsed time to its existing activity allowance.
export async function readScriptMockAsset() {
  const [code, manifestText] = await Promise.all([
    readFile(
      new URL("./vendor/script-mock-library.js", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("./vendor/script-mock-library.json", import.meta.url),
      "utf8",
    ),
  ]);
  const manifest = JSON.parse(manifestText);
  if (
    manifest.package !== "apipost-mock" ||
    manifest.version !== "1.0.2" ||
    manifest.sourceSha256 !==
      "444c7ccad3c4ee00ce6871517995852d5a5928715a6b449d3f2622291e6e816a" ||
    createHash("sha256").update(code).digest("hex") !== manifest.sha256
  )
    throw Error("脚本Mock库完整性校验失败");
  return code;
}
