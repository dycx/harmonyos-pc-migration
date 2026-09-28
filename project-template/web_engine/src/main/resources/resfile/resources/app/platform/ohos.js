/**
 * platform/ohos.js —— 鸿蒙（HarmonyOS PC）专有差异实现
 *
 * 已覆盖的实现：window.applyStartupSizing / isFillScreen / toggleFillScreen
 *   （窗口铺满与"系统标题栏悬停唤出"问题，见下方 window 段注释）
 * 其余通用能力（system.info / openPath / setAutoStart）由 generic.js 提供，
 * 鸿蒙上与 Windows 语义一致的部分无需重写——这正是本方案的目的：
 *   **业务代码一份，平台差异集中在这几个文件里。**
 *
 * ── 往这里加什么 ───────────────────────────────────────────────
 * 1) 鸿蒙侧独有的实现（Electron 鸿蒙版新增接口），例如：
 *      - 悬浮窗：new BrowserWindow({ windowInfo: { type: 'floatWindow' } })
 *      - 系统三键：win.setWindowButtonVisibility(true)
 *      - 应用角标：app.setBadgeCount(n)
 *    写成与 generic.js 相同的命名空间结构即可被自动合并覆盖。
 *
 * 2) 语义不同需要特殊处理的跨平台能力：
 *      - 窗口尺寸：鸿蒙首窗口尺寸由 module.json5 的 ohos.ability.window.* 决定，
 *        而不是 new BrowserWindow({width,height})。
 *      - 透明度：transparent 为整窗语义，优先于 opacity / backgroundColor 的 alpha。
 *
 * ── 鸿蒙上不可用的能力（官方 API 支持表标注"不支持"）────────────────
 *      app.setJumpList          app.setUserTasks        app.setAppUserModelId
 *      win.setSkipTaskbar       win.flashFrame          win.setProgressBar
 *      win.setOverlayIcon       win.setThumbarButtons   app.setAsDefaultProtocolClient
 *   这些入口在本文件不覆盖 → 继续走 generic.js 的抛错实现 → 渲染层收到
 *   E_UNSUPPORTED 后把按钮置灰（见 renderer/index.html 的能力驱动 UI 示例）。
 *   注意：支持表会随版本变化，**最终以真机运行时探测为准**（见 §8 实测项 A-47）。
 */
const generic = require('./generic');

function hasFn(obj, name) {
  return !!obj && typeof obj[name] === 'function';
}

/** 最近一次启动采用的填充模式（applyStartupSizing 记录，供三键"还原后再次铺满"复用同一模式） */
let fillMode = 'simple';

