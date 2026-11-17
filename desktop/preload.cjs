const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  openProjectTerminal: (id) => ipcRenderer.invoke("open-project-terminal", id),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  openProjectLocation: (id) => ipcRenderer.invoke("open-project-location", id),
});
