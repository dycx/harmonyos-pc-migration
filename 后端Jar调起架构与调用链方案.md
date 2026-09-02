# 后端 Jar 调起架构与调用链方案（JIT 约束下）

> 核心问题：Electron 模板机制是"前端产物做 resfile 由运行时调起"——那**后端 jar 怎么办**？在沙盒 JIT 限制（不申请权限时应用内子进程无 JIT）下，**前端和后端 jar 应分别如何调起**？整体工程体系和调用链是什么？
> 配套：《鸿蒙PC沙盒JIT与so加载限制解决方案.md》（JIT 机制）、《鸿蒙PC迁移实施手册.md》（总方案）
> 标注：✅ 已核实（模板源码/官方文档）｜🟡 需实测

---

## 0. 核心结论（先看）

1. **前端调起**（模板机制，✅ 已核实）：桌面点击 → ArkTS `EntryAbility` → WebWindow 组件 → `nativeContext.runBrowser(vec_args)`（libadapter.so 的 NAPI）→ **libelectron.so 拉起 Electron 运行时（应用主进程）** → 加载 `resfile/resources/app/main.js` → `main.js` 创建 BrowserWindow 加载你的前端页面。**前端运行在应用主进程，JIT 可用**（上架案例的 Chromium 能正常跑即证明）。
2. **不是两个应用，用户也不用装 JDK**：面向应用市场分发的最终形态 = **单个 HAP 自包含**——前端 + jar + **自包含 JDK（HNP 化，jlink 精简）** 全部打进一个应用（详见 0.1）。终端启动（形态 A）只作为**开发期/内部测试形态**。
3. **上架形态的 JIT 解法 = 申请权限（必要组成部分）**：应用内拉起自包含 JDK 的 java 属于应用子进程（JIT 默认受限），需申请 `ALLOW_WRITABLE_CODE_MEMORY`——该权限**官方明确"仅限平板、PC/2in1 设备应用申请"**，即**专为上架 PC 应用提供的 JIT 通道**（Chromium 上架应用能跑 V8 JIT 即证明通道可用）。**权限申请不是额外负担，而是上架形态的必选项，需在开发早期提交。**
4. **形态 B（一体体验）是上架形态**：jar 随 HAP（resfile/backend/）+ 自包含 HNP JDK，由 main.js spawn；用户无感。开发期用形态 A 快速联调，上架前完成形态 B 化 + 权限获批 + 自测。

---

## 0.1 ⭐ 面向上架应用市场的最终形态（单 HAP 自包含）

```
应用市场分发：用户只安装【一个】应用（你的 HAP），无需安装任何其他东西
┌─────────────────────────────────────────────────────────────┐
│ 你的 HAP（一个应用，一个图标）                                │
│  ├─ electron/libs/arm64-v8a/     运行时 so（libelectron 等） │
│  ├─ web_engine/.../resfile/resources/                       │
│  │   ├─ app/                     前端产物（Electron 加载）   │
│  │   └─ backend/                 app.jar + certs/           │
│  └─ hnp/jdk17/                   自包含 JDK（HNP 化随 HAP）  │
│       └─ bin/java + libjvm.so + lib/（jlink 精简 ~60-100MB） │
│  ★ module.json5 声明 ALLOW_WRITABLE_CODE_MEMORY（JIT 权限）  │
└─────────────────────────────────────────────────────────────┘

用户视角：装 1 个应用 → 点图标 → 前端页面 + 后端服务全部自动运行
         （无需装 JDK、无需装第二个应用、无需终端操作）
```

**自包含 JDK 的关键**（用户无需预装 BiShengJDK17-OH）：
- 用 **jlink** 把 JDK 17（aarch64）精简到 SpringBoot 所需模块（java.base、java.sql、java.naming、java.management、jdk.crypto.ec、jdk.unsupported、jdk.zipfs 等），体积 ~300MB → **~60-100MB**
- 按实施手册 §5 的 HNP 流程打包（hnp/bin/jdk17/bin/java + lib/），随 HAP 安装释放到沙箱
- ✅ 参考先例：应用市场版 **BiShengJDK17-OH 本身就是 HNP 安装 JDK 的应用**——"应用内置 HNP JDK"是官方认可模式（它是安装器形态，你的应用把 JDK 作为运行组件内置，更轻）

