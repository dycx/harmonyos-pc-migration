# 鸿蒙 PC 专项：主进程模块化与平台差异适配方案

> **本文可独立阅读**：不要求先读其它文档。文中涉及的平台事实均直接给出结论与出处（仓库内文件:行号 / 官方文档原文），代码可直接复制使用。
>
> **要解决的问题**：Windows Electron 工程里，界面按钮与系统交互的响应函数集中放在 `process-manage.js` 等独立模块中；迁移到鸿蒙 PC 后这些代码"失效"，只能把它们复制回 `main.js` 才生效。
>
> **参考实现**：`project-template/web_engine/src/main/resources/resfile/resources/app/`（`ipc/` + `platform/` 目录，已随本文落地并冒烟验证）
> **版本**：v1.0

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 这是问题吗？ | **是问题**，但不是"鸿蒙不支持模块化"。鸿蒙版 Electron 的 `ipcMain` / `ipcRenderer` **全部标注"支持"**（官方 API 索引 `research/api_index.md:475-494`）。真正原因是 5 类可验证的具体问题（§2），"复制回 main.js"只是**绕过了症状** |
| 为什么搬回 main.js 就好了？ | 因为 main.js **一定在包里**、**不涉及 require 自己**、**平台判断/注册顺序被你顺手改对了**——恰好避开了 §2 的 A/B/C/D 四类根因。代价是：main.js 变成上帝文件、每加一个功能都要动它、两个平台继续分叉 |
| 正确做法 | **一份业务代码 + 平台适配层**：依赖注入（消除循环 require）＋ `platform/` 集中平台差异 ＋ 通道契约 ＋ 能力探测/降级 ＋ 统一包装（消灭静默失效）＋ 构建期清单校验。渲染层代码零改动（§3~§6） |
| 谁能受益 | 任何"多文件主进程 + 需要按平台分流"的 Electron 工程；本文的做法在 Windows/macOS/Linux/鸿蒙上同样成立，不是鸿蒙特有技巧 |

**术语速查（本文自包含）**
- **主进程 / 渲染进程**：Electron 的 Node 侧（`main.js` 所在）与网页侧，二者通过 **IPC**（进程间通信）互相调用。
- **HAP**：鸿蒙应用的安装包；其中的 **resfile** 目录存放随包资源，Electron 前端产物（`main.js`、`renderer/`）就放在 `resfile/resources/app/` 下。
- **asar**：Electron 的打包压缩格式；鸿蒙壳工程**必须关闭**（`asar:false`），因为运行时需要直接读取 app 目录下的文件。
- **能力探测**：不查文档表格，而是在运行时用 `typeof obj.fn === 'function'` 判断某个 API 是否可用。

---

## 1. 现象与事实核对

### 1.1 现象

| 平台上 | 表现 |
|---|---|
| Windows | `main.js` `require('./process-manage')`，模块内用 `ipcMain.on/handle` 注册响应函数，界面按钮、系统交互全部正常 |
| 鸿蒙 PC | 同一份代码，按钮点了**没反应**（或整段逻辑不执行）；把这些函数**复制进 `main.js`** 后恢复正常 |

### 1.2 事实核对：鸿蒙版 IPC 是支持的

| API | 鸿蒙版支持 | 出处 |
|---|---|---|
| `ipcMain.handle` / `handleOnce` / `on` / `once` / `off` / `removeHandler` / `removeAllListeners` / `addListener` / `removeListener` | **支持**（9/9） | `research/api_index.md:475-483` |
| `ipcRenderer.invoke` / `send` / `sendSync` / `on` / `once` / `off` / `postMessage` / `sendToHost` / `removeListener` / `removeAllListeners` / `addListener` | **支持**（11/11） | `research/api_index.md:484-494` |
| `contextBridge`（preload 暴露接口） | **支持** | 同上 API 索引 contextBridge 段 |

> 也就是说：**"独立模块 + IPC"这条路在鸿蒙上是通的**。失效一定发生在"模块有没有被加载 / 有没有被注册 / 逻辑有没有走到"这三步中的某一步。

### 1.3 为什么"复制回 main.js"能修好，但会留下债

