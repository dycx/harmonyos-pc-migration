# HarmonyOS PC 迁移专项方案：JVM 后端部署、域名映射、网络打点、沙箱与证书

> 适用对象：Windows Electron 应用迁移至鸿蒙 PC（JDK17 + SpringBoot 后端 + C++ 工具）
> 配套文档：`鸿蒙PC迁移方案_Electron_SpringBoot_CPP.md`（总方案）、`DevEcoStudio工程配置文件详解.md`（配置）、`鸿蒙PC开发基础文档.md`（概念）
> 标注约定：✅ 有依据（官方/素材核实）｜🟡 需实测｜⚠️ 风险点

---

## 0. 目标架构（本专项的最终形态）

```
鸿蒙 PC（HarmonyOS 6.0+，ARM64）
├── HAP 应用（Electron 鸿蒙版壳工程）
│     ├── Chromium 渲染层：前端页面（baseURL 用固定域名，如 https://app.mycorp.local）
│     ├── Electron 主进程：
│     │     ├── 启动逻辑：探测后端端口 → 未就绪则拉起 JVM（或提示）
│     │     ├── 域名映射：webRequest.onBeforeRequest 把 app.mycorp.local → 127.0.0.1:8080
│     │     └── 网络打点：TCP 探测 / ping 封装
│     └── 应用沙箱（/data/storage/el2/base/...）
│
├── JVM + SpringBoot 后端（JDK17，监听固定端口如 8080）
│     ├── 形态 A：终端 java -jar（沙箱外，最稳）★推荐 MVP
│     ├── 形态 B：HNP JDK 由应用拉起（应用沙箱内，一体体验）
│     └── 形态 C：融合开发引擎 openEuler 内（可 JDK21）
│
└── 远程服务端（公司服务器/云）
      ├── TLS/mTLS 加密通信（证书：keystore/truststore，keytool 管理）
      └── 网络可达性：打点探测
```

---

## 1. JVM 启动 SpringBoot 后台服务：jar 放置、打包、启动逻辑

### 1.1 jar 包放置位置（三种形态，按推荐序）

| 形态 | jar 位置 | 启动方式 | 沙箱归属 | 适用 |
|---|---|---|---|---|
| **A. 独立进程（推荐 MVP）** | **不在 HAP 内**；部署到鸿蒙 PC 任意目录（如 `/data/storage/el2/base/files/backend/app.jar` 或用户目录），由终端/启动脚本 `java -jar` 启动 | 终端手动启动 / 桌面快捷脚本 | **沙箱外**（终端进程），网络与文件访问最宽松 | 迁移初期、先跑通 |
| **B. HAP 内资源 + HNP JDK 拉起（体验最优）** | `web_engine/src/main/resources/resfile/resources/backend/app.jar`（随 HAP 打包，装到沙箱 `resources/resfile/resources/backend/`） | Electron 主进程探测端口未就绪 → spawn HNP 化 JDK 的 java | **应用沙箱内**（进程归应用所有，文件限沙箱、网络受应用权限） | 后期体验优化（需 PoC） |
| **C. 融合开发引擎（可 JDK21）** | 引擎内任意目录（如 `/root/backend/app.jar`） | 引擎内 `java -jar`（手动拉起，无 systemctl） | **Linux 子系统内**（独立于鸿蒙沙箱） | 需要 JDK21 或后端要跑 Linux 服务 |

**形态 B 的 HAP 内目录结构（jar 与前端产物并列）：**
```
web_engine/src/main/resources/resfile/resources/
├── app/                      # Electron 前端产物（迁移方案 6.6.2）
│   ├── main.js
│   ├── package.json          # 删除 devDependencies
│   └── ...（渲染层资源）
└── backend/                  # ★新增：后端资源目录
    ├── app.jar               # SpringBoot fat-jar
    └── certs/                # ★证书目录（见第 5 章）
        ├── client.p12        # 客户端密钥库（mTLS）
        └── truststore.jks    # 信任库（服务端 CA）
```