**HAP 体积估算**：
| 组件 | 体积 |
|---|---|
| libelectron.so + 配套 | ~170MB |
| jlink 精简 JDK 17 | ~60-100MB |
| SpringBoot fat-jar | 40-80MB |
| 前端产物 + 资源 | 10-100MB |
| **合计** | **~300-400MB** |
⚠️ 上架前确认 AGC/应用市场的包体限制与上传方式（大包通常分片上传；若单包受限，评估再压缩 JDK/jar 或咨询审核）。

---

## 1. 模板运行机制全链路（前端是怎么被调起的，✅ 模板源码核实）

```
用户点击桌面图标
  │
  ▼
EntryAbility.ets（electron 模块，ArkTS）
  onWindowStageCreate(windowStage)
  │   加载页面 Index.ets（含 WebWindow 组件）
  ▼
WebWindow.ets（web_engine 模块，ArkTS）
  buildArgs() 构造 vec_args：
    ['--bundle-installation-dir=' + getContext().resourceDir, ...electronRelaunchArgs]
    // resourceDir = 应用资源目录（沙箱内 resfile 释放位置）
  config.nativeContext.runBrowser(vec_args)
  │   // nativeContext = JsBindingUtils.getNativeContext(kMainProcess)
  │   // 即 libadapter.so 注册的 NAPI 对象（C++ adapter 层）
  ▼
libadapter.so → libelectron.so（Chromium + Node.js 运行时拉起）
  │   这是【应用主进程】——由 ArkTS Ability 启动链直接拉起（非 fork 子进程）
  │   ✅ 上架案例证明该进程 JIT 可用（Chromium V8 正常运行）
  ▼
Electron 运行时加载主进程入口：
  /data/storage/el1/bundle/entry/resources/resfile/resources/app/main.js
  │   // __dirname 即 app 产物目录（沙箱内）
  │   // 你的 main.js 在这里执行：创建 Tray、BrowserWindow、加载 renderer
  ▼
mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'))
  → 你的前端页面运行（渲染层）
```

**关键结论**：
- 前端产物（asar:false 拆包的 app 目录）→ `resfile/resources/app/` → **随 HAP 安装、由主进程加载**，这一环你不需要改任何机制，只替换 app 目录内容。
- `main.js` 就是你原 Electron 工程的主进程入口（可保留原逻辑 + 按模板约束适配：先建托盘等）。

---

## 2. 工程体系全景（三个工程 + 一个壳）

```
┌─────────────────────────────────────────────────────────────┐
│ ① 原始 Electron 工程（VSCode/WebStorm，Windows 侧保留）       │
│    产物：electron-builder 打包（asar:false）→ app 拆包目录     │
│    动作：产物拷贝 → 壳工程 resfile/resources/app/             │
├─────────────────────────────────────────────────────────────┤
│ ② 后端 Maven 工程（IDEA，与鸿蒙无关）                        │
│    产物：app.jar（SpringBoot fat-jar）                       │
│    动作（二选一）：                                          │
│    A. 部署鸿蒙 PC 用户目录（不进 HAP）★推荐                   │
│    B. 拷贝 → 壳工程 resfile/resources/backend/（进 HAP）     │
├─────────────────────────────────────────────────────────────┤
│ ③ DevEco 壳工程（模板导入，唯一参与 HAP 打包的工程）           │
│    AppScope/           应用配置                               │
│    electron/           ArkTS 入口 + libs/arm64-v8a（运行时 so）│
│    web_engine/         Web 引擎 + resfile 资源                │
│      └─ resfile/resources/                                   │
│           ├─ app/         ← ① 前端产物（必需）               │
│           └─ backend/     ← ②B 后端 jar（可选，形态 B）       │
│    产物：electron-default-unsigned.hap → 签名 → hdc install   │
├─────────────────────────────────────────────────────────────┤
│ ④（可选）C++ 工具工程 → HNP 包 → 随 HAP 或独立（实施手册 §5） │
└─────────────────────────────────────────────────────────────┘
```

