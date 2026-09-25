# 鸿蒙 PC 专项：窗口"外框/占不满屏" 与 跨域登录跳转方案

> **适用**：Electron 34 鸿蒙壳工程（`templates/ohos_electron_hap-main` / `project-template`）
> **来源标注**：✅ 官方文档原文核实 ｜ ✅ 模板源码核实（给出文件:行号）｜ ⚠️ 需真机实测（编号对应手册附录 A）
> **配套改动**：本次已同步修改 `project-template`（清单见 §1.4、§2.4）
> **版本**：v1.0

---

## 0. 一句话结论

| 问题 | 根因（一句话） | 解法（一句话） |
|---|---|---|
| ① 模板窗口成了原应用的"外边框"、占不满屏 | 鸿蒙上 Electron 窗口是 **OHOS 窗口里的一块 XComponent 画面**；应用沿用 `frame:true` → 系统标题栏+窗口边框被打开；且**首窗口尺寸由 `module.json5` metadata 决定，`new BrowserWindow({width,height})` 对首窗口不生效** | `frame:false` + 页面自绘标题栏（`-webkit-app-region: drag`）+ `module.json5` 写首窗口尺寸 + 运行期 `maximize()` |
| ② 跨域/登录跳转在鸿蒙失败 | 多数情况**不是"鸿蒙禁跨域"，而是页面 origin 是 `file://`（Origin=`null`）、或失败点根本不在 CORS（整页跳转不受 CORS 约束）** | 先按 §2.2 场景分型；再用三件套：**真实 origin + 后端 CORS 回显 Origin + 主进程代理** |

> ⚠️ 全局原则：`webSecurity:false` / `--disable-web-security` 只是**开发期兜底**，官方 README 明确列为"风险参数，仅开发/测试，切勿生产"（✅ `research/rawgitcode_electron_readme.md:713`）。上架形态必须走正规方案。

---

# 第一部分：窗口"外框"与铺满屏幕

## 1.1 机制：为什么会凭空多一层框

鸿蒙上的层级关系（不是"两个窗口"，而是"一个 OS 窗口 + 一块应用画面"）：

```
OHOS 窗口（UIAbility，系统绘制标题栏/边框/圆角/阴影）
└── ArkTS 页面 pages/Index
    └── WebWindow() → NodeContainer → XComponent(SURFACE)   ← Electron 的全部画面画在这里
        └── Electron 浏览器进程：main.js → BrowserWindow（逻辑窗口，内容区 = 窗口 - drawableRect 内缩）
```

| 现象 | 机制 | 证据 |
|---|---|---|
| 出现系统标题栏/窗口边框（"外框"） | Electron 的 `frame` 选项被映射为**系统窗口装饰显隐** | ✅ `project-template/web_engine/src/main/ets/adapter/AppWindowAdapter.ets:465-468`（`setWindowDecorVisible(useNativeFrame)`） |
| 首窗口尺寸不受 `new BrowserWindow({width,height})` 控制 | Electron 主窗口的启动尺寸由 **UIAbility 启动参数**决定，需要 `module.json5` 的 `ohos.ability.window.*` metadata | ✅ 官方《Electron鸿蒙化指导文档》→ Electron鸿蒙特性说明 → 窗口 → **首窗口指定大小**；`project-template/electron/src/main/module.json5` 原本**没有**这段（本次已补） |
| 有装饰时画面还会四周内缩 | 内容区 = `windowRect` − `drawableRect`（标题栏/边框内缩量） | ✅ `web_engine/.../ability/WebAbility.ets:100-115`（`width - drawableRect.left*2`）；`AppWindowAdapter.ets:308-341`（`setBounds` 反向加回 border） |
| 无边框窗口的三键默认不显示 | `hideTitleBar=true` 时 `setWindowTitleButtonVisible(false,false,false)` | ✅ `web_engine/.../ability/WebAbility.ets:171-181`、`WebBaseAbility.ets:51`；✅ 官方 README「调整三键」 |

**结论**：这不是模板 bug，而是**平台差异**——想让鸿蒙和 Windows 表现一致，应用必须显式声明"无边框 + 自绘标题栏"，并显式指定首窗口尺寸。

## 1.2 解决步骤（4 步，全都已落到 `project-template`）