| 复制回 main.js 恰好避开了 | 说明 |
|---|---|
| 打包漏文件 | `main.js` 是入口，一定在产物里（§2.1） |
| 循环 require | 同一文件内不存在互相 require（§2.3） |
| 平台判断分支 | 搬的过程中通常会顺手改成"当前平台可用"的写法（§2.2） |
| 注册顺序 | 内联后执行顺序一目了然（§2.4） |

**留下的债**：main.js 体积膨胀、Windows 与鸿蒙两份实现继续分叉、每次加功能都要改入口文件、失效原因没有被理解，下次换个模块还会再踩一遍。

---

## 2. 定位方法：5 类根因 × 30 秒验证

### 2.0 先加"三行启动日志"（最小侵入，直接分诊）

在 `main.js` 顶部加：

```js
console.log('[boot] platform =', process.platform, '| arch =', process.arch, '| electron =', process.versions.electron);
try { console.log('[boot] process-manage resolved →', require.resolve('./process-manage')); }
catch (e) { console.error('[boot] process-manage MISSING:', e.code, e.message); }
```

再在你原来的模块**每个 handler 入口**加一行 `console.log('[pm] <通道名> 被调用')`。三个信号的分工：

| 日志表现 | 结论 |
|---|---|
| 启动时就报 `MISSING / MODULE_NOT_FOUND` | 根因 A（打包漏文件） |
| 能解析，但按钮点击后**没有** `[pm]` 日志 | 根因 B/D/E（注册或分支问题） |
| 有 `[pm]` 日志但功能没生效 | handler 内部逻辑（平台 API 不支持 / 参数错 / 窗口未就绪） |

### 2.1 根因 A：文件没进 HAP（最容易被掩盖）

**原因**：`electron-builder` 的 `files` 白名单没有包含该文件；或 `asar` 没关；或拷贝产物时漏了子目录。

**处置**：
```jsonc
// package.json（electron-builder 配置）
"build": {
  "asar": false,                                  // ★ 鸿蒙壳工程必须关闭 asar
  "files": ["**/*.js", "**/*.html", "**/*.css",   // ★ 用通配而不是逐个列，避免漏文件
            "!**/*.map", "!node_modules/**/{test,__tests__}/**"],
  "extraResources": []
}
```

**设备侧核对（自包含说明）**：应用的 app 目录随 HAP 安装在
`/data/storage/el1/bundle/<bundleName>/<module>/resources/resfile/resources/app`（沙箱只读视角；物理路径为 `/data/app/el1/bundle/public/<bundleName>/...`）。
用 `hdc` 列一下实际文件（`-b` 需 API 15+ 且为调试签名应用）：

```bash
hdc shell -b <bundleName> "ls -l /data/storage/el1/bundle/<bundleName>/<module>/resources/resfile/resources/app"
# 不确定 module 名就先逐层进：
hdc shell -b <bundleName> "ls /data/storage/el1/bundle/<bundleName>/"
```

**根治**：把清单比对做成构建步骤（§6 脚本），而不是靠人眼。

### 2.2 根因 B：平台判断分支（静默失效的头号来源）

**官方原文**：*"如果 npm 库里面使用了 `process.platform`、`os.type()` 等查平台的 API 来判断平台，未适配鸿蒙平台无法正常使用。因为 **`process.platform` 返回的是 `openharmony`**，三方库不一定认识它。"*（`research/rawgitcode_electron_readme.md:382-384`）

所以这类代码在鸿蒙上会**整段跳过**（不是报错，是"没反应"）：

```js
if (process.platform === 'win32') { ... }        // ❌ 鸿蒙上永远不成立
switch (process.platform) { case 'darwin': ... } // ❌ 落到 default 或什么都不做
```

**处置**：把平台判断从业务代码里**全部移出**，统一放进 `platform/index.js` 做归一化（§4.4），业务代码只调用 `platform.xxx`。
**必做实测**：鸿蒙上 `process.platform` 的真实取值（官方说 `openharmony`，社区实测还有 `ohos` / `linux` 的说法）——见 §8 A-09/A-45。

### 2.3 根因 C：循环依赖（require 回 main.js 拿窗口）

```js
// process-manage.js（Windows 上"能跑"的写法）
const { mainWindow } = require('./main');    // ❌ main.js 还没执行完，拿到的是空对象
ipcMain.on('do-something', () => mainWindow.webContents.send('x'));  // → undefined，静默失效
```

