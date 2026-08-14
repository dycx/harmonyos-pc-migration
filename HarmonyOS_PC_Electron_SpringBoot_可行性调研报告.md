# HarmonyOS PC 上开发「Electron 前端 + JDK21 & SpringBoot 后端」App 的可行性调研报告

> 调研时间：2026-08（信息截至 2026 年 7 月底）
> 状态：定稿
> 配套子报告：
> - [research/Electron鸿蒙化调研报告.md](research/Electron鸿蒙化调研报告.md)（Electron 鸿蒙化深度调研：官方态度证据链、版本矩阵、API 支持率精确统计、红莲花、上架案例）
> - [harmonyos-pc-dev-alternatives-report.md](harmonyos-pc-dev-alternatives-report.md)（替代技术路线深度调研：ArkTS/ArkWeb/Flutter/Tauri/Qt）
> - [harmonyos-java-backend-research.md](harmonyos-java-backend-research.md)（鸿蒙 PC 上运行 JDK/Spring Boot 深度调研：毕昇JDK、融合开发引擎、虚拟机、云端、Serverless）

---

## 一、结论摘要（TL;DR）

1. **「原样打包 Electron 跑在鸿蒙 PC」行不通**：HarmonyOS NEXT（纯血鸿蒙）不兼容 Windows `.exe` / Linux ELF 生态，无 Wine、无 WSL，Electron 官方二进制无法直接运行。
2. **但存在官方「Electron 鸿蒙化」方案，且真实可用**：华为/OpenHarmony SIG 已于 2025 年 6 月开源 **HarmonyOS Electron**（`openharmony-sig/electron`，基于 Chromium 132 的源码级移植），可把 Electron 应用编译/打包为鸿蒙 HAP 安装包运行，已支持上架华为 PC 应用市场。**但该方案处于早期阶段**（官方自己提示"未用过此框架不建议直接使用"），API 覆盖约 2/3，坑多，无 x86 支持。
3. **JDK21 在鸿蒙 PC 上暂无原生支持**：官方/社区只提供**毕昇 JDK 8 与 JDK 17**（应用市场可直接安装 "BiShengJDK17-OH"），JDK21 在 2026 年路线图上但无明确时间表。**但 2026-04 华为官方上线了「融合开发引擎」（openEuler Linux 子系统，类似 WSL）**，可在其中安装 **ARM64 JDK21 并运行 Spring Boot**——这是"本机跑 JDK21 后端"目前最现实的官方路径。
4. **「Electron 前端 + 本机 Spring Boot 后端」整体可行，但属于前沿探索**：需要 JDK21 降级（JDK17）或借助融合开发引擎，加上多轮适配（Native 模块重编译、沙箱路径、权限、进程启动 XPM 签名等），且存在应用沙箱访问本机 localhost 服务的未知风险，建议先做 PoC 验证。
5. **更稳妥的替代路线**：① 纯 ArkTS/ArkUI 原生 + 后端放远端/云；② 前端保留 Web 技术栈但改用 ArkWeb 套壳（Node 能力用 ArkTS/NAPI 重写）；③ 后端放融合开发引擎（本机 Linux 子系统）或云端；④ 在鸿蒙 PC 上装 Win11 ARM 虚拟机跑完整 Windows 版 Electron+JDK21（性能损失 20-30%）。（另：Tauri 已有 Eclipse Oniro 实验性移植、Qt 6.12 起官方支持 HarmonyOS、Flutter 有 ohos 社区分支，见第六章。）

---

## 二、背景：HarmonyOS PC 平台现状（截至 2026-07）