### ① 无边框：`frame:false`（消除"外框"）

```js
// 你的 main.js
const win = new BrowserWindow({
  width: 1280, height: 800,
  frame: false,              // ★★ 关键：关掉系统装饰（标题栏 + 窗口边框）
  titleBarStyle: 'hidden',   // 与 frame:false 配套（✅ 官方论坛《如何自定义标题栏》即此写法）
  webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
});
```

### ② 首窗口尺寸：写进 `electron/src/main/module.json5`

```json5
{
  "name": "EntryAbility",
  // ...
  "metadata": [
    { "name": "ohos.ability.window.width",  "value": "1280" },
    { "name": "ohos.ability.window.height", "value": "800"  },
    { "name": "ohos.ability.window.left",   "value": "center" },
    { "name": "ohos.ability.window.top",    "value": "center" }
  ]
}
```

> 只有首窗口需要这样写；其它窗口（`new BrowserWindow`）由 Electron 侧尺寸驱动。

### ③ 运行期铺满：`maximize()` / `setBounds()`（官方 API 表均标注"支持"）

```js
mainWindow.once('ready-to-show', () => {
  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;   // ✅ screen.getPrimaryDisplay 支持
  if (CONFIG.WINDOW.startMaximized) win.maximize();                     // ✅ win.maximize 支持
  else win.setBounds({ x: 0, y: 0, width: Math.min(width, 1280), height: Math.min(height, 800) });
});
```

需要真·全屏（无任务栏/沉浸）时用 `win.setFullScreen(true)`（✅ 支持）；注意模板里 `maximize` 走的是 `windowClass.maximize(ENTER_IMMERSIVE)`（✅ `AppWindowAdapter.ets:388-407`）。

### ④ 页面自绘标题栏（无边框后窗口要能拖、能关）

```html
<!-- 页面内：拖动区 + 三键 -->
<div class="titlebar">
  <span>我的应用</span>
  <div class="controls">
    <button id="win-min">─</button><button id="win-max">□</button><button id="win-close">✕</button>
  </div>
</div>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }      /* 别给页面留白边 */
  .titlebar { height: 36px; -webkit-app-region: drag; }           /* ★ 拖动窗口 */
  .titlebar .controls { -webkit-app-region: no-drag; }            /* ★ 按钮区不拖动 */
</style>
```

```js
// preload.js（contextIsolation:true 下页面拿不到 ipcRenderer，必须经 preload 暴露）
contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
});
```

```js
// main.js：三键 IPC
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window:close',    () => mainWindow.close());
```

## 1.3 常见追问

| 追问 | 答案 |
|---|---|
| 无边框后窗口拖不动？ | 用 `-webkit-app-region: drag` 圈出拖动区（✅ 官方示例支持；原生侧对应绑定 `AppWindow.StartWindowMoving`，见 `AppWindowAdapterBind.ets:231`） |
| 我就是要系统标题栏，只想去掉"框"？ | 做不到二选一：那个"框"就是系统窗口装饰本身。保留系统标题栏 = 保留外框；要应用自己的外观就必须 `frame:false` |
| 无边框还想有系统三键？ | 在 `loadURL/loadFile` **之前**调 `win.setWindowButtonVisibility(true)`（配合 `win.maximizable` 可单独控最大化键）——✅ 官方 FAQ 给了完整显隐对照表；或按官方 README 改 `WebAbility.ets` 的初始状态 |
| 三键/自绘按钮会不会重叠？ | 原生侧会上报标题栏按钮矩形（`windowTitleButtonRectChange` → `OnCaptionButtonRectChange`，✅ `WebAbility.ets:190-200`），自绘时右侧预留约 140px |
| 多窗口怎么办？ | 每个 `BrowserWindow` 对应一个 OHOS 窗口；**子窗与悬浮窗没有系统三键**（✅ 官方 README），需要多窗口就按主窗/子窗分别设计标题栏 |
| 最大化后仍有边距？ | ① 页面 CSS（`html,body margin:0;height:100%`）；② 检查 `frame` 是否真的为 false（有装饰就有 `drawableRect` 内缩）；③ 用模板日志 `[window] workArea=... maximized=true` 核对 |

## 1.4 本次已改动的模板文件（可直接对照）

