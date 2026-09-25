# 鸿蒙 PC 专项：启动闪屏（等待动画）不显示的定位与解决方案

> **适用**：Electron 34 鸿蒙壳工程（`templates/ohos_electron_hap-main` / `project-template`）
> **典型问题**：Windows 上启动时"屏幕居中的圆形图标 + 圆周顺时针进度"等待动画，在鸿蒙 PC 上不显示
> **来源标注**：✅ 官方文档原文 ｜ ✅ 模板源码核实（文件:行号）｜ ⚠️ 需真机实测（编号见 §7，已并入手册附录 A）
> **姊妹专项**：《鸿蒙PC迁移专项_多语言i18n方案.md》（语言/i18n）、《鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md》（窗口尺寸/无边框/跨域）
> **版本**：v1.0

---

## 0. 速览

**根因一句话**：Windows 上"窗口什么时候显示"由你的代码决定；**鸿蒙上由系统启动参数 + 托盘 + Ability 生命周期决定**——窗口可见性在**创建那一刻**就以 `StartOptions.startupVisibility` 定死，且**窗口显隐与托盘强绑定**（官方明文）。因此 Windows 那套 `show:false`→`show()`、`transparent:true`、`skipTaskbar`、把闪屏当首窗口再 `close()` 的写法会逐条踩雷。

**解法一句话**：**别用独立闪屏窗口，把等待动画做进主窗口页面里**（页面覆盖层）——不依赖托盘、不依赖 `show()`、不依赖透明，Windows/鸿蒙行为一致。

---

## 1. 先确认现象边界（3 个问题，决定往哪查）

| 问自己 | 若答"是" | 若答"否" |
|---|---|---|
| ① 是完全**没有任何等待画面**，还是有但**黑屏/白屏/透明**？ | 窗口"没显示"→ 查 §4 的 P1/P2/P3 | 窗口显示了、内容没渲染 → 查 P4（透明）与内容加载 |
| ② 等待期间最终**能进主界面**吗？ | 只是闪屏问题 | 主窗口/应用被终结了 → 查 P2（首窗口 close） |
| ③ Windows 上用的是**独立 BrowserWindow 闪屏**还是**主窗口内覆盖层**？ | 独立窗口 → 按 §4 逐条改造，或直接转 §5 | 已是覆盖层 → 问题在窗口本身或时序，查 P3/P6 |

---

## 2. 机制：鸿蒙上的"窗口可见性"是怎么定的

**冷启动时间线**（理解这条线，问题就清楚一半）：

```
用户点图标
  ↓ ① 系统"启动窗口"：module.json5 的 startWindowIcon + startWindowBackground（静态图，系统绘制，不能动画）
  ↓ ② ArkTS 页面加载：pages/Index → WebWindow → XComponent(SURFACE)
  ↓ ③ XComponent onLoad → runBrowser() 启动 Electron 浏览器进程
  ↓ ④ Electron 首帧渲染进 SURFACE → 你的页面（这里才是"动画"能出现的最早时刻）
```

**Windows 写法 → 鸿蒙行为对照**：

| Windows 常见写法 | 鸿蒙上的实际行为 | 依据 |
|---|---|---|
| `new BrowserWindow({ show:false })` 再 `splash.show()` | 可见性在创建时作为 UIAbility 启动参数下发：`startupVisibility: param.show ? STARTUP_SHOW : STARTUP_HIDE`；之后 `show()` 只能靠 `showAbility()` 拉前台，依赖托盘且时序敏感 | ✅ `AppWindowAdapter.ets:125`、`:229-236` |
| 闪屏先建、`new Tray()` 后建（或没有托盘） | 官方明文：**"出于 OH 系统限制原因，窗口的显示隐藏与应用托盘强绑定，因此在启动应用前，为了保证窗口创建正常，需要先创建托盘"** | ✅ 官方 README「窗口显示隐藏」 |
| `transparent: true`（圆形图标 + 透明底） | 透明是**整窗**语义，官方优先级 `transparent` > `opacity` > `backgroundColor.alpha`；SURFACE 的 alpha 合成表现需实测 | ✅ 官方 README「悬浮窗」；⚠️ A-43 |
| `skipTaskbar: true` | **不支持** | ✅ `research/api_index.md:285` |
| 闪屏是**第一个** BrowserWindow，最后 `splash.close()` | 首窗口（`browser1`）绑定入口 EntryAbility，`close()` 实现是 `terminateSelf()` | ✅ `AppWindowAdapter.ets:144-150`；⚠️ A-44 |
| 等后端就绪后才 `createWindow()` | 这段空窗期没有任何窗口可显示（系统启动窗口已消失） | ✅ `project-template/.../main.js` 当前流程（见 §5 末） |
| 动画靠 JS 定时器/框架挂载后 `setInterval` | 首帧前 JS 尚未就绪，动画起不来 | 建议改纯 CSS/SVG 动画 |