| 项目 | 现状 |
|---|---|
| 系统 | HarmonyOS 6.0（2025-10 发布）→ 6.1（API 23，当前主流，DevEco Studio 6.1）→ 7.0 已于 2026-06 出开发者 Beta；PC 版随 MateBook 14/Pro 鸿蒙版发布（2025-05 起） |
| 硬件 | 麒麟 X90（ARM64），24GB/512GB 起 |
| 生态 | 原生应用超 38 万款，其中 PC 应用超 1.9 万（2026-07 数据，快速增长中） |
| Windows 兼容 | **不能直接运行任何 Windows .exe**；无 Wine、无 WSL；仅有两条路：Win11 ARM 虚拟机（Oseasy/铠大师，性能损失约 20-30%）或"卓易通"兼容层（部分应用、不稳定） |
| 本机 Linux | **官方「融合开发引擎」**（2026-04 上线并转正）：openEuler Linux 子系统，类似 WSL；共享文件夹（/mnt/linux_share）、快照、磁盘扩容；NAT 联网；不支持 docker/systemctl/内核修改/USB/IPv6；仅主用户可用 |
| 内核管控 | PC 25 镜像起引入 XPM 内核管控：**未签名的可执行二进制无法执行**（应用内要跑二进制需走 HNP 签名方案） |
| 应用沙箱 | 应用运行在沙箱中，文件只能访问 `/data/storage/el1|el2/...` 沙箱目录，无法访问系统绝对路径 |
| PC 原生能力 | 自由窗口/多窗口/多实例、键鼠（hover/滚轮/快捷键）、系统托盘（Desktop Extension Kit）、文件拖放（UDMF）等官方 API 已就绪 |

---

## 三、核心问题 1：Electron 能在鸿蒙 PC 上运行吗？

### 3.1 直接运行：❌ 不可行
- Electron 官方只发布 Windows/macOS/Linux 三平台二进制；鸿蒙 NEXT 不兼容这三者。
- 社区与华为官方问答均确认：鸿蒙 NEXT **无法直接运行 Electron 应用**（Chromium+Node.js 技术栈与 ArkUI/方舟编译器不兼容）。

### 3.2 官方 Electron 鸿蒙化方案：✅ 存在且真实
- **HarmonyOS Electron**：2025 年 6 月开源至 OH 社区，仓库 `gitcode.com/openharmony-sig/electron`（持续维护），官方账号"HarmonyOS 技术支持"发布开发指导，官方知识地图总帖持续更新。
- **官方决策记录**：OpenHarmony 架构 SIG 第 182 次会议（2025-10-21）正式批准 Electron 37 / Chromium 138 新增版本，并明确区分 **PC-Chromium**（Electron 用）与 **ArkWeb-Chromium**（系统 WebView 用）——官方持续投入的实锤。
- **技术本质**：真正的 Electron **源码级移植**（PC-Chromium，非"渲染层换 ArkWeb"）——编译出 `libelectron.so`、`libadapter.so`（鸿蒙系统适配层）、`libffmpeg.so` 等 arm64 产物（musl libc），Node.js 主进程能力（fs/net/child_process）映射到鸿蒙沙箱，再嵌入 ArkTS 壳工程打包为 HAP。
- **官方版本矩阵**：Electron 25（Chromium 114 / Node 18.18.2）、**Electron 34（Chromium 132 / Node 20.18.1，当前主流预编译版）**、Electron 37（Chromium 138 / Node 22.16.0，2025-10 获批）；预编译 Release 包在华为云 CodeHub 分发（需华为云账号）。
- **官方支持声明**（华为开发者社区《Electron框架HarmonyOS开发指导》，2025-08-05）："HarmonyOS Electron 框架已获得 HarmonyOS 生态合作伙伴的支持……可在 HarmonyOS 5.0 上放心地集成和使用……核心功能稳定运行"；官方 FAQ 对存量项目答复"**现有 Electron 项目适配 HarmonyOS 是完全可行的**"。
- **官方警告**（README 原文）："如果您在其他平台未使用过此框架，不建议您直接使用该框架"——即：**有 Electron 存量项目再考虑迁移，新项目不建议赌这条路**。
- **工具链**：DevEco Studio 壳工程打包（方案一）；`@electron-ohos/electron-builder`（npm 26.8.x，electron-builder 鸿蒙分支，配置 `"ohos": {target:"hap",...}` 直接出 HAP，方案二）。⚠️ 注意：GitHub 上的 `ohos_electron_hap` 与 `ohos-cherrystudio-electron-base` 两个仓库 README 逐字节相同，实为**同一份官方 ohos_hap 模板的社区镜像**，非独立方案。
- **编译门槛高**：Ubuntu 22.04、磁盘 >200-300G、内存 >32G、x86_64 交叉编译（产物仅 arm64-v8a）；也可直接用华为云预编译 Release 包跳过源码编译。