| 文件 | 改动 |
|---|---|
| `project-template/electron/src/main/module.json5` | 补 `ohos.ability.window.*` 首窗口尺寸 metadata |
| `.../resfile/resources/app/main.js` | `frame:false` + `titleBarStyle` + `startMaximized` + `applyStartupSizing()` + 三键 IPC；preload 接入 |
| `.../resfile/resources/app/preload.js` | **新增**：`window.desktop` 三键桥 |
| `.../resfile/resources/app/renderer/index.html` | 自绘标题栏（drag 区 + 三键）+ `origin` 自检 chip |

---

# 第二部分：跨域与"登录跳转失败"

## 2.1 先建立三个前提认知（否则会在错误的方向上耗时间）

| # | 认知 | 含义 |
|---|---|---|
| 1 | **`webSecurity:false` 关的是"渲染进程同源策略"**，且鸿蒙上未必生效 | 它解决不了：`file://` 的 null origin、SameSite Cookie、证书错误、导航被拦 |
| 2 | **`file://` 页面的 Origin 是 `null`** | 带 Cookie（`credentials:'include'`）的跨域请求，后端无法安全地回 `null`，标准实现下**基本无解**。Windows 上因为 webSecurity 关得彻底才"看起来能用" |
| 3 | **整页跳转（`location.href` / 表单 POST / 302 回跳）不受 CORS 约束** | 这类"登录成功但回跳失败"与跨域无关，要查 Cookie、证书、协议回调、拦截器 |

**能/不能对照**：

| 手段 | 能解决 | 不能解决 |
|---|---|---|
| `webSecurity:false` | 渲染层 XHR/fetch 的读取限制（仅本机开发） | null origin、Cookie SameSite、证书、导航拦截、上架合规 |
| 后端 CORS（回显 Origin + credentials） | 渲染层带 Cookie 的跨域 XHR | null origin（`file://`）、整页跳转 |
| 主进程代理（`ses.fetch`/`net.request`） | **全部**跨域类问题（主进程无同源策略），Cookie 由 session 统一管理 | 整页跳转还是得靠 Cookie/协议配置 |
| 真实 origin（`app://` 或 `http://app.localhost`） | null origin 问题（②的前提） | 后端若不放行 CORS 仍会失败 |

## 2.2 ★ 场景分型矩阵（先定位，再改代码）

> 定位总入口：**应用内打开 devtools**（`Ctrl+Shift+I` 或 `win.webContents.openDevTools()`）→ Console 看报错原文 + Network 看请求。

| 场景 | 典型症状 | 30 秒识别方法 | 病根 | 方案 |
|---|---|---|---|---|
| **A. 页面内 XHR/fetch 跨域** | Console 报 `blocked by CORS policy`；Network 里请求前有 `OPTIONS` | 看是否有 OPTIONS 预检、Request Headers 的 `Origin` 是什么 | 同源策略（或 null origin） | §2.3 ①②③（**首选 ③ 主进程代理**） |
| **B. 整页跳转 SSO，登录后 302 回跳** | 登录页正常、认证成功、回跳后白屏/停在回调页 | Network 看最后一跳的 `302/200`、`Set-Cookie` 是否带 `SameSite/Secure` | **与 CORS 无关**：跨站 Cookie 被丢、证书、回跳地址不可达 | §2.3 ④：`SameSite=None; Secure`（https）/ 改用同源代理 / 证书放行 |
| **C. `window.open` 弹窗登录** | 弹窗能开、登录成功，主窗口无反应 | 弹窗是否 `about:blank`、`window.opener` 是否为 null | 跨窗口通信/opener 关系；子窗在鸿蒙是独立 OHOS 窗口 | §2.3 ⑤：主进程 `setWindowOpenHandler` + `did-create-window` 接管 |
| **D. 回调走自定义协议 `myapp://auth/callback`** | 回跳时系统无反应/报"无法打开链接" | 回跳 URL 的 scheme 是不是自己的 | 未注册协议/未接 Deeplink | §2.3 ⑥：`module.json5` skills + `app.on('open-url')`（⚠️ `app.setAsDefaultProtocolClient` 在鸿蒙**不支持**，见 `api_index.md:87`） |
| **E. 自签证书 / 公司内网 HTTPS** | Console 报 `ERR_CERT_AUTHORITY_INVALID` | 报错含 `CERT` | 证书链不受信 | §2.3 ⑦：`session.setCertificateVerifyProc`（✅ 支持）；仅开发可 `--ignore-certificate-errors` |
| **F. 被自家 `webRequest`/拦截器改写** | 只有某个域名/路径失败，且日志里有 redirect 记录 | 看主进程日志 `[redirect] ...` | 重定向规则过宽、丢了 Cookie/头、CORS 头被写坏 | §2.4（模板本次已修 `Access-Control-Allow-Origin: *` 的坑） |