---

## 3. 定位方法（三步，约 20 分钟）

### 3.1 Step 1｜静态自查：在你自己的 `main.js` 里搜 7 个关键字

| 关键字 | 鸿蒙上的后果 | 处置 |
|---|---|---|
| `transparent` | 整窗透明，可能完全看不见 | 改为 `frame:false` + `backgroundColor`（或用 `setOpacity`） |
| `skipTaskbar` | 不支持，可能整条调用链异常 | 直接删 |
| `show: false` | 窗口以 STARTUP_HIDE 启动 | 闪屏窗口直接 `show: true` 创建 |
| `new Tray(` 的位置 | 若晚于任何窗口 → 窗口创建/显隐异常 | 必须在**第一个窗口之前** |
| `splash.close()` | 若是首窗口 → `terminateSelf()` | 用 `hide()`，或让闪屏不是首窗口 |
| `parent:` / `modal:` | 子窗/悬浮窗行为不同（无三键） | 闪屏不要设 parent |
| `setInterval` / 框架挂载后再动画 | 首帧前不跑 | 改纯 CSS/SVG 动画 |

### 3.2 Step 2｜日志定位（判读表）

| 来源 | 命令/位置 | 判读 |
|---|---|---|
| 主进程日志 | 你应用的日志文件（路径见手册附录 C「Electron 数据写哪」） | 有无 `[tray] create failed`；`ensureBackend` 卡在哪一步 |
| hilog | `hdc shell hilog \| grep -iE "AppWindowAdapter\|AbilityManager\|showAbility\|terminateSelf"` | `AppWindowAdapter` 每个方法都有 `@LogMethod`：能看到 **createWindow 有没有被调用**、`showAbility success/fail`、有没有出现 `terminateSelf` |
| 渲染进程 | `win.webContents.openDevTools()`（或 `--remote-debugging-port`） | 闪屏页面 HTML 是否加载成功、CSS 动画是否在跑（Elements 里看 `animation`） |
| Ability 状态 | `hdc shell aa dump -a \| grep -i <bundleName>` | 数一下当前有几个 ability/window：是不是多出来一个"闪屏 ability" |

**最容易一眼看出的两个信号**：
- hilog 里**根本没有 `createWindow`** → 闪屏窗口压根没走到建窗逻辑（多半是先等后端、或异常早退）；
- hilog 里出现 `terminateSelf` → 踩中"首窗口 close"（P2）。

### 3.3 Step 3｜最小化复现（渐进验证，最有效）

按这个顺序做 5 个最小版本，哪一步开始不显示，问题就在那一步：

| 版本 | 内容 | 验证点 |
|---|---|---|
| V1 | `Tray` → `new BrowserWindow({ width:400,height:400, frame:false, show:true })` + 静态 HTML | 窗口能不能显示（验证 P1/P3）→ A-42 |
| V2 | V1 + 纯 CSS 圆环动画 | 动画能不能跑（验证内容/渲染） |
| V3 | V2 + `alwaysOnTop: true` | alwaysOnTop 是否影响显示 |
| V4 | V3 + `transparent: true` | 透明是否导致看不见 → A-43 |
| V5 | V4 + 后端就绪后关闭/隐藏闪屏 | 关窗是否终结应用 → A-44 |

---

## 4. 最可能的 6 类问题 × 解决方案

### P1｜闪屏窗口建在 Tray 之前（或应用没有 Tray）—— 最常见
**原因**：窗口显隐与托盘强绑定（官方明文）。
**处置**：
```js
app.whenReady().then(async () => {
  createTray();          // ★ 必须第一个：任何窗口之前
  createSplash();
  // ... 再建主窗口/等后端
});
```
**若确实不需要托盘**：按官方 README 注释掉 `web_engine/.../AppWindowAdapter.ets` 的 `processMode` 与 `startupVisibility` 两行（改的是官方模块，需接受后续升级冲突）。