### 3.3 API 兼容性（官方逐项标注，共 1294 个 API / 66 模块）
**总体支持率约 77%（998 支持 / 296 不支持）**，关键模块：
| 模块 | 支持情况 |
|---|---|
| webContents 186/189、webviewTag 113/114、Session 86/86、process 29/29、net / ipcMain / ipcRenderer / protocol / Cookies、**globalShortcut 5/5（全支持）** | 几乎全支持 |
| BrowserWindow | 142/198（Tab 化、flashFrame、hookWindowMessage 等不支持） |
| app | 68/108（activate/second-instance 等事件不支持） |
| Notification 11/22、clipboard 12/19（RTF 等格式不支持）、nativeTheme 7/8、dialog 7/8、screen 9/13 | 部分支持 |
| systemPreferences 10/36、Tray 10/35（交互残缺）、powerMonitor 6/16、shell 3/7 | 支持率低 |
| **autoUpdater 0/10（自动更新不可用，更新必须走华为应用市场）**、TouchBar、Dock、inAppPurchase、Extensions | 0 支持（TouchBar/Dock 为 macOS 专属，影响有限；autoUpdater 影响较大） |

**鸿蒙特有扩展**：`BrowserWindow` 新增 `windowInfo: {type: 'floatWindow'|'subWindow'|'mainWindow'}`（悬浮窗/子窗口）；`systemPreferences.requestSystemPermission()` / `requestDirectoryPermission()` / `fileAccessPersist()` 等新权限 API；JS ↔ ArkTS 互调（`callArkTSFunction`、aki 框架）；Deeplink；托盘（窗口显示隐藏与托盘强绑定）；剪贴板需先申请 `pasteboard` 权限；文件拖放需 API 20+ / HarmonyOS 6.0+（用 `webUtils.getPathForFile`）。

### 3.4 已知问题与限制（官方 issue + 实测文章）
- **版本门槛**：华为官方示例要求 API 20+ / HarmonyOS 6.0.0+ / DevEco Studio 6.0.0+（窗口三键显隐 `win.setWindowButtonVisibility` 等官方示例已提供，说明官方在持续维护开发文档）。
- **仅 arm64-v8a**：不支持 x86 构建；模拟器支持差（安装报错/黑屏，需 `--disable-gpu` 或真机）；**HarmonyOS 6.0 以下暂不支持 WebGL**。
- **平台判断不一致**：`process.platform` 返回值官方文档自相矛盾（'openharmony' vs 'ohos'），社区实测称 'linux'——三方库平台判断常出错，需逐个适配并在目标版本实测。
- **Native 模块**（C++ addon）：必须用鸿蒙工具链重编译为 arm64 `.node/.so`（C++ 最低 17），如 node-sqlite3（有官方适配示例）、serialport 等；esbuild 等含二进制的 npm 包无法直接使用（需走 hnp）；webpack 内联 `.node` 需配 externals。
- **三方库兼容实例**：`electron-window-state` 无法记忆窗口大小（重启恢复默认）；`electron-localshortcut` 报 "Cannot find module"——**凡依赖平台特性的 npm 包都可能需要改造**。
- **系统差异**：`nativeTheme` 暗色模式失效（需轮询 `getprop persist.sys.dark_mode`）；`shell.openExternal` 静默失败（需 `am start` 兜底）；窗口显示/隐藏与托盘强绑定；`exec` 可用但命令集是鸿蒙内核命令（如 `uname` 而非 `wmic`）。
- **XPM 内核管控**：应用内 `exec/spawn/fork` 可执行二进制需先打 HNP 签名包（官方提供 HNP 打包与 fork 指导文档），否则被拦截。
- **Bug 较多**（2026 年 issue）：release 模式 HAP 打开即崩、麦克风授权弹框不出现、`<a download>` 下载 0KB、ffmpeg 二进制无法执行、`utilityProcess.fork` 失败、文档含糊/错误等——**早期阶段特征明显**。
- **性能与安全**：坚盾守护模式（系统级安全模式）下禁用 JIT 与 WebAssembly，JS 性能显著下降；预编译包默认禁用硬件加速（渲染性能有折损）；官方无公开性能基准。
- **沙箱与签名**：文件只能读写应用沙箱目录（`app.getPath('userData')` 等映射到 `/data/storage/el2/base/files`）；OpenHarmony 签名 ≠ HarmonyOS 商用签名，商用设备需申请 HarmonyOS 证书。