### 1.2 打包方式

**后端打包（开发机完成，与鸿蒙无关）：**
```bash
# 开发机（Windows/Mac/Linux）上，Maven 打包 fat-jar：
mvn clean package -DskipTests
# 产物：target/app.jar（SpringBoot 内嵌 Tomcat 的 fat-jar，含全部依赖）

# 可选：把配置文件外置（便于鸿蒙端调整端口/证书路径），spring.config.location 指向沙箱目录
```

**HAP 打包（形态 B）：**
```bash
# 1) 把 app.jar + certs/ 复制到：
#    web_engine/src/main/resources/resfile/resources/backend/
# 2) DevEco Studio → Build → Build Hap(s) → 生成 electron-default-unsigned.hap
# 3) 签名后 hdc app install（resfile 内容会随 HAP 安装释放到应用沙箱：
#    /data/storage/el1/bundle/entry/resources/resfile/resources/backend/）
```

**⚠️ HAP 体积注意**：fat-jar（SpringBoot 通常 40~80MB）+ libelectron.so（160MB）→ HAP 可能 250MB+，属正常；若 HAP 有体积限制可改形态 A（jar 独立部署）。

### 1.3 启动逻辑写在哪里

**形态 B 的推荐位置：Electron 主进程 `main.js`**（主进程有 child_process 能力，且能访问 resfile 资源路径）：

```javascript
// main.js —— 后端启动逻辑（形态 B：HAP 内 jar + HNP JDK 拉起）
const { app, BrowserWindow, Tray } = require('electron');
const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');

const BACKEND_PORT = 8080;                 // 固定端口（与 SpringBoot 配置一致）
const BACKEND_HOST = '127.0.0.1';
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

// 探测后端是否已监听
function probeBackend(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
    socket.connect(BACKEND_PORT, BACKEND_HOST);
  });
}

// 启动后端（HNP 化的 java 二进制路径，见迁移方案第 5 章 HNP 流程）
function startBackend() {
  // ⚠️ 路径二选一（官方 HNP 指南）：软链 /data/app/bin/java（调试可用）
  //     或沙箱物理路径 /data/app/<bundleName>/jdk_1.0/bin/java（上架推荐）
  const javaBin = '/data/app/bin/java';
  // fat-jar 的沙箱路径（resfile 释放位置，装包后以实际为准）
  const jarPath = path.join(process.resourcesPath || '', 'resources/backend/app.jar');
  const child = spawn(javaBin, ['-jar', jarPath,
    '--server.port=' + BACKEND_PORT,
    // 证书参数（第 5 章）：
    // '-Djavax.net.ssl.trustStore=' + path.join(jarDir, 'certs/truststore.jks'),
    // '-Djavax.net.ssl.trustStorePassword=changeit',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => console.log('[backend]', d.toString()));
  child.stderr.on('data', d => console.error('[backend]', d.toString()));
  return child;
}

app.whenReady().then(async () => {
  // 1. 先建托盘（官方要求：窗口显示/隐藏与托盘强绑定）
  // const tray = new Tray(path.join(__dirname, 'tray_icon.png'));
  // 2. 探测后端，未就绪则拉起
  const ready = await probeBackend();
  if (!ready) {
    console.log('[backend] 未启动，尝试拉起 JVM...');
    try { startBackend(); } catch (e) { console.error('[backend] 拉起失败', e); }
    // 等待就绪（轮询，最多 30s；JVM 启动慢）
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await probeBackend()) break;
    }
  }
  // 3. 创建主窗口
  const win = new BrowserWindow({ width: 1280, height: 800 });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  // 4. 域名映射注册（见第 2 章）
  setupDomainRedirect();
});
```

**形态 A（终端启动）的启动逻辑**：Electron 主进程只做**探测 + 提示**，不拉起（避免沙箱外进程管理复杂度）：