### P2｜把闪屏当**首窗口**，最后 `close()` 掉
**原因**：首窗口 = 入口 Ability，`close()` → `terminateSelf()`（✅ `AppWindowAdapter.ets:144-150`）。
**处置**（任选）：
- 主窗口**先建**（`show:false`），闪屏后建（可加 `windowInfo: { type: 'floatWindow' }`，官方悬浮窗接口），结束时 `hide()`；
- 或者：闪屏就是入口窗口内容，**不关它**，用页面内覆盖层切换（→ §5，最推荐）。

### P3｜`show:false` 创建 + 稍后 `show()`
**原因**：启动可见性在创建瞬间定死（✅ `AppWindowAdapter.ets:125`），之后 `showAbility()` 依赖托盘且时序敏感。
**处置**：闪屏窗口**直接 `show:true`**；需要"先隐藏再出现"的，改成创建后再 `hide()`。

### P4｜`transparent:true` / `skipTaskbar` 等平台不支持项
**原因**：`skipTaskbar` 不支持（✅ `api_index.md:285`）；`transparent` 是整窗语义（✅ 官方 README 优先级说明）。
**处置**：
```js
// ❌ 不要：transparent:true + skipTaskbar:true
// ✅ 改为：实底窗口 + 圆角由页面 CSS 负责
new BrowserWindow({ frame: false, backgroundColor: '#ffffffff', resizable: false, alwaysOnTop: true });
```

### P5｜动画依赖"后端就绪"之后才创建一切 → 空窗期
**原因**：`ensureBackend()` 在 `createWindow()` **之前**（模板当前流程就是这样）→ 这段什么都没有。
**处置**：窗口**先建并显示**，等待过程用页面覆盖层表达；后端就绪后由主进程通知页面淡出（§5 代码）。

### P6｜系统启动窗口与闪屏视觉不连续（白屏/黑屏一闪）
**原因**：冷启动阶段是系统的静态启动窗口（`startWindowIcon` + `startWindowBackground`）。
**处置**：把它配成与闪屏同色同图（§5-1），观感上就是"启动窗口 → 动画"无缝接力。

---

## 5. 推荐落地形态：三层接力（页面覆盖层为主）

| 阶段 | 显示 | 实现 |
|---|---|---|
| ① 冷启动（ArkTS 页面加载前） | 系统启动窗口（静态） | `module.json5`：`startWindowIcon`/`startWindowBackground`；图标放 `AppScope/resources/base/media/startIcon.png`，底色改 `resources/base/element/color.json` 的 `start_window_background` |
| ② ArkTS 页面 → Electron 首帧 | （可选）ArkTS 层动画 | `electron/src/main/ets/pages/Index.ets` 用 `Stack` 包一层；隐藏时机可用官方 `callArkTSFunction`（README 有专章）⚠️ 需实测 |
| ③ Electron 首帧 → 后端就绪 | **页面内覆盖层（主推）** | 主窗口页面里的 SVG 圆环动画，收到 `backend:ready` 后淡出 |

**③ 的完整代码**：