### 3.5 社区与第三方
- **大厂选型信号**：QQ/微信/WPS 鸿蒙版均为 **ArkTS 原生重写**而非 Electron 迁移——主流大厂优先原生路线，与华为"不建议新项目用 Electron"的立场一致；公开可查的大厂 Electron 鸿蒙化量产案例缺位。
- 第三方商业方案：海泰方圆「红莲花」（基于 Chromium 114 完成 Chromium/CEF/Electron 鸿蒙化，2024-11 获原生鸿蒙适配认证，国内首家 Chromium 内核全功能浏览器过测），ToB 商用、未开源。
- 社区模板（ohos_electron_hap 等）实为官方 ohos_hap 壳工程模板的社区镜像，非独立方案；仅作快速起步参考。
- 真实迁移/上架案例：
  - **《厨房里的化学》已真实上架华为应用市场**（bundleName `com.chufang.electron_pro`），是公开可搜可下载的 Electron 鸿蒙版应用，证明"开发→签名→AGC 上架→审核→发布"端到端闭环成立。上架经验：本地应用无需 ICP 备案；签名路径不能含中文；审核指南 3.5 项是高频打回点；上架流程约 1-2 天。适合 Electron 适配的选题特征是：单机、轻量、无后端、无 Native 依赖。
  - 社区迁移案例：CHINER 元数建模（建模工具）、electron-markdownify（Markdown 编辑器）、Pomotroid（番茄钟）、KeeWeb（密码管理器）、轻画廊等，均为教程/个人项目级。

---

## 四、核心问题 2：JDK21 / Spring Boot 能在鸿蒙 PC 上运行吗？

### 4.1 毕昇 JDK（BiSheng JDK）鸿蒙支持现状（官方/社区路线图）
| JDK 版本 | 鸿蒙支持 | 说明 |
|---|---|---|
| JDK 8（8u432） | ✅ 已发布 | 应用市场 "BiShengJDK8-OH"，兼容性最佳 |
| JDK 11 | ❌ | 不在支持列表 |
| **JDK 17（17.0.13）** | ✅ **已发布** | 应用市场 "BiShengJDK17-OH"，终端 `java -version` 直接可用；标准 Java 17 程序无需改代码 |
| **JDK 21** | ⏳ **2026 年路线图，无明确时间表** | 官方未公布支持计划；FFM/虚拟线程等新 Native API 需鸿蒙系统库适配 |
| JDK 25 | ❌（可能 2027） | 未支持 |

来源：OpenHarmonyPCDeveloper/BiShengJDKInstaller（开源安装器，HNP 方式安装）+ 华为开发者论坛官方回复。**注意：同一设备只能安装一个 JDK 版本。**