```javascript
app.whenReady().then(async () => {
  const ready = await probeBackend();
  if (!ready) {
    // dialog 提示用户：请先启动后端
    // （可在应用内给出一键启动脚本说明，或引导到终端执行：
    //   java -jar /data/storage/el2/base/files/backend/app.jar --server.port=8080）
  }
  // ... 创建窗口、注册域名映射
});
```

### 1.4 SpringBoot 端口与绑定配置

```yaml
# application.yml（后端）
server:
  port: 8080                    # 固定端口（与前端/域名映射一致）
  address: 127.0.0.1            # ⚠️ 形态 A（沙箱外）：绑 127.0.0.1 只允许本机回环访问（安全）
                                # ⚠️ 形态 B（沙箱内）：若沙箱网络隔离导致回环互访失败，
                                #     改绑 0.0.0.0 后仍无法访问则需调整架构（见 4.5 实测点）
  servlet:
    context-path: /api          # 建议统一前缀，便于域名映射与前端配置
```

⚠️ **绑定地址与"固定端口被占用"**：若 8080 被其他应用占用，启动失败；建议后端支持 `--server.port` 覆盖（代码里已示范），或启动前探测端口占用。

---

## 2. localhost → 特定域名映射

### 2.1 需求场景

前端页面与后端通信时，出于**登录域/Cookie 作用域/OAuth 回调**等原因，需要把访问地址从 `http://localhost:8080` 变成固定域名（如 `http://app.mycorp.local:8080` 或 `https://app.mycorp.local`），且域名要"映射回"本机后端。

### 2.2 方案对比

| 方案 | 做法 | 可行性 | 评价 |
|---|---|---|---|
| **A. 修改系统 hosts** | 鸿蒙 PC 的 `/etc/hosts` 加 `127.0.0.1 app.mycorp.local` | 🔴 受限：沙箱内应用无权限改系统 hosts；需 root/系统级操作，普通应用不可行；融合开发引擎（Linux 子系统）内可改但只影响子系统 | 不推荐作为主方案 |
| **B. Electron webRequest 重定向（推荐）** | 主进程 `session.webRequest.onBeforeRequest` 把 `app.mycorp.local` 的请求改写为 `127.0.0.1:8080` | ✅ **官方 API 索引确认支持**（`webRequest.onBeforeRequest` 标注"支持"） | **主方案**：前端代码无需感知域名改写，后端照常监听 8080 |
| **C. 本地反向代理** | 应用内起一个 Node http-proxy 监听 80/443，域名 → 127.0.0.1:8080 | 🟡 可行但重：要多跑一个 Node 服务；80/443 端口在沙箱内监听未知 | 备选 |
| **D. ArkWeb 拦截（原生路线）** | ArkWeb 的 `onInterceptRequest`/`WebResourceHandler` 把域名请求映射到本地 | ✅ 原生路线可用（ArkWeb 请求拦截），但仅限非 Electron 壳 | 备选（若弃用 Electron） |
| **E. 前端配置层解决** | 前端所有请求的 baseURL 直接用 `http://127.0.0.1:8080`，域名仅用于 Cookie 域设置 | 🟡 部分场景可行（Cookie 域通过后端 Set-Cookie Domain 参数），但"域名"诉求若涉及页面地址则不行 | 辅助 |

### 2.3 推荐方案 B 详细配置（webRequest.onBeforeRequest）

```javascript
// main.js —— 域名映射（方案 B）
const { session } = require('electron');

const VIRTUAL_DOMAIN = 'app.mycorp.local';   // 前端使用的固定域名
const BACKEND_TARGET = 'http://127.0.0.1:8080';  // 实际后端

function setupDomainRedirect() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: ['*://' + VIRTUAL_DOMAIN + '/*'] }, (details, callback) => {
    // 把 app.mycorp.local 的请求重写到本机后端
    const url = new URL(details.url);
    const newUrl = BACKEND_TARGET + url.pathname + url.search;
    console.log('[redirect]', details.url, '->', newUrl);
    callback({ redirectURL: newUrl });
  });
  // 可选：把该域名的响应 CORS 头补全（若前端有跨域校验）
  ses.webRequest.onHeadersReceived({ urls: ['*://' + VIRTUAL_DOMAIN + '/*'] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });
}
```

