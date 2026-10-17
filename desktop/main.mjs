import { app, BrowserWindow, session } from "electron";
import path from "node:path";
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
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      const win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 950,
        minHeight: 680,
        title: "Local API",
        backgroundColor: "#faf6eb",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== service.url) event.preventDefault();
      });
      win.setMenuBarVisibility(false);
      await win.loadURL(service.url);
      console.error("DESKTOP_READY", service.url);
      app.on("window-all-closed", () => app.quit());
      app.on("before-quit", () => service.server.close());
      app.on("second-instance", () => {
        if (win.isMinimized()) win.restore();
        win.focus();
      });
    })
    .catch((error) => {
      console.error("DESKTOP_STARTUP_FAILURE", error.stack || error);
      app.exit(1);
    });
