# 鸿蒙 PC 开发基础文档（面向 Windows/Electron 开发者）

> 适用读者：有 Windows / Electron 桌面开发经验、**零鸿蒙经验**的团队，正在评估或执行「Windows Electron 应用迁移到鸿蒙 PC」。
> 编写日期：2026-08 ｜ 事实依据：工作区四份调研报告（见文末附录 B）｜ 版本快照：以 HarmonyOS 6.x（API 23）为主、HarmonyOS 7.0 Beta 为辅。
>
> **使用前提（公司内网、网络受限）**：本文档**自包含**——所有核心概念、配置、命令均已写全，离线可读、可照着做。附录 B 的官方链接仅作补充参考，**需要联网才能打开**，内网环境下请以本文档内容为准。
>
> **事实可信度标注约定**（沿用调研报告）：✅ = 官方/一手来源已证实；🟡 = 多方佐证但非官方；⚠️ 待核实 = 来源有出入或无法核实，**迁移前必须在目标真机/目标版本上实测**。文中所有标注「⚠️ 待核实」的条目，请勿作为技术决策的最终依据。

---

## 目录

1. [HarmonyOS 平台总览](#1-harmonyos-平台总览)
2. [系统架构体系（通俗版）](#2-系统架构体系通俗版)
3. [应用开发范式（重点）](#3-应用开发范式重点)
4. [Windows 功能场景替代对照表（核心章节）](#4-windows-功能场景替代对照表核心章节)
5. [常见问题 Q&A](#5-常见问题-qa)
6. [术语表](#6-术语表)
7. [附录](#7-附录)

---

# 1. HarmonyOS 平台总览

## 1.1 鸿蒙是什么：先把三个名字分清

做迁移决策前，最容易被绕晕的是「鸿蒙」这个词在不同语境下指三个不同的东西。一句话分清：

- **HarmonyOS NEXT（纯血鸿蒙）**：华为手机/平板/PC 上正在跑的**商业操作系统**，自 2024 年起彻底**不兼容安卓 APK**，应用只能用鸿蒙原生技术（ArkTS/ArkUI）或官方支持的移植框架开发。**你们要迁移到的就是它。**
- **OpenHarmony（开源鸿蒙）**：华为捐给开放原子开源基金会的**开源底座**，HarmonyOS NEXT 是它的商业发行版（类似「Android Open Source Project ↔ 各家手机系统」的关系）。社区版 Electron 鸿蒙化、社区工具链大多基于 OpenHarmony 构建；**注意：OpenHarmony 签名 ≠ HarmonyOS 商用签名**（详见 2.5）。
- **安卓（Android）**：谷歌的操作系统，与鸿蒙**无关**。HarmonyOS NEXT 不兼容 APK；「卓易通」等安卓兼容工具只是借道虚拟机/兼容层跑部分安卓应用，不是鸿蒙能力（详见 1.3）。

一句话版本：

> **HarmonyOS NEXT 是华为自研、与安卓无关、不跑 exe 也不跑 APK 的国产操作系统；OpenHarmony 是它的开源上游；你们要做的，是把 Electron 应用改造成「鸿蒙能安装运行的东西」。**

对 Windows 开发者最直观的类比：

| Windows 世界 | 鸿蒙世界 |
|---|---|
| Windows 系统（含 NT 内核） | HarmonyOS NEXT（微内核 + Linux 兼容层） |
| Windows 应用商店 / MSI / EXE | 华为应用市场（AppGallery）/ HAP 安装包 |
| Win32 API / .NET / COM | Kit 体系（ArkUI、AbilityKit、NetworkKit……） |
| .NET Framework / C# | ArkTS（TypeScript 超集）/ ArkUI（声明式 UI） |
| UWP 沙箱 / AppContainer | 应用沙箱（/data/storage/el1\|el2） |
| 注册表 / 系统服务 | 无对应 / 系统服务层（部分能力无开放 API） |
| Wine / WSL | 不存在；官方替代是「融合开发引擎」（Linux 子系统） |

## 1.2 鸿蒙 PC 现状（截至 2026-08）

### 1.2.1 系统与 API 版本线

| 版本 | 时间 | API 级别 | 说明 |
|---|---|---|---|
| HarmonyOS 5.0 | 2024-10 | API 12 | 纯血鸿蒙首个商用大版本（手机/平板） |
| HarmonyOS 6.0 | 2025-10-22 | API 20 起步 | 随鸿蒙电脑（PC）大规模铺开；Electron 鸿蒙版官方示例要求 **API 20+ / HarmonyOS 6.0.0+ / DevEco Studio 6.0.0+** |
| HarmonyOS 6.0.1 | 2025-11-25 | API 21 | 随 Mate 80 首发 |
| **HarmonyOS 6.1.0** | 2026 上半年 | **API 23（当前主流）** | 配套 DevEco Studio 6.1.0；存量设备 API 23 占比已超 23%，5.x 快速淘汰 |
| HarmonyOS 7.0 | 2026-06 | — | Developer Beta 1 已发布（主打"快启内核"、Agent 架构），正式版未定 |

✅ 来源：调研报告《HarmonyOS_PC_Electron_SpringBoot_可行性调研报告》与《harmonyos-pc-dev-alternatives-report.md》。版本号与 API 级别的对应关系在快速演进，**上架/适配决策前请以目标设备的实际系统版本为准**。

### 1.2.2 硬件与生态

- **硬件**：鸿蒙 PC 当前搭载 **麒麟 X90（ARM64 架构）**，典型配置 24GB 内存 / 512GB 存储起步。⚠️ 注意：是 **ARM64**，不是 x86——这直接影响二进制的兼容性（见 4.2.3 子进程与 HNP）。
- **生态数据**（2026-07）：HarmonyOS 原生应用超 38 万款，其中 **PC 应用超 1.9 万款**，仍在快速增长。相比 Windows 的千万级应用生态仍很小，但头部应用（QQ、微信、WPS 等）的鸿蒙版均已**用 ArkTS 原生重写**上架，不是靠兼容层。
- **PC 原生能力已就绪**：自由窗口/多窗口/多实例、键鼠（hover/滚轮/快捷键）、系统托盘（Desktop Extension Kit）、文件拖放（UDMF）等官方 API 均已提供——这些是你们迁移后要用的"系统集成能力"。

### 1.2.3 Windows 兼容限制（重要，先说结论）

**鸿蒙 PC 不能直接运行任何 Windows `.exe`，也没有 Wine、没有 WSL。** 想在鸿蒙 PC 上跑 Windows 软件，目前只有三条路：

| 路线 | 是什么 | 适用性 | 限制 |
|---|---|---|---|
| **Win11 ARM 虚拟机**（Oseasy/铠大师等） | 应用市场安装的虚拟机软件，内部装 Windows 11 ARM 版 | 过渡期兜底；跑完整 Windows 版 Electron + JDK 的场景 | 性能损失约 20-30%；虚拟化层稳定性一般；需注意虚拟机内 JDK 必须用 **ARM64 版**（x86 版 JDK 会崩，典型报错 `0xC0000005` 内存访问冲突） |
| **卓易通** | 华为官方的安卓兼容工具（安卓应用兼容层） | 跑部分安卓应用；**与 Windows 无关** | 仅部分应用可用、不稳定 |
| **融合开发引擎** | 华为官方 **openEuler Linux 子系统**（类似 WSL），2026-04 上线并转正 | 在鸿蒙 PC 本机跑 Linux 服务（如 JDK21 + Spring Boot）；**不是 Windows 兼容方案** | 仅支持 openEuler；无 docker/systemctl/内核操作/USB 直通/IPv6；仅主用户可用；NAT 联网、IP 不固定；共享文件夹挂载在 `/mnt/linux_share` |

> 对迁移团队的含义：**别指望"把 exe 拷过去就能跑"**。要么走官方 Electron 鸿蒙化（把 JS 代码和 Chromium 移植版重新打包成 HAP），要么用 ArkTS/ArkUI 重写 UI（官方推荐路线），要么过渡期用 Win11 ARM 虚拟机兜底。

### 1.2.4 与迁移最相关的三条"平台红线"

1. **应用沙箱**：应用只能读写自己的沙箱目录（`/data/storage/el1|el2/...`），Windows 绝对路径（`C:\Users\...`）全部失效。类似 iOS 的容器、UWP 的 AppContainer。
2. **XPM 二进制执行管控**：PC 镜像引入 XPM 内核管控后，**未签名的可执行二进制无法执行**；应用内要跑二进制（如 exe/ELF 子进程）必须走 HNP 签名方案（见 2.3、4.2.3）。
3. **权限与签名**：不是声明了就能用——权限分基础/按需/ACL 三级，ACL 权限要邮件向华为申请证书；签名体系分 OpenHarmony 与 HarmonyOS 两套（见 2.4、2.5）。

## 1.3 迁移路线对比：四条路怎么选

基于调研报告（详见 `harmonyos-pc-dev-alternatives-report.md`），对"Electron 前端 + Spring Boot 后端"团队，鸿蒙 PC 上有四条现实路线：

| 路线 | 前端怎么处理 | 后端怎么处理 | 开发成本 | 系统集成能力 | 风险 | 适用场景 |
|---|---|---|---|---|---|---|
| **A. Electron 鸿蒙化**（官方移植） | 现有 Web 技术栈（React/Vue）几乎不改，打成 HAP | 本机 BiShengJDK 17（降级）或放融合开发引擎/云端 | 中高（Native 适配 + 沙箱适配） | 中（窗口/托盘/权限部分支持，API 支持率约 77%） | 高（早期方案、坑多） | 已有 Electron 存量项目、必须保代码复用 |
| **B. ArkTS/ArkUI 原生**（官方主推） | ArkTS 全量重写 UI | 云端/融合开发引擎；或后端逻辑用 ArkTS/NAPI 重写 | 高（UI 重写，学习成本高） | 高（原生体验最好，PC 能力最全） | 低（官方路线，生态持续投入） | 新项目、追求稳定与原生体验 |
| **C. ArkWeb 套壳**（WebView 路线） | Web 产物打进 rawfile 用 ArkWeb 加载，几乎不改 | 远端（推荐）/融合开发引擎/本机 | 中（写 ArkTS 壳层 + JSBridge） | 中低（无 Node 主进程，Node 能力需用 ArkTS/NAPI 重写） | 中（自研内核非 Chromium 100% 兼容） | 纯 Web 应用、可接受无 Node 主进程 |
| **D. Win11 ARM 虚拟机**（过渡兜底） | 完整 Windows 版 Electron 不动 | 虚拟机内 JDK21 | 低（零改造） | 低（非原生） | 中（性能损失 20-30%、兼容层稳定性） | 过渡期、工具类自用 |

> 一句话建议：**存量 Electron 应用要"保代码"走 A；要"保体验"分步走 B（核心页面原生化 + 长尾页面 ArkWeb）；过渡期用 D 兜底**。官方立场明确：新项目不建议赌 Electron 路线（官方 README 原话："如果您在其他平台未使用过此框架，不建议您直接使用该框架"）。

---

# 2. 系统架构体系（通俗版）

这一章帮你们建立"鸿蒙系统里软件是怎么被装进去、怎么运行的"的图景。不需要背，看懂分层和三条红线即可。

## 2.1 分层架构：从内核到应用

鸿蒙 NEXT 的分层可以类比 Windows 来理解（不完全精确，但足够用）：

```
┌─────────────────────────────────────────────────────┐
│ 应用层      HAP 应用（你的 App）、系统应用、元服务      │  ← 类比：你的 .exe / UWP 应用
├─────────────────────────────────────────────────────┤
│ 框架层      Kit 体系：ArkUI（UI）、AbilityKit（能力）、 │  ← 类比：Win32 API + .NET + Electron 模块
│             NetworkKit（网络）、CoreFileKit（文件）…    │
├─────────────────────────────────────────────────────┤
│ 系统服务层  窗口管理、包管理、权限、通知、文件、媒体等    │  ← 类比：Windows services.exe / 系统服务
├─────────────────────────────────────────────────────┤
│ 内核层     鸿蒙微内核 + Linux 兼容层（L2）              │  ← 类比：NT 内核 + Win32 子系统
└─────────────────────────────────────────────────────┘
```

各层一句话说明：

- **内核层**：HarmonyOS NEXT 使用**自研微内核**处理核心的调度、IPC、安全；同时提供 **Linux 兼容层（L2）**，把 Linux 生态的 POSIX 接口（文件、网络、进程等）映射进来。这正是 Electron 鸿蒙版、Node.js、毕昇 JDK 能"搬过来"的底层原因——它们本质是 Linux 系软件。⚠️ 待核实/需注意：鸿蒙自研内核 + musl libc 的组合与标准 Linux（glibc）生态并不完全等价，NIO/TLS/端口监听等底层能力需实测（详见 4.2.4 与第 5 章网络类 Q&A）。
- **系统服务层**：窗口管理、包管理（安装/卸载 HAP）、权限管理、通知、剪贴板、媒体等系统服务。应用通过框架层 API 调用它们，不能直接碰内核。
- **框架层**：华为把系统能力打包成一个个 **Kit**（如 @kit.ArkUI、@kit.NetworkKit、@kit.CoreFileKit），应用 import 后调用。**"Kit 即官方能力包"**，类似 NuGet 包或 Electron 的内置模块，详见 3.6。
- **应用层**：你的 HAP 应用。运行在应用沙箱里，与系统和其他应用隔离。

## 2.2 应用沙箱：文件只能在自己的一亩三分地里

**类比：沙箱类似 iOS 的容器 / UWP 的 AppContainer**——应用以为自己在访问绝对路径，实际被映射到私有目录，看不到也写不了别人的文件。

- 应用内可见的沙箱根是 `/data/storage/`，下面按 **el1 / el2** 分两个加密级别：
  - **el1**：设备级加密目录——设备开机即可访问（存储不依赖用户解锁）。
  - **el2**：用户级加密目录——用户登录/解锁后才能访问。**应用用户数据默认放 el2**。
- 沙箱路径 ↔ 真实物理路径的映射关系（`<USERID>` 当前固定为 100，`<PACKAGENAME>` 是应用包名）：

| 应用沙箱路径 | 真实物理路径 | 用途 |
|---|---|---|
| `/data/storage/el1/bundle` | `/data/app/el1/bundle/public/<PACKAGENAME>` | 应用安装包目录（只读） |
| `/data/storage/el1/base` | `/data/app/el1/<USERID>/base/<PACKAGENAME>` | el1 级别数据目录 |
| `/data/storage/el2/base` | `/data/app/el2/<USERID>/base/<PACKAGENAME>` | **el2 级别数据目录（用户数据放这里）** |
| `/data/storage/el1/database` | `/data/app/el1/<USERID>/database/<PACKAGENAME>` | el1 数据库目录 |
| `/data/storage/el2/database` | `/data/app/el2/<USERID>/database/<PACKAGENAME>` | el2 数据库目录 |

对迁移的影响（三条铁律）：

1. **Windows 绝对路径全部失效**：`C:\Users\xxx\AppData\Roaming`、`D:\data` 等一概不存在。Electron 鸿蒙版中 `app.getPath('userData')` 等路径 API 会映射到沙箱目录（默认 `--user-data-dir=/data/storage/el2/base/files`）。
2. **访问公共目录（下载/文档/桌面）需要额外授权**：声明 `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY / READ_WRITE_DOCUMENTS_DIRECTORY / READ_WRITE_DESKTOP_DIRECTORY`（ACL 权限，需申请证书，见 2.4/2.5），并配合 `ohos.permission.FILE_ACCESS_PERSIST` + `systemPreferences.requestDirectoryPermission()` 做持久化授权。
3. **数据库、缓存、配置都放沙箱**：`/data/storage/el2/base/database`（数据库）、`/data/storage/el2/base/files`（文件）、`/data/storage/el2/base/preferences`（偏好设置）。

## 2.3 XPM 二进制执行管控：不是所有可执行文件都能跑

- 背景：HarmonyOS PC 镜像引入 **XPM（内核级可执行文件管控）**——**未签名的可执行二进制（ELF 等）无法被 exec/spawn/fork 执行**。这是系统级安全策略，应用内无法绕过。
- 对迁移的影响：你们 Electron 应用里如果有 `child_process.exec('xxx.exe' / 'some_binary')`、或 npm 包内含二进制（如 esbuild）、或 Java 进程等，**在鸿蒙上都跑不起来，除非**：
  1. 把可执行二进制打成 **HNP 包**（HarmonyOS Native Package，见 2.6）并签名后随 HAP 分发；Electron 鸿蒙版官方提供 HNP 打包与 fork 指导文档。
  2. 或者改用 ArkTS/NAPI 重写该能力（不依赖外部二进制）。
- ⚠️ 注意：Electron 鸿蒙版的 `exec` 命令集是**鸿蒙内核命令**（如 `uname` 而不是 Windows 的 `wmic`），且 `exec('uname -a')` 这类系统命令本身可用。

## 2.4 权限体系：基础 / 按需 / ACL 三级

鸿蒙权限分三级，理解这三级就能解释大部分"权限声明了却没生效"的问题：

| 级别 | 含义 | 典型权限 | 获取方式 |
|---|---|---|---|
| **基础权限** | 低风险，声明即授权，无需用户弹窗 | `ohos.permission.INTERNET`（联网）、`GET_NETWORK_INFO`、`RUNNING_LOCK`（后台运行锁）、`PREPARE_APP_TERMINATE`（关闭前清理）、`FILE_ACCESS_PERSIST`（文件持久化授权）、`READ_PASTEBOARD`（读剪贴板） | `module.json5` 的 `requestPermissions` 声明即可 |
| **按需申请权限** | 中等风险，运行时弹窗询问用户 | `MICROPHONE`（麦克风）、`CAMERA`（相机）、`LOCATION`（定位）、`CUSTOM_SCREEN_CAPTURE`（截屏）、`ACCESS_BLUETOOTH`（蓝牙） | 声明 + 运行时调用授权 API（如 `systemPreferences.askForMediaAccess`）；授权弹窗**仅弹一次**，拒绝后需用户去「设置 → 隐私和安全」手动改 |
| **ACL 签名权限** | 高风险，需要证书背书 | `SYSTEM_FLOAT_WINDOW`（全局悬浮窗）、`READ_WRITE_DOWNLOAD_DIRECTORY` / `READ_WRITE_DOCUMENTS_DIRECTORY` / `READ_WRITE_DESKTOP_DIRECTORY`（公共目录读写）、`WINDOW_TOPMOST`（置顶）、`PRIVACY_WINDOW`（隐私窗口）、`ACCESS_CERT_MANAGER`（证书管理）、`ACCESS_BIOMETRIC`（生物识别）、`PRINT`（打印） | 声明 + **邮件向华为申请 ACL 证书**，签名时带上；**未获批时官方建议先注释掉这些权限**（否则签名可能失败/上架被拒） |

**权限声明位置**（原生 ArkTS 与 Electron 鸿蒙版都是这里）：

```json5
// entry/src/main/module.json5（或 Electron 壳工程 web_engine/src/main/module.json5）
{
  "module": {
    // ... 其他配置
    "requestPermissions": [
      { "name": "ohos.permission.INTERNET" },                                    // 基础权限：联网
      { "name": "ohos.permission.MICROPHONE",                                    // 按需权限：麦克风
        "reason": "$string:reason_mic",                                          // 申请原因（弹窗文案）
        "usedScene": { "abilities": ["EntryAbility"], "when": "inuse" } },
      { "name": "ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY",                // ACL 权限：文档目录
        "reason": "$string:reason_docs",
        "usedScene": { "abilities": ["EntryAbility"], "when": "always" } }
    ]
  }
}
```

> ⚠️ 常见坑：ACL 权限**没拿到证书时**，签名会失败或安装报错——先把 ACL 权限从 `requestPermissions` 里注释掉，跑通基础流程后再逐个申请开启。

## 2.5 签名体系：调试 / 发布、OpenHarmony / HarmonyOS 两套

签名决定"这个包能不能装上、能不能上架"，是迁移团队最早会撞上的墙。

- **调试签名**：DevEco Studio 自动为开发者生成（本地证书 + Profile），用于连真机/模拟器调试。**签名路径不能含中文**（`hap-sign-tool` 会报错，见第 5 章 Q5）。
- **发布签名**：在 **AGC（AppGallery Connect，华为开发者后台）** 申请正式证书和 Profile，签名后才能在商用设备上安装、上架应用市场。
- **OpenHarmony 签名 ≠ HarmonyOS 商用签名**：用 OpenHarmony 工具链签的包装不到商用 HarmonyOS NEXT 设备上，典型报错：
  `The target device does not work with apps with an OpenHarmony signature. Sign the app with a HarmonyOS signature.`
  —— 商用设备必须申请 **HarmonyOS 签名**（走 AGC）。这是社区版工具链 + 商用设备的经典混搭坑。
- **ACL 权限证书**：2.4 节的 ACL 权限需要单独邮件向华为申请（`harmony_acl@huawei.com` 之类，以官方指引为准），获批后在 AGC 配置里勾选对应权限项。

## 2.6 包类型：HAP / APP / HNP

| 包类型 | 全称 | 是什么 | 类比 | 关键点 |
|---|---|---|---|---|
| **HAP** | HarmonyOS Ability Package | **一个模块的安装包**，包含代码 + 资源 + module.json5 配置。**安装/分发的最小单元** | 单个 EXE / APK | 一个应用可含多个 HAP（如 entry、feature）；DevEco 构建产物就是 HAP |
| **APP** | HarmonyOS Application Package | **应用包**，把多个 HAP（含不同设备形态的 HAP）打在一起，用于上架/分发 | .msixbundle / 安装捆绑包 | 上架华为市场传的是 APP 或 HAP |
| **HNP** | HarmonyOS Native Package | **可执行二进制/动态库的打包方案**（含签名），让应用在 XPM 管控下能执行自带二进制 | 签名的 DLL/EXE 依赖 | 应用内要 exec/spawn/fork 二进制，必须先打 HNP 包；Electron 鸿蒙版、毕昇 JDK 安装器都走这条路 |

> 一句话记忆：**HAP 是"装进手机/PC 的那个包"，APP 是"上架时的一捆包"，HNP 是"沙箱里偷偷执行二进制的合法通行证"。**

---

# 3. 应用开发范式（重点）

这一章是"怎么写一个鸿蒙应用"的完整入门。先讲模型，再讲语言、UI、工程、调试，最后讲 Kit 体系。**Electron 迁移团队建议至少精读 3.1、3.2、3.4、3.5**，其余可先浏览。

## 3.1 应用模型：Stage 模型（Ability 体系）

### 3.1.1 一句话背景

鸿蒙应用模型分两代：老的 **FA 模型**（类小程序/页面栈，已废弃）和现在的 **Stage 模型**（类 Android Activity + 服务组件、类 UWP 的应用模型）。**新开发一律用 Stage 模型**，本文档只讲 Stage。

### 3.1.2 核心概念：Ability = "能力单元"

**Ability 是鸿蒙应用的基本组成单元**——可以类比 Electron 的"窗口 + 主进程入口"、Android 的 Activity/Service：

| 鸿蒙概念 | 类比 | 说明 |
|---|---|---|
| **UIAbility** | 一个窗口/任务入口（≈ Electron 的 BrowserWindow + app 生命周期） | 每个 UIAbility 对应一个用户可见的窗口任务。桌面应用通常有 1 个 EntryAbility 作为主窗口入口 |
| **ExtensionAbility** | 后台扩展能力（≈ Electron 的托盘/后台任务、Windows 服务） | 无界面或常驻的系统扩展：如托盘的 `StatusBarViewExtensionAbility`（Desktop Extension Kit）、输入法、壁纸等 |
| **Want** | 启动参数/意图（≈ Android Intent） | 描述"我想启动哪个 Ability、带什么参数"，用于应用内/应用间跳转 |
| **AbilityStage** | 应用级生命周期（≈ Electron 的 app.whenReady） | 应用启动最先执行的地方，全局初始化放这里 |
| **Context** | 上下文句柄（≈ Electron 的 app 对象的一部分） | 通过 context 拿沙箱路径、启动其他 Ability、读取资源 |

**类比总结：UIAbility ≈ "Activity / 窗口入口"，Want ≈ "Intent / 启动参数"，ExtensionAbility ≈ "托盘图标背后的常驻进程"。**

### 3.1.3 生命周期（以 UIAbility 为例）

```
onCreate()               // Ability 创建（≈ Electron app 'ready' 前）
  → onWindowStageCreate()// 窗口阶段创建（可在这里加载页面）
  → onForeground()       // 进入前台（≈ 窗口显示）
  → （用户操作...）
  → onBackground()       // 退到后台（≈ 窗口最小化/隐藏）
  → onDestroy()          // 销毁（≈ app quit）
```

页面级生命周期（ArkUI 组件，见 3.3）：`aboutToAppear`（页面即将显示）→ `onPageShow`（页面显示）→ `onPageHide`（页面隐藏）→ `aboutToDisappear`（页面销毁）。

### 3.1.4 桌面特殊：托盘（Desktop Extension Kit）

鸿蒙 PC 的托盘能力由 **Desktop Extension Kit（桌面拓展服务）** 提供：通过 `StatusBarViewExtensionAbility` + `statusBarManager` 在系统状态栏/托盘区创建常驻入口。这是 Electron 迁移里"最小化到托盘"的官方落点（详见 4.2）。

## 3.2 ArkTS 语言速览：TypeScript 的严格超集

### 3.2.1 ArkTS 与 TypeScript 的关系

**ArkTS 是 TypeScript 的超集**，在 TS 基础上：

- **新增**：声明式 UI 的装饰器语法（`@Entry`、`@Component`、`@State` 等）——这是它区别于纯 TS 的核心。
- **收紧**（官方称"静态类型约束"）：
  - **不允许 `any` / `unknown`**（TS 严格模式下也建议禁用的类型）——所有变量必须有明确类型；
  - 对象字面量必须符合显式类型（不允许"鸭子类型"推断）；
  - 部分动态特性受限（如禁止 `eval`、限制动态属性访问等）。

> 对团队的意义：**会 TS 的同事几乎零成本上手 ArkTS 语法**——把 `any` 消灭掉、类型写严谨，剩下的就是学 ArkUI 的组件和装饰器。

### 3.2.2 声明式 UI 示例：最小可运行应用

一个完整可运行的 ArkTS 页面（计数器）。这就是鸿蒙版的"Hello World + 交互"：

```ts
// entry/src/main/ets/pages/Index.ets
// @Entry 标记页面入口；@Component 标记这是一个 UI 组件
@Entry
@Component
struct Index {
  // @State 声明的变量：值变化时自动触发 UI 刷新（类比 React 的 state / Vue 的 ref）
  @State title: string = 'Hello HarmonyOS'
  @State count: number = 0

  // build() 描述 UI 结构：组件树
  build() {
    Column({ space: 16 }) {                       // 纵向容器，子组件间距 16
      Text(this.title)                            // 文本组件
        .fontSize(28)
        .fontWeight(FontWeight.Bold)

      Text(`点击次数：${this.count}`)              // 模板字符串与 TS 一致
        .fontSize(20)
        .fontColor('#666666')

      Row({ space: 12 }) {                        // 横向容器
        Button('+1')
          .onClick(() => {
            this.count++                          // 直接改 @State 变量，UI 自动刷新
          })
        Button('清空')
          .onClick(() => {
            this.count = 0
          })
      }
    }
    .width('100%')                                // 通用属性：宽
    .height('100%')                               // 通用属性：高
    .justifyContent(FlexAlign.Center)             // 主轴居中
  }
}
```

把这段代码放进 DevEco Studio 新建的 `Empty Ability` 工程的 `Index.ets`，即可在模拟器/真机运行。

**要点**（与 React/Vue 对照）：

| ArkTS 写法 | 类比 |
|---|---|
| `@State count: number = 0` | React `useState` / Vue `ref`：状态驱动 UI |
| `this.count++` 直接改值 | 响应式自动更新，无需手动 setState（类似 Vue） |
| `build() { ... }` 组件树 | JSX / template |
| `.fontSize(28)` 链式属性 | 样式即属性（类似 SwiftUI/Flutter 风格） |
| `@Prop`（父传子）、`@Link`（双向） | props / v-model |

### 3.2.3 状态管理装饰器速查

| 装饰器 | 作用 | 类比 |
|---|---|---|
| `@State` | 组件内状态，变化触发刷新 | useState |
| `@Prop` | 父组件传入的只读属性 | props |
| `@Link` | 与父组件状态双向同步 | v-model / 受控组件 |
| `@Provide` / `@Consume` | 跨层级共享状态（祖先提供，后代消费） | Context / provide-inject |
| `@Watch('xxx')` | 监听某状态变化回调 | watch / useEffect |
| `@StorageLink` | 与 AppStorage（应用级存储）双向绑定 | 全局 store（Pinia/Vuex） |

## 3.3 ArkUI 核心概念：组件树、状态、生命周期

### 3.3.1 组件树

ArkUI 是**声明式 UI 框架**：`build()` 里声明组件树，组件是 UI 的最小单元。常用基础组件：

- 容器：`Column`（纵向）、`Row`（横向）、`Stack`（层叠）、`Scroll`（滚动）、`List`（列表）、`Grid`（网格）、`RelativeContainer`（相对布局）
- 基础：`Text`（文本）、`Image`（图片）、`Button`（按钮）、`TextInput`（输入框）、`Slider`（滑块）、`Progress`（进度条）
- 弹窗：`AlertDialog`、`CustomDialog`（自定义对话框）、`bindMenu`（右键菜单）
- 特殊：`Web`（ArkWeb 网页组件，见 4.1 场景 24 与 3.7）、`XComponent`（原生渲染占位）、`Canvas`（画布）

### 3.3.2 状态管理

见 3.2.3 表格。核心心智模型：**UI = f(state)**——改状态，UI 自动重绘；不要手动操作 DOM 节点。

### 3.3.3 生命周期（页面级）

| 回调 | 时机 | 类比 |
|---|---|---|
| `aboutToAppear()` | 组件即将挂载 | `componentDidMount` 前 / `mounted` |
| `onPageShow()` | 页面显示（含从后台/其他页面返回） | `visibilitychange` → visible |
| `onPageHide()` | 页面隐藏 | `visibilitychange` → hidden |
| `aboutToDisappear()` | 组件即将销毁 | `componentWillUnmount` / `onUnmounted` |
| `onBackPress()` | 用户按返回 | `beforeunload` / 路由守卫 |

**典型用法**：在 `aboutToAppear` 里初始化数据、注册事件；在 `aboutToDisappear` 里释放资源。

## 3.4 工程结构详解：DevEco Studio 工程

DevEco Studio 创建的工程结构如下（这是标准 Stage 模型工程，**Electron 鸿蒙化的壳工程结构与此同构**，只是多了 electron 产物目录）：

```
MyApp/                                  # 工程根目录
├── AppScope/                           # 应用级配置（整个 App 一份）
│   ├── app.json5                       # ★应用级配置：bundleName（包名）、版本、应用图标/名称
│   └── resources/                      #   应用级资源（如应用图标 media/app_icon）
│       └── base/
│           ├── element/string.json     #   应用名等字符串
│           └── media/                  #   图标等图片资源
│
├── entry/                              # 一个"模块"（module），对应一个 HAP 安装包
│   ├── src/main/
│   │   ├── module.json5                # ★模块级配置：Ability 列表、权限声明、设备类型、页面路由
│   │   ├── ets/                        #   ArkTS 源码目录
│   │   │   ├── Application/
│   │   │   │   └── AbilityStage.ets    #   应用级生命周期入口（全局初始化）
│   │   │   ├── entryability/
│   │   │   │   └── EntryAbility.ets    #   主 UIAbility：onCreate/onWindowStageCreate...
│   │   │   └── pages/
│   │   │       └── Index.ets           #   页面组件（@Entry @Component）
│   │   └── resources/                  #   模块级资源
│   │       ├── base/
│   │       │   ├── element/            #     字符串/颜色/数值（string.json、color.json）
│   │       │   ├── media/              #     图片
│   │       │   └── profile/
│   │       │       └── main_pages.json #     ★页面路由表（哪些 .ets 是页面）
│   │       └── rawfile/                #   原始文件：按原样打进 HAP（Web 前端资源放这里）
│   ├── build-profile.json5             #   模块构建配置（签名配置、编译选项、targets）
│   ├── oh-package.json5                #   模块依赖清单（ohpm 三方库，类似 package.json）
│   ├── hvigorfile.ts                   #   模块构建脚本（hvigor 构建系统，类似 Gradle）
│   └── obfuscation-rules.txt           #   代码混淆规则（可选）
│
├── build-profile.json5                 # 工程级构建配置（产品/签名/SDK 版本）
├── oh-package.json5                    # 工程级依赖（类似 workspace 的 package.json）
├── hvigorfile.ts                       # 工程级构建脚本入口
├── hvigor/                             # hvigor 配置目录（构建引擎版本等）
└── hvigorw / hvigorw.bat               # hvigor 命令行包装器（类似 gradlew）
```

### 3.4.1 关键文件逐一说明

**① AppScope/app.json5 —— 应用身份证**

```json5
{
  "app": {
    "bundleName": "com.example.myapp",  // 包名，全局唯一（上架后不可改）
    "vendor": "example",                // 厂商
    "versionCode": 1000000,             // 版本号（数字，上架递增）
    "versionName": "1.0.0",             // 版本名（展示用）
    "icon": "$media:app_icon",          // 应用图标（$media: 引用 resources 资源）
    "label": "$string:app_name"         // 应用名（$string: 引用字符串资源）
  }
}
```

**② entry/src/main/module.json5 —— 模块能力声明（最重要）**

```json5
{
  "module": {
    "name": "entry",                    // 模块名
    "type": "entry",                    // 模块类型：entry=应用入口模块，feature=功能模块
    "srcEntry": "./ets/Application/AbilityStage.ets", // 应用入口
    "description": "$string:module_desc",
    "mainElement": "EntryAbility",      // 主 Ability
    "deviceTypes": ["phone", "tablet", "2in1"],       // 支持的设备形态（2in1=PC/平板）
    "deliveryWithInstall": true,        // 安装时随应用一起交付
    "installationFree": false,          // 是否免安装（元服务才 true）
    "pages": "$profile:main_pages",     // 页面路由表引用
    "abilities": [                      // Ability 列表
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "description": "$string:EntryAbility_desc",
        "icon": "$media:app_icon",
        "label": "$string:EntryAbility_label",
        "startWindowIcon": "$media:app_icon",        // 启动窗口图标
        "startWindowBackground": "$color:start_window_background", // 启动窗口背景色
        "exported": true,               // 是否允许被其他应用拉起
        "skills": [                     // 声明如何被系统/其他应用拉起
          {
            "entities": ["entity.system.home"],      // 桌面图标入口
            "actions": ["action.system.home"]
          }
        ]
      }
    ],
    "requestPermissions": [             // ★权限声明（见 2.4）
      { "name": "ohos.permission.INTERNET" }
    ]
  }
}
```

**③ pages/main_pages.json —— 页面路由表**

```json
{
  "src": [
    "pages/Index",        // 首页
    "pages/About"         // 其他页面（对应 ets/pages/About.ets）
  ]
}
```

**④ build-profile.json5 —— SDK 与签名**

```json5
{
  "app": {
    "signingConfigs": [],               // 签名配置（DevEco 自动生成/管理）
    "products": [
      {
        "name": "default",              // 产品名
        "signingConfig": "default",
        "compatibleSdkVersion": "6.0.0(20)",  // 最低兼容 SDK（API 20，即 HarmonyOS 6.0）
        "runtimeOS": "HarmonyOS"
      }
    ]
  }
}
```

**⑤ oh-package.json5 —— 依赖清单**

```json5
{
  "name": "entry",
  "version": "1.0.0",
  "description": "示例模块",
  "main": "",
  "author": "",
  "license": "Apache-2.0",
  "dependencies": {
    // 三方库用 ohpm install 安装后自动出现，类似 npm 的 package.json
    // 注意：@kit.xxx 是 SDK 内置的，不需要也不应该写在这里
  }
}
```

**⑥ hvigorfile.ts —— 构建脚本**

```ts
import { hapTasks } from '@ohos/hvigor-ohos-plugin';
export default {
  system: hapTasks,  // 声明这是 HAP 模块（构建系统是 hvigor，类似 Gradle）
  plugins: []
}
```

> 记忆锚点：**app.json5 = 应用信息，module.json5 = 模块能力（Ability + 权限 + 设备），main_pages.json = 路由表，build-profile.json5 = SDK/签名，oh-package.json5 = 依赖，hvigorfile.ts = 构建声明。**

## 3.5 开发调试流程

标准流程（对比"装 VS + 建项目 + F5"）：

```
1. 安装 DevEco Studio（内含 SDK）           ← 类似装 Visual Studio + 工作负载
2. 新建工程（Empty Ability 模板）           ← 类似 File > New Project
3. 配置签名（DevEco 自动生成调试证书）        ← 类似开发者模式/自签名
4. 连接设备：模拟器（DevEco 内置 PC 模拟器）或真机（USB 连接）
5. 点击 Run（构建 HAP → 自动签名 → hdc 安装到设备 → 启动）
6. 调试：断点调试 ArkTS / hilog 看日志 / DevEco Profiler
7. 打包：Build > Build Hap(s)/APP(s) → 产出 .hap 或 .app
```

关键工具链名称（记熟，附录 A 有命令）：

| 工具 | 作用 | 类比 |
|---|---|---|
| **DevEco Studio** | 官方 IDE（基于 IntelliJ） | Visual Studio / VS Code + 插件 |
| **hdc** | 设备连接/管理命令行工具（HarmonyOS Device Connector） | adb |
| **hilog** | 系统日志工具 | logcat / DebugView |
| **hvigor** | 构建系统（hvigorw 是它的命令行入口） | Gradle |
| **ohpm** | 鸿蒙三方库包管理器（OpenHarmony Package Manager） | npm |
| **hap-sign-tool** | HAP 签名工具（命令行，CI 用） | signtool / codesign |

## 3.6 Kit 体系：官方能力包

**Kit = 华为把系统能力打包成的官方 SDK 集合**。应用通过 `import { xxx } from '@kit.XXXKit'` 使用，类似"官方 NuGet 包"或"Electron 内置模块"。常用 Kit：

| Kit | 提供能力 | 类比（Electron/Windows） |
|---|---|---|
| `@kit.ArkUI` | 声明式 UI 全部组件与状态管理 | React/Vue + 样式系统 |
| `@kit.AbilityKit` | Ability 生命周期、Want、应用跳转 | app 生命周期 + 启动参数 |
| `@kit.NetworkKit` | HTTP/WebSocket 等网络能力（http 模块） | Electron net / fetch |
| `@kit.CoreFileKit` | 文件/目录读写（fs 模块） | Node fs |
| `@kit.NotificationKit` | 系统通知 | Electron Notification / Windows Toast |
| `@kit.PasteboardKit` | 剪贴板 | Electron clipboard |
| `@kit.WindowKit` | 窗口管理（自由窗口/悬浮窗/子窗口） | BrowserWindow / Win32 HWND |
| `@kit.WebKit` | ArkWeb 网页组件 | WebView / WebView2 |
| `@kit.ArkData` | 关系型数据库（RDB，SQLite 内核）、首选项、分布式数据 | better-sqlite3 + electron-store |
| `@kit.SQLiteKit` | SQLite 数据库 | better-sqlite3 |
| `@kit.DeviceInfoKit` | 设备信息 | os 模块 / systeminfo |
| `@kit.MediaKit` | 音视频采集播放 | MediaDevices / 媒体 API |
| `@kit.ScreenCaptureKit` | 屏幕采集 | desktopCapturer |
| `@kit.BasicServicesKit` | 基础服务（设置、日志等） | 系统 API |

**示例**（网络请求，原生 ArkTS 写法，见 4.2.4 与第 5 章网络类 Q&A）：

```ts
import { http } from '@kit.NetworkKit';

const httpRequest = http.createHttp();
httpRequest.request('https://api.example.com/health', {
  method: http.RequestMethod.GET,
  header: { 'Content-Type': 'application/json' }
}).then((resp: http.HttpResponse) => {
  console.info(`status=${resp.responseCode}, body=${resp.result as string}`);
}).catch((err: Error) => {
  console.error(`请求失败: ${err.message}`);
});
```

> 注意：`@kit.*` 由 SDK 直接提供，**不需要 ohpm install**；ohpm 只装第三方库（如图表、UI 组件库）。

## 3.7 NAPI 与 ArkWeb JSBridge：Web 团队的"迁移桥"

如果走 **ArkWeb 套壳路线（第 1.3 节路线 C）**，你们的前端代码基本保留，缺的是两样东西：①Electron 的 Node.js 主进程能力；②原生能力 ↔ Web 页面的通信。对应解法：

### 3.7.1 没有 Node 主进程怎么办：能力上移 ArkTS / 用 NAPI

- ArkWeb 套壳里**没有 Node.js**（这是与 Electron 最大的架构差异）。文件、网络、通知等能力由 **ArkTS 壳层**直接调用 Kit 提供。
- 需要高性能/底层能力时用 **NAPI**（Native API，ArkTS ↔ C/C++ 互调标准）：把 C/C++（或 Rust）编译成 `.so`，通过 NAPI 暴露给 ArkTS 调用。⚠️ 注意：NAPI 模块同样要按鸿蒙 NDK 工具链编译，且受沙箱/XPM 约束。

### 3.7.2 Web ↔ ArkTS 双向通信（JSBridge）

ArkWeb 组件提供双向桥：

**① JS（网页）→ ArkTS（壳层）**：用 `javaScriptProxy` 把 ArkTS 对象挂到网页的 `window` 上：

```ts
// ArkTS 侧：页面里注册代理对象
Web({ src: $rawfile('web/index.html') })
  .javaScriptProxy({
    object: {
      // 网页里调用 window.nativeBridge.readFile(path) 就会走到这里
      readFile: (path: string): string => {
        // 调用 @kit.CoreFileKit 读文件，返回给网页
        return fs.readTextSync(path);
      },
      notify: (msg: string): void => {
        // 调用 @kit.NotificationKit 发系统通知
      }
    },
    name: 'nativeBridge',   // 网页侧通过 window.nativeBridge 访问
    methodList: ['readFile', 'notify'],
    controller: this.controller
  })
```

网页侧直接 `window.nativeBridge.readFile('/data/storage/el2/base/files/a.txt')`。

**② ArkTS（壳层）→ JS（网页）**：`runJavaScript()`（异步执行，须在页面加载完成 `onPageEnd` 之后调用）：

```ts
this.controller.runJavaScript('window.doRefresh()');
```

**③ 传参限制**：官方限制**不支持非字符串参数**——传对象请先 `JSON.stringify`，网页侧 `JSON.parse`；需要高频双向消息时用 `WebMessagePort`（postMessage 通道）。

> 迁移提示：把原来 Electron 主进程里的 `ipcMain.handle(...)` 逐个改写成 ArkTS 代理对象的方法，渲染进程的 `ipcRenderer.invoke(...)` 改为 `window.nativeBridge.xxx(...)`——**IPC 调用面基本可以一一对应**，是工作量最可控的改造路径。

# 4. Windows 功能场景替代对照表（核心章节）

> 本章是迁移工作量评估的**主工具**：左边是你们 Windows/Electron 里用到的能力，右边是鸿蒙上的对应方案。分两列给出：**原生 ArkTS 方案**（官方推荐路线，能力最全）与 **Electron 鸿蒙版方案**（官方移植版，API 支持率约 77%——998/1294 支持、296 不支持，数据来自官方 API 索引）。
>
> 用法建议：把你们应用的 Electron API 调用清单逐行对照，**标红不支持/受限的行**，那就是迁移改造点。API 支持率数字出处：`openharmony-sig/electron` 官方 `docs/api/index.md`（✅ 已证实）。

## 4.1 总对照表

| # | 场景 | Windows / Electron 原有做法 | 原生 ArkTS 方案（Kit/API + 一句用法） | Electron 鸿蒙版方案 | ⚠️ 限制与说明 |
|---|---|---|---|---|---|
| 1 | **文件读写** | `fs` + `app.getPath('userData')` 等 | `@kit.CoreFileKit` 的 `fs`：`fs.openSync('/data/storage/el2/base/files/a.txt', fs.OpenMode.READ_WRITE)`；用户数据统一放沙箱 | `fs` 可用，路径 API 映射到沙箱（`--user-data-dir=/data/storage/el2/base/files`） | ⚠️ **Windows 绝对路径全部失效**；公共目录（下载/文档/桌面）需 ACL 权限 + `FILE_ACCESS_PERSIST` + `systemPreferences.requestDirectoryPermission()` |
| 2 | **系统托盘** | `new Tray(icon)` + 菜单 | **Desktop Extension Kit**：`StatusBarViewExtensionAbility` + `statusBarManager` 创建托盘入口与菜单 | `Tray` 基本可用（10/35 支持），官方有 `communication-electron-tray-demo` 示例 | ⚠️ 托盘事件大量不支持（double-click、drag/drop、balloon 等）；**窗口显示/隐藏与托盘强绑定**——启动前必须先创建托盘，不需要托盘时要注释壳工程 `AppWindowAdapter.ets` 的 `processMode/startupVisibility` |
| 3 | **系统通知** | `new Notification()`（Windows Toast） | `@kit.NotificationKit`：`notificationManager.publish(request)` 发系统通知 | `Notification`（11/22 支持） | ⚠️ actions、reply、sound、subtitle 等字段不支持；通知权限按需申请 |
| 4 | **全局快捷键** | `globalShortcut.register()` | 原生侧可监听按键（`@ohos.multimodalInput`，覆盖范围 ⚠️ 待核实） | **`globalShortcut` 5/5 全支持**（Electron 鸿蒙版少有的完整模块） | ✅ 全局快捷键是官方文档标注全支持的模块；但**能否全局生效取决于系统桌面环境**，建议真机实测 |
| 5 | **剪贴板** | `clipboard.readText()/writeText()` | `@kit.PasteboardKit`：`pasteboard.getSystemPasteboard().setData(...)` | `clipboard`（12/19 支持） | ⚠️ RTF/FindText 等格式不支持，文本/图片/文件路径（FileNameW）可用；**必须先申请剪贴板权限**（`READ_PASTEBOARD`，Electron 侧用 `systemPreferences.requestSystemPermission('pasteboard')`） |
| 6 | **窗口管理**（自由窗口/多窗口/悬浮窗） | `new BrowserWindow()` | `@kit.WindowKit` + `@kit.AbilityKit`：`windowStage.createSubWindow()` 建子窗口；自由窗口（freeform）系统级支持；悬浮窗需 `SYSTEM_FLOAT_WINDOW` 权限 | `BrowserWindow`（142/198 支持）；新增 `windowInfo: {type: 'floatWindow'\|'subWindow'\|'mainWindow'}` 悬浮窗类型，支持透明/透明度 | ⚠️ 子窗口/悬浮窗无系统三键（最小化/最大化/关闭）；首窗口尺寸/位置只能通过 `module.json5` 的 `ohos.ability.window.width/height/left/top` metadata 配置；Tab 化、flashFrame 等不支持 |
| 7 | **子进程/命令行** | `child_process.exec/spawn/fork` | 原生 ArkTS **没有** exec/spawn；需用 NAPI 写 C/C++ 模块或改架构（后端外置） | `exec/spawn/fork/execFile` 可用，但**可执行二进制必须先打 HNP 包签名**（官方《Electron HNP打包与fork指南》） | ⚠️ **XPM 管控**：未签名二进制无法执行；命令集是鸿蒙内核命令（`uname` 而非 `wmic`）；含二进制的 npm 包（esbuild 等）不能直接用 |
| 8 | **网络请求** | `net` / `fetch` / axios | `@kit.NetworkKit` 的 `http`：`http.createHttp().request(url, ...)`；需 `ohos.permission.INTERNET` | `net`/`fetch`/`ipcMain` 等基本全支持（Session 86/86） | ⚠️ 明文 HTTP 需显式配置：API 10+ 在 `app.json5` 开 `network.cleartextTraffic: true`，**API 23 起用 `network_config.json`**（`cleartextTrafficPermitted`）；生产强烈建议 HTTPS（详见 4.2.4、Q22-Q25） |
| 9 | **数据库** | better-sqlite3 / sql.js / lowdb | `@kit.ArkData` 关系型存储（RDB，SQLite 内核）`relationalStore.getRdbStore(context, config)`；或 `@kit.SQLiteKit`；轻量配置用 Preferences | node-sqlite3 有**官方适配示例**（需用鸿蒙工具链重编译 addon） | ⚠️ 数据库文件放沙箱 `/data/storage/el2/base/database/`；C++ addon 必须重编译（C++ 标准最低 17） |
| 10 | **打印** | `webContents.print()` / Windows 打印 API | `@kit.PrintKit`（打印框架）⚠️ 覆盖面待核实 | Electron 打印相关 API ⚠️ 待核实 | ⚠️ 需 `ohos.permission.PRINT`（按需权限）；打印效果需真机验证 |
| 11 | **摄像头/麦克风** | `getUserMedia` / `systemPreferences.askForMediaAccess` | `@kit.MediaKit` + 权限 `CAMERA`/`MICROPHONE`（运行时弹窗） | `systemPreferences.askForMediaAccess('camera'\|'microphone')` 可用 | ⚠️ 授权弹窗**只弹一次**，拒绝后须去「设置 → 隐私和安全」手动改；社区反馈存在"麦克风授权弹框不出现"的 bug（2026 年 issue） |
| 12 | **屏幕截图/录屏** | `desktopCapturer` | `@kit.ScreenCaptureKit`（屏幕采集）；需 `CUSTOM_SCREEN_CAPTURE` 权限 | 无直接 Electron 截图 API；官方示例用"无 UI 快捷截屏"调用系统原生截图能力 | ⚠️ **坚盾守护模式**（系统高安全模式）下能力受限；`PRIVACY_WINDOW` 隐私窗口可禁止被截屏录屏 |
| 13 | **开机自启** | `app.setLoginItemSettings()` | 无直接 API；引导用户在系统设置中添加自启动，或申请常驻能力 ⚠️ 待核实 | `app.setLoginItemSettings` ⚠️ 待核实（官方 API 索引未见标注） | ⚠️ 无注册表/启动项机制；建议作为"设置项"引导用户手动开启 |
| 14 | **自动更新** | `autoUpdater`（electron-updater） | 无自建更新通道；**更新必须走华为应用市场**（AGC 应用内升级） | **`autoUpdater` 0/10 全不支持** | ❌ 这是迁移的最大痛点之一：应用上架后，新版本由市场分发，**应用内无法自更新** |
| 15 | **注册表/环境变量** | `regedit` / `process.env` | **无对应**：沙箱内无注册表；环境变量受限 | 无对应 | ✅ 结论：用沙箱内配置文件（JSON/Preferences）替代注册表；环境变量只能在进程内自设 |
| 16 | **串口/USB** | `serialport` / `usb` | **受限**：普通应用无通用 USB 直通能力；融合开发引擎也不支持 USB 直通 | serialport 等 addon 需重编译，且系统层 USB 能力受限 ⚠️ 待核实 | ⚠️ 对依赖串口/USB 设备的工控类应用，鸿蒙 PC 迁移风险最高，需先做 PoC |
| 17 | **系统信息** | `os` / `process` / `systeminfo` | `@kit.DeviceInfoKit`（`deviceInfo`）：`deviceInfo.deviceType`、`deviceInfo.osFullName` 等 | `os`/`process` 模块部分支持 | ⚠️ **`process.platform` 返回值存在官方文档冲突**（'openharmony' vs 'ohos'），社区实测称 'linux'——**必须按目标版本实测**（见 Q26） |
| 18 | **深链（自定义协议）** | `app.setAsDefaultProtocolClient('myapp')` | `@kit.AbilityKit`：`module.json5` 的 `skills` 里声明 `uris`，系统把 `myapp://` 链接路由给应用 | Deeplink 有官方文档（含 `module.json5` 配置说明） | ✅ 支持；注意要配合 `exported: true` 和 uris 声明 |
| 19 | **应用间跳转** | `shell.openExternal(url)` / 拉起其他应用 | `Want` 拉起：`context.startAbility({ bundleName, abilityName, ... })` | `shell.openExternal` ⚠️ 部分场景**静默失败**（社区实测），需用 `am start` 兜底 | ⚠️ 建议封装一层"openExternal 失败则 am start"的兜底逻辑 |
| 20 | **文件拖放** | `webUtils.getPathForFile(file)` / HTML5 DnD | **UDMF（统一数据定义框架）** + ArkUI 拖拽事件（`onDrop` 等），支持组件内/跨应用拖放 | `webUtils.getPathForFile` 可用（**要求 API 20+ / HarmonyOS 6.0.0+ / Electron 34+**） | ✅ PC 原生拖放已就绪；跨设备键鼠拖拽（PC↔PAD）系统级支持 |
| 21 | **多窗口/多实例** | 多个 `BrowserWindow` / 多开 | 自由窗口多窗口 + `module.json5` 的 `multiAppMode` 配置多实例 | `BrowserWindow` 多窗口可用；`multiAppMode` 支持多实例 | ✅ 官方原生支持；不需要多实例时把 `multiAppMode` 配置删掉 |
| 22 | **菜单栏** | `Menu.buildFromTemplate` | ArkUI 组件内菜单（`bindMenu`/`Menu`） | `Menu` 部分支持（应用菜单栏能力有限） | ⚠️ 系统级菜单栏定制受限，建议用窗口内自定义标题栏+菜单（官方有示例：无边框窗口 + `-webkit-app-region: drag`） |
| 23 | **系统主题/暗色** | `nativeTheme` | ArkUI 资源限定符（dark 限定符）自动适配 | `nativeTheme`（7/8 支持） | ⚠️ 社区实测 `nativeTheme.themeSource` 返回 undefined（暗色模式失效），需轮询 `getprop persist.sys.dark_mode` 兜底（单篇实测，⚠️ 待核实） |
| 24 | **Web 页面承载** | `BrowserWindow` + Chromium 渲染 | **ArkWeb**（`Web({ src: $rawfile('web/index.html') })` 加载本地打包的 H5/React/Vue） | 自带 **PC-Chromium**（Chromium 114/132/138，与系统 ArkWeb-Chromium 是两套） | ⚠️ ArkWeb 是自研内核，与 Chromium 非 100% 兼容（WebGPU 等待跟进）；Electron 鸿蒙版仅 arm64、模拟器支持差、6.0 以下无 WebGL |

## 4.2 重点场景补充说明

### 4.2.1 托盘（场景 2）——迁移高频改动点

Electron 鸿蒙版中托盘与窗口显隐**强绑定**（系统限制）：启动应用前必须先创建 Tray，否则窗口创建可能异常；不需要托盘时须修改壳工程 `web_engine/src/main/ets/adapter/AppWindowAdapter.ets`，注释掉 `processMode` 与 `startupVisibility`：

```ts
const options: StartOptions = {
  // processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
  // startupVisibility: param.show ? contextConstant.StartupVisibility.STARTUP_SHOW : contextConstant.StartupVisibility.STARTUP_HIDE,
  windowLeft: param.left - leftBorder,
  // ...
}
```

原生 ArkTS 路线用 Desktop Extension Kit：新建 `StatusBarViewExtensionAbility`，在 `onCreate` 中注册 `statusBarManager` 添加托盘图标与菜单项，点击后通过 Want 拉起主界面（`EntryAbility`）。

### 4.2.2 文件系统（场景 1）——路径改造清单

迁移时对代码里的路径做一次系统替换：

| Electron 写法 | 鸿蒙沙箱写法（Electron 鸿蒙版） |
|---|---|
| `app.getPath('userData')` | `/data/storage/el2/base/files`（默认映射） |
| `app.getPath('temp')` | `/data/storage/el2/base/cache` 等沙箱内目录 |
| `C:\Users\<user>\Documents\...` | 需 `READ_WRITE_DOCUMENTS_DIRECTORY`（ACL）+ 授权 |
| 任意绝对路径（`D:\data\db.sqlite`） | 放到 `/data/storage/el2/base/database/` 或 `el2/base/files/` |

> 自查清单：全局搜索 `C:\`、`D:\`、`/Users/`、`/home/`、`app.getPath`、`process.cwd`，逐一改为沙箱路径。

### 4.2.3 子进程与 HNP（场景 7）——二进制执行路径

```bash
# 流程：把需要执行的二进制（如工具程序、JDK）打成 HNP 包并签名
# 参考官方《Electron HNP打包与fork指南》：
# 1) 准备可执行文件与依赖 .so
# 2) 用官方 hnp 打包工具生成 HNP 包（内含签名）
# 3) 放入 HAP 工程的指定目录
# 4) 代码里用 child_process.execFile/fork 调用
```

⚠️ 实测要点：`exec('uname -a')` 这类**鸿蒙内核自带命令**可以直接执行（无需 HNP）；只有**应用自带的第三方二进制**才需要 HNP 签名。ESBuild、ffmpeg、node 子进程等都属后者。

### 4.2.4 网络与明文 HTTP（场景 8）——配置与代码

开发期访问本机/内网 HTTP 服务（如你们的 Spring Boot 后端 `http://192.168.x.x:8080` 或 `http://localhost:8080`）：

**① 权限**（`module.json5`）：
```json5
"requestPermissions": [ { "name": "ohos.permission.INTERNET" } ]
```

**② 明文 HTTP 放行**——按 API 版本二选一：
- **API 10 ~ API 22**：在 `AppScope/app.json5` 声明：
```json5
{
  "app": {
    // ...
    "network": { "cleartextTraffic": true }   // 允许所有明文 HTTP（开发期）
  }
}
```
- **API 23（HarmonyOS 6.1）起**：改用 `entry/src/main/resources/base/profile/network_config.json`，可全局或按域名控制：
```json
{
  "network-config": {
    "cleartextTrafficPermitted": true,
    "domains": [ { "domain": "192.168.1.10", "cleartextTrafficPermitted": true } ]
  }
}
```

**③ 沙箱访问本机服务的风险**：⚠️ 待核实——鸿蒙沙箱与应用沙箱外进程（如终端里跑的 Spring Boot）之间的 localhost 网络通路是否畅通，**没有公开结论**（调研报告明确列为"最大不确定性"）。**必须 PoC 实测**：`http://localhost:8080`、`http://127.0.0.1:8080`、局域网 IP 三种都试。生产强烈建议 HTTPS。

### 4.2.5 深链（场景 18）——module.json5 配置示例

自定义协议（如 `myapp://open?id=123`）让外部链接直接打开应用：

```json5
// entry/src/main/module.json5，在 EntryAbility 的 skills 中追加
{
  "skills": [
    {
      "entities": ["entity.system.home"],
      "actions": ["action.system.home", "ohos.want.action.viewData"],
      "uris": [
        { "scheme": "myapp", "host": "open", "path": "id" }  // myapp://open?id=...
      ]
    }
  ]
}
```

`EntryAbility.ets` 中通过 `onNewWant` / `want.uri` 接收参数并路由。Electron 鸿蒙版同样在壳工程 `module.json5` 配置（官方《Deeplink 使用文档》有 Windows/macOS/Linux/OH 平台差异对照）。

### 4.2.6 数据库（场景 9）——ArkTS 原生 RDB 示例

```ts
import { relationalStore } from '@kit.ArkData';
import { UIAbilityContext } from '@kit.AbilityKit';

// 打开/创建数据库（文件自动落在沙箱 /data/storage/el2/base/database/ 下）
const store = await relationalStore.getRdbStore(context as UIAbilityContext, {
  name: 'myapp.db',
  securityLevel: relationalStore.SecurityLevel.S1
});

// 建表
await store.executeSql('CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)');

// 插入
await store.insert('note', { title: '第一条记录' } as relationalStore.ValuesBucket);

// 查询
const result = await store.querySql('SELECT * FROM note');
while (result.goToNextRow()) {
  console.info(`id=${result.getLong(result.getColumnIndex('id'))}, title=${result.getString(result.getColumnIndex('title'))}`);
}
result.close();
```

Electron 鸿蒙版则用重编译后的 node-sqlite3（官方适配示例），API 与 Windows 上一致，只是数据库文件路径要落到沙箱。

### 4.2.7 系统通知（场景 3）——ArkTS 原生示例

```ts
import { notificationManager } from '@kit.NotificationKit';

const request: notificationManager.NotificationRequest = {
  id: 1,
  content: {
    notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
    normal: {
      title: '任务完成',
      text: '导出已完成，共 128 条记录'
    }
  }
};
await notificationManager.publish(request);   // 需要通知权限（按需申请）
```

# 5. 常见问题 Q&A

> 共 29 条，按类别组织。每条格式：**问题 → 原因 → 解决方案（含命令/配置）**。全部基于调研报告中的官方 FAQ、社区实测与上架案例整理；标注「⚠️ 待核实」的条目请在目标版本上实测。

## 5.1 环境安装类

### Q1. DevEco Studio 装不上 / 安装后打不开
- **原因**：常见于①安装包不完整或未按官方要求安装（先装 IDE 再装 SDK）；②系统要求不满足（DevEco Studio 6.x 要求 **64 位系统、JDK 17**，自带 JBR 时也要检查）；③内网环境缺少在线组件。
- **解决方案**：
  1. 确认系统满足：Windows 10/11 64 位（或 macOS），内存 ≥ 8GB（建议 16GB+），磁盘 ≥ 30GB 可用空间。
  2. 卸载重装：删除 `C:\Users\<user>\.huawei`、`~/.ohos`、DevEco 安装目录残留后重装。
  3. 内网环境：DevEco 首次启动会联网拉取 SDK/HarmonyOS 组件——**公司内网需配置离线 SDK**：下载 SDK 离线包（HarmonyOS SDK 全量包）后，在 Settings → SDK Manager 里手动指定 SDK 路径。
  4. 确认 JDK：DevEco 6.x 内置 JBR（基于 JDK 17）；若用外部 JDK，必须是 **JDK 17**（非 17 会导致构建失败，见 Q7）。

### Q2. SDK 下载慢 / 下载失败（内网环境）
- **原因**：SDK 组件托管在华为 CDN，内网无外网出口或带宽受限。
- **解决方案**：
  1. 在**有外网的开发机**上装好 DevEco 并下载全部 SDK 组件，然后整体拷贝 `DevEco Studio\sdk` 目录到内网机器（注意版本一致性）。
  2. 或配置代理：DevEco Settings → HTTP Proxy 填入公司代理。
  3. 或申请华为开发者站点离线包（部分组件提供全量离线下载）。
  4. ⚠️ 注意：SDK 版本必须与 DevEco 版本配套（如 DevEco Studio 6.1 ↔ API 23 SDK），混用会导致编译期找不到 API。

### Q3. 为什么要求 JDK 17？我项目是 JDK 21 怎么办
- **原因**：**DevEco Studio 的构建链（hvigor/hap-sign-tool）基于 JDK 17**；华为官方 FAQ 明确"非 JDK 17 会导致编译失败"。这是**开发机**的构建要求，与应用运行时的 JDK 无关。
- **解决方案**：
  1. 开发机安装 **JDK 17** 并让 DevEco 使用它（或直接用 DevEco 内置 JBR），构建产物是 HAP，与 JDK 版本无关。
  2. 你们的 **Spring Boot 后端**若需要 JDK 21，与鸿蒙前端构建解耦：前端构建用 JDK 17，后端部署按第 1.2.3 节的融合开发引擎/云端方案走（后端在鸿蒙 PC 本机暂无原生 JDK 21，详见调研报告《harmonyos-java-backend-research.md》）。

### Q4. 调试证书/Profile 怎么来？ACL 权限证书怎么申请
- **原因**：鸿蒙签名体系分调试/发布两套（见 2.5）；ACL 权限需要额外证书。
- **解决方案**：
  1. **调试**：DevEco Studio 登录华为开发者账号后，File → Project Structure → Signing Configs → **Automatically generate signature**，自动生成调试证书+Profile。
  2. **发布**：在 **AGC（AppGallery Connect）** 控制台创建应用 → 申请发布证书与 Profile → 配置进工程。
  3. **ACL 权限**：按官方指引**邮件向华为申请**（说明 bundleName、需要的 ACL 权限、用途），获批后在签名配置里勾选；**未获批前先把 ACL 权限从 module.json5 注释掉**（否则签名/安装报错）。
  4. ⚠️ 商用 HarmonyOS 设备**不认 OpenHarmony 签名**（报错 `The target device does not work with apps with an OpenHarmony signature`），必须用 HarmonyOS 签名。

## 5.2 工程构建类

### Q5. hap-sign-tool 报错：签名失败 / 找不到文件
- **原因**：**签名工具对中文路径/空格敏感**——项目路径、签名文件路径、输出路径含中文时 `hap-sign-tool` 解析失败（上架案例中最常见的坑之一）。
- **解决方案**：
  1. 把**整个工程放到纯英文路径**下（如 `D:\dev\MyApp`，不要 `D:\开发\我的应用`）。
  2. 检查证书文件（.cer/.p12）、Profile（.p7b）文件名与路径均不含中文和空格。
  3. 命令行签名（CI 场景）示例（参数以官方文档为准）：
  ```bash
  java -jar hap-sign-tool.jar sign-app \
    -keyAlias <别名> -signAlg SHA256withECDSA \
    -keystore <keystore路径> -keystorepass <密码> -keypass <密码> \
    -appCertFile <发布证书.cer> -profileFile <profile.p7b> \
    -inFile <unsigned.hap> -outFile <signed.hap>
  ```
  4. 确认执行环境是 JDK 17。

### Q6. TS 编译报错：TS2367 / 找不到类型 'ohos'
- **原因**：三方库或业务代码里硬编码了平台判断，例如 `if (process.platform === 'win32')` 或 `NodeJS.Platform` 类型不含 'ohos'——Electron 鸿蒙版的 TS 类型声明里没有鸿蒙平台枚举，硬编码比较直接编译报错。
- **解决方案**（官方建议）：
  1. **不要硬编码平台字符串**，改用 `process.platform` 动态判断（运行时判断，编译期不报错）：
  ```ts
  const isWin = process.platform === 'win32';
  const isHarmony = process.platform === 'openharmony' || process.platform === 'ohos' || process.platform === 'linux'; // 三个候选值都判断，见 Q26
  ```
  2. 三方库内部若硬编码平台，需 patch 或 fork 修改。
  3. ⚠️ 待核实：`process.platform` 实际返回值官方文档自相矛盾（'openharmony' / 'ohos'），社区实测为 'linux'——**在目标版本上跑 `console.log(process.platform)` 实测后再定判断逻辑**。

### Q7. hvigor 构建失败：JDK 版本不匹配 / 找不到 SDK
- **原因**：①构建机 JDK 非 17；②`build-profile.json5` 的 `compatibleSdkVersion` 与已装 SDK 不匹配；③依赖拉取失败（内网）。
- **解决方案**：
  1. 确认 `java -version` 为 17.x（或让 DevEco 使用内置 JBR）。
  2. 检查 `build-profile.json5`：`"compatibleSdkVersion": "6.0.0(20)"` 等写法要与 SDK 管理器里实际安装的 API 版本一致。
  3. 内网构建：`ohpm install` 拉三方库失败时，配置 ohpm 镜像源或离线仓库（把 `.ohpm` 缓存目录拷到内网机）。
  4. 命令行构建用 `./hvigorw clean` 后再 `./hvigorw assembleHap`（见附录 A）。

### Q8. 权限声明错误：编译报错 / 运行时权限不生效
- **原因**：①权限名拼写错误或该权限不存在于当前 API 版本；②**ACL 权限没拿到证书**（签名失败/安装失败）；③按需权限声明缺少 `reason` 或 `usedScene`。
- **解决方案**：
  1. 权限名从官方权限文档复制，注意版本差异（如 API 23 新增/改名权限）。
  2. 声明格式补全：
  ```json5
  {
    "name": "ohos.permission.MICROPHONE",
    "reason": "$string:reason_mic",          // 弹窗展示的申请原因，必须有
    "usedScene": { "abilities": ["EntryAbility"], "when": "inuse" }
  }
  ```
  3. **ACL 权限先注释掉**，跑通无 ACL 版本，再走邮件申请流程逐个加上（见 Q4）。
  4. 权限字符串资源 `reason_mic` 要写在 `resources/base/element/string.json` 里。

### Q9. 构建时提示找不到某个 npm 依赖 / 二进制包（如 esbuild）无法使用
- **原因**：鸿蒙 Electron 是 ARM64 平台，npm 包里的**预编译二进制（esbuild、node-gyp 产物等）是 x86/Windows 版**，无法加载；纯 JS 依赖没问题。
- **解决方案**：
  1. 区分依赖类型：纯 JS 库 → 直接用；C++ addon（.node）→ 用鸿蒙工具链重编译（见 Q23）；含二进制 CLI 工具 → 走 HNP 方案（见 4.2.3）。
  2. webpack 打包时 `.node` 文件被内联解析 → 配置 `externals` 保留运行时 require。
  3. 替换方案：esbuild → 用纯 JS 的打包器或鸿蒙侧预编译产物。

### Q10. 构建出的 HAP 安装时报"install parse native so failed"
- **原因**：HAP 内包含的 `.so` 架构不匹配（如放了 x86 的 so，或 so 未放对目录），或模拟器兼容问题。
- **解决方案**：
  1. 确认 so 为 **arm64-v8a**，放在 `libs/arm64-v8a/` 目录。
  2. 检查 native 模块是否用鸿蒙工具链重编译（不能直接用 npm 装的原版）。
  3. 模拟器安装失败时（该报错常见于模拟器），**换真机调试**或加 `--disable-gpu`（见 Q13）。

## 5.3 运行调试类

### Q11. 应用启动白屏
- **原因**：常见于①渲染进程未加载成功（资源路径错误）；②GPU/硬件加速在模拟器或特定设备上不可用；③入口页面/路由配置错误。
- **解决方案**：
  1. 原生 ArkTS：检查 `main_pages.json` 路由与 `EntryAbility` 加载的页面是否一致；看 hilog 中是否有页面加载报错。
  2. Electron 鸿蒙版：在壳工程 `WebWindow.ets` 的启动参数里加 `--disable-gpu` 试试（预编译包默认已 `app.disableHardwareAcceleration()`）。
  3. 查看 hilog 定位（见 Q17）：`hilog | grep -i "error\|crash"`。
  4. 确认 `web_engine/src/main/resources/resfile/resources/app` 下业务产物（编译后的 JS）是否齐全。

### Q12. 安装失败：签名不匹配 / INSTALL_PARSE_FAILED
- **原因**：①设备上已装同名应用但签名不同（调试签名 vs 发布签名切换过）；②包名冲突；③OpenHarmony 签名包装到 HarmonyOS 设备。
- **解决方案**：
  1. 先卸载旧包再装：
  ```bash
  hdc app uninstall com.example.myapp
  hdc app install entry-default-signed.hap
  ```
  2. 确认整条链签名一致：DevEco 里用同一个签名配置（Signing Configs）重新构建。
  3. 商用设备必须 HarmonyOS 签名（见 Q4）。
  4. 换包名测试：临时改 `bundleName` 验证是否包名冲突。

### Q13. 模拟器黑屏 / 无法运行
- **原因**：Electron 鸿蒙版**模拟器支持差**：ARM Mac 模拟器跑 PC 应用黑屏、安装报错（`code:9568347, error: install parse native so failed`）；GPU 加速在模拟器不可用。
- **解决方案**：
  1. 首选**真机**调试（鸿蒙 PC 真机）。
  2. 必须用模拟器时：加 `--disable-gpu` / `app.disableHardwareAcceleration()`（预编译包默认已禁用）。
  3. ⚠️ 待核实：部分 2026 年教程显示 DevEco 6.x 的 2in1 模拟器已可演示 Electron 应用，与早期"模拟器不可用"的报告矛盾——**以你当前 DevEco 版本实测为准**。

### Q14. 崩溃后怎么定位？只看得到堆栈顶 `ld-musl-aarch64.so`
- **原因**：native 层崩溃（so/addon 问题）时堆栈常指向 musl 运行库，表面信息不足。
- **解决方案**：
  1. 收集三件套再反馈：**日构建版本号**（如 20241229.1）或 **commit-id**（`git log`）+ **崩溃堆栈**（DevEco 的 crash 保存按钮导出）+ 复现步骤。
  2. 用 hilog 过滤崩溃日志：`hilog | grep -iE "fatal|crash|signal"`。
  3. native 崩溃排查顺序：addon 是否重编译 → so 架构/目录 → 权限是否齐全 → 最小化复现。
  4. 已知问题可对照官方知识地图的"历史问题集"（见附录 B）。

### Q15. 窗口不显示 / 最小化后无法恢复
- **原因**：**窗口显示/隐藏与托盘强绑定**（系统限制）：没创建托盘时窗口行为异常；或注释了 `processMode/startupVisibility` 后行为变化。
- **解决方案**：
  1. 需要托盘：启动时**先创建 Tray 再创建 BrowserWindow**（见 4.2.1 代码）。
  2. 不需要托盘：注释壳工程 `AppWindowAdapter.ets` 的 `processMode` 和 `startupVisibility` 两行（见 4.2.1）。
  3. 窗口尺寸/位置不生效：首窗口只能通过 `module.json5` 的 `metadata`（`ohos.ability.window.width/height/left/top`）配置，**Electron 侧的 setBounds 对首窗口可能无效**。

### Q16. 应用运行卡顿 / JS 性能明显下降
- **原因**：①**坚盾守护模式**（系统高安全模式）下全面禁用 JIT + 暂停 WebAssembly（Wasm 依赖 JIT），JS 性能显著下降；②预编译 Electron 包默认禁用硬件加速，渲染性能有折损。
- **解决方案**：
  1. 确认设备是否开启坚盾守护模式（设置 → 隐私和安全 → 坚盾守护模式）；评估应用在该模式下是否可接受，必要时提示用户。
  2. 检查 Wasm 依赖：静态扫描代码与三方库的 Wasm 使用，在坚盾模式下做全功能测试。
  3. 真机 GPU 可用（模拟器不行）；性能敏感场景优先原生 ArkTS。

## 5.4 网络类

### Q17. hilog 怎么看？日志太多找不到重点
- **原因**：hilog 是系统级日志，默认全量输出。
- **解决方案**：
```bash
hdc hilog -r                                  # 清空缓冲区（再触发问题）
hdc shell hilog | grep -i "myapp\|error"      # 按关键字过滤
hdc shell hilog | grep "<你的包名>"            # 按包名过滤
# DevEco 的 Log 窗口：过滤条件填 包名/Domain/Tag 更直观
```
  常用：`hilog -r` 清空 → 复现 → `hilog | grep 关键字` 抓取。

### Q18. 白屏/请求失败时如何确认是网络还是渲染问题
- **原因**：网络请求失败与渲染失败现象类似。
- **解决方案**：按层排查——
  1. 先看权限：`module.json5` 是否声明 `ohos.permission.INTERNET`（基础权限，声明即可用）。
  2. 看明文 HTTP 配置（Q20）。
  3. hilog 过滤网络域：`hilog | grep -i "network\|http"`。
  4. 用系统自带浏览器/终端 `curl` 验证目标地址可达性，排除服务端问题。

### Q19. 访问 localhost / 127.0.0.1 失败
- **原因**：①应用沙箱与本机服务（终端/融合开发引擎里跑的 Spring Boot）之间的网络通路**无公开结论**（调研报告列为最大不确定性）；②`localhost` 解析在沙箱内可能指向应用自身。
- **解决方案**：
  1. **PoC 必测三连**：`http://localhost:8080`、`http://127.0.0.1:8080`、局域网 IP（如 `http://192.168.x.x:8080`），三种都试。
  2. 检查服务端监听地址：Spring Boot 要监听 `0.0.0.0` 而非 `127.0.0.1`（融合开发引擎 NAT 模式下尤其如此）。
  3. 若沙箱不通：**架构调整**——后端改跑远端/云端，或后端放融合开发引擎后让应用走局域网 IP，或后端逻辑用 ArkTS/NAPI 重写（见 4.2.4 ③）。

### Q20. 明文 HTTP 请求被拦（http 访问失败，https 正常）
- **原因**：鸿蒙默认限制明文 HTTP；API 10+ 需显式配置放行。
- **解决方案**：
  1. API 10 ~ API 22：`AppScope/app.json5` 加 `"network": { "cleartextTraffic": true }`（见 4.2.4）。
  2. **API 23（HarmonyOS 6.1）起**：用 `src/main/resources/base/profile/network_config.json` 的 `cleartextTrafficPermitted`（可全局或按域名）——**两套配置位置不同，别搞混**。
  3. 生产环境强烈建议 HTTPS（应用市场对非 HTTPS 审核更严，且有明文策略不确定性）。

### Q21. 自签名 HTTPS 证书请求失败
- **原因**：自签名证书不被系统信任（开发期常见）。
- **解决方案**：
  1. 开发期可临时忽略证书错误（仅限开发/内网，**切勿用于生产**）：Electron 鸿蒙版启动参数 `--ignore-certificate-errors`（官方明确警告风险）。
  2. 生产方案：用正规 CA 证书（华为云/任意 CA）；或内网部署私有 CA 并把根证书安装到设备信任区 ⚠️ 待核实可行性。
  3. 纯 ArkTS 路线：`http` 模块目前不支持跳过证书校验的通用开关，需用 HTTPS 证书 ⚠️ 待核实。

## 5.5 Electron 迁移类

### Q22. process.platform 到底返回什么？三方库平台判断全乱
- **原因**：官方文档自相矛盾（一处 'openharmony'、一处 'ohos'），社区实测为 'linux'（内核是 Linux 兼容层导致）——**没有统一答案，与版本/构建方式有关**（⚠️ 待核实）。
- **解决方案**：
  1. **不要在代码里硬编码平台**：用 `process.platform` 动态判断，且把三个候选值都当"鸿蒙"处理（见 Q6 代码）。
  2. 逐库排查：凡用 `process.platform`/`os.type()`/`os.platform()` 做判断的三方库（如平台差异的路径、换行符处理），逐个适配。
  3. 迁移前在目标版本真机跑 `console.log(process.platform, process.arch)` 记录实测值，作为适配依据。

### Q23. Node 原生 addon（.node）加载失败：模块不存在 / 段错误
- **原因**：addon 是 C/C++ 编译的，**未适配鸿蒙的原版二进制无法加载**；必须用鸿蒙工具链重编译为 arm64 的 `.node/.so`。
- **解决方案**：
  1. 识别 addon：`npm ls` 找 `node-gyp` 构建的包（sqlite3、serialport、bcrypt 等）。
  2. 用鸿蒙交叉编译工具链（`aarch64-linux-ohos` 目标 clang/llvm，来自 Electron 源码 SDK）重编译，**C++ 标准最低 17**；产物放 `ohos_hap/electron/libs/arm64-v8a/`，修改引入路径。
  3. 参考官方《Electron加载Addon指导文档》（以 node-sqlite3 为例）。
  4. webpack 打包配置 `externals` 保留 `.node` 的运行时 require（见 Q9）。

### Q24. 托盘图标不显示 / 点了没反应
- **原因**：①未先创建 Tray 就创建窗口（显隐与托盘强绑定）；②Tray API 支持率低（10/35），交互事件（double-click、drag/drop、balloon 等）不支持；③托盘图标资源路径错误。
- **解决方案**：
  1. `app.whenReady().then(() => { new Tray(...); ... })`——**保证托盘先于窗口创建**（见 4.2.1）。
  2. 检查图标路径：`path.join(__dirname, 'icon.png')`，图标资源要打进 HAP（rawfile/resources）。
  3. 交互需求超出 Tray 支持范围时，改用**原生 Desktop Extension Kit**（`StatusBarViewExtensionAbility`）实现完整托盘菜单（见 4.2.1）。

### Q25. 文件路径失效：读不到 C:\Users\... / 数据"丢了"
- **原因**：**沙箱隔离**——Windows 绝对路径在鸿蒙上不存在，应用只能读写 `/data/storage/el1|el2`（见 2.2）。
- **解决方案**：
  1. 按 4.2.2 的路径改造清单全局替换。
  2. 用户数据放 `/data/storage/el2/base/files`（Electron 默认 `--user-data-dir` 已映射过去）。
  3. 需要访问下载/文档/桌面等公共目录：ACL 权限 + `systemPreferences.requestDirectoryPermission()` 授权（见 2.4）。
  4. ⚠️ 数据迁移提示：老 Windows 应用的用户数据在**旧设备**上，鸿蒙版无法直接读取——需要设计导入/导出功能（如导出 JSON 再导入）。

### Q26. 暗色模式失效（nativeTheme.themeSource 返回 undefined）
- **原因**：Electron 鸿蒙版对系统主题的适配不完整（社区实测单篇报告，⚠️ 待核实；官方 API 索引 nativeTheme 7/8 支持）。
- **解决方案**：
  1. 兜底轮询系统属性：`execSync('getprop persist.sys.dark_mode')` 判断深浅色。
  2. 或用原生 ArkUI 的 dark 资源限定符实现主题适配（与系统主题自动联动）。
  3. 迁移前在目标真机上实测 `nativeTheme` 各属性行为。

### Q27. autoUpdater 不能用，怎么发新版本
- **原因**：**`autoUpdater` 0/10 全不支持**（官方 API 索引明确），Electron 鸿蒙版没有自更新通道。
- **解决方案**：
  1. 更新走**华为应用市场（AppGallery）**：新版本重新打包签名 → AGC 上传 → 审核通过后市场自动分发更新，用户在应用市场升级。
  2. 应用内可提示"检查更新"：跳转应用市场应用详情页（`am start` 或深链）。
  3. 内部/ToB 场景：不经过市场的更新方案 ⚠️ 待核实（XPM + 签名体系下自建更新通道受限，建议先咨询华为对接人）。

### Q28. shell.openExternal 打开网址没反应（静默失败）
- **原因**：社区实测 `shell.openExternal` 在部分场景静默失败（⚠️ 待核实，单篇实测报告）；系统浏览器拉起机制与 Windows 不同。
- **解决方案**：
  1. 封装兜底：`openExternal` 失败时改用 `exec('am start -a android.intent.action.VIEW -d <url>')`（鸿蒙支持 am 命令拉起意图）。
  2. 或原生侧用 `Want`（`context.startAbility`）拉起浏览器应用。

## 5.6 上架类

### Q29. 上架华为市场需要 ICP 备案吗？审核一般打回哪些点
- **原因/事实**（来自真实上架案例《厨房里的化学》）：**本地单机应用无需 ICP 备案**（无服务器/无经营性内容）；审核流程约 1-2 天。
- **解决方案/经验**：
  1. **高频打回点：审核指南第 3.5 项**（功能/权限/内容相关）——提交前逐条对照审核指南自查。
  2. **PC+Pad 双端权限报错**：若报"权限声明包含仅 2in1 设备使用的权限"——只上 PC 就**删除 pad_entry 模块**；双端都要就**把仅 2in1 使用的权限声明从 web_engine 模块转移到 pc_entry 模块**。
  3. **签名路径不能含中文**（见 Q5）。
  4. 权限声明与**实际使用必须一致**：声明了 ACL 权限却未申请证书、或申请了未使用的权限，都会被拒。
  5. 非 HTTPS 请求审核更严（见 Q20）。
  6. 上架流程：AGC 创建应用 → 填包名/版本 → 上传 HAP/APP → 提交审核 → 发布（Electron 应用已有成功先例，端到端闭环成立）。

# 6. 术语表

> 鸿蒙开发常用术语，按字母序/类别组织。每个一句话解释，配合正文对应章节理解效果更佳。

| 术语 | 一句话解释 | 类比 |
|---|---|---|
| **Ability** | 鸿蒙应用的基本功能单元：UIAbility（窗口入口）与 ExtensionAbility（后台扩展） | Activity / 窗口入口 |
| **UIAbility** | 有界面的 Ability，一个 UIAbility 对应一个窗口任务 | Activity / Electron 主窗口 |
| **ExtensionAbility** | 无界面/常驻的扩展能力（托盘、输入法、壁纸等） | 后台服务 / Electron 托盘进程 |
| **AbilityStage** | 应用级生命周期入口，应用启动最先执行 | Electron `app.whenReady` |
| **Want** | 启动/跳转意图：描述"拉起哪个 Ability、带什么参数" | Android Intent |
| **Stage 模型** | 当前唯一的应用开发模型（Ability 体系）；老的 FA 模型已废弃 | 应用框架规范 |
| **ArkTS** | 鸿蒙应用开发语言：TypeScript 超集，加声明式 UI 装饰器、禁 any/unknown | TS + JSX |
| **ArkUI** | 鸿蒙声明式 UI 框架（组件树 + 状态管理） | SwiftUI / Compose / React |
| **ArkWeb** | 鸿蒙系统 Web 渲染引擎（Web 组件），自研内核 | WebView / WebView2 |
| **NAPI** | Native API：ArkTS 与 C/C++ 互调的标准接口 | JNI / FFI |
| **Kit** | 官方能力包集合（@kit.ArkUI、@kit.NetworkKit 等），SDK 内置 | NuGet 包 / Electron 内置模块 |
| **HAP** | HarmonyOS Ability Package：一个模块的安装包，安装分发最小单元 | EXE/APK |
| **APP** | 应用包：多个 HAP 的集合，上架/分发单元 | .msixbundle |
| **HNP** | HarmonyOS Native Package：可执行二进制打包签名方案（XPM 管控下执行二进制用） | 签名的 EXE 依赖 |
| **hdc** | HarmonyOS Device Connector：设备连接管理命令行工具 | adb |
| **hilog** | 鸿蒙系统日志工具 | logcat / DebugView |
| **hvigor** | 鸿蒙构建系统（hvigorw 为命令行入口） | Gradle |
| **ohpm** | 鸿蒙三方库包管理器 | npm |
| **hap-sign-tool** | HAP 命令行签名工具 | signtool |
| **AGC** | AppGallery Connect：华为开发者后台（应用管理/签名/上架） | 开发者控制台 |
| **DevEco Studio** | 华为官方 IDE（IntelliJ 底座），开发/构建/调试/签名一体 | Visual Studio |
| **2in1** | 双形态设备：PC + 平板（鸿蒙对"桌面设备"的官方叫法，deviceTypes 里写 `2in1`） | — |
| **XPM** | 内核级可执行文件管控：未签名二进制无法执行 | 强制代码签名 |
| **ACL** | 高风险权限的签名授权机制（ACL 权限需向华为申请证书） | 特殊权限 + 证书 |
| **UDMF** | 统一数据定义框架：跨应用拖放/分享的数据交换标准 | 剪贴板数据协议 |
| **沙箱** | 应用文件/进程隔离：只能访问 `/data/storage/el1\|el2` | iOS 容器 / UWP AppContainer |
| **el1 / el2** | 沙箱下两个加密级别：el1 设备级、el2 用户级（用户数据放 el2） | 加密分区 |
| **bundleName** | 应用包名，全局唯一，上架后不可改 | 包名 / AppID |
| **module** | 工程里的一个模块（entry=入口模块，feature=功能模块），一个 module 产出一个 HAP | 项目/子项目 |
| **requestPermissions** | module.json5 里声明权限的字段 | 权限清单 |
| **rawfile** | resources 下"原样打包"的目录（Web 资源、静态文件放这里） | www 目录 |
| **HAR** | HarmonyOS Archive：共享代码/资源的模块包（类似 npm 包但含 ArkUI 组件） | npm 包 / 组件库 |
| **元服务（Atomic Service）** | 免安装的轻量应用形态（installationFree: true） | 小程序 / PWA |
| **自由窗口（freeform）** | PC 上的任意尺寸/位置窗口模式，鸿蒙原生支持 | 桌面窗口 |
| **多实例（multiAppMode）** | 同一应用多开模式，module.json5 配置 | 多开 |
| **坚盾守护模式** | 系统高安全模式：禁用 JIT/Wasm，影响 JS 性能 | 安全模式 |
| **融合开发引擎** | 华为官方 Linux 子系统（openEuler，类似 WSL），2026-04 上线 | WSL |
| **卓易通** | 华为官方安卓兼容工具（跑部分安卓应用） | 安卓模拟器/兼容层 |
| **Oseasy / 铠大师** | 鸿蒙 PC 上的第三方 Win11 ARM 虚拟机 | 虚拟机 |
| **BiShengJDK** | 毕昇 JDK：华为基于 OpenJDK 的发行版；鸿蒙版目前 JDK 8/17 | OpenJDK |
| **PC-Chromium** | OpenHarmony 上独立维护的 Chromium 移植（Electron 用），与 ArkWeb-Chromium 区分 | — |
| **electron-builder 鸿蒙分支** | `@electron-ohos/electron-builder`：出 HAP 的打包工具 | electron-builder |
| **cleartextTraffic** | 明文 HTTP 放行配置（API 10+ 在 app.json5；API 23+ 用 network_config.json） | 网络安全策略 |

---

# 7. 附录

## 附录 A：常用命令速查

> 以下命令在**开发机终端**（Windows/macOS）或**鸿蒙 PC 终端**执行，环境变量配好 DevEco 工具链后可用。各工具具体参数以你安装的 DevEco/SDK 版本为准（本表为常用子集）。

### A.1 hdc（设备连接与安装）

```bash
hdc list targets                       # 列出已连接的设备（真机/模拟器），记下 device serial
hdc -t <serial> shell                  # 进入设备 shell（类 adb shell）
hdc app install <xxx-signed.hap>       # 安装 HAP（必须是已签名的包）
hdc app install -r <xxx.hap>           # 覆盖安装（-r = replace）
hdc app uninstall <bundleName>         # 卸载应用（如 com.example.myapp）
hdc app list                           # 列出已安装应用
hdc fport tcp:9229 tcp:9229            # 端口转发（调试 Electron 主进程用，见 A.3）
hdc hilog -r                           # 清空日志缓冲区
hdc file send <本地文件> <设备路径>     # 传文件到设备
hdc file recv <设备路径> <本地目录>     # 从设备拉文件
```

### A.2 hilog（日志）

```bash
hdc shell hilog                        # 实时输出系统日志（Ctrl+C 退出）
hdc shell hilog -r                     # 清空缓冲区
hdc shell hilog | grep -i error        # 过滤错误
hdc shell hilog | grep <包名或关键字>   # 按关键字过滤
hdc shell hilog -P <pid>               # 按进程号过滤（pid 用 ps -ef 查）
```

### A.3 Electron 主进程远程调试（DevEco 壳工程）

```bash
# 1) 在 ohos_hap/web_engine/src/main/ets/components/WebWindow.ets 的 vec_args 中加入 '--inspect=9229'
# 2) 重新打包安装，然后：
hdc fport tcp:9229 tcp:9229            # 端口转发
# 3) 开发机 Chrome 打开 chrome://inspect → Configure... → 确保 localhost:9229 已配置 → 点击 inspect
```

### A.4 hvigorw（构建）

```bash
./hvigorw clean                        # 清理构建产物
./hvigorw assembleHap                  # 构建 HAP（产物在 entry/build/default/outputs/）
./hvigorw --mode module -p module=entry@default assembleHap   # 指定模块构建
./hvigorw signHap                      # 单独签名（通常 DevEco 自动完成）
# Windows 用 hvigorw.bat
```

### A.5 ohpm（三方库管理）

```bash
ohpm init                              # 初始化 oh-package.json5
ohpm install <包名>                    # 安装三方库（如 ohpm install @ohos/lottie）
ohpm install                           # 按 oh-package.json5 安装全部依赖
ohpm list                              # 列出已安装依赖
# 注意：@kit.* 是 SDK 内置，不要 ohpm install
```

### A.6 鸿蒙 PC 终端（真机侧命令）

```bash
java -version                          # 已安装 BiShengJDK17-OH 时可用（JDK 17）
java -jar app.jar                      # 运行 Java 程序（需先装毕昇 JDK）
uname -a                               # 查看内核信息（鸿蒙内核命令集）
help -a                                # 查看全部可用命令（鸿蒙命令集，非 Windows）
getprop persist.sys.dark_mode          # 查询系统深色模式（暗色适配兜底用）
am start -a android.intent.action.VIEW -d <url>   # 拉起系统浏览器（openExternal 兜底）
```

### A.7 hap-sign-tool（命令行签名，CI 用）

```bash
java -jar hap-sign-tool.jar sign-app \
  -keyAlias <证书别名> -signAlg SHA256withECDSA \
  -keystore <xxx.p12> -keystorepass <密码> -keypass <密码> \
  -appCertFile <证书.cer> -profileFile <profile.p7b> \
  -inFile <input.hap> -outFile <output-signed.hap>
# ⚠️ 所有路径不能含中文/空格；执行环境 JDK 17（详见 Q5）
```

### A.8 Electron 鸿蒙化打包（方案二：electron-builder 鸿蒙分支）

```bash
# 在 Electron 项目 package.json 中配置：
#   "ohos": { "target": "hap", "hvigorwPath": "...", "ohpmPath": "...",
#             "sdkPath": "...", "ohosHapPath": "..." }
npm install @electron-ohos/electron-builder
npm run dist:ohos                      # 直接产出 HAP（不支持自动签名，需 hdc install 手动装）
```

## 附录 B：官方文档入口列表

> ⚠️ **以下链接需要联网才能访问**；公司内网/离线环境下，**以本文档内容为准**。链接路径来自调研报告引用的官方页面（2026-08 快照），页面路径可能随官网改版变化。

**开发入门与 PC 专项**
- 鸿蒙电脑应用开发入门：`developer.huawei.com/consumer/cn/multidevice/pc/get-started/`
- ArkUI 简介：`developer.huawei.com/consumer/cn/doc/doccenter-capabilities/arkui-overview`
- 所有 HarmonyOS 开发套件版本：`developer.huawei.com/consumer/cn/doc/doccenter-release-notes/overview-allversion`
- 窗口模式简介 / 自由窗口：`doccenter-capabilities/window-mode-overview`、`doccenter-capabilities/freeform-window-overview`
- Desktop Extension Kit（系统托盘）：`doccenter-capabilities/statusbar-extension-introduction`
- 拖拽事件（UDMF）：`harmonyos-references/apis-arkui/arkui-ts/ts-universal-events-drag-drop`
- ArkWeb 简介：`harmonyos-guides/web-component-overview`

**Electron 鸿蒙化（论坛官方帖，需登录论坛）**
- 《Electron开发HarmonyOS应用知识地图》（官方总帖）：论坛话题 `0204203363319759021`
- 《Electron框架HarmonyOS开发指导》（官方账号"HarmonyOS技术支持"）：论坛话题 `0204189796759316140`
- 《已有Electron项目，如何适配HarmonyOS PC》（版本矩阵/五步迁移/TS 报错对照）：论坛话题 `0202206298304106575`
- 官方源码仓：`gitcode.com/openharmony-sig/electron`（含 1294 API 索引、HNP/子进程/Addon/Deeplink 全套文档）
- 预编译 Release 包：华为云 CodeHub（需华为云账号登录下载）

**签名 / 权限 / 沙箱**
- 应用签名（DevEco Studio）：`harmonyos-guides/ide-signing`
- 应用沙箱目录：OpenHarmony docs `app-sandbox-directory`（docs.openharmony.cn）
- 明文 HTTP 配置（network_config.json，API 23 起）：官方文档搜 "network_config"（路径随版本变化）

**后端 / Java 相关**
- 华为「融合开发引擎（Linux 子系统）」支持页（FAQ：systemctl/docker/网络模式）：`consumer.huawei.com/cn/support/content/zh-cn16091898/`
- 鸿蒙 PC 对 JDK 21 及以上版本的支持路线图（华为论坛问答）：话题 `0208214238763794004`
- openEuler 毕昇 JDK（Linux 版支持 8/11/17/21）：`openeuler.org/en/other/projects/bishengjdk/`

**上架**
- AGC 云函数文档：`doc/appgallery-connect-Guides/...`（上架/签名相关在 AGC 控制台内）

---

## 附录 C：给迁移团队的三条行动建议（总结）

1. **先做 2 周 PoC，再排迁移计划**。PoC 必测四项：①应用能否在目标真机安装运行（签名链通不通）；②前端依赖的 Electron API 在鸿蒙版的可用性（对照第 4 章表格逐个过）；③沙箱内能否访问本机 Spring Boot（localhost/127.0.0.1/局域网 IP 三连测，这是最大不确定性）；④每个 C++ addon 能否重编译。
2. **按"依赖审计 → 平台/路径适配 → addon 重编译 → HAP 重组 → 真机调试"五步走**（官方迁移方法论）。预算 1-3 个月工作量（视 Native 依赖多寡）；纯 JS 应用会快很多。
3. **后端降级或外置**：鸿蒙原生只有 JDK 8/17；要 JDK 21 就把后端放融合开发引擎（本机 openEuler 子系统）或云端；**不要押注"毕昇 JDK 直接在鸿蒙上跑完整 Spring Boot"**（官方自己都不推荐用 JDK 原生网络/IO，且无成功公开案例）。

---

*本文档基于工作区调研报告整理（《HarmonyOS_PC_Electron_SpringBoot_可行性调研报告》《harmonyos-pc-dev-alternatives-report》《research/Electron鸿蒙化调研报告》《harmonyos-java-backend-research》），信息截至 2026-08。标注「⚠️ 待核实」的条目请在目标真机/目标版本上实测后再做技术决策。*