**前端侧配置**（渲染进程/构建配置）：
```javascript
// 前端请求统一走固定域名（fetch/axios baseURL）
const API_BASE = 'http://app.mycorp.local:8080/api';   // 端口可省略（映射到 8080 时）
// 或配合 context-path 后：const API_BASE = 'http://app.mycorp.local/api';
```

**后端侧确认**（无需改代码，但注意）：
- 后端响应 Cookie 时若需要固定域：`Set-Cookie: sessionId=xxx; Domain=mycorp.local; Path=/`（Java 侧 `response.addHeader` 或 Spring 配置）
- 若后端校验 `Host` 头（少见），需允许 `app.mycorp.local`（webRequest 重定向会保留 Host 头为原域名，后端一般忽略）

⚠️ **需实测**：webRequest 重定向在鸿蒙版上的实际行为（官方标注 API 支持，但跨沙箱/回环请求的实际可达性受第 4.5 节端口互访影响）。

### 2.4 HTTPS 域名（可选进阶）

若要求 `https://app.mycorp.local`（前端页面本身用 https），两种做法：
1. **应用内生成/内置自签证书** + `session.setCertificateVerifyProc` 放行该证书（API 索引标注**支持**，见 5.4）——前端页面地址 https、请求 https，重定向到后端 http。
2. 保持页面 http，仅后端通信 http（内网本机场景一般可接受；注意明文 HTTP 需 `cleartextTraffic` 配置，见 4.3）。

---

## 3. 网络情况打点（ping 的鸿蒙替代）

### 3.1 Windows 现状

Windows 上通常 `ping <目标IP/域名>`（ICMP）判断网络可达，或 `ping -n 1` 探测后打点。

### 3.2 鸿蒙 PC 上的实现（三级方案）

**① 首选：Node TCP/HTTP 探测（跨平台、不依赖 ICMP、权限要求低）** —— Electron 主进程内：

```javascript
// net-probe.js —— 通用网络打点（推荐）
const net = require('net');
const http = require('http');

// TCP 端口探测（判断"到目标主机某端口可达"，最贴近业务）
function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ ok: true, latency: Date.now() - t0 }); });
    socket.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.code }); });
    const t0 = Date.now();
    socket.connect(port, host);
  });
}

// HTTP 探测（判断服务是否响应，可带路径/超时）
function httpProbe(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code }));
  });
}

// 打点示例：探测远程服务端（与第 5 章证书通信的服务）
async function networkProbe() {
  const remote = await tcpProbe('server.mycorp.com', 443);
  const backend = await tcpProbe('127.0.0.1', 8080);
  console.log('[probe] remote:', remote, 'backend:', backend);
  // 上报打点：写入本地日志文件（沙箱 files 目录）或上报远程
}
```

**② 备选：`exec('ping ...')`**（若鸿蒙内核提供 ping 命令）：
```javascript
const { exec } = require('child_process');
function pingProbe(host, callback) {
  // ⚠️ 鸿蒙内核命令集与 Linux/Windows 不同（调研素材确认 exec 可用、命令集是鸿蒙内核命令）
  // 先确认 ping 存在：exec('which ping', ...)；
  exec(`ping -c 1 -W 2 ${host}`, (err, stdout) => {
    callback({ ok: !err, output: stdout });
  });
}
```
🟡 **需实测**：鸿蒙 PC 终端/沙箱内是否有 `ping` 命令、ICMP 是否被沙箱允许（ICMP 需要 raw socket，沙箱应用大概率受限）。**实测前先用方案 ① 兜底**。