```html
<!-- 主窗口页面顶层：居中圆形图标 + 圆周进度（12 点起顺时针） -->
<div id="splash">
  <div class="ring-wrap">
    <svg viewBox="0 0 120 120" width="120" height="120">
      <circle cx="60" cy="60" r="52" fill="none" stroke="#e5e7eb" stroke-width="6"/>
      <circle id="ring" cx="60" cy="60" r="52" fill="none" stroke="#2563eb"
              stroke-width="6" stroke-linecap="round"/>
    </svg>
    <img class="logo" src="logo.png" alt="">
  </div>
  <div class="tip">正在启动后台服务…</div>
</div>
```
```css
#splash { position: fixed; inset: 0; z-index: 9999; background: #fff;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  transition: opacity .35s ease; }
#splash.hide { opacity: 0; pointer-events: none; }          /* 淡出后不挡鼠标 */
.ring-wrap { position: relative; width: 120px; height: 120px; }
.ring-wrap .logo { position: absolute; inset: 0; margin: auto; width: 56px; height: 56px; }
#ring {
  stroke-dasharray: 326.7;            /* 2πr, r = 52 */
  stroke-dashoffset: 326.7;
  transform: rotate(-90deg);          /* ★ 起点从 12 点开始 */
  transform-origin: 50% 50%;
  animation: ring-turn 1.2s linear infinite;   /* ★ 顺时针转一圈 */
}
@keyframes ring-turn { to { stroke-dashoffset: 0; } }
```
```js
// main.js：把"等后端"做成"窗口先显示 + 页面演进度"
function createWindow() {
  mainWindow = new BrowserWindow({ /* 无边框等配置见窗口专项 */ });
  mainWindow.loadFile(...);
  mainWindow.once('ready-to-show', () => { applyStartupSizing(mainWindow); mainWindow.show(); });

  // ★ 关键：窗口先出来，后端探测放到窗口之后（不要阻塞建窗）
  ensureBackend().then((ok) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend:ready', { ok });   // 页面收此消息后淡出覆盖层
    }
  });
}
```
```js
// preload.js
contextBridge.exposeInMainWorld('api', {
  onBackendReady: (cb) => ipcRenderer.on('backend:ready', (_e, payload) => cb(payload)),
});
```
```js
// 页面
window.api?.onBackendReady(({ ok }) => {
  document.getElementById('splash').classList.add('hide');
  if (!ok) showBackendOfflineHint();     // 失败时给"重试/去终端启动"的提示，而不是空白等待
});
```

> ⚠️ **模板自身的坑**：`project-template/.../main.js` 当前是 `await ensureBackend()` → `createWindow()`，等待期（最长 60s）**没有任何窗口**。按上面改成"先建窗、后等后端"即可（本次仅记录，未改代码）。

---

## 6. 反模式清单（鸿蒙上不要这么做）

| ❌ 反模式 | 后果 |
|---|---|
| 闪屏窗口 `show:false` + 稍后 `show()` | 可能一直不显示 |
| 闪屏用 `transparent:true` 做圆形/圆角 | 可能整窗透明到看不见 |
| 闪屏设 `skipTaskbar:true` | 平台不支持 |
| 闪屏 = 第一个窗口，然后 `close()` | `terminateSelf()`，主界面/应用异常 |
| 在 `Tray` 之前建任何窗口 | 窗口创建/显隐不可靠 |
| 等后端就绪后才建第一个窗口 | 空窗期无任何画面 |
| 动画全靠 JS 定时器 | 首帧前不跑 |

---

## 7. 实测项（A-42~A-44，已并入手册附录 A）

| # | 实测项 | 通过标准 / 判读 |
|---|---|---|
| **A-42** | 闪屏最小 case（**V1**：Tray 先建 + `frame:false` + `show:true` 非透明窗口） | 能否稳定显示 → 决定 §4 P1/P3 是否成立 |
| **A-43** | `transparent:true` 在鸿蒙上的实际表现 | 整窗透明？内容是否仍绘制？→ 决定 P4 |
| **A-44** | 首窗口 `close()` 是否终结应用（闪屏当首窗口） | 应用退出/主窗口异常 → 决定 P2 的严重度 |

---

## 8. 相关文件

**本仓库**
- 实施手册：`鸿蒙PC迁移实施手册.md`（第三部分 P1 前端迁移 / 附录 A 实测表 / 附录 C「Electron 数据写哪」）
- 姊妹专项：`鸿蒙PC迁移专项_多语言i18n方案.md`、`鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md`
- 官方原文：`research/rawgitcode_electron_readme.md`（窗口显示隐藏、三键、悬浮窗/透明度优先级、`callArkTSFunction` 指南入口）
- API 支持表：`research/api_index.md`（`win.setSkipTaskbar` :285 不支持）
- 模板源码：`project-template/web_engine/src/main/ets/adapter/AppWindowAdapter.ets`（:125 可见性、:144-150 close、:229-246 show/hide）

**外部**
- 官方仓库（含 callArkTSFunction / API 索引）：<https://gitcode.com/openharmony-sig/electron>
- Electron 官方文档：`BrowserWindow`（`show` / `transparent` / `alwaysOnTop` / `skipTaskbar`）
