import { cp, mkdir, rename, writeFile, readdir, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { desktopLayout } from "../desktop/build-layout.mjs";
const layout = desktopLayout();
await mkdir(layout.root, { recursive: true });
await cp("desktop/node_modules/electron/dist", layout.root, {
  recursive: true,
  verbatimSymlinks: true,
});
if (process.platform === "darwin") {
  await rename(
    path.join(layout.root, "Electron.app"),
    path.join(layout.root, "LocalAPI.app"),
  );
} else {
  await rename(
    path.join(
      layout.root,
      process.platform === "win32" ? "electron.exe" : "electron",
    ),
    layout.executable,
  );
}
await mkdir(layout.app, { recursive: true });
for (const entry of ["src", "public", "scripts", "LICENSE"])
  await cp(entry, path.join(layout.app, entry), { recursive: true });
await cp("production/node_modules", path.join(layout.app, "node_modules"), {
  recursive: true,
});
await mkdir(path.join(layout.app, "desktop"), { recursive: true });
for (const file of await readdir("desktop"))
  if (/\.(mjs|cjs)$/.test(file))
    await cp(
      path.join("desktop", file),
      path.join(layout.app, "desktop", file),
    );
await writeFile(
  path.join(layout.app, "package.json"),
  JSON.stringify({
    name: "local-api-workbench",
    version: "0.1.0",
    type: "module",
    main: "desktop/main.mjs",
  }),
);
if (process.platform !== "win32") await chmod(layout.executable, 0o755);
if (process.platform === "darwin") {
  const plist = path.join(layout.root, "LocalAPI.app/Contents/Info.plist");
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :CFBundleDisplayName Local API",
    plist,
  ]);
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :CFBundleName Local API",
    plist,
  ]);
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      path.join(layout.root, "LocalAPI.app"),
    ],
    { stdio: "inherit" },
  );
}
console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    executable: layout.executable,
  }),
);
