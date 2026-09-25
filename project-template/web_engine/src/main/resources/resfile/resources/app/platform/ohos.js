/**
 * platform/ohos.js —— 鸿蒙（HarmonyOS PC）专有差异实现
 *
 * 当前为空实现：通用能力（system.info / openPath / setAutoStart）由 generic.js 提供，
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
module.exports = {
  /** 供文档/UI 展示：本平台上已知不受支持的能力（判定仍以运行时探测为准） */
  unsupportedHere: [
    'window.setTaskbarVisible',  // win.setSkipTaskbar
    'window.flash',              // win.flashFrame
    'app.setJumpList',
  ],

  // 目前无需覆盖任何通用实现；有鸿蒙专有实现时按 generic.js 的结构补在这里。
};
