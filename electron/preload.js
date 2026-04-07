const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tasksApi", {
  list: () => ipcRenderer.invoke("tasks:list"),
  add: (payload) => ipcRenderer.invoke("tasks:add", payload),
  complete: (id) => ipcRenderer.invoke("tasks:complete", id),
  remove: (id) => ipcRenderer.invoke("tasks:delete", id),
  runCodex: (payload) => ipcRenderer.invoke("tasks:run-codex", payload),
  getCodexInfo: () => ipcRenderer.invoke("codex:info"),
  connectCodex: () => ipcRenderer.invoke("codex:connect"),
  onTasksUpdated: (callback) =>
    ipcRenderer.on("tasks:updated", (_event, tasks) => callback(tasks)),
});