**③ 原生侧：@kit.NetworkKit 网络状态检测**（判断"有没有网"，不判断"目标可达"）：
```typescript
// ArkTS（若在壳工程 ArkTS 侧打点）
import { connection } from '@kit.NetworkKit';
const netHandle = await connection.getDefaultNet();
const caps = await connection.getNetCapabilities(netHandle);
// caps.bearerTypes 判断网络类型（WIFI/蜂窝/以太网）
// 配合 TCP/HTTP 探测使用：网络状态 + 目标可达性 = 完整打点
```

**组合建议**：打点逻辑 = `@kit.NetworkKit`（有无网络）+ Electron 主进程 `tcpProbe`（目标可达、延迟）+ 本地文件/远程上报（落点）。全部封装在 Electron 主进程的 `network-probe.js` 模块，替换 Windows 的 ping 调用点。

---

## 4. Electron 与 Java 的沙箱模型：网络与文件系统配置

### 4.1 事实基础（调研素材核实）

| 项 | Electron（HAP 应用） | Java 进程 |
|---|---|---|
| **沙箱** | ✅ 运行在**应用沙箱**（mnt/pid namespace + SELinux/seccomp）；文件仅限 `/data/storage/el1\|el2/...` 映射目录（《可行性报告》§2） | **取决于启动方式**：终端启动 → 沙箱外（终端进程上下文）；HNP 由应用拉起 → **应用沙箱内**；融合开发引擎 → Linux 子系统内 |
| **网络** | 需 `ohos.permission.INTERNET`；明文 HTTP 需显式配置（4.3） | 终端/子系统内：网络宽松；沙箱内：随应用权限 |
| **文件系统** | 沙箱目录：`el2/base/files`（Electron `userData` 默认）、`el2/base/database`、`el2/base/cache`；公共目录（下载/文档/桌面）需 ACL 权限 + FILE_ACCESS_PERSIST + 用户授权 | 终端：可访问用户区；沙箱内：同应用沙箱 |
| **端口监听** | ⚠️ 应用沙箱内监听端口的行为**无公开结论**（最大不确定点） | 终端：可正常监听；沙箱内：待实测 |
| **可执行二进制** | XPM 管控：应用内 exec/spawn 必须 HNP 签名（迁移方案 §5） | JDK 需 HNP 化才能在应用内被拉起（BiShengJDK17-OH 本身就是 HNP 安装，见 4.4） |

### 4.2 网络访问配置清单

```json5
// web_engine/src/main/module.json5（或 electron 模块）—— 权限声明
"requestPermissions": [
  { "name": "ohos.permission.INTERNET" },                    // ✅ 网络基础权限
  { "name": "ohos.permission.GET_NETWORK_INFO" },            // 获取网络信息（打点用）
  { "name": "ohos.permission.RUNNING_LOCK" }                 // 后台持续运行
]
```
```json5
// AppScope/app.json5 —— 明文 HTTP（本机 http://127.0.0.1:8080 属于明文，必须显式放行）
{
  "app": {
    "bundleName": "com.yourcompany.yourapp",
    // API 10~22：
    "network": { "cleartextTraffic": true }
    // API 23+：改用 src/main/resources/base/profile/network_config.json（见《配置详解》§3.6）
  }
}
```
```json5
// network_config.json（API 23+，按域控制明文）
{
  "cleartextTrafficPermitted": false,
  "domains": [
    { "domain": "127.0.0.1", "cleartextTrafficPermitted": true },
    { "domain": "app.mycorp.local", "cleartextTrafficPermitted": true }
  ]
}
```
⚠️ 生产建议：远程服务端通信一律 HTTPS（第 5 章）；仅本机回环/虚拟域名允许明文。

### 4.3 文件系统访问配置

```bash
# 应用沙箱内路径（Electron 与 HNP 拉起的 Java 共享）
/data/storage/el2/base/files/          # 用户数据（Electron userData 默认映射，Java 写日志/打点也放这里）
/data/storage/el2/base/database/       # 数据库文件
/data/storage/el2/base/cache/          # 缓存
# 应用代码里取路径：Electron 用 app.getPath('userData')；Java 用环境变量/启动参数传入
```