## 2.3 三件套（正规解法，按推荐度排序）

### ① 给页面一个真实 origin（**前提条件**，先做）

两个方案（都已在模板里预留开关）：

```js
// 方案 A：模板自带虚拟域名（复用 webRequest 重定向）
win.loadURL('http://app.localhost/');     // origin = http://app.localhost，可被后端精确放行

// 方案 B：特权自定义协议 app://（本次模板新增，CONFIG.USE_APP_SCHEME=true 启用）
protocol.registerSchemesAsPrivileged([{   // ★ 必须在 app ready 之前调用
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);
// ready 之后：
protocol.handle('app', (req) => {
  const { pathname } = new URL(req.url);
  const filePath = path.normalize(path.join(__dirname, 'renderer', decodeURIComponent(pathname)));
  if (!filePath.startsWith(path.join(__dirname, 'renderer'))) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(filePath).toString());
});
win.loadURL('app://bundle/index.html');   // origin = app://bundle（standard+secure，非 null）
```

> ✅ `protocol.registerSchemesAsPrivileged`（`api_index.md:670`）、`protocol.handle`（`:658`）均标注"支持"；⚠️ 但鸿蒙版实际 origin 取值需实测（**A-32**）。
> 模板自检页已加 `origin` chip：显示"真实 origin ✅"还是"origin=null ⚠️"，一眼可判。

### ② 后端按规矩放行 CORS（Spring Boot，本项目后端可控）

```java
@Configuration
public class CorsConfig implements WebMvcConfigurer {
  @Override public void addCorsMappings(CorsRegistry registry) {
    registry.addMapping("/**")
      // ★ 带 Cookie 时必须用 allowedOriginPatterns 精确放行，不能用 allowedOrigins("*")
      .allowedOriginPatterns("http://app.localhost", "app://bundle",
                             "http://127.0.0.1:*", "http://localhost:*")
      .allowedMethods("GET","POST","PUT","DELETE","OPTIONS")
      .allowedHeaders("*")
      .allowCredentials(true)      // ★ 与前端 credentials:'include' 配对
      .maxAge(3600);
  }
}
```

```java
// Spring Security 在场时：让预检 OPTIONS 先于认证通过
http.cors(Customizer.withDefaults())
    .authorizeHttpRequests(auth -> auth.requestMatchers(HttpMethod.OPTIONS, "/**").permitAll() /* ... */);
```

前端侧：`fetch(url, { credentials: 'include' })`（跨域带 Cookie 必须显式声明）。

### ③ 主进程代理（**最稳，推荐用于登录这种"必须成功"的链路**）

主进程没有同源策略（官方文档原文：*渲染进程请求受浏览器跨域规则限制，主进程请求无跨域问题*），且能统一管理 Cookie 与证书：

```js
// main.js
const { ipcMain, session } = require('electron');

ipcMain.handle('api:login', async (_e, { url, payload }) => {
  const res = await session.defaultSession.fetch(url, {          // ✅ ses.fetch 支持（api_index.md:738）
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'include',                                      // 走 session 的 Cookie
  });
  return { status: res.status, body: await res.text() };
});
```

```js
// preload.js
contextBridge.exposeInMainWorld('api', {
  login: (p) => ipcRenderer.invoke('api:login', p),
});
```

### ④ 场景 B（整页跳转）专项

- 回跳 Cookie 丢失 → 后端 `Set-Cookie: ...; SameSite=None; Secure`（**必须 HTTPS**）；若前端页与后端同源（都用 `http://app.localhost`），则无需 None；
- 跳转链路观测：`mainWindow.webContents.on('will-redirect', (e, url) => console.log('[redirect]', url))`（✅ `will-redirect` 支持，`api_index.md:995`）；
- 证书：见 ⑦；
- 回调是自定义协议：见 ⑥。

