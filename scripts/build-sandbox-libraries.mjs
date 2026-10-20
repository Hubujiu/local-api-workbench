import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("src/vendor", { recursive: true });
await build({
  entryPoints: ["scripts/sandbox-library-entry.mjs"],
  outfile: "src/vendor/script-libraries.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  external: ["crypto"],
  legalComments: "inline",
});
const notices = [];
for (const name of ["crypto-js", "chai", "lodash", "moment", "uuid"]) {
  const packageInfo = JSON.parse(
    await readFile("node_modules/" + name + "/package.json", "utf8"),
  );
  let text;
  for (const filename of ["LICENSE", "LICENSE.txt", "LICENSE.md"])
    try {
      text = await readFile("node_modules/" + name + "/" + filename, "utf8");
      break;
    } catch {}
  if (!text) throw Error("Missing license for " + name);
  notices.push(name + " " + packageInfo.version + "\n" + text);
}
await writeFile(
  "src/vendor/THIRD-PARTY-LICENSES.txt",
  notices.join("\n\n---\n\n"),
);