**Java 侧获取沙箱路径**：形态 B 下 JVM 由应用拉起，工作目录/用户目录是沙箱内路径；建议启动参数显式指定：
```bash
java -jar app.jar \
  --app.data-dir=/data/storage/el2/base/files \
  --logging.file.path=/data/storage/el2/base/files/logs
```

**访问公共目录（下载/文档/桌面）**（若后端或前端需要）：
```json5
// ACL 权限（需邮件向华为申请，未获批先注释）+ 运行时授权
{ "name": "ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY",
  "reason": "$string:reason_documents",
  "usedScene": { "abilities": ["EntryAbility"], "when": "always" } }
```
Electron 侧再调 `systemPreferences.requestDirectoryPermission('documents')` 触发用户授权。

### 4.4 JDK 的 HNP 化（形态 B 关键）

- **事实**：`BiShengJDK17-OH`（应用市场版）本身就是通过 **HNP 机制安装**的公网 JDK 工具链（《Java后端调研报告》：BiShengJDKInstaller 项目 hnp 目录）；openEuler Linux 版毕昇 JDK 支持 8/11/17/21。
- **应用内拉起 JDK 的两条路**：
  1. **复用系统安装的 BiShengJDK17-OH**：终端里 `java` 全局可用；但应用沙箱内 spawn 系统级 java 是否被 XPM 放行 🟡 需实测（系统签名 vs 应用签名）。
  2. **自带 JDK 打 HNP 包**：把 JDK17（aarch64）按迁移方案 §5.3 的 HNP 流程打包（hnp/bin/jdk/bin/java + libjvm.so + lib/ 全部），随 HAP 安装释放；Electron spawn `/data/app/<bundleName>/jdk_1.0/bin/java`。体积大（JDK ~300MB），但可控、签名闭环。

### 4.5 端口互访的实测点与应对（本项目最大不确定点）

| 场景 | 是否可行 | 依据/应对 |
|---|---|---|
| 形态 A：Electron（沙箱）→ 127.0.0.1:8080（终端进程） | 🟡 **未知，必须 PoC** | 沙箱网络隔离若阻止跨进程回环，改用形态 C（子系统内后端 + NAT 网络）或形态 B（同一沙箱内互访） |
| 形态 B：Electron 与 Java 同处应用沙箱 → 回环互访 | 🟡 未知，需 PoC | 同一沙箱内 loopback 通常可行（多数系统允许应用内回环），但仍需实测 |
| 形态 C：子系统内后端 → 前端访问 | 🟡 需配置 | 融合开发引擎 NAT 网络 + IP 不固定（官方 FAQ）；前端用动态 IP 或反向代理；**不建议作为主方案**（IP 漂移） |
| 远程服务端通信（出网） | ✅ 常规 | INTERNET 权限 + HTTPS（第 5 章） |

**PoC 验证脚本**（开工第 2 周必做）：
1. 鸿蒙 PC 终端 `java -jar app.jar` 启动（绑 127.0.0.1:8080）
2. Electron 壳工程内 `tcpProbe('127.0.0.1', 8080)` → 记录结果
3. 若不通：改绑 0.0.0.0 再测 → 仍不通：换形态 B（HNP JDK 同沙箱）或形态 C
4. 把结论回填本文档 4.5 表

---

## 5. 证书处理（TLS/mTLS，keytool 的鸿蒙实现）

### 5.1 需求与 Windows 现状

后端与远程服务端用证书加密 socket/HTTP（TLS 或双向 mTLS）。Windows 上：
- `keytool -genkeypair`（生成客户端密钥对）、`keytool -importcert`（导入服务端 CA）、`keytool -exportcert`（导出 CSR）
- 产物：keystore（.jks/.p12 存私钥+证书）、truststore（.jks 存信任的 CA）
- JVM 启动参数：`-Djavax.net.ssl.keyStore=... -Djavax.net.ssl.trustStore=...`

### 5.2 keytool 在鸿蒙 PC 上的可用性

