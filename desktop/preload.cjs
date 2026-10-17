const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  openProjectLocation: (id) => ipcRenderer.invoke("open-project-location", id),
});