Node 的循环 `require` 返回**未完成的 exports**；谁先加载谁吃亏。**两端加载顺序不同**（打包方式、入口时序差异），所以 Windows 能跑、鸿蒙不能。

**处置**：改成"取值函数注入"（§4.5），模块内永远 `getMainWindow()`，不要缓存窗口引用。

### 2.4 根因 D：注册时机

- `ipcMain.handle` 必须早于渲染层调用：若在窗口加载之后再注册，页面首屏的 `invoke` 会失败；
- 依赖窗口的注册（`mainWindow.on(...)`）必须在窗口创建之后。

**处置**：明确固定顺序 —— **建托盘 → 注册 IPC → 建窗口**（§4.6），并在启动日志里打印已注册通道清单。

### 2.5 根因 E：preload 未生效（渲染层压根没发出调用）

若渲染层是 `window.electronAPI.xxx()` 而 preload 没加载成功，`window.electronAPI` 是 `undefined`，点击自然无反应——**这种情况把代码搬进 main.js 也不会好**。

**验证**：渲染层 `console.log(typeof window.electronAPI)`；preload 里 `console.log('[preload] loaded')`；主进程建窗时确认 `webPreferences.preload` 指向的**绝对路径**存在（`path.join(__dirname, 'preload.js')`）。

### 2.6 分诊表

| 现象 | 最可能根因 | 先做什么 |
|---|---|---|
| 启动日志报 `MODULE_NOT_FOUND` / 应用起不来 | A 打包漏文件 | §2.1 设备侧列目录 + 改 `files` |
| 应用正常、按钮点了没反应、**无任何日志** | B 平台分支 / C 循环依赖 | §2.0 三行日志 + 搜索 `process.platform` |
| 首屏调用失败、之后正常 | D 注册时机 | 把注册挪到建窗之前 |
| 连 `[preload] loaded` 都没有 | E preload | 检查 preload 路径与文件是否打包 |
| 有 `[pm]` 日志但功能无效 | 平台 API 不支持 | §7 速查表 + 能力降级（§4.4） |

---

## 3. 目标架构

```
app/
├── main.js                  # 只做引导与装配（托盘 → 注册 IPC → 建窗 → 等后端），不含业务逻辑
├── preload.js               # 安全桥：按契约暴露白名单方法，统一拆包 {ok,data|error}
├── logger.js                # 统一日志出口与前缀（便于在 hilog 里过滤主进程链路）
├── ipc/
│   ├── channels.js          # ★ 通道契约：主进程/preload/渲染层三处共用同一份常量
│   ├── register.js          # ★ 统一注册器：日志 + 错误结构 + 已注册通道清单
│   └── process-manage.js    # ★ 业务模块：导出 register(ctx)，不 require main，不判断平台
├── platform/
│   ├── index.js             # ★ 平台归一化 + 选实现 + 能力探测（全工程唯一出现平台名的地方）
│   ├── generic.js           # 跨平台通用实现（只用跨平台 API）
│   ├── windows.js           # 仅 Windows 差异（任务栏、跳转列表、闪烁…）
│   └── ohos.js              # 仅鸿蒙差异（当前为空占位，注明往哪加）
└── renderer/                # 渲染层：按"能力表"决定按钮可用性，两端同一份页面代码
```

**依赖方向（单向，不允许反向）**：

```
renderer → preload → (IPC 契约) → ipc/*.js → platform/*.js → electron / node
                                     ↑
                                   main.js（只注入依赖：ipcMain、getMainWindow、platform、log）
```

**六条硬规则**
1. `main.js` 不写业务逻辑，只装配；
2. 业务模块**导出注册函数**，不产生"加载即副作用"；
3. 业务模块**不出现平台名**（`process.platform` / `os.type()` / `navigator.platform` 都不行）；
4. 窗口等可变对象用**取值函数**注入，不缓存引用；
5. 一律通过 `register.js` 注册，不直接用 `ipcMain.handle`；
6. 平台差异只写在 `platform/<platform>.js`，且**优先能力探测而非平台名判断**。

---

## 4. 参考实现（模板中已落地，可直接复制）

> 路径：`project-template/web_engine/src/main/resources/resfile/resources/app/`
> 以下代码与模板一致，可直接拷进你自己的工程。

### 4.1 `logger.js`：统一日志出口

