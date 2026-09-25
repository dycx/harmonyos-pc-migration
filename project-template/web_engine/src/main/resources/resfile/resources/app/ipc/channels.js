/**
 * ipc/channels.js —— IPC 通道契约（主进程 / preload / 渲染层共用同一份常量）
 *
 * 为什么要有这个文件：
 *   通道名写错（'sys:open-path' vs 'sys:openPath'）是"按钮点了没反应"的高频原因，
 *   而且在 Windows 上跑通、迁移到鸿蒙后才暴露。两边引用同一份常量即可根除。
 *
 * 命名规范：<域>:<动作>，全小写 kebab-case
 *
 * ⚠️ 打包注意：本文件必须随 app 一起打进 HAP（见《主进程模块化与平台差异适配方案》§6 清单校验）
 */
const CH = {
  // --- 应用 / 平台信息 ---
  APP_INFO: 'app:info',
  APP_CAPABILITIES: 'app:capabilities',

  // --- 窗口三键（自绘标题栏用；由 ipc/process-manage.js 注册）---
  WIN_MINIMIZE: 'window:minimize',
  WIN_MAXIMIZE: 'window:maximize',
  WIN_CLOSE: 'window:close',
  WIN_IS_MAXIMIZED: 'window:is-maximized',

  // --- 系统交互（原 Windows 工程 process-manage.js 里的那类操作）---
  SYS_OPEN_PATH: 'sys:open-path',
  SYS_TASKBAR_VISIBLE: 'sys:taskbar-visible',
  SYS_FLASH_FRAME: 'sys:flash-frame',
  SYS_JUMP_LIST: 'sys:jump-list',
  SYS_AUTO_START: 'sys:auto-start',

  // --- 主进程 → 渲染层的事件（单向广播）---
  EVT_BACKEND_READY: 'backend:ready',
};

module.exports = { CH };