### ⑤ 场景 C（弹窗登录）

```js
mainWindow.webContents.setWindowOpenHandler(({ url }) => ({    // ✅ setWindowOpenHandler 支持（:1094）
  action: 'allow',
  overrideBrowserWindowOptions: { frame: false },
}));
mainWindow.webContents.on('did-create-window', (child) => {    // ✅ did-create-window 支持（:955）
  child.webContents.on('did-navigate', (_e, url) => console.log('[popup]', url));
});
```

若回跳后用 `window.opener.postMessage(...)` 通知主窗，注意**跨源必须指定 targetOrigin**；更稳的做法是让子窗把结果交给主进程（`ipcRenderer.send` 或 `webContents.send` 给主窗）。

### ⑥ 场景 D（自定义协议回调 / Deeplink）

- 在 `electron/src/main/module.json5` 的 abilities `skills` 里声明 `uris`（参考官方 README《Deeplink 使用指南》）；
- 应用内接收：`app.on('open-url', (event, url) => { ... })`（✅ 支持，`api_index.md:22`）；
- ⚠️ **不要**用 `app.setAsDefaultProtocolClient()` / `app.requestSingleInstanceLock()`——鸿蒙版**不支持**（`api_index.md:87`、`:79`）。

### ⑦ 场景 E（证书）

```js
session.defaultSession.setCertificateVerifyProc((request, callback) => {   // ✅ 支持（api_index.md:761）
  // 仅对指定内网域名放行；生产建议改用受信 CA / mTLS（见手册第四部分 3.8）
  callback(request.hostname.endsWith('.mycorp.local') ? 0 : -3);
});
```

### ⑧ 兜底开关（仅本机开发，且**必须验证是否真生效**）

```js
// main.js 最顶部，app.whenReady() 之前
app.commandLine.appendSwitch('disable-web-security');   // ✅ appendSwitch 支持（api_index.md:364）
```

**判据**：devtools → Network，看跨域请求前**是否还发 `OPTIONS` 预检**。
- 有预检 → CORS 仍在生效（开关没起作用），别再耗时间，直接走 ①②③；
- 无预检且请求成功 → 开关生效（仅限本机开发）。

## 2.4 本模板 `main.js` 里已修的坑（务必同步到你的应用）

```js
// ❌ 修复前（模板旧代码）——与 credentials:'include' 互斥，带 Cookie 的登录请求会被浏览器判死
headers['Access-Control-Allow-Origin'] = ['*'];

// ✅ 修复后：回显具体 Origin + 允许凭据（Origin 需在 onBeforeSendHeaders 里先记录）
headers['Access-Control-Allow-Origin'] = [requestOrigin];
headers['Access-Control-Allow-Credentials'] = ['true'];
headers['Vary'] = ['Origin'];
```

> 每个"跨域 + 登录"项目几乎都会踩这一条：`ACAO: *` 和 `credentials` **只能二选一**。

## 2.5 现场定位 10 分钟清单

| 步骤 | 动作 | 判读 |
|---|---|---|
| 1 | 应用内开 devtools（`win.webContents.openDevTools()`），复现登录 | Console 报错原文分三类：`blocked by CORS policy`→A；`ERR_CERT_*`→E；无 JS 报错但页面停在回调→B/D |
| 2 | Network → 选中失败请求 → Request Headers | `Origin: null` → `file://` 页面（先做 §2.3①）；`Origin: http://app.localhost` → 正常，问题在后端放行 |
| 3 | 同请求 → 看是否有 `OPTIONS` | 有 → CORS 生效中；无却被拦 → 检查 preload/`webSecurity`/拦截器 |
| 4 | 回跳那一跳 → Response Headers | `Set-Cookie` 缺 `SameSite=None; Secure` → 跨站 Cookie 被丢（B 型） |
| 5 | 主进程日志 | 看 `[redirect] app.localhost -> ...`、`[scheme] app://...`、`[window] workArea=...` 是否符合预期 |
| 6 | 系统日志 | `hdc shell hilog \| grep -iE "chromium\|electron\|adapter"`（参考手册附录 C 的 hdc 速查） |