### 4.2 在鸿蒙 PC 上运行 Java 的四种形态
1. **终端直接运行**（最简单）：安装 BiShengJDK17-OH 后，鸿蒙 PC 的「终端」里 `java -jar app.jar` / `javac` 直接可用；已验证可编译运行标准 Java 程序、`-cp` 引用三方 JAR（华为云 CodeArts IDE 也默认集成 Java 环境）。⚠️ 仅 JDK 8/17；⚠️ **无公开案例证明毕昇 JDK17-OH 跑通完整 Spring Boot**（嵌入式 Tomcat 的 NIO/端口监听、TLS 在鸿蒙内核+musl 下的适配未知），官方论坛甚至建议用 @kit.NetworkKit 等 Kit 替代 JDK 原生网络/IO——**必须真机冒烟测试**（`java -jar` 启动、curl 本机端口、HTTPS、JDBC）。
2. **融合开发引擎内运行**（2026-04 起官方路径，✅ 可跑 JDK21）：在融合开发引擎（openEuler Linux 子系统）内安装 **OpenJDK 21 / 毕昇 JDK 21（Linux AArch64 版官方支持 8/11/17/21）** 并运行 Spring Boot（手动拉起进程，无需 systemd；NAT 模式可联网/对外服务；共享文件夹 `/mnt/linux_share` 与鸿蒙交换数据）。⚠️ 限制：仅 openEuler、无 docker、无 systemctl、无内核操作、无 IPv6、仅主用户、IP 不固定。
3. **应用内启动 Java 子进程**（Electron/原生 App 内嵌）：受 XPM 内核管控约束，需要走 HNP 签名方案（JDK 安装器本身就是 HNP 包）；Electron 鸿蒙版已提供 `exec/spawn/fork` 的 HNP 指导文档，**理论上可行，未见公开案例**。
4. **远程部署**（最主流、最省事）：后端跑在云服务器/局域网机器，鸿蒙 App 通过 `@kit.NetworkKit` HTTP 调用（需 `ohos.permission.INTERNET` 权限；明文 HTTP 在 API 10+ 需 `cleartextTraffic` 配置、API 23+ 用 `network_config.json`，生产建议 HTTPS）。注意：AGC 云函数仅支持 Java 1.8（跑不了 Spring Boot）；华为云 FunctionGraph 支持 Java 8/11/17/21 但是函数模型；完整 Spring Boot 用华为云 ECS/CCE 等普通服务器。

### 4.3 Spring Boot 版本选择
- **JDK 17 即可满足 Spring Boot 3.x 全系**：官方要求"至少 Java 17"（3.0–3.2 兼容至 21；3.3 至 23；3.4 至 24；3.5 至 24+；4.0 最低 17、兼容至 25、官方推荐 21）。
- **降级代价**：无法使用 JDK 21 虚拟线程（Spring Boot 3.2+ 的虚拟线程特性需要 JDK 21）、FFM（Foreign Function & Memory）等新特性；对大多数业务应用影响有限。
- **版本支持窗口**（截至 2026-08）：3.2/3.3 OSS 支持已结束；3.4 刚结束；3.5 商业支持到 2026-12；**新项目建议 Spring Boot 4.0.x（兼容 JDK 17）或 3.5.x**。
- **运行限制（实测/社区反馈）**：JDK 内部 API（`sun.management` 等）访问受限；AWT/Swing 图形库不支持（后端不需要）；中文输出可能有编码问题（后端日志注意 UTF-8 配置）；依赖 JNI 的三方库（如部分加密/驱动库）需单独适配；鸿蒙 NEXT 从 API 8 起**永久移除 Java 应用开发形态**，Java 仅作为独立进程/工具存在。

### 4.4 Maven/Gradle 等工具链
- 路线图提到将提供"三方件下载能力（如 Maven）"，目前需自行适配；构建可在开发机完成（交叉编译），鸿蒙端只运行产物。

---

## 五、组合方案评估：Electron 前端 + 本机 Spring Boot 后端

### 5.1 目标架构（用户设想）
```
形态一：前后端全部原生方式（Electron 鸿蒙版 + 本机 JDK）
鸿蒙 PC
├── HAP 应用（Electron 鸿蒙版，HAP 打包）
│     ├── Chromium(鸿蒙移植版) 渲染 React/Vue 前端
│     └── Node.js 主进程（沙箱内，API 适配层）
└── Spring Boot 后端（JDK17 终端启动 or HNP 方式由应用拉起）
        └── 监听 localhost:8080，被 Electron 前端 HTTP 调用

形态二：后端放融合开发引擎（可跑 JDK21）
鸿蒙 PC
├── HAP 应用（Electron 鸿蒙版）
└── 融合开发引擎（openEuler Linux 子系统）
        └── JDK21 + Spring Boot（监听端口，NAT 网络）
```

