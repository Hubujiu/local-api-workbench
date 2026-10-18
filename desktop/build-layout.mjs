import path from "node:path";
export function desktopLayout(platform = process.platform) {
  if (!["win32", "darwin", "linux"].includes(platform))
    throw Error("不支持的桌面平台");
  const root = path.resolve("dist/LocalAPI");
  return {
    platform,
    root,
    executable: path.join(
      root,
      platform === "darwin"
        ? "LocalAPI.app/Contents/MacOS/Electron"
        : platform === "win32"
          ? "LocalAPI.exe"
          : "LocalAPI",
    ),
    app: path.join(
      root,
      platform === "darwin"
        ? "LocalAPI.app/Contents/Resources/app"
        : "resources/app",
    ),
  };
}