```js
function ts() { return new Date().toISOString().slice(11, 23); }   // HH:mm:ss.SSS
function makeLogger(tag) {
  const prefix = `[app]${tag ? `[${tag}]` : ''}`;
  const line = (level) => (...args) => [`${prefix} ${level} ${ts()}`, ...args];
  return {
    info:  (...a) => console.log(...line('INFO ')(...a)),
    warn:  (...a) => console.warn(...line('WARN ')(...a)),
    error: (...a) => console.error(...line('ERROR')(...a)),
  };
}
module.exports = { makeLogger, ...makeLogger('boot') };
```
**要点**：统一前缀后，设备上一条命令就能捞出主进程链路：`hdc shell hilog | grep -i "\[app\]"`。

### 4.2 `ipc/channels.js`：通道契约

```js
const CH = {
  APP_INFO: 'app:info',
  APP_CAPABILITIES: 'app:capabilities',

  WIN_MINIMIZE: 'window:minimize',      // 自绘标题栏三键
  WIN_MAXIMIZE: 'window:maximize',
  WIN_CLOSE: 'window:close',
  WIN_IS_MAXIMIZED: 'window:is-maximized',

  SYS_OPEN_PATH: 'sys:open-path',       // 系统交互（原 process-manage.js 里的那类）
  SYS_TASKBAR_VISIBLE: 'sys:taskbar-visible',
  SYS_FLASH_FRAME: 'sys:flash-frame',
  SYS_JUMP_LIST: 'sys:jump-list',
  SYS_AUTO_START: 'sys:auto-start',

  EVT_BACKEND_READY: 'backend:ready',   // 主进程 → 渲染层的单向事件
};
module.exports = { CH };
```
**要点**：三处引用同一份常量，根除"通道名拼错导致的按钮无反应"（这类错误往往在换平台时才暴露）。
⚠️ 本文件必须随包打进去——漏了它，`preload.js` 直接 require 失败（正是 §2.1 的坑）。

### 4.3 `ipc/register.js`：统一注册器（消灭静默失效）

```js
const registered = new Set();

function wrap(name, fn) {
  registered.add(name);
  return async (event, ...args) => {
    const t0 = Date.now();
    try {
      const data = await fn(event, ...args);
      log.info(`${name} ok ${Date.now() - t0}ms`);
      return { ok: true, data };
    } catch (err) {
      log.error(`${name} FAILED (${Date.now() - t0}ms):`, (err && err.stack) || err);
      return { ok: false, error: { code: (err && err.code) || 'E_IPC', message: String((err && err.message) || err) } };
    }
  };
}
function handle(ipcMain, name, fn) { ipcMain.handle(name, wrap(name, fn)); }
function on(ipcMain, name, fn) { /* 单向通知：异常只记日志 */ }
function dumpRegistered() { log.info(`registered channels: ${[...registered].sort().join(', ')}`); }
```
**要点**：① 每个 handler 有出入口日志 → 一眼判断"有没有进 handler"；② 错误统一成 `{ok:false,error}` → 渲染层能区分"没注册 / 不支持 / 业务失败"；③ 启动打印通道清单 → 与 preload 对账。

### 4.4 `platform/`：平台差异的唯一入口

**`platform/index.js`（归一化 + 选实现 + 能力探测）**

```js
const ALIAS = { openharmony: 'ohos', ohos: 'ohos', win32: 'windows', windows: 'windows' };
const rawPlatform = process.platform;
const name = process.env.APP_PLATFORM || ALIAS[rawPlatform] || rawPlatform;   // APP_PLATFORM 便于开发机联调

let impl = {};
try { impl = require(`./${name}`); }
catch (e) { log.warn(`no platform impl for "${name}" → fallback to generic`); }  // ★ 未知平台不能让应用崩溃

const generic = require('./generic');
const api = merge(generic, impl);        // generic 打底，平台实现覆盖差异（两层浅合并）

function capabilities() {                // 运行时探测，供渲染层做按钮置灰
  const win = BrowserWindow.getAllWindows()[0];
  return {
    platform: name, rawPlatform,
    openPath:  !!shell && typeof shell.openPath === 'function',
    autoStart: typeof app.setLoginItemSettings === 'function',
    taskbarVisible: !!win && typeof win.setSkipTaskbar === 'function',
    flashFrame: !!win && typeof win.flashFrame === 'function',
    jumpList: typeof app.setJumpList === 'function',
  };
}
```