### 5.2 可行性判定
| 环节 | 判定 | 依据 |
|---|---|---|
| Electron 前端跑在鸿蒙 | 🟡 可行（官方方案，早期阶段） | openharmony-sig/electron 官方开源 + 官方开发指导 + 真实案例（CHINER） |
| JDK21 原生 | 🔴 暂不可用 | 官方仅支持 JDK8/17，JDK21 无时间表 |
| JDK21（融合开发引擎内） | 🟢 可行 | openEuler 子系统内可装 ARM64 OpenJDK 21，手动拉起 Spring Boot |
| JDK17 + Spring Boot 3.x（原生） | 🟢 可行 | BiShengJDK17-OH 应用市场可装，Spring Boot 3.x 支持 JDK17 |
| 后端以终端进程方式运行（JDK17） | 🟡 基础可用，完整 Spring Boot 待实测 | JDK 编译/运行已验证；但 NIO/TLS/端口监听在鸿蒙内核+musl 下无公开案例，需冒烟测试 |
| 应用内拉起后端（HNP） | 🟡 理论可行，需 PoC | Electron HNP 文档齐全，但无公开组合案例 |
| 前端(沙箱内)访问本机后端 | 🟠 **未知风险** | 鸿蒙沙箱网络隔离行为缺少公开资料；社区反馈 WebView 访问 localhost/局域网服务有坑（需 INTERNET 权限、明文 HTTP 配置等），**必须 PoC 实测** |

### 5.3 关键风险清单
1. **JDK21 缺失（原生）**：原生仅 JDK17（或等 2026 年路线图兑现）；若后端强依赖 JDK21 特性（虚拟线程、FFM）需降级重构，或把后端放进融合开发引擎（openEuler 子系统内可装 JDK21）。
2. **Electron 鸿蒙化成熟度**：API 覆盖 2/3、bug 多、仅 arm64、编译链重（>200G 磁盘 / 32G 内存）或依赖华为云预编译框架。
3. **Native 依赖适配**：npm 的 C++ addon、Java 的 JNI 库都要逐个重编译/适配，是最耗时的部分。
4. **沙箱与 XPM**：文件访问限定沙箱目录；二进制执行需 HNP 签名；权限（麦克风/相机/目录）需逐项申请（部分需 ACL 证书）。
5. **本机服务互访未知**：应用沙箱 ↔ 本机 Spring Boot（终端进程）的网络通路是否畅通、端口能否监听/被访问，无公开结论（JDK 网络层在鸿蒙的适配也未验证），是方案的最大不确定性。
6. **上架与签名**：HAP 需要华为开发者证书/ACL 权限申请；上架 PC 应用市场有额外要求（权限归属模块等）；Electron 应用上架已有成功先例但审核流程需预留 1-2 天。
7. **生态演进风险**：鸿蒙 PC 系统、Electron 鸿蒙版、毕昇 JDK 三方都在快速变动，版本绑定风险高。

---

## 六、替代方案对比

| 方案 | 前端技术 | 后端承载 | 开发成本 | 系统集成 | 风险 | 适用场景 |
|---|---|---|---|---|---|---|
| **A. Electron 鸿蒙化 + 本机 JDK17 后端** | 现有 Web 技术栈（React/Vue）几乎不改 | 本机 BiShengJDK17 + Spring Boot | 中高（Native 适配 + 沙箱适配） | 中（窗口/托盘/权限部分支持） | 高（早期方案） | 已有 Electron 存量项目必须上鸿蒙 |
| **A'. Electron 鸿蒙化 + 融合开发引擎跑 JDK21** | 现有 Web 技术栈几乎不改 | 融合开发引擎（openEuler 子系统）内 JDK21 + Spring Boot | 中高（同 A，后端免降级） | 中 | 高（Electron 早期方案 + 子系统依赖） | 强依赖 JDK21 特性的存量项目 |
| **B. ArkTS/ArkUI 原生 + 远端 Spring Boot** | 用 ArkTS 重写 UI（学习成本高） | 云/局域网服务器 | 高（UI 重写） | 高（原生体验） | 低（官方主推） | 新项目、追求稳定与原生体验 |
| **C. ArkWeb 套壳 + 后端任意** | Web 资源基本不改 | 远端（推荐）/融合开发引擎/本机 | 中（JSBridge 改造） | 中低（Node 能力需用 ArkTS/NAPI 重写） | 中 | 前端是纯 Web 应用、可接受无 Node 主进程 |
| **D. Win11/Linux ARM 虚拟机** | 完整 Windows/Linux Electron（含 JDK21） | 虚拟机内 | 低（零改造） | 低（非原生、性能损失 20-30%） | 中（兼容层稳定性） | 过渡期兜底、工具类自用 |
| **E. Flutter for OpenHarmony** | Dart 重写 | 远端/NAPI | 中高 | 中 | 中高（非官方 fork：3.7.12-ohos-1.0.4，插件缺口大） | 团队熟悉 Flutter 且要多端 |
| **F. Tauri（Eclipse Oniro 移植）** | Web 保留 + Rust 重写后端 | Rust 本地（非 Java） | 中 | 中 | 高（实验性：2026-04 移植，上游未承诺） | Rust 团队尝鲜 |
| **G. Qt for HarmonyOS** | QML/Widgets 重写 | C++ 本地 | 高 | 强（Qt 6.12 官方支持，已有托盘） | 中 | C++ 团队、原生级需求 |

