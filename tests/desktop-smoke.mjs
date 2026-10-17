import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(path.join(os.tmpdir(), "local-api-desktop-"));
let application;
try {
  application = await electron.launch({
    executablePath: path.resolve("dist/LocalAPI/LocalAPI.exe"),
    env: { ...process.env, LOCAL_API_DESKTOP_DATA: root },
    timeout: 30000,
  });
  const window = await application.firstWindow();
  await window.getByRole("button", { name: "发 送", exact: true }).waitFor();
  await window.getByRole("button", { name: "发 送", exact: true }).click();
  await window
    .getByText("欢迎使用 Local API", { exact: false })
    .last()
    .waitFor();
  assert(await window.getByText("200", { exact: true }).isVisible());
  const settings = await application.evaluate(({ BrowserWindow }) => {
    const preferences =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
      sandbox: preferences.sandbox,
    };
  });
  assert.equal(settings.nodeIntegration, false);
  assert.equal(settings.contextIsolation, true);
  assert.equal(settings.sandbox, true);
  console.log("PACKAGED_DESKTOP_SMOKE_PASS");
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
}