**症状 → 结论速查**：

| 症状 | 结论 |
|---|---|
| 只在鸿蒙失败，Windows 正常，Console 有 CORS 字样 | 优先怀疑 `Origin: null`（`file://`）→ §2.3① |
| 登录接口 200，但后续接口 401 | Cookie 没带上 → §2.3② ④ |
| 页面停在 SSO 回调地址 | 回调地址不可达/协议未注册 → ⑥ |
| 只有某个域名失败 | 自家 webRequest 规则命中 → 场景 F |
| 全屏/窗口相关（非网络） | 回第一部分 |

## 2.6 API 支持依据（本仓库可复查）

| API | 支持 | 位置 |
|---|---|---|
| `app.commandLine.appendSwitch` | 支持 | `research/api_index.md:364` |
| `session.webRequest`（全 8 钩子） | 支持 | `:785`、`:1176-1183` |
| `session.fetch` / `ses.cookies` / `ses.setCertificateVerifyProc` | 支持 | `:738`、`:779`、`:761` |
| `protocol.registerSchemesAsPrivileged` / `protocol.handle` | 支持 | `:670`、`:658` |
| `net.request` | 支持 | `:580` |
| `win.maximize` / `win.setFullScreen` / `win.setBounds` / `win.isMaximized` | 支持 | `:231`、`:260`、`:251`、`:215` |
| `win.setWindowButtonVisibility` / `win.setMinimumSize` / `win.setResizable` | 支持 | `:296`、`:272`、`:280` |
| `screen.getPrimaryDisplay` | 支持 | `:694` |
| `webContents.setWindowOpenHandler` / `did-create-window` / `will-redirect` / `will-navigate` | 支持 | `:1094`、`:955`、`:995`、`:993` |
| `app.on('open-url')` | 支持 | `:22` |
| `app.setAsDefaultProtocolClient` / `app.requestSingleInstanceLock` | **不支持** | `:87`、`:79` |

---

# 第三部分：真机验收清单（新增实测项，已并入手册附录 A）

| # | 实测项 | 通过标准 |
|---|---|---|
| **A-30** | `module.json5` 首窗口尺寸 metadata 是否生效 | 冷启动窗口尺寸 = 配置值（而非系统默认） |
| **A-31** | `frame:false` 是否彻底去除系统装饰；`-webkit-app-region: drag` 拖动是否生效 | 无标题栏/无边框；按住自绘标题栏可移动窗口 |
| **A-32** | `app://` 特权协议方案可用性与页面实际 origin | 页面加载正常且 `location.origin = app://bundle`（非 `null`） |
| **A-33** | `--disable-web-security` 在鸿蒙版是否真生效 | 跨域请求前后**无 OPTIONS 预检**且请求成功 |
| **A-34** | 带 Cookie 跨域（`credentials:'include'`）+ `onHeadersReceived` 回显 Origin 是否被采纳 | 登录接口 200 且后续接口带 Cookie 200 |
| **A-35** | `window.open` 子窗口的 opener/回跳通信行为 | 子窗登录完成后主窗能收到结果 |
| **A-36** | `app.on('open-url')` 自定义协议回调（Deeplink） | 系统能把 `myapp://...` 回调送到应用 |

---

# 第四部分：相关文件与参考

**本仓库**
- 实现手册：`鸿蒙PC迁移实施手册.md`（§3.5 域名映射 / 第四部分 3.8 证书 / 附录 A 实测表 / 附录 C hdc 速查）
- 模板：`project-template/`（本次改动见 §1.4、§2.4）
- 官方文档原文：`research/rawgitcode_electron_readme.md`（窗口/三键/坚盾模式/风险参数）
- API 支持总表：`research/api_index.md`（1294 个 API）
- 官方论坛要点摘录：`research/topics_limitations.md`（自定义标题栏示例、三键 FAQ）

**外部**
- 官方《Electron鸿蒙化指导文档》：<https://gitcode.com/openharmony-sig/electron>
- 官方示例《HarmonyOS electron如何自定义标题栏》（`frame:false` + `-webkit-app-region: drag`）
- Electron 官方文档：`BrowserWindow` / `session` / `protocol` / `webRequest`