---

## 七、分场景建议

### 场景 1：全新项目，目标鸿蒙 PC 为主
> **不建议 Electron 鸿蒙化路线**。官方推荐 ArkTS/ArkUI 原生开发；后端用 JDK17（或直接云端）跑 Spring Boot。
> 若团队全是 Web 技术栈且可接受风险：先做 **2 周 PoC**（ArkWeb 套壳 + 远端后端，或 Electron 鸿蒙版 + JDK17 本机后端），验证：① 应用能否在本机拉起/访问 Spring Boot；② 前端依赖的 Electron API 在鸿蒙版的可用性；③ 真机性能。

### 场景 2：已有 Electron 存量应用，必须迁鸿蒙 PC
> 走官方 Electron 鸿蒙化流程（openharmony-sig/electron），核心步骤：依赖审计（JS 模块 vs C++ addon）→ 平台判断/沙箱路径/权限适配 → addon 交叉编译（arm64）→ HAP 工程重组 → 真机调试。预算 1-3 个月工作量（视 Native 依赖多寡）。**后端降级 JDK17**，或干脆把后端移到远端。

### 场景 3：只关心业务先跑起来（过渡）
> ① 后端先跑云端，前端选 ArkWeb 套壳或 Electron 鸿蒙化（按前端复用需求取舍）；② 或鸿蒙 PC 装 Win11 ARM 虚拟机（Oseasy/铠大师）跑现有 Windows 版 Electron+JDK21，体验差但零改造；③ 或把后端放进融合开发引擎（本机 openEuler 子系统，可跑 JDK21），前端任意；同时立项原生迁移。

### 场景 4：后端强依赖 JDK21+（虚拟线程/FFM）
> 鸿蒙原生 JDK21 暂无（2026 年路线图，无明确时间表）。可行路径：① 后端跑**融合开发引擎**（本机 openEuler 子系统内装 ARM64 OpenJDK 21，手动拉起 Spring Boot，无需 systemd）；② 后端跑远端（云/局域网）；③ 前端任意（Electron 鸿蒙化 / ArkWeb 套壳 / 原生）。不建议阻塞业务等待原生 JDK21。

---

## 八、关键参考资料

