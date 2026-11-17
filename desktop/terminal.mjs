/** Project paths are passed as cwd/environment data, never interpolated into shell source. */
export function terminalLaunch(directory, platform = process.platform) {
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoExit",
        "-Command",
        "Set-Location -LiteralPath $env:LOCAL_API_DIRECTORY",
      ],
      options: {
        cwd: directory,
        env: { ...process.env, LOCAL_API_DIRECTORY: directory },
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    };
  if (platform === "darwin")
    return {
      command: "open",
      args: ["-a", "Terminal", directory],
      options: { cwd: directory, detached: true, stdio: "ignore" },
    };
  return {
    command: "x-terminal-emulator",
    args: [],
    options: { cwd: directory, detached: true, stdio: "ignore" },
  };
}