**HAP 安装后的沙箱布局（形态 B 示意）**：
```
/data/storage/el1/bundle/<bundleName>/entry/resources/resfile/resources/
├── app/            ← Electron 主进程加载（__dirname 指向这里）
│   ├── main.js
│   ├── package.json
│   └── renderer/
└── backend/        ← 形态 B：jar 所在（沙盒内，仅沙盒内进程可读）
    ├── app.jar
    └── certs/
```

---

## 3. 后端 jar 的调起方式与调用链

> **形态定位（重要）**：**形态 A = 开发期/内部测试形态**（快速联调，免权限）；**形态 B = 上架形态**（单 HAP 自包含，需权限，见 0.1）。开发期用 A 跑通业务，上架前完成 B 化。

### 形态 A：终端启动（开发期/内部测试，JIT 零门槛）

```
鸿蒙 PC 用户目录
  └── backend/app.jar        ← 部署位置（终端可见；不进 HAP）

鸿蒙 PC 终端（开发者终端/系统终端）：
  java -jar /.../backend/app.jar --server.port=8080
    → JVM 进程 = 命令执行器直接启动 → ✅ JIT 可用（无需申请权限）
    → 监听 127.0.0.1:8080（沙盒外进程）

Electron 应用（沙盒内）启动时：
  main.js:
    probeBackend() → TCP 探测 127.0.0.1:8080
      ├─ 已就绪 → 正常创建窗口
      └─ 未就绪 → dialog 提示：
           "后端未启动，请在终端执行：java -jar .../app.jar"
         （或应用内按钮引导；不 spawn JVM——避免子进程 JIT 问题）
  渲染层请求 http://app.mycorp.local:8080
    → main.js webRequest 重定向 → 127.0.0.1:8080 → 后端响应
```

**要点**：
- jar **不进 HAP**（HAP 内文件在沙盒内，沙盒外终端进程读不到——应用沙盒与终端用户目录隔离）
- 部署方式：开发期用 hdc/文件管理器拷贝到用户目录
- ⚠️ **此形态仅限开发/内部/企业自用**：要求用户装 JDK + 手动起后端，**不适合应用市场上架分发**
- ⚠️ 未知点：**沙盒内 Electron ↔ 沙盒外终端进程的网络互访（127.0.0.1）是否通**——见第 6 章实测项（不通则形态 A 连开发联调都不可用，直接以形态 B 为开发目标）

### 形态 B：HAP 内 jar + 自包含 HNP JDK 拉起（上架形态，需 JIT 权限）

```
Electron 主进程 main.js（沙盒内，应用主进程）：
  app.whenReady() →
    probeBackend() 未就绪 →
    spawn('<沙箱>/hnp/jdk17/bin/java',      // 自包含 JDK（jlink 精简 + HNP，随 HAP）
          ['-jar', __dirname + '/../backend/app.jar', '--server.port=8080'])
      → JVM = 应用 fork 的子进程 → ❌ JIT 默认被禁
      → 必须：module.json5 声明 + ACL 申请 ALLOW_WRITABLE_CODE_MEMORY
              （获批后 JIT 可用——上架形态的必要组成部分，见 0.1）
      → 兜底：-Xint 解释执行（能跑、性能降 5-10 倍，仅调试/权限未批时临时用）
```

**要点**：
- jar 放 `resfile/resources/backend/app.jar`；JDK 自包含放 `hnp/jdk17/`（用户无需装 BiShengJDK17-OH）
- 子进程与主进程同沙盒 → **回环互访（127.0.0.1）大概率通**（同一沙盒内 loopback——这是形态 B 相对 A 的优势，但仍需实测）
- 若 sqlite-jdbc 的 so 需要：随 HAP 放 `libs/arm64-v8a/`（应用签名内，见《沙盒JIT与so加载限制解决方案》§5）

