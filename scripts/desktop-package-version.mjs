import { readFile } from "node:fs/promises";
import path from "node:path";

export function checkedDesktopVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) ||
    value
      .split(".")
      .some((part, index) => Number(part) > (index === 2 ? 65535 : 255))
  )
    throw new Error(
      "Expected a canonical desktop release version (MSI version bounds)",
    );
  return value;
}

async function readJson(root, file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

export async function desktopSourceVersion(root = process.cwd()) {
  const [source, desktop, lock, desktopLock] = await Promise.all([
    readJson(root, "package.json"),
    readJson(root, "desktop/package.json"),
    readJson(root, "package-lock.json"),
    readJson(root, "desktop/package-lock.json"),
  ]);
  const version = checkedDesktopVersion(source.version);
  if (
    ![
      desktop.version,
      lock.version,
      lock.packages?.[""]?.version,
      desktopLock.version,
      desktopLock.packages?.[""]?.version,
    ].every((value) => value === version)
  )
    throw new Error(
      "Desktop version does not match source package and lockfiles",
    );
  return version;
}

export async function packagedDesktopVersion(appDirectory, expected) {
  const packaged = await readJson(appDirectory, "package.json");
  if (
    packaged.name !== "local-api-workbench" ||
    packaged.main !== "desktop/main.mjs"
  )
    throw new Error("Unexpected packaged desktop application identity");
  const version = checkedDesktopVersion(packaged.version);
  if (version !== expected)
    throw new Error("Packaged desktop version differs from source");
  return version;
}
