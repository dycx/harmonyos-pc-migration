/**
 * platform/index.js —— 平台归一化 + 实现选择 + 能力探测
 *
 * 全工程**只有这个文件出现"平台名"**；业务代码（ipc/*.js、main.js）只调用 platform.xxx。
 * 这样新增一个平台或调整平台差异时，不需要动任何业务代码。
 *
 * ── 平台名为什么需要归一化 ──────────────────────────────────────
 * 官方文档明确：鸿蒙上 `process.platform` 返回 **openharmony**（不是 win32/linux）；
 * 社区实测还有 `ohos` / `linux` 等说法（随版本与构建方式变化）。
 * 所以这里用别名表归一，并保留 APP_PLATFORM 环境变量作为调试/兜底开关：
 *   APP_PLATFORM=windows electron .     # 在开发机上强制走 Windows 实现
 *
 * ── 能力为什么要"运行时探测"而不是"查表" ─────────────────────────
 * API 支持表是文档口径，会随版本变化；且存在"接口存在但调用即抛错"的情况。
 * 因此：capabilities() 用 typeof 探测 + 首次调用失败由渲染层置灰（双保险）。
 */
const { app, BrowserWindow, shell } = require('electron');
const { makeLogger } = require('../logger');

const log = makeLogger('platform');

/* ---------- 1. 平台名归一化 ---------- */
const ALIAS = {
  openharmony: 'ohos',   // 官方文档口径
  ohos: 'ohos',
  win32: 'windows',
  windows: 'windows',
};

const rawPlatform = process.platform;
const name = process.env.APP_PLATFORM || ALIAS[rawPlatform] || rawPlatform;

/* ---------- 2. 选择实现（找不到就落到 generic，保证应用能起来） ---------- */
const generic = require('./generic');
let impl = {};
try {
  impl = require(`./${name}`);
} catch (e) {
  // 关键：未知平台不能让应用崩溃。落到 generic 后，业务功能按"跨平台能力"降级运行。
  log.warn(`no platform impl for "${name}" (raw=${rawPlatform}) → fallback to generic`);
}

/* ---------- 3. 两层浅合并：generic 打底，平台实现覆盖差异 ---------- */
function merge(base, over) {
  const out = { ...base };
  Object.keys(over || {}).forEach((k) => {
    const v = over[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...(base[k] || {}), ...v } : v;
  });
  return out;
}

const api = merge(generic, impl);

/* ---------- 4. 能力探测（供渲染层做按钮置灰） ---------- */
function currentWindow() {
  return BrowserWindow.getAllWindows()[0];
}

function hasFn(obj, fnName) {
  return !!obj && typeof obj[fnName] === 'function';
}

/**
 * 返回能力表。注意：这里只做"接口是否存在"的静态探测，
 * "存在但调用失败"的情况由渲染层在收到 E_UNSUPPORTED 后置灰（见 renderer/index.html）。
 */
function capabilities() {
  const win = currentWindow();
  return {
    platform: name,
    rawPlatform,
    openPath: hasFn(shell, 'openPath'),
    autoStart: hasFn(app, 'setLoginItemSettings'),
    taskbarVisible: hasFn(win, 'setSkipTaskbar'),
    flashFrame: hasFn(win, 'flashFrame'),
    jumpList: hasFn(app, 'setJumpList'),
    // 本平台已知不受支持清单（来自 platform/<name>.js 的声明，仅作 UI 提示）
    unsupportedHere: api.unsupportedHere || [],
  };
}

module.exports = {
  name,
  rawPlatform,
  capabilities,
  unsupportedHere: api.unsupportedHere || [],
  system: api.system,
  window: api.window,
  app: api.app,
};
