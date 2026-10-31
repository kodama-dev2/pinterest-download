const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pinterestApp", {
  desktop: true,
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