module.exports = {
  /** 供文档/UI 展示：本平台上已知不受支持的能力（判定仍以运行时探测为准） */
  unsupportedHere: [
    'window.setTaskbarVisible',  // win.setSkipTaskbar
    'window.flash',              // win.flashFrame
    'app.setJumpList',
  ],

  window: {
    /**
     * ★★ 鸿蒙窗口填充：**唯一能禁掉"鼠标触到屏幕上/下边缘唤出系统标题栏"的方式**。
     *
     * ── 问题现象 ────────────────────────────────────────────────────
     * `frame:false` 让系统标题栏/边框默认消失，但只要窗口处于最大化状态，
     * 鼠标移到屏幕**上/下边缘**，系统仍会把标题栏滑出来（看起来"外层窗口又出现了"）。
     * 这是**系统窗口行为，不是模板 bug**，光靠 `frame:false` 或 `maximize()` 去不掉。
     *
     * ── 官方依据（Electron 鸿蒙版 API 文档"差异说明"原文）───────────
     *   win.setFullScreen     → "鸿蒙全屏会遮挡Dock栏，鼠标移动到上方/下方会唤出标题栏"  ← 有该行为
     *   win.setSimpleFullScreen → "鸿蒙全屏会遮挡Dock栏"                                 ← 无该行为
     *   win.maximize          → "无差异"（但窗口进入最大化态，系统标题栏仍可被唤出）
     *
     * ── 原生侧对应实现（壳工程源码，可自行核对）─────────────────────
     *   win.setSimpleFullScreen(true) → AppWindowAdapter.ets:272-289
     *        windowClass.maximize(MaximizePresentation.ENTER_IMMERSIVE_DISABLE_TITLE_AND_DOCK_HOVER)
     *   win.setFullScreen(true)       → AppWindowAdapter.ets:254-269 → ENTER_IMMERSIVE
     *   win.maximize()                → AppWindowAdapter.ets:388-408 → EXIT_IMMERSIVE
     *   枚举名 ENTER_IMMERSIVE_DISABLE_TITLE_AND_DOCK_HOVER 即"进入沉浸式 + 禁用标题栏/Dock 悬停"。
     *
     * ── 代价（务必知情）────────────────────────────────────────────
     * 该模式会**遮挡 Dock 栏且 Dock 不再随悬停唤出**（官方差异说明）。若必须保留 Dock，
     * 把 CONFIG.WINDOW.fullScreenMode 改为 'bounds'（普通窗口铺满工作区，不进入最大化态），
     * 而不要退回 'maximize' —— 后者正是本问题现象的来源。
     *
     * @param {BrowserWindow} win
     * @param {object} opts CONFIG.WINDOW
     * @returns {{mode: string, applied: string, fallback?: string}}
     *          实际采用的方式；若接口缺失会带 fallback 字段（不静默失效）
     */
    applyStartupSizing(win, opts = {}) {
      if (!win || win.isDestroyed()) return { mode: opts.fullScreenMode || 'simple', applied: 'no-window' };
      fillMode = opts.fullScreenMode || 'simple';

      if (opts.startMaximized && fillMode === 'simple') {
        if (hasFn(win, 'setSimpleFullScreen')) {
          win.setSimpleFullScreen(true);
          return { mode: 'simple', applied: 'setSimpleFullScreen' };
        }
        // 该鸿蒙构建未暴露此接口 → 明确回退并标记，避免"改了没效果还查不出原因"
        const r = generic.window.applyStartupSizing(win, opts);
        return { mode: 'simple', applied: r.applied, fallback: 'setSimpleFullScreen 不可用' };
      }

      // 'maximize' / 'fullscreen' / 'bounds' / 非铺满：语义与通用实现一致
      const r = generic.window.applyStartupSizing(win, opts);
      return { mode: fillMode, applied: r.applied };
    },

    /**
     * 是否处于铺满状态。
     * ⚠️ simple 全屏不是"最大化"态，`isMaximized()` 返回 false —— 两个状态都要认，
     *    否则自绘三键的图标会与实际状态不一致。
     */
    isFillScreen(win) {
      if (!win || win.isDestroyed()) return false;
      if (hasFn(win, 'isSimpleFullScreen') && win.isSimpleFullScreen()) return true;
      if (win.isMaximized()) return true;
      if (hasFn(win, 'isFullScreen') && win.isFullScreen()) return true;
      return false;
    },

    /** 切换"铺满 / 还原"：还原后再铺满时，进入的是启动时同一个模式 */
    toggleFillScreen(win) {
      if (!win || win.isDestroyed()) return;

      // 还原
      if (hasFn(win, 'isSimpleFullScreen') && win.isSimpleFullScreen()) {
        win.setSimpleFullScreen(false);
        return;
      }
      if (hasFn(win, 'isFullScreen') && win.isFullScreen()) {
        win.setFullScreen(false);
        return;
      }
      if (win.isMaximized()) {
        win.unmaximize();
        return;
      }

      // 铺满：跟随启动模式，避免"点一下最大化就把悬停标题栏放回来"
      switch (fillMode) {
        case 'fullscreen':
          win.setFullScreen(true);
          break;
        case 'bounds': {
          const { screen } = require('electron');
          const { width, height } = screen.getPrimaryDisplay().workAreaSize;
          win.setBounds({ x: 0, y: 0, width, height });
          break;
        }
        case 'maximize':
          win.maximize();
          break;
        case 'simple':
        default:
          if (hasFn(win, 'setSimpleFullScreen')) win.setSimpleFullScreen(true);
          else win.maximize();
          break;
      }
    },
  },
};
