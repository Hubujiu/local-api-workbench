import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
await mkdir("public/vendor", { recursive: true });
await build({
  entryPoints: ["src/markdown-renderer.mjs"],
  outfile: "public/vendor/markdown-renderer.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "inline",
});
const notices = [];
for (const name of [
  "markdown-it",
  "entities",
  "linkify-it",
  "mdurl",
  "punycode.js",
  "uc.micro",
]) {
  let license;
  for (const filename of ["LICENSE", "LICENSE.txt", "LICENSE-MIT.txt"]) {
    try {
      license = await readFile("node_modules/" + name + "/" + filename, "utf8");
      break;
    } catch {}
  }
  if (!license) throw Error("Missing license for " + name);
  const pkg = JSON.parse(
    await readFile("node_modules/" + name + "/package.json", "utf8"),
  );
  notices.push(name + " " + pkg.version + "\n" + license);
}
await writeFile(
  "public/vendor/THIRD-PARTY-LICENSES.txt",
  notices.join("\n\n---\n\n"),
);
