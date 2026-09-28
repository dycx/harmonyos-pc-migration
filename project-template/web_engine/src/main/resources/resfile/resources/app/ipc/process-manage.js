/**
 * ipc/process-manage.js —— 参考业务模块
 *
 * 这就是"原 Windows 工程里放着界面按钮与系统交互响应函数"的那个文件。
 * 迁移要点（对照《主进程模块化与平台差异适配方案》§5）：
 *   ① 不 require('./main')      → 需要的东西全部由 main.js 注入，彻底避开循环依赖
 *   ② 不出现 process.platform   → 平台差异交给 platform/*，本文件两端完全一致
 *   ③ 不直接用 ipcMain.handle   → 统一走 register.js 的 handle/on（日志 + 错误结构）
 *   ④ 导出的是"注册函数"而不是"带副作用的模块" → main.js 里一行装配，顺序可控
 *
 * 新增一个按钮/系统交互的完整流程：
 *   channels.js 加常量 → 这里加一行 handle(...) → preload.js 暴露方法 → 渲染层调用
 */
const { CH, handle, on } = require('./register');
const { makeLogger } = require('../logger');

const log = makeLogger('process-manage');

/**
 * @param {object} ctx 由 main.js 注入的上下文
 * @param {object} ctx.ipcMain
 * @param {object} ctx.platform   platform/index.js 实例
 * @param {Function} ctx.getMainWindow  ★ 取值函数（永远拿到最新窗口，而不是 require 时的快照）
 */
module.exports = function register(ctx) {
  const { ipcMain, platform, getMainWindow } = ctx;

  /* ---------- 窗口三键（自绘标题栏用；无边框窗口的必需能力） ---------- */
  on(ipcMain, CH.WIN_MINIMIZE, () => getMainWindow()?.minimize());
  // 铺满/还原走 platform：鸿蒙上是 setSimpleFullScreen（否则系统标题栏会在鼠标触到
  // 屏幕上/下边缘时滑出来），Windows 上就是普通的 maximize/unmaximize。
  on(ipcMain, CH.WIN_MAXIMIZE, () => platform.window.toggleFillScreen(getMainWindow()));
  on(ipcMain, CH.WIN_CLOSE, () => getMainWindow()?.close());
  handle(ipcMain, CH.WIN_IS_MAXIMIZED, () => platform.window.isFillScreen(getMainWindow()));

  /* ---------- 平台 / 能力信息 ---------- */
  handle(ipcMain, CH.APP_INFO, () => platform.system.info());
  handle(ipcMain, CH.APP_CAPABILITIES, () => platform.capabilities());

  /* ---------- 系统交互（Windows 上原本散落在这个文件里的那些操作） ---------- */
  handle(ipcMain, CH.SYS_OPEN_PATH, (_e, p) => platform.system.openPath(p));

  handle(ipcMain, CH.SYS_TASKBAR_VISIBLE, (_e, visible) => {
    // 鸿蒙上 platform.window.setTaskbarVisible 会抛 E_UNSUPPORTED →
    // 被 register.js 转成 {ok:false,error} → 渲染层置灰按钮并提示
    return platform.window.setTaskbarVisible(!!visible);
  });

  handle(ipcMain, CH.SYS_FLASH_FRAME, (_e, on_) => platform.window.flash(!!on_));

  handle(ipcMain, CH.SYS_JUMP_LIST, () => platform.app.setJumpList([
    { type: 'tasks', items: [{ program: process.execPath, args: '--new-window', title: '新建窗口' }] },
  ]));

  handle(ipcMain, CH.SYS_AUTO_START, (_e, enabled) => platform.app.setAutoStart(!!enabled));

  log.info(`process-manage registered (platform=${platform.name}, raw=${platform.rawPlatform})`);
};