**`platform/generic.js`（通用能力）**：只使用跨平台 API；平台不支持的能力统一抛带 `code='E_UNSUPPORTED'` 的错误。

```js
function unsupported(what) {
  const err = new Error(`${what} is not supported on platform "${process.platform}"`);
  err.code = 'E_UNSUPPORTED';
  return err;
}
module.exports = {
  system: {
    info() { /* platform/arch/osType/cpuCount/totalMemMB/versions */ },
    async openPath(p) { const m = await shell.openPath(p); if (m) throw new Error(m); return true; },
  },
  window: {
    setTaskbarVisible() { throw unsupported('win.setSkipTaskbar'); },   // 由 windows.js 覆盖
    flash() { throw unsupported('win.flashFrame'); },
  },
  app: {
    setAutoStart(enabled) { app.setLoginItemSettings({ openAtLogin: !!enabled }); return app.getLoginItemSettings(); },
    setJumpList() { throw unsupported('app.setJumpList'); },
  },
};
```

**`platform/windows.js`（只写差异）**

```js
module.exports = {
  window: {
    setTaskbarVisible(visible) {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || typeof win.setSkipTaskbar !== 'function') throw unsupported('win.setSkipTaskbar');
      win.setSkipTaskbar(!visible); return true;
    },
    flash(on) { /* win.flashFrame(on) */ },
  },
  app: { setJumpList(items) { /* app.setJumpList(items) */ } },
};
```

**`platform/ohos.js`（鸿蒙差异 + 不支持清单）**

```js
module.exports = {
  unsupportedHere: ['window.setTaskbarVisible', 'window.flash', 'app.setJumpList'],
  // 目前无需覆盖通用实现；鸿蒙专有接口（悬浮窗 windowInfo、系统三键 setWindowButtonVisibility、
  // 角标 app.setBadgeCount 等）按 generic.js 的命名空间结构补在这里即可。
};
```

> **为什么要"generic + 平台覆盖"两层**：新增平台时只写差异；平台实现缺失时自动降级到通用能力，应用不会因为找不到平台文件而起不来。

### 4.5 `ipc/process-manage.js`：业务模块（导出注册函数）

```js
const { CH, handle, on } = require('./register');

module.exports = function register(ctx) {
  const { ipcMain, platform, getMainWindow } = ctx;      // ★ 依赖注入，不 require('./main')

  on(ipcMain, CH.WIN_MINIMIZE, () => getMainWindow()?.minimize());
  on(ipcMain, CH.WIN_MAXIMIZE, () => {
    const win = getMainWindow();
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  on(ipcMain, CH.WIN_CLOSE, () => getMainWindow()?.close());
  handle(ipcMain, CH.WIN_IS_MAXIMIZED, () => !!(getMainWindow() && getMainWindow().isMaximized()));

  handle(ipcMain, CH.APP_INFO, () => platform.system.info());
  handle(ipcMain, CH.APP_CAPABILITIES, () => platform.capabilities());

  handle(ipcMain, CH.SYS_OPEN_PATH, (_e, p) => platform.system.openPath(p));
  handle(ipcMain, CH.SYS_TASKBAR_VISIBLE, (_e, v) => platform.window.setTaskbarVisible(!!v));
  handle(ipcMain, CH.SYS_FLASH_FRAME, (_e, v) => platform.window.flash(!!v));
  handle(ipcMain, CH.SYS_JUMP_LIST, () => platform.app.setJumpList([/* ... */]));
  handle(ipcMain, CH.SYS_AUTO_START, (_e, v) => platform.app.setAutoStart(!!v));
};
```
**对比原来的写法**：没有 `require('./main')`、没有 `process.platform`、没有直接 `ipcMain.handle`。**同一个文件在 Windows 与鸿蒙上行为一致**，差异全在 `platform/`。

### 4.6 `main.js`：只做装配

