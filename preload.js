const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cms", {
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onPublishLog: (fn) => ipcRenderer.on("publish-log", (_event, line) => fn(line)),
});