### 形态 C：融合开发引擎（openEuler 子系统）

```
引擎内：java -jar /root/backend/app.jar（Linux 进程，无鸿蒙沙盒限制，JIT 可用）
前端访问：http://<引擎IP>:8080（NAT 网络，IP 不固定 🟡）
```
适用：需要 JDK21 或形态 B 网络不通时的退路（IP 漂移是痛点，且引擎非常驻，不适合用户分发，仅技术兜底）。

---

## 4. 决策矩阵（按"是否上架"分场景）

| 场景 | 形态 | JIT | 所需条件 | 说明 |
|---|---|---|---|---|
| **开发/联调期** | A（终端启动） | ✅ | 无 | 快速迭代业务，不管分发 |
| **上架（推荐主形态）** | B（自包含 HAP） | ✅ | 申请 `ALLOW_WRITABLE_CODE_MEMORY` | 单应用一体体验（0.1）；**权限为上架必选项，尽早申请** |
| 上架但权限未批（临时） | B'（-Xint） | 禁用 | 无 | 仅自测/灰度，性能差 |
| 需要 JDK21 | C（融合开发引擎） | ✅ | 引擎运行 | 用户需另开引擎，不适合大众分发 |

**推荐演进路径**：
```
第 1 阶段（本周）：形态 A 联调，跑通全部业务功能（验证 N-1 沙盒内外互访）
第 2 阶段（并行，立即发起）：申请 ALLOW_WRITABLE_CODE_MEMORY
   —— 上架形态的必经审批，周期不可控，越早越好
第 3 阶段（申请期间）：完成形态 B 工程改造
   —— jlink 精简 JDK + HNP 打包 + main.js spawn 逻辑 + jar 入 HAP
第 4 阶段（获批后）：形态 B 全量自测（JIT 生效验证、性能、稳定性）
第 5 阶段：上架（此时是单 HAP，用户零额外安装）
```

---

## 5. 完整调用链（上架形态 B 为最终目标，端到端时序）

```
[启动时序 —— 形态 B（上架版，权限获批后）]
1. 用户点击应用图标
2. EntryAbility（ArkTS）onWindowStageCreate
3. WebWindow.ets → runBrowser(vec_args)   [主进程拉起，JIT ✅]
4. libelectron.so → Electron 加载 app/main.js
5. main.js：
   a. 创建 Tray（模板约束：先建托盘）
   b. probeBackend() 探测 127.0.0.1:8080
   c. 未就绪 → spawn 自包含 JDK：<沙箱>/hnp/jdk17/bin/java -jar <沙箱>/.../backend/app.jar
      （权限已获批 → JIT ✅；轮询等待就绪，最长 30-60s）
   d. 创建 BrowserWindow → loadFile renderer/index.html
6. 渲染层（前端页面）登录/业务请求
   → baseURL: http://app.mycorp.local:8080/api
   → main.js webRequest.onBeforeRequest 重定向 → http://127.0.0.1:8080/api
   → 后端响应（同沙盒内 JVM 子进程，JIT ✅（权限））

[运行期依赖关系 —— 上架形态]
┌─────────────┐   HTTP(重定向)   ┌──────────────────┐
│ 渲染层(前端) │ ───────────────▶ │ Electron 主进程   │
└─────────────┘                  │ (webRequest 改写) │
        ▲                        └────────┬─────────┘
        │ loadFile                        │ HTTP 127.0.0.1:8080
        │                                 ▼
┌─────────────┐                  ┌───────────────────────────┐
│ app/main.js │◀──runBrowser────│ ArkTS 壳 + native           │
└─────────────┘                  └───────────────────────────┘
        │ spawn（同沙盒子进程）            │
        ▼                                 │
┌────────────────────────────┐            │
│ 自包含 JDK（HNP）           │            │
│  └─ java -jar backend/app.jar          │
│     SpringBoot:8080（JIT ✅ 需权限）    │
└────────────────────────────┘            │
        全程单 HAP、用户零额外安装          │
[开发期对照]：第 5 步 c 改为"提示终端启动"（形态 A，JIT 免权限），
  依赖关系图中 JVM 盒子替换为"终端启动的 JVM（沙盒外）"。
```

