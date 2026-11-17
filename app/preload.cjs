// Мост между интерфейсом и главным процессом: только перечисленные методы, без доступа к Node.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("kz", {
  core: (method, args) => ipcRenderer.invoke("core", method, args),
  pickDir: () => ipcRenderer.invoke("pick-dir"),
  pickFile: kind => ipcRenderer.invoke("pick-file", kind),
  open: p => ipcRenderer.invoke("open", p),
  openUrl: u => ipcRenderer.invoke("open-url", u),
  copy: t => ipcRenderer.invoke("copy", t),
  version: () => ipcRenderer.invoke("version"),
  reschedule: () => ipcRenderer.invoke("reschedule"),
  pathOf: file => webUtils.getPathForFile(file),
  on: (ch, fn) => { if (["progress", "net", "fetched", "team"].includes(ch)) ipcRenderer.on(ch, (_e, m) => fn(m)); },
});
