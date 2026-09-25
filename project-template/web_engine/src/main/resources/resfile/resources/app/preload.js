/**
 * preload.js —— 渲染层 ↔ 主进程的安全桥（配合 contextIsolation: true）
 *
 * 无边框窗口（main.js CONFIG.WINDOW.frame = false）下，系统标题栏已隐藏，
 * 页面里的自绘标题栏需要这三个能力：最小化 / 最大化(还原) / 关闭。
 * 这里只暴露最小接口，不向页面暴露任何 Node 能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
});
