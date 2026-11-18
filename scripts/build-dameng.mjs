import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../native/dameng/", import.meta.url));
const output = fileURLToPath(
  new URL("../src/vendor/dameng-native/", import.meta.url),
);
execFileSync("cargo", ["build", "--locked", "--release"], {
  cwd: root,
  stdio: "inherit",
});
const host = /^host: (.+)$/m
  .exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1]
  .trim();
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version=1", "--filter-platform", host],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  ),
);
const binary =
  "workbench-dameng-read" + (process.platform === "win32" ? ".exe" : "");
await mkdir(output, { recursive: true });
const notices = [];
for (const crate of metadata.packages
  .filter((p) => p.name !== "workbench-dameng-read")
  .sort((a, b) => a.id.localeCompare(b.id))) {
  const directory = path.dirname(crate.manifest_path);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (f) =>
        f.isFile() &&
        /^(licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(f.name),
    )
    .map((f) => f.name);
  if (crate.license_file && !files.includes(crate.license_file))
    files.push(crate.license_file);
  let entry = [crate.name, crate.version, crate.license, crate.repository]
    .filter(Boolean)
    .join(" · ");
  for (const file of files.sort())
    entry += "\n" + (await readFile(path.join(directory, file), "utf8"));
  notices.push(entry);
}
await writeFile(
  path.join(output, "THIRD-PARTY-NOTICES.txt"),
  notices.join("\n\n"),
);
await cp(
  path.join(metadata.target_directory, "release", binary),
  path.join(output, binary),
);
