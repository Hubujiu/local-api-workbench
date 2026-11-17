import { installDesktopShutdown } from "../src/host-shutdown.mjs";
import { spawn } from "node:child_process";
import { terminalLaunch } from "./terminal.mjs";
import { app, BrowserWindow, session, ipcMain, shell, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
let service;
console.error("DESKTOP_STARTING", process.versions.electron);
if (process.env.LOCAL_API_DESKTOP_DATA) {
  app.setPath("userData", process.env.LOCAL_API_DESKTOP_DATA);
}
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else
  app
    .whenReady()
    .then(async () => {
      service = await createApp({
        root: path.join(app.getPath("userData"), "projects"),
        port: 0,
      });
      installDesktopShutdown(app, service);
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      function validateSender(event) {
        if (
          !event.senderFrame ||
          new URL(event.senderFrame.url).origin !== service.url
        )
          throw Error("Untrusted renderer");
      }
      ipcMain.handle("choose-directory", async (event) => {
        validateSender(event);
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      });
      ipcMain.handle("open-project-location", async (event, id) => {
        validateSender(event);
        await service.store.get(id);
        shell.showItemInFolder(service.store.file(id));
      });
      ipcMain.handle("open-project-terminal", async (event, id) => {
        validateSender(event);
        await service.store.get(id);
        const spec = terminalLaunch(path.dirname(service.store.file(id)));
        return new Promise((resolve, reject) => {
          const child = spawn(spec.command, spec.args, spec.options);
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve({ ok: true });
          });
        });
      });
      const win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 950,
        minHeight: 680,
        title: "Local API",
        backgroundColor: "#faf6eb",
        webPreferences: {
          preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (service.oauthAllowed(url)) shell.openExternal(url);
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== service.url) event.preventDefault();
      });
      win.webContents.on("will-prevent-unload", (event) => {
        const choice = dialog.showMessageBoxSync(win, {
          type: "question",
          title: "未保存的修改",
          message: "当前有未保存的修改，是否放弃并退出？",
          buttons: ["留在应用", "放弃并退出"],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice === 1) event.preventDefault();
      });
      win.setMenuBarVisibility(false);
      await win.loadURL(service.launchUrl);
      console.error("DESKTOP_READY", service.url);
      app.on("window-all-closed", () => app.quit());
      app.on("second-instance", () => {
        if (win.isMinimized()) win.restore();
        win.focus();
      });
    })
    .catch((error) => {
      console.error("DESKTOP_STARTUP_FAILURE", error.stack || error);
      app.exit(1);
    });