---

## 6. 需要实测的关键点（按优先级）

| # | 实测项 | 影响 | 对应形态 |
|---|---|---|---|
| N-1 | **沙盒内 Electron ↔ 沙盒外终端 JVM 的 127.0.0.1 互访** | 形态 A 成立与否（最大未知点） | A |
| N-2 | 应用能否拉起系统终端并传命令（Want 拉起终端 App） | 形态 A 的"引导启动"体验 | A |
| N-3 | HNP JDK 由应用 spawn 的完整链路（XPM/路径/启动） | 形态 B 基础 | B |
| N-4 | 形态 B 下同沙盒回环互访 | 形态 B 网络 | B |
| N-5 | `ALLOW_WRITABLE_CODE_MEMORY` 申请结果 + 授权后 JVM JIT 生效 | 形态 B 升级条件 | B |
| N-6 | jlink 精简 JDK 在鸿蒙运行（模块裁剪是否影响 SpringBoot） | 形态 B 体积 | B |
| N-6 | 终端 java 进程读取"用户目录 jar"与日志写入位置 | 形态 A 部署细节 | A |

---

## 7. main.js 骨架（形态 A + 预留形态 B 开关）

```javascript
// app/main.js —— 鸿蒙版主进程入口（基于模板适配）
const { app, BrowserWindow, Tray, dialog } = require('electron');
const net = require('net');
const path = require('path');

const BACKEND_PORT = 8080;
const BACKEND_HOST = '127.0.0.1';
const USE_EMBEDDED_BACKEND = false;   // 形态 B 开关（权限获批后改 true）

function probeBackend(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
    s.connect(BACKEND_PORT, BACKEND_HOST);
  });
}

async function ensureBackend() {
  if (await probeBackend()) return;
  if (USE_EMBEDDED_BACKEND) {
    // 形态 B：spawn HNP JDK（需权限；无权限时加 -Xint）
    // const { spawn } = require('child_process');
    // const child = spawn('/data/app/<bundle>/jdk_1.0/bin/java',
    //   ['-jar', path.join(__dirname, '../backend/app.jar')], { stdio: 'ignore' });
    // 等待就绪（轮询 30s）...
  } else {
    // 形态 A：提示用户终端启动（不 spawn，规避子进程 JIT 限制）
    dialog.showMessageBox({
      type: 'info',
      title: '后端服务未启动',
      message: '请先在鸿蒙终端执行：\njava -jar <部署路径>/app.jar --server.port=8080',
      buttons: ['重试', '退出']
    }).then(async ({ response }) => {
      if (response === 0) {
        if (await probeBackend(2000)) { /* 就绪后刷新页面 */ }
      } else { app.quit(); }
    });
  }
}

function setupDomainRedirect() { /* webRequest 域名映射（实施手册 3.5）*/ }

app.whenReady().then(async () => {
  const tray = new Tray(path.join(__dirname, 'tray_icon.png'));  // 模板约束：先建托盘
  await ensureBackend();
  const win = new BrowserWindow({ width: 1280, height: 800 });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  setupDomainRedirect();
});
```

---

## 8. 结论一句话

**前端**走模板机制（resfile/app + runBrowser，应用主进程，JIT 无问题，零改动思路）；**后端 jar** 在 JIT 约束下**优先形态 A（独立部署 + 终端启动，沙盒外 JIT 可用，Electron 只探测和引导，不 spawn）**；想要自动拉起的一体体验，就去申请 `ALLOW_WRITABLE_CODE_MEMORY` 后升级形态 B。工程体系 = "原始 Electron 工程（出前端产物）+ Maven 工程（出 jar）+ DevEco 壳工程（组 HAP）"三方协作，N-1（沙盒内外回环互访）是必须先验证的地基。
