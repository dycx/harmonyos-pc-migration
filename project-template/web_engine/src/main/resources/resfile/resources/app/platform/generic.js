/**
 * platform/generic.js —— 跨平台通用实现（Windows / 鸿蒙 / 其它平台都能用）
 *
 * 分层原则：
 *   generic.js  → 只使用 Electron 跨平台 API（shell / os / app 的通用能力）
 *   windows.js  → 只写 Windows 专有差异（任务栏、跳转列表、闪烁…）
 *   ohos.js     → 只写鸿蒙专有差异（当前为空，占位并注明往哪加）
 *   index.js    → 归一化平台名 + 选择实现 + 能力探测，业务代码只认 platform.xxx
 *
 * 平台不支持的入口统一抛 E_UNSUPPORTED，由 ipc/register.js 转成 {ok:false,error}，
 * 渲染层据此把按钮置灰——而不是"点了没反应"。
 */
const os = require('os');
const { app, shell } = require('electron');
const { makeLogger } = require('../logger');

const log = makeLogger('platform:generic');

function unsupported(what) {
  const err = new Error(`${what} is not supported on platform "${process.platform}"`);
  err.code = 'E_UNSUPPORTED';
  return err;
}

/** 运行时探测：比"API 支持表"更可靠（接口存在但调用即抛错的情况很常见） */
function hasFn(obj, name) {
  return !!obj && typeof obj[name] === 'function';
}

module.exports = {
  /** 平台不支持的能力清单（供文档/UI 展示；真正的判定以运行时探测为准） */
  unsupportedHere: [],

  system: {
    /** 平台与运行时信息（两端都支持） */
    info() {
      return {
        platform: process.env.APP_PLATFORM || process.platform,
        rawPlatform: process.platform,
        arch: process.arch,
        osType: os.type(),
        osRelease: os.release(),
        cpuCount: os.cpus().length,
        totalMemMB: Math.round(os.totalmem() / 1048576),
        versions: {
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
        },
      };
    },

    /** 用系统默认程序打开路径/文件（shell.openPath 为跨平台 API） */
    async openPath(p) {
      if (!hasFn(shell, 'openPath')) throw unsupported('shell.openPath');
      const target = String(p || '').trim();
      if (!target) throw new Error('openPath: empty path');
      const errMsg = await shell.openPath(target); // 成功返回空串
      if (errMsg) throw new Error(`openPath failed: ${errMsg}`);
      log.info('openPath ok:', target);
      return true;
    },
  },

  window: {
    // 任务栏/窗口特效类能力默认不可用，由 windows.js 覆盖
    setTaskbarVisible() { throw unsupported('win.setSkipTaskbar'); },
    flash() { throw unsupported('win.flashFrame'); },
  },

  app: {
    /** 开机自启：Electron 跨平台 API（注意：能力仍以运行时探测为准） */
    setAutoStart(enabled) {
      if (!hasFn(app, 'setLoginItemSettings')) throw unsupported('app.setLoginItemSettings');
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      const state = hasFn(app, 'getLoginItemSettings') ? app.getLoginItemSettings() : {};
      log.info('setAutoStart:', !!enabled, JSON.stringify(state));
      return state;
    },

    setJumpList() { throw unsupported('app.setJumpList'); },
  },
};
