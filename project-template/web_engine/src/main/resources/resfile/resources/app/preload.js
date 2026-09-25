/**
 * preload.js —— 渲染层 ↔ 主进程的安全桥（配合 contextIsolation: true）
 *
 * 要点：
 *   ① 通道名来自 ipc/channels.js —— 与主进程**共用同一份契约**，杜绝字符串写错
 *   ② 统一拆包主进程返回的 { ok, data|error } —— 渲染层拿到的就是数据或一个带 code 的错误
 *   ③ 只暴露白名单方法，不向页面暴露任何 Node 能力
 *
 * 无边框窗口（main.js CONFIG.WINDOW.frame = false）下，系统标题栏已隐藏，
 * 页面里的自绘标题栏需要 window.desktop 的四个方法。
 */
const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('./ipc/channels');

/** 调用主进程 handler 并拆包；失败时抛出带 code 的错误（如 E_UNSUPPORTED） */
async function invoke(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok === true) return r.data;
  const err = new Error((r && r.error && r.error.message) || `IPC ${channel} failed`);
  err.code = (r && r.error && r.error.code) || 'E_IPC';
  err.channel = channel;
  throw err;
}

/* ---------- 窗口三键（自绘标题栏） ---------- */
contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send(CH.WIN_MINIMIZE),
  toggleMaximize: () => ipcRenderer.send(CH.WIN_MAXIMIZE),
  close: () => ipcRenderer.send(CH.WIN_CLOSE),
  isMaximized: () => invoke(CH.WIN_IS_MAXIMIZED),
});

/* ---------- 业务/系统交互（对应 ipc/process-manage.js 注册的通道） ---------- */
contextBridge.exposeInMainWorld('api', {
  channels: CH,
  info: () => invoke(CH.APP_INFO),
  capabilities: () => invoke(CH.APP_CAPABILITIES),
  openPath: (p) => invoke(CH.SYS_OPEN_PATH, p),
  setTaskbarVisible: (v) => invoke(CH.SYS_TASKBAR_VISIBLE, v),
  flashFrame: (on) => invoke(CH.SYS_FLASH_FRAME, on),
  setJumpList: () => invoke(CH.SYS_JUMP_LIST),
  setAutoStart: (v) => invoke(CH.SYS_AUTO_START, v),
  /** 主进程 → 渲染层：后端就绪事件（页面据此淡出等待动画） */
  onBackendReady: (cb) => ipcRenderer.on(CH.EVT_BACKEND_READY, (_e, payload) => cb(payload)),
});