```js
const log = require('./logger');
const platform = require('./platform');
const ipc = require('./ipc/register');
const registerProcessManage = require('./ipc/process-manage');

// 启动自检（§2.0 的三行日志）
log.info(`boot: platform=${platform.rawPlatform} → ${platform.name} | electron=${process.versions.electron}`);
['./ipc/process-manage', './platform/index'].forEach((m) => {
  try { log.info(`boot: resolve ${m} → ${require.resolve(m)}`); }
  catch (e) { log.error(`boot: module MISSING ${m} (${e.code})：检查打包是否漏文件！`); }
});

function registerModules() {
  registerProcessManage({ ipcMain, platform, log, getMainWindow: () => mainWindow });
  ipc.dumpRegistered();
}

app.whenReady().then(async () => {
  createTray();                 // 1. 托盘最先（鸿蒙：窗口显隐与托盘强绑定）
  registerModules();            // 2. ★ 先注册 IPC，再建窗口
  createWindow();               // 3. 窗口先出来（避免"等后端"期间没有画面）
  const ok = await ensureBackend();
  mainWindow?.webContents.send(ipc.CH.EVT_BACKEND_READY, { ok });
});
```

### 4.7 `preload.js`：契约共用 + 统一拆包

```js
const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('./ipc/channels');            // ★ 与主进程共用契约

async function invoke(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok === true) return r.data;
  const err = new Error((r && r.error && r.error.message) || `IPC ${channel} failed`);
  err.code = (r && r.error && r.error.code) || 'E_IPC';
  throw err;                                          // 渲染层拿到带 code 的错误
}

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send(CH.WIN_MINIMIZE),
  toggleMaximize: () => ipcRenderer.send(CH.WIN_MAXIMIZE),
  close: () => ipcRenderer.send(CH.WIN_CLOSE),
  isMaximized: () => invoke(CH.WIN_IS_MAXIMIZED),
});
contextBridge.exposeInMainWorld('api', {
  info: () => invoke(CH.APP_INFO),
  capabilities: () => invoke(CH.APP_CAPABILITIES),
  openPath: (p) => invoke(CH.SYS_OPEN_PATH, p),
  setTaskbarVisible: (v) => invoke(CH.SYS_TASKBAR_VISIBLE, v),
  flashFrame: (on) => invoke(CH.SYS_FLASH_FRAME, on),
  setJumpList: () => invoke(CH.SYS_JUMP_LIST),
  setAutoStart: (v) => invoke(CH.SYS_AUTO_START, v),
  onBackendReady: (cb) => ipcRenderer.on(CH.EVT_BACKEND_READY, (_e, p) => cb(p)),
});
```

### 4.8 渲染层：能力驱动 UI（不支持的按钮置灰）

```html
<button class="btn" data-cap="taskbarVisible" id="pm-taskbar">隐藏任务栏图标</button>
```
```js
const caps = await window.api.capabilities();
document.querySelectorAll('[data-cap]').forEach((btn) => {
  if (caps[btn.dataset.cap] === false) btn.disabled = true;      // 静态探测：置灰
});
btn.onclick = async () => {
  try { await window.api.setTaskbarVisible(false); }
  catch (e) {
    if (e.code === 'E_UNSUPPORTED') btn.disabled = true;         // 运行期兜底：接口存在但调用失败
    console.warn(e.code, e.message);
  }
};
```
**要点**：**能力以运行时结果为准**。文档表格只作参考——"接口存在但调用即抛错"在跨端移植里很常见，所以静态探测 + 运行期置灰两层都要有。

---

## 5. 迁移步骤：把现有 `process-manage.js` 改造过来

| 步骤 | 动作 | 验收 |
|---|---|---|
| 1 | `main.js` 加 §2.0 三行日志，复现问题并确认根因（A~E 哪一类） | 能说清"是没加载 / 没注册 / 没进 handler" |
| 2 | 新建 `ipc/channels.js`，把工程里所有通道名收进去 | `grep -rn "ipcMain\.\(on\|handle\)" .` 结果中的名字都在 channels 里 |
| 3 | 新建 `ipc/register.js`，把 `wrap/handle/on/dumpRegistered` 落地 | 启动日志能打印通道清单 |
| 4 | 新建 `platform/`，把散落的 `process.platform`/`os.type()` 判断全部搬进 `platform/<name>.js` | `grep -rn "process.platform" app/` 只在 `platform/` 与启动日志里出现 |
| 5 | 把 `process-manage.js` 改成 `module.exports = function register(ctx) {...}`，删掉 `require('./main')`，改用 `ctx.getMainWindow()` 与 `ctx.platform` | 文件内不再出现平台名与 main.js |
| 6 | `main.js` 里一行装配 + 构建期清单校验接入 CI | 打包产物与源码清单一致（§6） |

