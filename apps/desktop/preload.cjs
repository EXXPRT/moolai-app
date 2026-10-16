const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("moolai", {
  request: (method, path, body) =>
    ipcRenderer.invoke("moolai:request", { method, path, body }),
  openExternal: (url) => ipcRenderer.invoke("moolai:open-external", url),
  chooseFolder: () => ipcRenderer.invoke("moolai:choose-folder"),
  subscribe: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("moolai:event", listener);
    ipcRenderer.send("moolai:subscribe");
    return () => {
      ipcRenderer.removeListener("moolai:event", listener);
      ipcRenderer.send("moolai:unsubscribe");
    };
  },
});