| 方式 | 可行性 | 说明 |
|---|---|---|
| **鸿蒙 PC 终端（推荐）** | 🟡 大概率可用，需实测 | `keytool` 是 JDK 标准工具，随 **BiShengJDK17-OH** 安装后应位于 JDK bin 目录（`java`/`javac` 已验证可用，keytool 同目录）；终端里执行 `keytool -help` 验证 |
| 开发机生成 + 拷贝 | ✅ 100% 可行 | 证书操作不依赖目标平台（纯 Java/文件操作），**完全可以在开发机 Windows 上用 keytool 生成**，把 .jks/.p12 文件随 jar 一起部署——**推荐此方式，绕开鸿蒙环境不确定性** |

> 结论：**证书生成/管理推荐在开发机完成**（keytool 行为与平台无关）；鸿蒙 PC 只需"存放证书文件 + JVM 启动参数指向"。若必须在鸿蒙 PC 上临时操作证书，用 BiShengJDK17-OH 的 keytool（需实测确认存在）。

### 5.3 证书文件放置与 JVM 参数

**形态 A（终端启动）**：
```bash
# 证书文件随 jar 放同一目录：
# /data/storage/el2/base/files/backend/
#   ├── app.jar
#   ├── certs/client.p12        # 客户端密钥库（mTLS 用）
#   └── certs/truststore.jks    # 信任库（远程服务端 CA）
java -jar /data/storage/el2/base/files/backend/app.jar \
  -Djavax.net.ssl.keyStore=/data/storage/el2/base/files/backend/certs/client.p12 \
  -Djavax.net.ssl.keyStorePassword=changeit \
  -Djavax.net.ssl.trustStore=/data/storage/el2/base/files/backend/certs/truststore.jks \
  -Djavax.net.ssl.trustStorePassword=changeit \
  --server.port=8080
```

**形态 B（HAP 内资源）**：证书放 `resources/backend/certs/`（1.1 目录树），运行时路径为沙箱内 `.../resources/backend/certs/`，启动参数由 Electron 主进程拼接（1.3 代码已注释示范）。

**Spring Boot 侧（Java 代码，与平台无关）**：
```yaml
# application.yml —— 出站 TLS/mTLS（RestTemplate/WebClient/OkHttp 配置）
server:
  ssl:                    # 若后端自身也要提供 HTTPS（可选）
    enabled: false        # 本机内部用 HTTP，出站才加密（简化）
# 出站加密建议用代码配置而非全局 JVM 参数（更可控）：
# RestTemplate:
#   SSLContext 用 truststore 构建，或直接依赖 -Djavax.net.ssl.trustStore
```
```java
// Java 侧：加载信任库/密钥库的标准方式（与 Windows 完全一致，无需改代码）
System.setProperty("javax.net.ssl.trustStore", certDir + "/truststore.jks");
System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
// 或通过 Spring 的 SSL bundles（Spring Boot 3.1+）：
// spring.ssl.bundle.jks.server.keystore.location=file:./certs/client.p12
```

### 5.4 前端（Electron/Chromium）证书处理

**关键事实（官方 API 索引核实）**：
- ✅ `session.setCertificateVerifyProc` **支持**（可自定义服务端证书校验逻辑）
- ❌ `app` 模块 `select-client-certificate` 事件**不支持**（客户端证书选择受限）
- ✅ `webContents.select-client-certificate` 事件支持（渲染进程级）

**推荐架构：前端不直接走 mTLS，由后端代理（与本项目架构天然契合）**
```
前端（Electron 渲染层）
  │  http://app.mycorp.local:8080（webRequest 重定向 → 127.0.0.1:8080，明文本机）
  ▼
本地 SpringBoot 后端（持有 client.p12 + truststore.jks）
  │  TLS/mTLS（证书加密）
  ▼
远程服务端
```
- 前端只管本机 HTTP，**证书全部在 Java 侧**（keytool 生成、JVM 加载）——规避 `select-client-certificate` 不支持的问题
- 若远程服务端是自签 CA：Java 侧 truststore 导入该 CA 即可（5.3）
- 若前端仍需要校验服务端证书（如直连 https 页面）：用 `session.setCertificateVerifyProc`（支持）：