**改造前后的对比（同一个按钮）**

```js
// ❌ 改造前：Windows 能跑，鸿蒙失效
const { mainWindow } = require('./main');
ipcMain.on('hide-taskbar', () => {
  if (process.platform === 'win32') mainWindow.setSkipTaskbar(true);   // 鸿蒙：条件不成立 + mainWindow 为 undefined
});

// ✅ 改造后：两端同一份代码
module.exports = function register({ ipcMain, platform, getMainWindow }) {
  on(ipcMain, CH.SYS_TASKBAR_VISIBLE, (_e, v) => platform.window.setTaskbarVisible(!!v));
};
```

---

## 6. 构建期防复发：产物清单校验

模板已提供脚本：`project-template/scripts/check-app-manifest.js`

```bash
# 用法：node scripts/check-app-manifest.js <源app目录> <HAP内app目录>
node scripts/check-app-manifest.js \
  app \
  project-template/web_engine/src/main/resources/resfile/resources/app
```

它会做三件事：
1. 递归比对两个目录的相对路径清单 → **缺失/多余**逐条打印；
2. 校验**核心模块清单**（`main.js`、`preload.js`、`ipc/*.js`、`platform/*.js`、`logger.js`）是否齐备；
3. 退出码 `0/1`，可直接接入 CI 或 `prebuild` 脚本：

```jsonc
// package.json
"scripts": {
  "sync:ohos": "cp -r dist/app/* project-template/web_engine/src/main/resources/resfile/resources/app/",
  "check:app":  "node scripts/check-app-manifest.js dist/app project-template/web_engine/src/main/resources/resfile/resources/app",
  "build:ohos": "npm run sync:ohos && npm run check:app"
}
```

> 实测效果（本仓库验证过两条路径）：目录一致 → `✅ 一致`、退出码 0；故意删掉 `ipc/process-manage.js` → `❌ 产物缺失 1 个文件`、退出码 1。

**另外两条**：
- electron-builder 的 `files` 用通配（`"**/*.js"`）而不是逐个列；
- `asar:false`（鸿蒙壳工程需要直接读取 app 目录文件）。

---

## 7. 平台差异速查表（鸿蒙 vs Windows）

**鸿蒙版"支持"的常用能力**（可放心用）

| API | 鸿蒙 | 出处 |
|---|---|---|
| `ipcMain.*` / `ipcRenderer.*` | 支持 | `research/api_index.md:475-494` |
| `session.webRequest`（8 个钩子）、`ses.fetch`、`ses.cookies`、`ses.setCertificateVerifyProc` | 支持 | `:1176-1183`、`:738`、`:779`、`:761` |
| `protocol.registerSchemesAsPrivileged` / `protocol.handle` | 支持 | `:670`、`:658` |
| `app.commandLine.appendSwitch` | 支持 | `:364` |
| `win.maximize` / `setFullScreen` / `setBounds` / `setWindowButtonVisibility` / `setAlwaysOnTop` / `setOpacity` | 支持 | `:231`、`:260`、`:251`、`:296`、`:244`、`:274` |
| `dialog.showMessageBox(Sync)` | 支持 | `:400`、`:401` |
| `app.setBadgeCount`、`app.setLoginItemSettings` | 支持 | `:88`、`:91` |
| `webContents.setWindowOpenHandler`、`app.on('open-url')` | 支持 | `:1094`、`:22` |

**鸿蒙版"不支持"的 API（能力探测/降级对象）**

| API | 鸿蒙 | 出处 | 建议 |
|---|---|---|---|
| `win.setSkipTaskbar` | **不支持** | `:285` | 能力置灰；鸿蒙无对应语义 |
| `win.flashFrame` | **不支持** | `:177` | 改用应用内提醒/通知 |
| `win.setProgressBar` / `setOverlayIcon` / `setThumbarButtons` | **不支持** | `:278`、`:275`、`:286` | 任务栏进度/缩略图按钮类交互需自绘替代 |
| `app.setJumpList` / `app.setUserTasks` / `app.setAppUserModelId` | **不支持** | `:90`、`:97`、`:86` | 跳转列表/任务菜单类功能隐藏 |
| `app.setAsDefaultProtocolClient` / `app.requestSingleInstanceLock` | **不支持** | `:87`、`:79` | 自定义协议改用官方 Deeplink 配置 + `app.on('open-url')` |