### Electron 鸿蒙化
- [openharmony-sig/electron（官方仓库，含 README/API 文档/HNP 指南）](https://gitcode.com/openharmony-sig/electron)
- [华为开发者社区《Electron框架HarmonyOS开发指导》（官方账号"HarmonyOS技术支持"，2025-08）](https://harmonyosdev.csdn.net/6891720a080e555a88d541f5.html)
- [华为开发者论坛《Electron开发HarmonyOS应用知识地图》（官方总帖）](https://developer.huawei.com/consumer/cn/forum/topic/0204203363319759021?fid=0109140870620153026)
- [华为开发者论坛《已有Electron项目，如何适配HarmonyOS PC》（版本矩阵/五步迁移）](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575)
- [OpenHarmony 架构 SIG 第182次会议纪要（2025-10 批准 Electron 37/Chromium 138）](https://lists.openatom.io/hyperkitty/list/dev@openharmony.io/thread/KWEY4NJGZ675UWMFP6Z6OPZL6D2M2NRK/)
- [Electron35 项目适配鸿蒙 PC 端完整方案（CSDN）](https://blog.csdn.net/m0_59315734/article/details/157737347)
- [Electron 移植鸿蒙 PC：四个 Windows 兼容性大坑（红客联盟）](https://www.ihonker.com/thread-35233-1-1.html)
- [CHINER 元数建模 Electron 鸿蒙 PC 适配全记录](https://blog.csdn.net/user340/article/details/161998869)
- [《厨房里的化学》Electron 鸿蒙版上架记（应用市场可搜：com.chufang.electron_pro）](https://blog.csdn.net/weixin_52908342/article/details/161923909)
- [ohos_electron_hap（官方模板社区镜像）](https://github.com/ohosvscode/ohos_electron_hap)
- [@electron-ohos/electron-builder（electron-builder 鸿蒙分支）](https://www.npmjs.com/package/@electron-ohos/electron-builder)
- [海泰方圆「红莲花」鸿蒙版 Chromium/CEF/Electron](https://www.haitaichina.com/qyxw/1937.htm)

### JDK / Spring Boot
- [BiShengJDKInstaller（JDK8/17 鸿蒙安装器，含版本路线图）](https://gitcode.com/OpenHarmonyPCDeveloper/BiShengJDKInstaller)
- [鸿蒙 PC Java 开发环境搭建：BiShengJDK17-OH（CSDN）](https://harmonypc.csdn.net/697076877c1d88441d8e79a3.html)
- [鸿蒙 PC 对 JDK 21 及以上版本的支持路线图（华为论坛问答）](https://developer.huawei.com/consumer/cn/forum/topic/0208214238763794004?fid=0109140870620153026)
- [鸿蒙 PC 端 Java 应用开发实战（腾讯云开发者社区）](https://cloud.tencent.com.cn/developer/article/2610881)
- [Spring Boot 3.5 系统要求（JDK 17+）](https://springdoc.tech/spring-boot/3.5.10/system-requirements/)

### 平台现状
- [MateBook 14 鸿蒙版 · 软件兼容性对照表（2026-07 实测）](https://m.toutiao.com/article/7666020621444252166/)
- [鸿蒙电脑应用突破 1.9 万（IT之家）](https://www.ithome.com/0/983/259.htm)
- [华为「融合开发引擎」上线鸿蒙 PC 端，支持运行 Linux 环境（IT之家）](https://www.ithome.com/0/934/994.htm)
- [融合开发引擎（Linux 子系统）官方支持页（含 FAQ：systemctl/docker/网络模式等）](https://consumer.huawei.com/cn/support/content/zh-cn16091898/)
- [鸿蒙 NEXT 中如何使用 Electron（itying 社区问答）](https://bbs.itying.com/topic/68f72bc523bfd6004cd75d38)
- [卓易通：华为官方安卓兼容工具](https://baike.baidu.com/item/%E5%8D%93%E6%98%93%E9%80%9A/68251054)
- [鸿蒙PC安装虚拟机跑 IDEA+SpringBoot（实测：ARM 虚拟机需 ARM64 JDK）](https://bbs.itying.com/topic/697bd89bc504c50058fd2420)
- [nodejs/node PR #58350：Node.js 官方支持 OpenHarmony 构建目标（已合入）](https://github.com/nodejs/node/pull/58350)

### 替代方案（详见子报告 `harmonyos-pc-dev-alternatives-report.md`）
- [Eclipse Newsletter：Bringing Ionic and Tauri to OpenHarmony（2026-04）](https://newsroom.eclipse.org/eclipse-newsletter/2026/april/bridging-ecosystem-divide-bringing-ionic-and-tauri-openharmony)
- [Tauri PR #15237：HarmonyOS PC 白屏修复（已合入）](https://github.com/tauri-apps/tauri/pull/15237)
- [Qt for HarmonyOS development with 6.12.0 Beta2（Qt Wiki）](https://wiki.qt.io/index.php?title=Qt_for_HarmonyOS_development_with_6.12.0_Beta2)
- [openharmony-sig/flutter_flutter（Gitee，ohos 分支）](https://gitee.com/openharmony-sig/flutter_flutter)
- [Desktop Extension Kit（系统托盘）官方文档](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/statusbar-extension-introduction)

---

*本报告基于公开资料整理，标注"需实测/未知"的结论建议在真机（HarmonyOS 6.x PC）上以 PoC 验证后再做技术决策。*