```javascript
// main.js —— 自定义证书校验（可选，自签/内网 CA 场景）
const { session } = require('electron');
session.defaultSession.setCertificateVerifyProc((request, callback) => {
  // request.hostname、request.certificate
  if (request.hostname === 'app.mycorp.local') {
    callback(0);            // 0 = 信任（内网自签场景）
  } else {
    callback(-3);           // 其他按默认拒绝
  }
});
```
⚠️ 生产安全：`setCertificateVerifyProc` 全放行（恒 callback(0)）仅限内网自签场景；建议按 hostname 白名单 + 校验证书指纹。

### 5.5 keytool 常用命令速查（开发机执行）

```bash
# 1) 生成客户端密钥对（mTLS 客户端证书）—— 开发机
keytool -genkeypair -alias client -keyalg RSA -keysize 2048 \
  -validity 3650 -keystore client.p12 -storetype PKCS12 -storepass changeit

# 2) 生成 CSR 提交给服务端签发（或自签）
keytool -certreq -alias client -keystore client.p12 -storepass changeit -file client.csr

# 3) 导入服务端 CA 到信任库
keytool -importcert -alias server-ca -file server-ca.cer \
  -keystore truststore.jks -storepass changeit -noprompt

# 4) 导入签发的客户端证书回密钥库
keytool -importcert -alias client -file client-signed.cer \
  -keystore client.p12 -storepass changeit

# 5) 查看
keytool -list -keystore truststore.jks -storepass changeit
```

---

## 6. 待实测清单（开工 PoC 必做）

| # | 实测项 | 影响 | 对应章节 |
|---|---|---|---|
| 1 | 沙箱内 Electron 访问 127.0.0.1:8080（形态 A 终端进程）是否通 | 决定后端形态 A/B/C | 4.5 |
| 2 | 沙箱内监听端口行为（JVM 沙箱内绑 8080） | 形态 B 可行性 | 4.5 |
| 3 | `webRequest.onBeforeRequest` 重定向在鸿蒙版的实际行为 | 域名映射方案 | 2.3 |
| 4 | 鸿蒙终端/沙箱内是否有 `ping` 命令、ICMP 是否放行 | 打点方案①/②取舍 | 3.2 |
| 5 | BiShengJDK17-OH 是否含 `keytool` | 鸿蒙侧证书操作 | 5.2 |
| 6 | HNP 化的 JDK 能否被应用 spawn 并正常跑 SpringBoot（NIO/TLS） | 形态 B 核心 | 1.3/4.4 |
| 7 | 明文 HTTP 配置（cleartextTraffic）对本机回环是否生效 | 前端→后端通信 | 4.2 |
| 8 | `setCertificateVerifyProc` 在鸿蒙版的实际行为 | 前端证书校验 | 5.4 |

---

## 7. 附录：配置与代码汇总索引

| 内容 | 位置 |
|---|---|
| Electron 主进程后端启动逻辑（形态 A/B） | 第 1.3 节 `main.js` |
| 域名映射 webRequest 代码 | 第 2.3 节 `setupDomainRedirect()` |
| 网络打点（TCP/HTTP 探测 + ping 备选 + NetworkKit） | 第 3.2 节 |
| 沙箱权限与明文 HTTP 配置 | 第 4.2 节 json5 示例 |
| 证书 JVM 参数与 Spring 配置 | 第 5.3 节 |
| keytool 命令速查 | 第 5.5 节 |
| 涉及 API 支持依据 | 《Electron鸿蒙化调研报告》§4.1（webRequest 8/8、Session 86/86、app select-client-certificate 不支持） |

*本专项方案基于公开资料与调研素材整理，第 6 章实测项完成前，涉及沙箱网络/端口的行为均以"待实测"为准，实测结果应回填本文档相应章节。*
