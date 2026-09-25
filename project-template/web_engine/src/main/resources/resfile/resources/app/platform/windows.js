/**
 * platform/windows.js —— Windows 专有系统交互
 *
 * 这里可以放心使用 Windows 独有的 Electron API：
 *   win.setSkipTaskbar / win.flashFrame / app.setJumpList / app.setUserTasks …
 *
 * 所有入口都做运行时探测（hasFn）——即使 API 表里写"支持"，也要防接口存在但调用抛错。
 * 非 Windows 平台不会走到本文件（由 platform/index.js 按平台名选择实现）。
 */
const { app, BrowserWindow } = require('electron');
const { makeLogger } = require('../logger');

const log = makeLogger('platform:windows');

function currentWindow() {
  return BrowserWindow.getAllWindows()[0];
}

function unsupported(what) {
  const err = new Error(`${what} is not supported on platform "${process.platform}"`);
  err.code = 'E_UNSUPPORTED';
  return err;
}

function hasFn(obj, name) {
  return !!obj && typeof obj[name] === 'function';
}

module.exports = {
  unsupportedHere: [],   // Windows 上这些能力都可用

  window: {
    /** 是否在任务栏显示窗口（visible=false → 隐藏任务栏图标） */
    setTaskbarVisible(visible) {
      const win = currentWindow();
      if (!win || !hasFn(win, 'setSkipTaskbar')) throw unsupported('win.setSkipTaskbar');
      win.setSkipTaskbar(!visible);
      log.info('setTaskbarVisible:', !!visible);
      return true;
    },

    /** 任务栏图标闪烁，提醒用户注意（Windows 经典交互） */
    flash(on) {
      const win = currentWindow();
      if (!win || !hasFn(win, 'flashFrame')) throw unsupported('win.flashFrame');
      win.flashFrame(!!on);
      log.info('flashFrame:', !!on);
      return true;
    },
  },

  app: {
    /** 跳转列表（右键任务栏图标的任务菜单） */
    setJumpList(items) {
      if (!hasFn(app, 'setJumpList')) throw unsupported('app.setJumpList');
      const result = app.setJumpList(items || []);
      log.info('setJumpList result:', String(result));
      return String(result || 'ok');
    },
  },
};