> ⚠️ 表格是**文档口径**，会随版本变化；最终以真机运行时探测为准（§8 A-47）。

---

## 8. 实测项（已并入手册附录 A）

| # | 实测项 | 通过标准 |
|---|---|---|
| **A-45** | 独立 JS 模块在 HAP 内的加载：`require.resolve('./ipc/process-manage')` 可解析、模块内 `ipcMain.handle` 生效 | 启动日志打印出 resolve 路径；按钮点击出现 handler 日志 |
| **A-46** | 构建产物清单校验接入（源目录 vs HAP 内 app 目录） | `check-app-manifest.js` 退出码 0；故意删文件时退出码 1 |
| **A-47** | 能力探测与真实可用性是否一致（`setSkipTaskbar` / `flashFrame` / `setJumpList` / `setLoginItemSettings`） | 记录"探测结果 vs 调用结果"，回填本文 §7 |
| **A-48** | `process.platform` 归一化后的分流是否正确（含未知平台兜底到 generic） | 鸿蒙上 `platform.name==='ohos'`；`APP_PLATFORM=windows` 时走 Windows 实现 |

---

## 9. FAQ

**Q1：能不能简单点，就都写在 main.js？**
小工程可以。但只要出现"多个模块 + 平台差异"，main.js 会迅速膨胀，且两端继续分叉；本文的骨架本身就是**为省事**设计的——新增一个按钮只需 4 步：`channels.js` 加常量 → `process-manage.js` 加一行 `handle` → `preload.js` 暴露方法 → 渲染层调用。

**Q2：`platform/ohos.js` 现在是空的，有意义吗？**
有：① 它声明了"本平台已知不支持清单"；② 它给出了后续鸿蒙专有实现的落点；③ 平台名归一化后，鸿蒙走的就是"generic + ohos 覆盖"，Windows 走"generic + windows 覆盖"，业务代码不用改。

**Q3：为什么不直接判断 `process.platform === 'openharmony'`？**
因为该值在官方文档、社区实测之间不一致（`openharmony` / `ohos` / `linux`），且可能随版本变化。归一化 + 别名表 + `APP_PLATFORM` 覆盖，比在业务代码里硬编码平台名稳。

**Q4：能力表查询和运行时探测，到底信哪个？**
以运行时为准，表格用来"提前设计降级"。做法就是 §4.8 的两层：静态探测置灰 + 运行期 `E_UNSUPPORTED` 再置灰。

**Q5：这套改动会不会影响 Windows 侧？**
不会。Windows 上 `platform.name === 'windows'`，走 `windows.js`；业务模块与渲染层代码完全不变。

---

## 10. 附：模板文件清单

| 文件 | 作用 |
|---|---|
| `app/main.js` | 引导与装配（托盘 → 注册 IPC → 建窗 → 等后端 → 广播事件） |
| `app/preload.js` | 契约化安全桥（`window.desktop` / `window.api`） |
| `app/logger.js` | 统一日志出口 |
| `app/ipc/channels.js` | 通道契约常量 |
| `app/ipc/register.js` | 统一注册器（日志 + 错误结构 + 通道清单） |
| `app/ipc/process-manage.js` | 业务模块示例（窗口三键、平台信息、系统交互） |
| `app/platform/index.js` | 平台归一化 + 实现选择 + 能力探测 |
| `app/platform/generic.js` | 跨平台通用实现 |
| `app/platform/windows.js` | Windows 差异实现 |
| `app/platform/ohos.js` | 鸿蒙差异实现（占位 + 不支持清单） |
| `app/renderer/index.html` | 自检页 + **能力驱动 UI** 示例 |
| `scripts/check-app-manifest.js` | 构建期产物清单校验 |

**与其它专项的关系（可选阅读，本文不依赖）**：窗口尺寸/无边框/跨域见《鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md》；启动等待动画见《鸿蒙PC迁移专项_启动闪屏定位与解决方案.md》；语言/i18n 见《鸿蒙PC迁移专项_多语言i18n方案.md》。
