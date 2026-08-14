# Windows Electron 应用迁移至 HarmonyOS PC 完整方案（JDK17 降级 + C++ exe）

> 版本：v1.0
> 适用对象：有 Electron + Java（Spring Boot）经验、无鸿蒙开发经验的团队
> 目标环境：公司内网、网络受限，本文档**自包含、可离线照做**
> 事实依据：工作区调研素材——《HarmonyOS_PC_Electron_SpringBoot_可行性调研报告.md》（下称《可行性报告》）、《research/Electron鸿蒙化调研报告.md》（下称《Electron调研报告》）、《harmonyos-java-backend-research.md》（下称《Java后端调研报告》）、《harmonyos-pc-dev-alternatives-report.md》（下称《替代方案报告》）、官方仓库 README 快照《research/rawgitcode_electron_readme.md》（下称《官方README》）、官方 HNP 文档快照《research/hnp打包与fork指导文档.md》（下称《HNP文档》）、五步迁移 FAQ 快照、三篇实战迁移文章（Electron35 迁移、markdownify 迁移、上架实录）。所有"⚠️ 需实测/未验证"均来自素材中的待核实项，请勿当作已证实结论。
>
> 重要前提（务必先读）：
> 1. **Windows .exe 无法在鸿蒙 PC 直接运行**——鸿蒙 NEXT 无 Wine、无 WSL，不兼容 Windows/Linux ELF 生态（《可行性报告》§3.1）。Electron 官方二进制同样不能直接跑。
> 2. **存在官方「Electron 鸿蒙化」方案**：`openharmony-sig/electron` 于 2025-06 开源，是 Chromium 源码级移植（非换 ArkWeb），官方明确"现有 Electron 项目适配 HarmonyOS 是完全可行的"，但也警告"如果您在其他平台未使用过此框架，不建议您直接使用该框架"（《Electron调研报告》§1.2、§摘要）。**本方案即为该官方路线，属前沿探索，预算需留足试错空间。**
> 3. **JDK21 无鸿蒙原生支持**，官方仅提供毕昇 JDK 8/17（应用市场可装）。本方案默认**降级 JDK 17**；若强依赖 JDK21 特性（虚拟线程/FFM），第 4.3.2 节给出"融合开发引擎"路径。
> 4. 官方 API 支持率约 **77%（998/1294）**，autoUpdater 等完全不可用，托盘/系统偏好等残缺——第 3 章逐个给出适配法。

---

## 目录

- [0. 迁移总览](#0-迁移总览)
- [1. 前置评估与清单](#1-前置评估与清单)
- [2. 环境搭建（离线准备最重要）](#2-环境搭建离线准备最重要)
- [3. Electron 前端迁移（核心章节）](#3-electron-前端迁移核心章节)
- [4. JDK17 后端迁移](#4-jdk17-后端迁移)
- [5. C++ exe 迁移（关键章节）](#5-c-exe-迁移关键章节)
- [6. 工程配置与构建](#6-工程配置与构建)
  - [6.6 完整实操路径：模板导入 → 前后端产物组合 → 构建 HAP](#66-完整实操路径模板导入--前后端产物组合--构建-hap)
- [7. 测试与调试](#7-测试与调试)
- [8. 上架（可选章节）](#8-上架可选章节)
- [9. 风险清单与应急预案表](#9-风险清单与应急预案表)
- [10. 附录](#10-附录)

---

# 0. 迁移总览

## 0.1 目标架构图

迁移后的目标形态（MVP 阶段"终端手动启动后端"，见 0.3）：

```
┌────────────────────────────────────────────────────────────────────┐
│                        鸿蒙 PC（HarmonyOS 6.x / 麒麟 X90 ARM64）        │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ HAP 应用（Electron 鸿蒙版，HAP 安装包，运行在应用沙箱内）          │  │
│  │                                                             │  │
│  │  ┌─────────────────┐      ┌─────────────────────────────┐  │  │
│  │  │ Chromium 渲染进程 │◄────►│ Node.js 主进程（libelectron.so）│  │  │
│  │  │ React/Vue 业务 UI │  IPC │ fs/net/child_process 等能力   │  │  │
│  │  └─────────────────┘      └───────────┬─────────────────┘  │  │
│  │                                       │                    │  │
│  │                     spawn/exec（HNP 签名包，绕过 XPM 拦截）      │  │
│  │                                       │                    │  │
│  │  ┌────────────────────────────────────▼─────────────────┐  │  │
│  │  │ C++ 工具（原 Windows exe → OHOS ARM64 ELF，HNP 打包）     │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────┬───────────────────────────────────────────┘  │
│                  │ HTTP(S) localhost:8080（⚠️ 沙箱内访问本机服务       │
│                  │        需实测，见 4.6）                          │
│  ┌───────────────▼───────────────────────────────────────────┐  │
│  │ Spring Boot 后端（JDK17，BiShengJDK17-OH，终端独立进程启动）      │  │
│  │   └── JDBC ──► 数据库（⚠️ JDBC 是最大不确定点，见 4.4）          │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

关键技术事实（出处）：
- Electron 鸿蒙版 = `libelectron.so + libadapter.so + libffmpeg.so + ArkTS 壳工程(ohos_hap)`，最终打成 HAP（《Electron调研报告》§2.1、《官方README》）。
- Node.js 主进程能力保留（fs/net/child_process），但受沙箱约束；执行外部二进制需先打 **HNP 包**（《Electron调研报告》§2.1、《HNP文档》前言）。
- 应用沙箱内文件只能读写 `/data/storage/el1|el2/...`；`app.getPath('userData')` 默认映射 `/data/storage/el2/base/files`（《官方README》§鸿蒙内的路径、《可行性报告》§3.4）。

## 0.2 迁移决策要点（决策前必读）

| # | 决策点 | 本方案默认选择 | 依据 / 备注 |
|---|---|---|---|
| D1 | Electron 版本 | **Electron 34（Chromium 132 / Node 20.18.1）** | 当前官方主流预编译版，官方版本矩阵：E25(C114/Node18)、**E34(C132/Node20.18.1)**、E37(C138/Node22.16.0)（《Electron调研报告》§2.4）；预编译包 `v34.6.3-20260105.1-release.zip` 免编译可直接用（《Electron调研报告》§2.3） |
| D2 | 前端框架 | 保留现有 React/Vue 技术栈，仅做平台适配 | 官方五步方法论：业务代码最大程度复用（《Electron调研报告》§2.2、Electron35 迁移文） |
| D3 | 后端 JDK | **降级 JDK 17（BiShengJDK17-OH）** | JDK21 无鸿蒙原生支持（《可行性报告》§4.1、《Java后端调研报告》§0）；Spring Boot 3.x 全系最低 Java 17（《Java后端调研报告》§3.2） |
| D4 | 后端运行形态 | **MVP 用形态①（终端手动启动）**；如需 JDK21 升级为形态②（融合开发引擎） | 四条路径见第 4.3 节（《Java后端调研报告》§2） |
| D5 | C++ exe 路线 | **路线 A：编译为独立 OHOS ARM64 ELF + HNP 打包，Electron spawn 调用**（若 exe 是独立工具）；逻辑库型选路线 B（addon） | 四条路线对比见第 5.2 节；官方 HNP fork 指南为本路线官方依据（《HNP文档》） |
| D6 | 打包方式 | DevEco Studio 方案一（手动壳工程）为主；`@electron-ohos/electron-builder` 方案二为备选 | 官方工具链清单（《Electron调研报告》§2.3）；升级文档推荐方案二（upgrade_readme.md） |
| D7 | 应用更新 | **不走 autoUpdater（0/10 全不支持），走华为应用市场** | 《Electron调研报告》§4.1、《可行性报告》§3.3 |
| D8 | 硬件加速 | 接受**默认禁用硬件加速**（预编译包自带 `app.disableHardwareAcceleration()`） | 《可行性报告》§3.4、《Electron调研报告》§4.6；模拟器白屏时还需改 `CommandLineAdapter.ets` 的 `--use-gl`（markdownify 迁移文） |
| D9 | 上架 | 目标为**上架华为 PC 应用市场**（已有成功先例） | 《厨房里的化学》上架实录（《可行性报告》§3.5、csdn_shangjia.txt） |

## 0.3 MVP 路径（先跑通前端 → 再加后端 → 再加 C++ 工具）

按"每次只引入一个不确定变量"的原则分三阶段推进：

```
阶段 M1（前端跑通）        阶段 M2（后端跑通）          阶段 M3（C++ 工具跑通）
┌─────────────────┐      ┌─────────────────────┐      ┌───────────────────────┐
│ 官方示例 HAP 跑通  │      │ 毕昇JDK17 终端跑通       │      │ C++ 交叉编译出 ELF      │
│ (hello world)    │      │ java -version        │      │ (aarch64-linux-ohos)  │
│        ▼         │      │         ▼            │      │          ▼            │
│ 自有前端打包进壳工程 │      │ fat-jar 冒烟测试        │      │ HNP 打包 + 壳工程集成    │
│ (无 Node 依赖)    │      │ (NIO/TLS/JDBC ⚠️)    │      │ (hnpcli pack)         │
│        ▼         │      │         ▼            │      │          ▼            │
│ 逐步放开 Electron  │      │ 前后端联调             │      │ Electron spawn 调用     │
│ API 适配清单      │      │ (沙箱访问 localhost⚠️) │      │ (XPM 拦截问题排查)      │
└─────────────────┘      └─────────────────────┘      └───────────────────────┘
   里程碑 M1           里程碑 M2                    里程碑 M3
```

- **里程碑 M1（约 1-2 周）**：拿到预编译包 → DevEco 打开 ohos_hap → 真机/2in1 模拟器跑通官方示例 → 把自己的前端构建产物（纯静态、不依赖 Node API）放入 `resources/app` 跑通 → 达到"界面能在鸿蒙 PC 显示"。
- **里程碑 M2（约 1-2 周）**：后端 fat-jar 在毕昇JDK17 上完成冒烟测试（4.4 清单）→ 前端通过 HTTP 调用后端。⚠️ 本阶段含整个方案最大未知点：JDK 网络层在鸿蒙的适配 + 沙箱访问本机端口。
- **里程碑 M3（约 2-4 周）**：C++ 工具源码交叉编译 → HNP 打包 → Electron 主进程拉起 → 全链路回归。

## 0.4 里程碑计划（含工作量估计）

| 里程碑 | 内容 | 前置 | 工期（1 人） | 验收标准 | 阻塞风险 |
|---|---|---|---|---|---|
| P0 环境准备 | DevEco/SDK/预编译包/账号/真机 | 内网下载通道打通 | 3-5 天 | 官方示例 HAP 上真机 | 下载渠道权限（需华为云账号） |
| M1 前端跑通 | 前端产物进壳工程 + 适配清单执行 | P0 | 1-2 周 | 主界面显示、主要交互可用 | Electron API 缺失、白屏 |
| M2 后端跑通 | JDK17 + fat-jar + 联调 | P0 | 1-2 周 | 4.4 冒烟全过、前端调通后端 | **JDK 网络层适配（最大风险）** |
| M3 C++ 工具 | 交叉编译 + HNP + 调用 | M1、源码可得 | 2-4 周 | exe 等价功能在鸿蒙执行 | XPM 拦截、Win32 API 适配面 |
| M4 打磨上架 | 权限/签名/上架 | M1-M3 | 1 周 | AGC 上架通过 | 审核 3.5 项打回 |

总量预估：**4-8 人周**（视 Node 原生模块与 C++ 工具源码复杂度浮动；官方口径"视 Native 依赖多寡，预算 1-3 个月"（《可行性报告》§7 场景 2））。

---

# 1. 前置评估与清单

> 开工前用 1-2 天把下面的盘点做完，结果直接决定 M1-M3 的工作量分配。**第 2 章的离线下载清单应与本节并行启动**（下载通道往往是内网环境最长的前置链路）。

## 1.1 现有应用资产盘点表

| 资产类别 | 盘点项 | 需要记录的信息 | 对迁移的影响 |
|---|---|---|---|
| **前端依赖** | `package.json` dependencies 全部条目 | 版本号、是否纯 JS | 纯 JS 直接可用；平台判断类需适配（3.3） |
| **Node 原生模块** | 含 `.node`/`.so`/`binding.gyp` 的包（如 sqlite3、serialport、ffi-napi、bcrypt、canvas、sharp、node-pty 等） | 包名、版本、C++ 依赖、是否有源码 | **必须用鸿蒙工具链重编译**（3.7），每个模块是独立工作量 |
| **含二进制 npm 包** | 自带预编译二进制/平台专属文件的包（esbuild、electron、@swc/core、rollup native、puppeteer 的 chromium 等） | 包名、用途（构建期 or 运行期） | 构建期的可留在开发机；**运行期的需走 HNP 或替换**（3.8） |
| **主进程代码** | main.js/ts、preload、IPC 通道清单 | 用到的 Electron API 清单 | 对照第 3.3 节适配清单逐项检查；API 支持率见《Electron调研报告》§4.1 |
| **渲染进程代码** | 是否依赖 Node/Electron API（nodeIntegration、remote） | 使用点 | 推荐改 preload + contextBridge 安全模式（markdownify 迁移文） |
| **Java 依赖** | `pom.xml`/`build.gradle` 全部依赖 | 版本、是否含 JNI 本地库 | 纯 Java 可直接跑；**JNI 库（JDBC 驱动、加密库等）需逐个适配**（《Java后端调研报告》§1.3-2）；版本降级风险见 4.2 |
| **Java 代码对 JDK21 的依赖** | 虚拟线程（`Thread.ofVirtual`）、FFM（`java.lang.foreign`）、Record Patterns、`SequencedCollection` 等 | 使用点清单 | 决定降级工作量；虚拟线程是 3.2+ 可配置特性，降级需改回平台线程（4.2） |
| **C++ 工具** | **源码可得性（最关键）**、构建系统（CMake/MSBuild）、依赖库（Boost/OpenSSL 等）、Win32 API 使用面 | 源码路径、依赖清单、`CreateFile`/`GetSystemInfo`/注册表/剪贴板等调用点 | 无源码则走 5.5 应急方案；Win32→POSIX 适配面见 5.4 |
| **数据库/外部依赖** | 后端连接的数据库类型、驱动 | 驱动是否含 JNI（如某些国产加密驱动） | JDBC 是冒烟测试重点（4.4） |
| **数据与配置** | 用户数据存放路径、配置文件、注册表使用 | 路径/键清单 | 全部迁入沙箱路径（3.3-3）；注册表需改文件存储（5.4） |
| **打包与 CI** | electron-builder 配置、CI 脚本 | 平台 target | `asar:false`、删 devDependencies（3.5）；CI 需替换为鸿蒙构建流水线 |

## 1.2 风险点预判（开工前让相关方签字确认）

| 风险 | 等级 | 说明 | 预案位置 |
|---|---|---|---|
| R1 JDK21 缺失（原生） | 🔴 高 | 原生仅 JDK8/17；JDK21 无时间表（《可行性报告》§5.3-1） | 4.2 降级 / 4.3.2 融合开发引擎 |
| R2 Electron 鸿蒙化成熟度 | 🔴 高 | API 覆盖约 77%、bug 多、仅 arm64、编译链重（《可行性报告》§5.3-2） | 3.x 全章适配法 + 9 应急预案 |
| R3 Native 依赖适配 | 🟠 中高 | npm addon 与 Java JNI 都要逐个重编译（《可行性报告》§5.3-3） | 3.7、4.5 |
| R4 沙箱与 XPM | 🟠 中高 | 文件限沙箱目录；二进制执行需 HNP 签名；部分权限需 ACL 证书（《可行性报告》§5.3-4） | 5.3、6.2 |
| R5 **本机服务互访未知** | 🔴 高 | 沙箱↔本机 Spring Boot 网络通路、端口监听无公开结论，**方案最大不确定性**（《可行性报告》§5.3-5、《Java后端调研报告》§6-1/2） | **4.4 冒烟测试必须最先做**；失败走 4.3.2/4.3.3 |
| R6 签名与上架 | 🟠 中 | HAP 需华为证书/ACL；上架审核 1-2 天（《可行性报告》§5.3-6） | 6.3、8 |
| R7 版本演进绑定 | 🟠 中 | 鸿蒙系统、Electron 鸿蒙版、毕昇 JDK 三方都在快速变动（《可行性报告》§5.3-7） | 10.3 版本快照记录 |

---

# 2. 环境搭建（离线准备最重要！）

> 内网环境的第一原则：**所有需要联网的东西一次性下载齐全**，再开始搭环境。建议下载工作交给一名成员在可联网机器（或有代理的跳板机）完成，其余人并行做 1.1 资产盘点。
> ⚠️ 涉及"华为云 CodeHub / 华为开发者联盟 / AGC"的下载需要华为账号（个人可注册，免费）；若公司无代理出口，需提前申请审批，这部分是内网环境的主要前置时间。

## 2.1 开发机环境（按顺序安装）

### 2.1.1 最低配置

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 或 macOS（arm 芯片）或 Ubuntu 22.04 | 使用预编译包方案，开发机不做 Chromium 编译，16G 内存即可（《踩坑实录》§1.1 方式二） |
| 磁盘 | ≥ 10GB 空闲 | 预编译包 + DevEco + SDK |
| DevEco Studio | **6.0.0+（建议 6.1.x）** | 官方示例要求 DevEco Studio 6.0.0+（《可行性报告》§3.4） |
| HarmonyOS SDK | **API 20+（建议 API 23 / HarmonyOS 6.1.0）** | 文件拖放 `webUtils.getPathForFile` 等要求 API 20+（《Electron调研报告》§4.4） |
| Node.js | **20.18.1** | 与 Electron 34 内置 Node 版本一致（《Electron调研报告》§2.4），避免原生模块 ABI 不一致 |
| JDK | **JDK 17（仅用于 DevEco/hvigor 构建）** | DevEco 构建基于 JDK 17，非 17 会编译失败（《Java后端调研报告》§1.1） |
| hdc | DevEco SDK `toolchains` 目录内 | 命令行安装/调试 HAP 用 |
| 终端设备 | 鸿蒙 PC（HarmonyOS 6.0+）或 2in1 平板/模拟器 | 仅 arm64-v8a（《可行性报告》§3.2） |

### 2.1.2 安装步骤（命令完整可复制）

1. **安装 JDK 17**（构建用；注意与鸿蒙设备端运行用的毕昇 JDK 是两回事，见 4.1）。Windows 可下载 Temurin 17 LTS（https://adoptium.net/temurin/releases/?version=17），安装后验证：
   ```bat
   java -version
   :: 期望输出以 17.x 开头，例如：openjdk version "17.0.13" 2024-10-15
   ```

2. **安装 Node.js 20.18.1**（Windows 用官方 msi 或 nvm-windows；macOS 用 nvm）：
   ```bash
   node -v   # 期望 v20.18.1
   npm -v    # 期望 10.x
   ```

3. **安装 DevEco Studio 6.x**：
   - 下载：https://developer.huawei.com/consumer/cn/deveco-studio/ （需登录华为开发者账号）
   - 安装时勾选安装 HarmonyOS SDK 与 DevEco 自带工具链（hvigor、ohpm、hdc）。
   - 在欢迎页 → SDK Manager 中确保 SDK 版本 ≥ API 20（推荐 API 23 与 HarmonyOS 6.1.0 配套；版本对照见《替代方案报告》§1.1）。
   - ⚠️ 若内网无法在线下载 SDK：在可联网机器下载 SDK 离线包（DevEco 官网提供 SDK 包下载），拷贝到开发机后通过 SDK Manager 的"导入本地 SDK"功能导入。

4. **验证 hdc**（Windows 将 `<DevEco安装目录>\sdk\default\openharmony\toolchains` 加入 PATH）：
   ```bash
   hdc --version          # 期望输出 hdc 版本号
   hdc list targets       # 设备连接后应列出设备序列号/地址
   ```

## 2.2 离线/受限网络准备清单（最重要的一节）

> 下表所有条目**必须在开工前于可联网机器下载完毕**，随 U 盘/内网共享/文件服务器带入开发环境。每项标注来源 URL 与账号要求。完整汇总表见 10.1 附录。

| # | 软件/资源 | 版本/命名 | 来源 URL（下载点） | 账号要求 | 备注 |
|---|---|---|---|---|---|
| 1 | DevEco Studio 安装包 | 6.1.x 全平台安装包 | https://developer.huawei.com/consumer/cn/deveco-studio/ | 华为开发者账号 | 同时可用于提取 SDK/工具链 |
| 2 | HarmonyOS SDK（离线） | API 20+/23 | DevEco 官网 SDK 下载页（同 DevEco 下载区） | 华为开发者账号 | 若 SDK Manager 在线下载不可用则走离线包 |
| 3 | **Electron 鸿蒙版预编译包** | `v34.6.3-20260105.1-release.zip`（约数百 MB） | 华为云 CodeHub：https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home | **华为云账号** | 免编译直接开发（《Electron调研报告》§2.3）；内网重点资源，**放第一位下载**。✅ **本地已有等价离线副本**：`templates/ohos_electron_hap-main/`（E34 运行时，Chromium 132/Node 20.18.1，见 6.6.1 来源 A），无华为云账号可先用它跑通流程，正式开发再核对官方包 |
| 4 | Node.js 安装包 | `node-v20.18.1`（win-x64 / macos-arm64 / linux-x64） | https://nodejs.org/dist/v20.18.1/ 或镜像 https://npmmirror.com/mirrors/node/ | 无 | |
| 5 | JDK 17（构建用） | Temurin 17 LTS | https://adoptium.net/temurin/releases/?version=17 | 无 | |
| 6 | npm 依赖离线包 | 你的前端全部 dependencies（**不含 devDependencies 的"运行期"依赖全集**） | 见 2.2.1 `npm pack` 方案 | 无 | 含鸿蒙所需三方库源码包 |
| 7 | `@electron-ohos/electron-builder` | 26.8.x | https://www.npmjs.com/package/@electron-ohos/electron-builder | 无 | 备选打包方案（方案二）用 |
| 8 | Maven 依赖离线仓库 | 后端全部依赖 + 插件 | 见 2.2.2 | 无 | 拷贝 `~/.m2/repository` |
| 9 | 毕昇 JDK 17-OH | BiShengJDK17-OH | **鸿蒙应用市场**（设备端搜索安装，无需离线包） | 华为账号 | 设备端安装，见 4.1 |
| 10 | 鸿蒙交叉编译工具链 | `aarch64-linux-ohos` 目标 clang/llvm | DevEco SDK native 目录（`sdk/default/openharmony/native/llvm/bin`）或 Electron 源码 `src/ohos_sdk/...` | — | 一般随 DevEco/SDK 自带，无需单独下载；⚠️ 预编译包方案下该工具链的来源与版本匹配需实测（5.3.1） |
| 11 | 官方文档离线快照 | 官方 README/API 索引/各指导文档 | gitcode.com/openharmony-sig/electron 克隆或打包下载 | GitCode 账号可选 | 本文档已集成大部分；建议整仓 clone 留档 |
| 12 | （备选）Ubuntu 22.04 | ISO + apt 离线包 | 清华镜像 https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/ | 无 | 仅当需要源码编译 Electron 时（2.4） |
| 13 | 华为签名材料 | p12 私钥、cer 证书、p7b profile | AGC 在线生成下载（需联网） | **华为开发者联盟账号** | 见 6.3；**存储路径不能含中文**（《厨房里的化学》上架实录） |

### 2.2.1 npm 依赖离线缓存方案（选一）

**方案 A：`npm pack` 逐包打包（推荐，简单可靠）**
在可联网机器上，对 `package.json` 的全部 dependencies 执行：
```bash
# 1) 生成完整依赖清单（含传递依赖）
npm install --ignore-scripts     # 先装一遍以解析 lockfile
# 2) 逐包打成 tgz（含生产依赖全树）
npm pack --pack-destination ./offline-npm $(node -e "
  const l=require('./package-lock.json');
  const pkgs=[];
  (function walk(n){for(const [k,v] of Object.entries(n.packages||{})){
    if(v.resolved&&!pkgs.includes(k))pkgs.push(k);
  }})(l);
  console.log(pkgs.filter(p=>!p.startsWith('node_modules/')).join(' '));
")
# 3) 将 ./offline-npm 目录整体拷入内网
```
内网机器安装：
```bash
# 逐个安装（注意顺序：先装无依赖的会被 npm 自动解决，直接全部给即可）
npm install ./offline-npm/*.tgz --ignore-scripts
# 或写个脚本循环安装
for f in offline-npm/*.tgz; do npm install "$f" --save --ignore-scripts; done
```

**方案 B：verdaccio 内网私有仓库（适合多人团队）**
```bash
# 可联网机器安装并缓存
npm install -g verdaccio
verdaccio                  # 默认 4873 端口
npm set registry http://<内网服务器>:4873
# 在可联网机器预拉取：
npm cache add <pkg>@<ver>   # 预热缓存
```
内网机器统一 `npm set registry http://<内网服务器>:4873` 后正常 `npm install` 即可。

⚠️ 注意：**原生模块（addon）不能用 `--ignore-scripts` 跳过编译就完事**——鸿蒙侧需要的是源码 + 鸿蒙工具链重编译产物（3.7），因此离线包里必须保留源码与 `binding.gyp`（不要只拷预编译产物）。

### 2.2.2 Maven 依赖离线方案

```bash
# 可联网机器上，在项目根目录执行：
mvn -DskipTests dependency:go-offline
# 或全量拉取（含插件）：
mvn -DskipTests -Dmaven.repo.local=./offline-m2 dependency:resolve-plugins dependency:resolve
# 然后将整个 ~/.m2/repository（或 ./offline-m2）拷贝进内网

# 内网机器：把仓库目录放好后，构建/打包时使用
mvn -o -Dmaven.repo.local=/path/to/repository clean package
# -o = offline 模式，不会尝试联网
```

⚠️ JNI 类 Java 库（含 `.so/.dll` 的驱动/加密库）离线包也要保留**源码或可重编译材料**，鸿蒙 ARM64 上可能需重编译（4.5）。

### 2.2.3 华为云 CodeHub 预编译包下载说明

1. 使用华为云账号登录上述 CodeHub 项目主页。
2. 在 Releases/产物区找到形如 `v34.6.3-20260105.1-release.zip` 的文件下载（版本号以官方实际发布为准）。
3. 解压后应包含：
   - `ohos_hap/` —— 鸿蒙壳工程（DevEco 直接打开）
   - `libelectron/`（或 `electron/`）—— 运行时产物（`libelectron.so`、`libadapter.so`、`libffmpeg.so`、`electron`、`icudtl.dat`、`v8_context_snapshot.bin`、`*.pak`、`locales/`）
   - 官方内置 `app.disableHardwareAcceleration()` 等开箱配置（《Electron调研报告》§2.3）
4. ⚠️ 若早期某些资源标注"内测权限"，需要联系官方/申请权限（《Electron调研报告》§2.3）；当前 2026 年版本一般可直接下载。

## 2.3 真机准备

| 步骤 | 操作 | 说明 |
|---|---|---|
| 1 | 准备设备 | 鸿蒙 PC（HarmonyOS 6.0+，麒麟 X90）或 2in1 平板；**必须 arm64**（x86 不支持，《可行性报告》§3.2） |
| 2 | 开启开发者模式 | 设置 → 关于本机 → 连续点击版本号 → 开启开发者选项；再在开发者选项中打开"USB 调试/开发者调试" |
| 3 | 连接 | USB 连开发机，`hdc list targets` 能看到设备；无线调试可 `hdc tconn <设备IP>:5555` |
| 4 | 注册签名账号 | 华为开发者联盟注册（https://developer.huawei.com/consumer/cn/ ），实名认证；开发期用**自动签名（调试证书）**即可（6.3） |
| 5 | （上架才需要）AGC 项目 | AGC 控制台创建应用、获取 bundleName、申请正式证书/Profile（6.3、8） |
| 6 | （设备端）安装毕昇 JDK | 鸿蒙应用市场搜 "BiShengJDK17-OH" 安装（4.1）；⚠️ 同一设备只能装一个 JDK 版本（《可行性报告》§4.1） |

⚠️ 模拟器说明：2in1 模拟器可用但**支持差**——安装报错（`code:9568347, error: install parse native so failed`）、白屏（需 `--disable-gpu`）等已知问题（《Electron调研报告》§4.3）；2026 年也有教程在 2in1 模拟器演示成功（待核实 8）。**建议直接准备真机**，模拟器仅作无真机时的兜底。

## 2.4 备选：Ubuntu 22.04 交叉编译环境（仅当不用预编译包时）

> 官方源码编译仅用于：① 修改 Electron 框架源码；② 需要自行产出未发布版本；③ 预编译包下载渠道拿不到。**默认走 2.2 预编译包，本节作为备选。**

要求（官方 README）：**Ubuntu 22.04、磁盘 >200GB（官方建议 200-300G）、内存 >32GB、x86_64 CPU**（《官方README》§环境配置）。

完整步骤（命令可复制，来源于《官方README》§源码与工具下载安装 + 《踩坑实录》）：

```bash
# 1) 基础工具（首次拉代码需要）
sudo apt update && sudo apt install -y git-lfs ccache curl python3 python3-pip

# 2) repo 工具（多仓管理）
mkdir -p ~/bin
curl https://gitee.com/oschina/repo/raw/fork_flow/repo-py3 > ~/bin/repo
chmod a+x ~/bin/repo
echo 'export PATH=~/bin/:$PATH' >> ~/.bashrc && source ~/.bashrc
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple requests

# 3) Node.js 20.18.1（nvm 方式）
git clone https://gitee.com/mirrors/nvm && cd nvm && bash install.sh && source ~/.bashrc
nvm install 20.18.1 && nvm use 20.18.1 && node -v

# 4) 拉取源码（数十 GB，网络须稳定，可断点重试）
git clone -b master https://gitcode.com/openharmony-sig/electron.git
cd electron
git lfs pull
repo init -u https://gitcode.com/openharmony-tpc/manifest.git -b pc_chromium_132 -m chromium.xml --no-repo-verify
repo sync -c                       # 可多次执行直至成功
repo forall -c 'git lfs pull'      # 可多次执行

# 5) 应用补丁
pushd src && find -name "*.git*" -exec rm -rf "{}" \; && popd
chmod +x override_files.sh && ./override_files.sh

# 6) 安装编译依赖（仅首次）
sudo ./src/build/install-build-deps.sh --no-chromeos-fonts

# 7) 编译（1-2 小时，取决于硬件；报 rust-toolchain.tar.gz 缺失=网络问题，重跑 override_files.sh 后 rm -rf src/out 再编译）
./electron_build.sh
```

产物输出在 `src/out/musl_64/`：`locales/`、`libelectron.so`、`electron`、`resources.pak`、`chrome_100_percent.pak`、`chrome_200_percent.pak`、`icudtl.dat`、`libadapter.so`、`libffmpeg.so`、`v8_context_snapshot.bin`（《官方README》§输出结果）。

拷贝脚本（《官方README》原文，`source_path` 改成自己的路径）：
```sh
#!/bin/sh
source_path=./Electron实际目录/src/out/musl_64
destination_path=./electron
if [ -d ${destination_path} ];then rm -rf ${destination_path}; fi
mkdir ${destination_path}
cp ${source_path}/libelectron.so ${destination_path}
cp ${source_path}/libffmpeg.so ${destination_path}
cp ${source_path}/libadapter.so ${destination_path}
cp ${source_path}/electron ${destination_path}
cp ${source_path}/icudtl.dat ${destination_path}
cp ${source_path}/v8_context_snapshot.bin ${destination_path}
cp ${source_path}/chrome_100_percent.pak ${destination_path}
cp ${source_path}/chrome_200_percent.pak ${destination_path}
cp ${source_path}/resources.pak ${destination_path}
mkdir ${destination_path}/locales
cp ${source_path}/locales/zh-CN.pak ${destination_path}/locales
cp ${source_path}/locales/en-US.pak ${destination_path}/locales
```
> 之后把 `electron/` 产物与 `ohos_hap` 壳工程组合（README 指示：在工程中新建 `electron/libs/arm64-v8a` 替换 so 库；`libc++_shared.so` 从 `/src/ohos_sdk/openharmony/native/llvm/lib/aarch64-linux-ohos` 取；业务代码放 `web_engine/src/main/resources/resfile/resources/app`）。用预编译包则跳过本节。

## 2.5 双工程隔离工作区布局（官方最佳实践）

官方五步方法论的最佳实践：**原始 Electron 工程与鸿蒙 Electron 工程分开维护**（VSCode/WebStorm + DevEco Studio 双工程）（《Electron调研报告》§2.2）。

```
工作区/迁移根目录/
├── app-electron/                  # 原 Electron 工程（只改适配代码，保持 npm start 可跑）
│   ├── src/  main/  renderer/  preload/
│   ├── scripts/build-ohos-package.js   # 同步脚本（3.5.3）
│   └── package.json
├── ohos_hap/                      # 鸿蒙壳工程（DevEco Studio 打开，来自预编译包解压）
│   ├── AppScope/
│   ├── electron/                  # entry 模块（module.json5、签名、HAP 输出）
│   ├── web_engine/                # Electron runtime HAR 模块（resfile/resources/app 放业务产物）
│   ├── hvigor/  build-profile.json5  oh-package.json5
│   └── hnp/arm64-v8a/             # HNP 包放置处（第 5 章）
├── backend-java/                  # Spring Boot 工程（改 JDK17 兼容）
└── cpp-tool/                      # C++ 工具源码（交叉编译 + HNP）
```

---

# 3. Electron 前端迁移（核心章节）

## 3.1 官方五步迁移方法论总览

官方《已有Electron项目，如何适配HarmonyOS PC》给出的五步（《Electron调研报告》§2.2、FAQ 快照）：

1. **分析依赖**，对不满足的依赖进行适配和替换；
2. **业务代码适配 HarmonyOS**（权限判断、平台判断、沙箱路径等差异点）；
3. **TypeScript 项目编译为 JavaScript**；
4. 将**编译产物及 package.json 复制到鸿蒙样例工程**（删除 devDependencies）；
5. **安装依赖并启动工程**，异常则回退到第 1 步。

最佳实践（同源）：原始工程与鸿蒙工程分开维护；`electron-builder` 打包设置 `asar:false` 拆包后拷贝 app 产物；C/C++ Native 模块用鸿蒙工具链重编译后放入 `ohos_hap\electron\libs\arm64-v8a` 并修改引入路径。

> 实战经验（markdownify 迁移文）：**"运行时适配优先，业务逻辑最小侵入"**——不要一遇到问题就改业务代码，先把"业务 ↔ Electron 运行时"的连接层（remote、对话框、托盘、快捷键、路径）做成兼容层。

## 3.2 第一步：依赖审计

### 3.2.1 依赖三分类处理策略

| 分类 | 判断方法 | 处理方式 | 工作量 |
|---|---|---|---|
| **A. 纯 JS 模块** | `node_modules/<pkg>` 内无 `.node`、无 `build/`、无 `prebuilds/`、无平台二进制 | **直接可用**；仅需检查是否调用系统 API（fs 操作绝对路径等）（Electron35 迁移文） | 低 |
| **B. C++ addon（.node/.so）** | 包内有 `binding.gyp`、`*.node`、`prebuilds/` | **用鸿蒙工具链重编译为 arm64 `.node/.so`**，放入 `ohos_hap\electron\libs\arm64-v8a`，修改引入路径（《Electron调研报告》§2.2/§4.2）；C++ 标准最低 17（《官方README》§开源三方库可能遇到的问题） | **高（每模块一个）** |
| **C. 含二进制 npm 包** | 包自带平台可执行文件（esbuild 的 `bin/`、`@swc/core`、rollup 原生绑定、`electron` 自身等） | 构建期的留在开发机；**运行期的走 HNP 打包或替换纯 JS 替代品**（《官方README》§开源三方库可能遇到的问题-3） | 中 |

### 3.2.2 依赖审计表模板（按 1.1 盘点结果填写）

| 包名 | 版本 | 分类(A/B/C) | 平台判断类? | 二进制? | 处理动作 | 负责人 | 状态 |
|---|---|---|---|---|---|---|---|
| react / vue | 18.x | A | 否 | 否 | 直接复用 | | |
| electron-store | 8.x | A | 否(仅路径) | 否 | 改沙箱路径 | | |
| sqlite3 | 5.x | B | — | 有 | 重编译(参考官方 sqlite3 适配示例) | | |
| esbuild | 0.2x | C | — | 有 | 构建期→留开发机；运行期→HNP/替换 | | |
| electron-localshortcut | 3.x | A | 是 | 否 | **适配**（报 Cannot find module，《可行性报告》§3.4）| | |

> 已知三方库兼容实例：`electron-window-state` 无法记忆窗口大小（重启恢复默认）、`electron-localshortcut` 报 "Cannot find module"——**凡依赖平台特性的 npm 包都可能需要改造**（《可行性报告》§3.4）。`electron-window-state` 替代：用 `module.json5` 的窗口 metadata + 自定义 JSON 持久化（6.2.4）。

## 3.3 第二步：代码适配清单（按项逐个核对）

> 下文每项给出"现象/原因 → 适配代码"。建议先建一个 `compat/runtime.js` 兼容层（见 3.3.9），业务代码统一走兼容层，避免到处散落 `if (platform)`（markdownify 迁移文）。

### 3.3.1 process.platform 平台判断（⚠️ 来源冲突，必须实测）

- **冲突事实**：官方 FAQ 称鸿蒙平台输出 `openharmony`（《Electron调研报告》§4.2/待核实1）；官方 README 称 `ohos`（《官方README》§开源三方库可能遇到的问题-2："process.platform 返回的是 openharmony"）；社区单篇实测称返回 `'linux'`（juejin_4api_full.txt，待核实2）。**可能与版本/构建方式有关，迁移第一步在真机上打印实测**。
- **适配原则**（同时覆盖三种可能）：

```javascript
// compat/platform.js —— 不要直接信任 process.platform 单值
const path = require('path');
const isOhos =
  process.platform === 'ohos' ||
  process.platform === 'openharmony' ||
  (process.platform === 'linux' && looksLikeOhosByPath());

function looksLikeOhosByPath() {
  // 鸿蒙沙箱路径特征（markdownify 迁移文实测有效）
  const hints = [
    '/data/storage/el1/bundle/electron/resources/resfile',
    '/resources/resfile/resources/app',
    '/bundle/electron/resources/resfile'
  ];
  const p = __dirname || '';
  return hints.some(h => p.includes(h));
}

module.exports = { isOhos, platform: process.platform };
```

- **TS 侧**：鸿蒙版 `NodeJS.Platform` 类型声明没有 'ohos'，硬编码平台判断会 TS2367 报错（见 3.4.3 错误对照表）；正确做法是 `const p: string = process.platform` 动态比较（Electron35 迁移文）。
- **排查动作**：把所有 `process.platform === 'win32'` 分支列出来，评估鸿蒙上走哪条路径。原 Windows 专属逻辑（注册表、wmic、绝对路径）必须在鸿蒙分支给出替代。

### 3.3.2 沙箱路径适配（所有文件操作必改）

- **事实**：应用运行在沙箱，Windows 绝对路径全部失效；`app.getPath('userData')` 默认映射 `/data/storage/el2/base/files`（《官方README》§鸿蒙内的路径、《可行性报告》§3.4）。
- **适配**：

```javascript
const { app } = require('electron');
// 原 Windows 代码：C:/Users/xxx/Documents/test.txt → 失效
// 鸿蒙：所有用户数据读写收敛到沙箱目录
const dataDir = app.getPath('userData');       // /data/storage/el2/base/files
const filePath = require('path').join(dataDir, 'config.json');
fs.writeFileSync(filePath, JSON.stringify(cfg));
```

- **路径分隔符**：一律用 `path.join()`，禁止手写 `\\` 或 `C:\` 拼接（juejin_4api_full.txt 坑1）。
- **读写公共目录（下载/文档/桌面）**：需要 `READ_WRITE_DOWNLOAD_DIRECTORY` 等 ACL 权限（6.2.2）+ `systemPreferences.requestDirectoryPermission(path)`（《官方README》§新增接口）。
- 沙箱↔真实物理路径映射表（《官方README》§鸿蒙内的路径）：

| 沙箱路径 | 物理路径 |
|---|---|
| /data/storage/el1/bundle | /data/app/el1/bundle/public/\<PACKAGENAME\> |
| /data/storage/el1/base | /data/app/el1/\<USERID\>/base/\<PACKAGENAME\> |
| /data/storage/el2/base | /data/app/el2/\<USERID\>/base/\<PACKAGENAME\> |
| /data/storage/el1/database | /data/app/el1/\<USERID\>/database/\<PACKAGENAME\> |
| /data/storage/el2/database | /data/app/el2/\<USERID\>/database/\<PACKAGENAME\> |

### 3.3.3 权限 API（鸿蒙新增，类型声明需替换）

- 鸿蒙新增 `systemPreferences.requestSystemPermission(permission)`，取值：`location`、`camera`、`microphone`、`screen-capture`、`user-download-dir`、`user-desktop-dir`、`user-document-dir`、`bluetooth`、`pasteboard`（《官方README》§新增请求权限接口）。
- 新增 `requestDirectoryPermission(path|null)`、`fileAccessPersist(paths[])`、`getMediaAccessStatus(mediaType)`、`askForMediaAccess(mediaType)`、`openApplicationInfoEntry()`（《官方README》§systemPreferences 模块）。
- **TS 报错修复**：`Property 'requestSystemPermission' does not exist on type 'SystemPreferences'`（TS2339）→ 用鸿蒙适配版 Electron 源码的 `src/electron/electron.d.ts` **替换**业务代码 `node_modules/electron/electron.d.ts`（Electron35 迁移文）。
- **用法示例**（剪贴板必须先申请权限，《Electron调研报告》§4.4）：

```javascript
const { systemPreferences, clipboard } = require('electron');
async function ensurePasteboard() {
  const ok = await systemPreferences.requestSystemPermission('pasteboard');
  if (!ok) { console.warn('pasteboard 权限被拒绝，去 设置→隐私和安全 手动开启'); return; }
  console.log('read:', clipboard.readText());
}
```

- **授权弹窗只弹一次**；被拒后必须去系统"设置 → 隐私和安全"手动更改，不会再次弹窗（《官方README》）。

### 3.3.4 nativeTheme 暗色模式（⚠️ 需实测）

- **官方 API 支持**：nativeTheme 7/8 支持（《Electron调研报告》§4.1）。
- **社区单篇实测**：`nativeTheme.themeSource` 返回 `undefined`，`shouldUseDarkColors` 为 undefined，`updated` 事件不触发（juejin_4api_full.txt 坑2；与官方文档冲突，待核实2）。官方口径：暗色模式需轮询 `getprop persist.sys.dark_mode`（《可行性报告》§3.4）。
- **兼容实现**（juejin 方案 + 官方口径结合，作为兜底）：

```javascript
const { nativeTheme } = require('electron');
const { execSync } = require('child_process');
function getSystemTheme() {
  if (isOhos) {
    try {
      return execSync('getprop persist.sys.dark_mode').toString().trim() === '1' ? 'dark' : 'light';
    } catch { return 'light'; }
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}
// 监听：鸿蒙上 5s 轮询兜底（无 updated 事件时）
```

### 3.3.5 shell.openExternal（⚠️ 需实测，给出兜底）

- 官方支持率低（shell 3/7，《Electron调研报告》§4.1）；社区实测 `shell.openExternal` **静默失败**（返回 undefined 无异常，juejin_4api_full.txt 坑3）。
- **兼容实现**：

```javascript
const { shell } = require('electron');
const { exec } = require('child_process');
function openUrl(url) {
  if (isOhos) {
    return new Promise((resolve, reject) => {
      exec(`am start -a android.intent.action.VIEW -d "${url}"`, (err) =>
        err ? reject(err) : resolve());
    });
  }
  return shell.openExternal(url);
}
```
> ⚠️ `am start` 命令为社区实测方案（juejin 文），需在目标版本验证；失败时降级为应用内 WebView 打开。

### 3.3.6 窗口与托盘适配（先建托盘！）

- **窗口显示/隐藏与托盘强绑定**："出于 OH 系统限制原因，窗口的显示隐藏与应用托盘强绑定，因此在启动应用前，为了保证窗口创建正常，需要先创建托盘"（《官方README》§窗口显示隐藏、《可行性报告》§3.4）。
- **必须适配**：`app.whenReady()` 后**先创建 Tray** 再创建窗口：

```javascript
const { app, BrowserWindow, Tray, nativeImage } = require('electron');
const path = require('path');
let mainWindow, tray;
app.whenReady().then(() => {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray_icon.png')));
  tray.setToolTip('应用名');
  tray.setContextMenu(require('electron').Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => mainWindow && mainWindow.show() },
    { label: '退出', click: () => app.quit() }
  ]));
  mainWindow = new BrowserWindow({ width: 1280, height: 800 });
  mainWindow.loadFile('index.html');
});
```

- **不需要托盘/隐藏窗口时**：注释 `ohos_hap/web_engine/src/main/ets/adapter/AppWindowAdapter.ets` 中的 `processMode` 与 `startupVisibility` 属性（《官方README》§窗口显示隐藏，代码见 6.1）。
- **Tray API 残缺**：Tray 10/35 支持，`double-click`、`drag-*`、`mouse-*`、`balloon-*`、`setTitle` 等不支持（api_index.md）；只用 `click`、`setContextMenu`、`setToolTip`、`setImage` 这些支持的即可。
- **窗口三键**：有边框窗口（frame:true）默认显示三键；无边框窗口默认无三键，可用 `win.setWindowButtonVisibility(true)` 控制（`maximizable` 决定最大化键显隐），须在 `loadURL/loadFile` 之前调用（《官方README》§调整三键、《问题集》自定义标题栏示例）。
- **首窗口尺寸**：只能通过 `module.json5` 的 metadata 配置（6.2.4），代码里设置无效（《Electron调研报告》§4.4）。
- **悬浮窗**：`new BrowserWindow({ windowInfo: { type: 'floatWindow' }, transparent: true, ... })`，type 取值 mainWindow/subWindow/floatWindow（《官方README》§悬浮窗）。
- **BrowserWindow 其他差异**：窗口 Tab 化、flashFrame、hookWindowMessage 等不支持（《Electron调研报告》§4.1）。
- **关闭行为**：markdownify 实践——鸿蒙端 `close` 事件直接放行退出，桌面端才 hide 到托盘：

```javascript
mainWindow.on('close', (event) => {
  if (isQuitting || isOhos) return;   // 鸿蒙端直接退出
  event.preventDefault();
  mainWindow.hide();
});
```

### 3.3.7 剪贴板

- 支持情况：clipboard 12/19，**文本/图片/FileNameW 文件路径格式支持**；RTF、FindText、Bookmark 不支持（《Electron调研报告》§4.1/§4.4）。
- **必须**先 `requestSystemPermission('pasteboard')`（3.3.3）；跨设备剪贴板系统级支持。
- 文件拖放：用 `webUtils.getPathForFile(file)` 获取路径，要求 **API 20 / HarmonyOS 6.0.0 / DevEco 6.0 / Electron 34**（《Electron调研报告》§4.4）。

### 3.3.8 其他已知差异清单

| 项 | 差异 | 适配 |
|---|---|---|
| `exec` 命令集 | 可用，但命令是**鸿蒙内核命令集**（如 `uname`，无 `wmic`；`help -a > help.txt` 可查全量）（《Electron调研报告》§4.4） | 把所有 exec 的 Windows 命令替换为鸿蒙等价命令 |
| `powerMonitor` | suspend/resume 语义差异：社区实测"息屏即触发 suspend"，非真睡眠（juejin 坑4）；且 powerMonitor 6/16 支持 | 用"息屏时长阈值"判断真睡眠（juejin 方案，30s 阈值） |
| `globalShortcut` | **5/5 全支持**（《Electron调研报告》§4.1） | 可用；但 `electron-localshortcut` 类三方包报错，改 `globalShortcut` 或渲染进程 keydown 兜底（markdownify） |
| `Notification` | 11/22，actions/reply/sound 等不支持 | 只调用基础 `new Notification({title,body})` |
| `app` 事件 | activate/second-instance/continue-activity 等不支持（《Electron调研报告》§4.1） | 删除或降级；`window-all-closed` 等常用事件支持 |
| `dialog` | 7/8 支持 | 若 renderer 用 remote 调 dialog，改主进程 IPC 兜底（markdownify） |
| 菜单 Menu | 应用菜单支持；鸿蒙上桌面菜单栏概念不同 | markdownify：`capabilities.applicationMenu=false` 时跳过 |
| 拖放/多窗口 | PC 原生能力已就绪（《可行性报告》§2） | 按官方 API 使用 |
| WebGL | **HarmonyOS 6.0 以下不支持**（《可行性报告》§3.4） | 确认目标系统 ≥6.0 或移除 WebGL 依赖 |
| 坚盾守护模式 | 系统级安全模式**禁用 JIT + 暂停 WebAssembly**（《官方README》§坚盾守护模式） | 评估 JS/Wasm 性能；文档要求做兼容性检查 |
| `utilityProcess.fork` | 有失败 issue（《可行性报告》§3.4）；fork 走 HNP（《HNP文档》） | 用 HNP + `child_process` 路线 |
| 下载 `<a download>` | 有 0KB 下载 issue（《可行性报告》§3.4） | ⚠️ 需实测；改用 `webContents.downloadURL` 或主进程写文件 |

### 3.3.9 统一兼容层 runtime.js（推荐结构，markdownify 实战模板）

```javascript
// compat/runtime.js
const { isOhos } = require('./platform');

const capabilities = {
  applicationMenu: !isOhos,     // 桌面菜单
  localShortcut: !isOhos,       // 本地快捷键三方库
  tray: !isOhos,                // 托盘（鸿蒙上其实可用但交互残缺，按需开关）
  shellOpenExternal: !isOhos,   // 外链（鸿蒙走 am start 兜底）
  contextMenu: !isOhos
};

function safeCall(label, fn, fallback) {
  try { return fn(); }
  catch (e) { console.warn(`[runtime] ${label} failed:`, e && e.message); return fallback; }
}

function safeRequire(mod, fallback) {
  try { return require(mod); } catch { return fallback; }
}

module.exports = { isOhos, platform: process.platform, capabilities, safeCall, safeRequire };
```

主进程用法（markdownify 迁移文示范的三处核心改造）：
1. remote 兜底：`const remoteMain = safeRequire('@electron/remote/main', null); if (remoteMain) remoteMain.initialize();`
2. 对话框兜底：渲染进程 `dialog.showSaveDialogSync` 失败时走 `ipcRenderer.sendSync('markdownify:show-save-dialog-sync', options)`，主进程 `ipcMain.on(...)` 代调。
3. 路径兜底：渲染进程 `require('@electron/remote').app.getPath('userData')` 失败时走 `ipcRenderer.sendSync('markdownify:get-path','userData')`，主进程 `event.returnValue = app.getPath(name)`。

## 3.4 第三步：TS 编译

### 3.4.1 tsconfig 要点

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "strict": false,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/renderer/**/*"]
}
```
- 编译命令：`npx tsc -p tsconfig.json`（产物进 `dist/`）。
- 渲染进程若用 webpack/vite 打包，构建产物以浏览器资源形式进壳工程（3.5），不参与 Node 侧编译。

### 3.4.2 替换 electron.d.ts（关键一步）

鸿蒙适配版新增了 `requestSystemPermission` 等接口与平台差异声明，**必须用鸿蒙版类型声明替换本地 `node_modules/electron/electron.d.ts`**，否则 TS2339 报错（Electron35 迁移文）。来源：鸿蒙适配版 Electron 源码 `src/electron/electron.d.ts`（源码编译环境）或预编译包/官方仓库 docs 中提供的 d.ts。

```bash
# 示例：从官方仓库获取鸿蒙版 electron.d.ts 后覆盖本地声明
cp /path/to/harmony-electron.d.ts ./node_modules/electron/electron.d.ts
# 或使用 patch-package 固化到仓库，避免每次 npm install 后丢失
npx patch-package electron
```

### 3.4.3 常见 TS 编译错误对照表（来自 Electron35 迁移文）

| 错误码 | 描述 | 解决方案 |
|---|---|---|
| TS2339 | 调用了不存在的属性（如 `requestSystemPermission`） | 替换鸿蒙版 `electron.d.ts`（3.4.2） |
| TS2367 | 变量比较时类型不匹配（`'ohos'` 不属于 `NodeJS.Platform`） | 改用 `const p: string = process.platform` 动态判断（3.3.1） |
| TS2345 | 参数赋值时类型不匹配 | 检查鸿蒙端接口参数类型，调整传入数据格式 |
| TS2554 | 实参和形参个数不匹配 | 参考鸿蒙 Electron 接口文档，补充缺失参数 |
| TS2346 | 参数类型 X 不能赋值给类型 Y | 核对接口声明，转换参数类型（如 string→number） |
| TS2684 | 泛型约束不匹配 | 调整泛型参数，符合鸿蒙端接口约束 |
| TS2769 | 没有对应的重载方法 | 检查函数参数组合，匹配鸿蒙端支持的重载形式 |
| TS2564 | 属性未初始化 | 在构造函数中初始化属性，或添加可选链声明 |

> 还有 ArkTS 壳层编译错误（如 `autoStartupManager` 不存在，见 6.1.2）——那是壳工程侧问题，与本表无关。

## 3.5 第四步：产物放入壳工程

### 3.5.1 打包配置修改

- **`asar: false`**（关键）：鸿蒙壳工程需要直接读取 app 目录下的文件，禁止压缩成 asar（Electron35 迁移文、《Electron调研报告》§2.2）。

```json
// package.json build 字段（electron-builder 配置示例）
"build": {
  "asar": false,
  "files": ["dist/**", "main.js", "package.json", "assets/**"],
  "extraResources": []
}
```

- **package.json 进壳工程前删除 devDependencies**（官方五步第 4 步：《Electron调研报告》§2.2）。`node_modules` 只保留生产依赖。

### 3.5.2 复制到壳工程

业务产物目标目录（鸿蒙运行时真正加载的位置）：

```
ohos_hap/web_engine/src/main/resources/resfile/resources/app/
├── main.js              # 主进程入口
├── runtime.js           # 兼容层（3.3.9）
├── preload.js
├── index.html
├── renderer/ 或 dist/   # 渲染产物
└── node_modules/        # 仅生产依赖（含重编译后的 addon，见 3.7）
```

### 3.5.3 同步脚本（避免手拷，markdownify 实战做法）

```javascript
// scripts/build-ohos-package.js —— 复制运行期必要文件到 HAP 资源目录
const fs = require('fs');
const path = require('path');
const OUT = process.env.OHOS_OUT || 'ohos_hap/web_engine/src/main/resources/resfile/resources/app';

['main.js','runtime.js','preload.js','index.html'].forEach(f =>
  fs.copyFileSync(f, path.join(OUT, f)));
fs.cpSync('dist', path.join(OUT, 'dist'), { recursive: true });
// 根据 package-lock.json 复制生产依赖（npm ci --omit=dev 到临时目录再拷入）
console.log('OpenHarmony app resources written to:', OUT);
```

package.json scripts（markdownify 方案）：
```json
"scripts": {
  "build:ohos": "node scripts/build-ohos-package.js",
  "ohos:sync": "OHOS_OUT=ohos_hap/web_engine/src/main/resources/resfile/resources/app npm run build:ohos",
  "ohos:build": "npm run ohos:sync && node scripts/build-ohos-hap.js"
}
```
> `build-ohos-hap.js` 内部调用 hvigor 命令行（见 6.4）。

## 3.6 第五步：调试迭代

启动后循环执行："启动 → 观察 hilog（7.3）→ 记录 API 缺失/白屏/崩溃 → 回到第 1 步（依赖）/第 2 步（代码）修复"。调试手段见第 7 章。已知高频问题速查：

| 现象 | 根因/处置 |
|---|---|
| 模拟器白屏 | GPU/EGL 问题：改 `CommandLineAdapter.ets` 中 `--use-gl=egl` → `--use-gl=disabled` 并追加 `--disable-gpu` 系列参数（markdownify 迁移文 §十）；预编译包已内置 `disableHardwareAcceleration`，源码编译需自己加 |
| 窗口能开、内容空白 | 先确认 JS 是否加载（`window.onerror` + hilog），再查 GPU 链路（markdownify） |
| release 模式 HAP 打开即崩 | 官方已知 issue（《可行性报告》§3.4）⚠️ 需实测，优先 debug 包验证功能 |
| `Cannot find module` | 三方库平台判断失败（electron-localshortcut 等）→ 适配或替换 |
| 按钮无响应 | remote/app/dialog 不可用 → 走兼容层 IPC 兜底（3.3.9） |
| 权限弹窗不出现 | 部分权限弹窗有 issue（《可行性报告》§3.4）→ 到系统设置手动授权验证 |

## 3.7 Node 原生模块（addon）重编译

> 官方支持路径：《Electron调研报告》§4.2——用鸿蒙编译工具链（`aarch64-linux-ohos` 目标的 clang/llvm）重编译 `.node/.so`，放入 `ohos_hap\electron\libs\arm64-v8a`；**C++ 标准最低 17**。官方以 node-sqlite3 为例有专门指导文档（Electron加载Addon指南，仓库 docs 下）。

步骤（以某 addon `mymod` 为例）：

1. **确认 Node 版本**：鸿蒙版 Node 由适配版决定（E34=Node 20.18.1），addon 的 N-API/ABI 必须匹配（《Electron调研报告》§4.2）。
2. **准备工具链**（环境变量，来自《HNP文档》§二.1.1；路径按你的环境调整）：

```bash
export CC="<鸿蒙Electron源码目录或DevEco SDK>/src/ohos_sdk/openharmony/native/llvm/bin/clang --target=aarch64-linux-ohos"
export CXX="<同上>/clang++ --target=aarch64-linux-ohos"
export LD="<同上>/lld --target=aarch64-linux-ohos"
export STRIP="<同上>/llvm-strip"
export RANLIB="<同上>/llvm-ranlib"
export OBJDUMP="<同上>/llvm-objdump"
export OBJCOPY="<同上>/llvm-objcopy"
export NM="<同上>/llvm-nm"
export AR="<同上>/llvm-ar"
export CFLAGS="-fPIC -D__MUSL__=1"
export CXXFLAGS="-fPIC -D__MUSL__=1"
export CC_host="<本机 clang>"
export CXX_host="<本机 clang++>"
```
> ⚠️ 预编译包方案下工具链来源：DevEco Studio native SDK（`sdk/default/openharmony/native/llvm/bin`）理论上可用，但**目标三元组/版本是否与 Electron 34 匹配需实测**（素材中工具链路径均来自源码目录）。

3. **编译 addon**（node-gyp 或 node-gyp rebuild 变体）：

```bash
cd node_modules/mymod
npm_config_arch=arm64 node-gyp rebuild --target=20.18.1 --arch=arm64 --platform=ohos
# 或按官方 addon 指导文档的步骤（修改 binding.gyp / 源码后再编译）
```

4. **放入壳工程**：

```
ohos_hap/electron/libs/arm64-v8a/
└── mymod.node          # 或 mymod.so（按 addon 产出）
```

5. **修改引入路径**：webpack 打包会把 `require('.node')` 内联解析 → 配置 `externals` 保留运行时 require（《Electron调研报告》§4.2）：

```javascript
// webpack.config.js
externals: [
  (ctx, callback) => {
    if (/\.node$/.test(ctx.request)) return callback(null, 'commonjs ' + ctx.request);
    callback();
  }
]
// 或 externals: { mymod: 'commonjs mymod' }
```

6. 主进程 require 时指向壳内路径：
```javascript
// 用 app.getAppPath() 或 __dirname 定位（需实测 addon 在沙箱内的加载路径）
const mod = require(path.join(app.getAppPath(), 'libs', 'arm64-v8a', 'mymod.node'));
```
> ⚠️ addon 加载路径与 `libs/arm64-v8a` 的运行时映射需实测（官方文档以 sqlite3 为例，按该文档实操为准）。

## 3.8 含二进制 npm 包（esbuild 等）处理

- **事实**：esbuild 等自带二进制的 npm 包无法直接使用——"linux 机器需要 root 权限，新 PC 走 hnp 方案"（《官方README》§开源三方库可能遇到的问题-3、《Electron调研报告》§2.3）。
- **决策表**：

| 场景 | 处理 |
|---|---|
| 构建期使用（webpack/vite 打包时） | **留在开发机**，产物是纯 JS/bundle，不进 HAP |
| 运行期必须执行该二进制（如 esbuild serve） | 方案①：把该二进制的 arm64 版**打成 HNP 包**（5.3），主进程 spawn 调用；方案②：换纯 JS 替代（如 `esbuild-wasm`、`terser` 等） |
| 运行期加载的是原生绑定（rollup 的 `@rollup/rollup-linux-arm64-gnu` 等） | 找 `-ohos`/musl 版本（`-musl` 系列）或重编译（3.7）；否则替换 |

---

# 4. JDK17 后端迁移

> 核心事实（《Java后端调研报告》§0）：鸿蒙 PC 上 **JDK 17 可用**（毕昇 JDK 17 鸿蒙版，应用市场一键安装，`java`/`javac` 已验证可运行标准 Java 程序）；**JDK 21 无官方支持**；**"毕昇 JDK 直接跑通完整 Spring Boot"无公开实测案例**——本方案把冒烟测试放在最前（4.4）。

## 4.1 毕昇JDK17-OH 安装与验证

1. 鸿蒙 PC 打开**应用市场**，搜索 **"BiShengJDK17-OH"** 并安装（来源：《Java后端调研报告》§1.1、《可行性报告》§4.1）。
2. 打开鸿蒙 PC 自带「终端」（或 CodeArts IDE 内置终端），验证：

```bash
java -version
# 期望输出（官方实测值）：
# openjdk version "17.0.13" 2024-10-15
# OpenJDK Runtime Environment BiSheng (build 17.0.13+6)
# OpenJDK 64-Bit Server VM BiSheng (build 17.0.13+6, mixed mode, sharing)
javac -version
# 期望输出：javac 17.0.13
```

3. 快速验证可编译运行标准 Java 程序 + `-cp` 引用三方 JAR（《Java后端调研报告》§1.1）：

```bash
cat > Hello.java <<'EOF'
public class Hello { public static void main(String[] a){ System.out.println("ok"); } }
EOF
javac Hello.java && java Hello
```

4. ⚠️ **注意**：
   - 同一设备只能安装一个 JDK 版本（《可行性报告》§4.1），若已装 JDK8 需先卸载/切换。
   - DevEco 构建用的 JDK17 与设备端运行用的 BiShengJDK17-OH 是两回事，互不影响。
   - 终端输出中文可能乱码（4.5-2），冒烟测试建议先纯英文输出。

## 4.2 Spring Boot 版本选择建议

**结论：Spring Boot 3.x 全系最低 Java 17，降级无版本障碍；用不了的是 JDK21 专属特性**（《Java后端调研报告》§3）。

| Spring Boot | 最低 Java | 最高兼容 | 备注 |
|---|---|---|---|
| 3.0 / 3.1 | 17 | 21 | 已 EOL |
| 3.2 | 17 | 21 | 首个支持 Java 21 虚拟线程（需 JDK21） |
| 3.3 | 17 | 23 | OSS 已结束 |
| 3.4 | 17 | 24 | OSS 已结束 |
| **3.5.x** | 17 | 24+ | **商业支持至 2026-12**（推荐之一） |
| 4.0.x | 17 | 25 | 2025-11 发布，官方推荐 21，OSS 支持中（推荐之二） |

**本方案建议**：
- 保守/有商业订阅：**Spring Boot 3.5.x + JDK17**（来源：《Java后端调研报告》§3.4、可行性报告 §4.3）。
- 追求 OSS 支持窗口：**Spring Boot 4.0.x + JDK17**（官方称最低 17，但部分新特性在 17 上可能有功能取舍，以官方 system-requirements 与 release notes 为准——⚠️ 待核实，《Java后端调研报告》§6-7）。
- **降级改造清单**（若原代码用了 JDK21 特性）：
  - 虚拟线程：删除/关闭 `spring.threads.virtual.enabled=true`（3.2+ 配置项），回退平台线程；`Thread.ofVirtual()` 改为 `Executors.newFixedThreadPool(...)`。
  - FFM（`java.lang.foreign`）：JDK22+ 专属，改用 JNI/现有库。
  - Record Patterns、SequencedCollection 等语法糖：降编译目标到 17 后按编译器提示改写。
- **禁用项**：AWT/Swing 图形库在鸿蒙不支持（后端不需要，无影响）（《可行性报告》§4.3）。

## 4.3 后端运行形态选择与决策

> 官方口径整理（《Java后端调研报告》§2、《可行性报告》§4.2）：四条路径 —— ①终端直接运行（JDK17，最简单）；②融合开发引擎 openEuler 内运行（可 JDK21，官方路径）；③HNP 方式由应用拉起（探索）；④远程部署（最省事但"非本机"）。**按目标"前后端都跑本机"选择 ①→②→③ 的升级顺序。**

### 4.3.1 形态①：终端手动启动（MVP 默认，JDK17）

```bash
# 开发/演示：鸿蒙 PC 终端里手动启动
cd /path/to/backend
java -jar backend.jar --server.port=8080
# 常驻方式（终端关闭后继续运行）：
nohup java -jar backend.jar --server.port=8080 > /data/storage/el2/base/backend.log 2>&1 &
```

- 优点：零安装依赖（JDK17 已装）、最贴近现有开发流程。
- 缺点：每次开机需手动拉起；无守护（无 systemd）；⚠️ 完整 Spring Boot（嵌入式 Tomcat 的 NIO/端口监听、TLS）在鸿蒙内核 + musl 下的适配**未验证**（《Java后端调研报告》§2.a）——**先跑 4.4 冒烟测试再决定是否押注此形态**。

### 4.3.2 形态②：融合开发引擎内运行（可 JDK21，官方路径）

**适用**：后端强依赖 JDK21（虚拟线程/FFM），或形态①冒烟失败时升级。

事实（《Java后端调研报告》§2.b-B1、《可行性报告》§4.2）：
- 华为官方「融合开发引擎」：HarmonyOS 6.0/6.1 鸿蒙电脑，应用市场尝鲜专区上线（2026-04，已转正），openEuler Linux 子系统，类 WSL。
- 能力：共享文件夹 `/mnt/linux_share`、快照（最多 5 个）、磁盘扩容、NAT 联网。
- **限制**：仅 openEuler；**不支持 docker/systemctl/内核操作/USB/IPv6**；仅主用户可用；共享文件夹属主 root（需 sudo）；IP 不固定。

步骤：
```bash
# 1) 应用市场安装「融合开发引擎」，启动进入 openEuler 终端
# 2) 安装 JDK21（openEuler AArch64，毕昇 JDK Linux 版官方支持 8/11/17/21）
sudo dnf install -y java-21-openjdk   # 或安装 BiSheng JDK21 (Linux AArch64)
java -version
# 3) 将 fat-jar 通过共享文件夹放入：/mnt/linux_share/backend.jar（鸿蒙侧对应共享目录）
# 4) 手动拉起（无 systemd，用 nohup）
cd /mnt/linux_share
nohup java -jar backend.jar --server.port=8080 > backend.log 2>&1 &
# 5) 验证
curl http://127.0.0.1:8080/actuator/health
```
- 前后端联调：HAP 沙箱访问子系统内服务——⚠️ **网络通路需实测**（子系统 NAT 网络 + 沙箱出网规则）；失败时可用共享文件夹交换数据 + 轮询文件作为过渡。
- 参考替代：OSEasy 虚拟机装 ARM64 Debian 12 + JDK（社区实测可行，注意内核版本 6.5/6.12 起不来的坑）（《Java后端调研报告》§2.b-B2）。

### 4.3.3 形态③：HNP 方式由应用拉起（探索）

- 理论路径：Electron 鸿蒙版 `exec/spawn/fork` 的 HNP 指导文档齐全，JDK 安装器本身也是 HNP 包（《可行性报告》§4.2-3、《Java后端调研报告》§2.a）。
- 现实：**无公开组合案例**（Electron + HNP + JDK 拉起 Spring Boot），需要自己打通 JDK 主程序与 JVM 依赖库的 HNP 打包（JDK 结构复杂，打包面大）。
- 建议：**列为 P2 探索项**，仅在形态①/②均不可行且必须"应用内自动拉起"时投入；先跑 5.3 的 HNP 流程练手，确认 HNP 链路 OK 后再打包 JDK（⚠️ 高成本、未验证）。
- 应急：若 JDK 的 HNP 打包过于复杂，可考虑"应用内 spawn 调用终端命令 `java -jar`"——但鸿蒙沙箱内是否有终端/是否绕过 XPM 需实测，不推荐优先。

### 4.3.4 形态④：远程部署（备注，非本方案主线）

后端放云/局域网服务器，前端改 HTTP 调用（需 INTERNET 权限；明文 HTTP 需配置，见 4.6）。零鸿蒙适配成本，但不符合"全本机"目标，仅作兜底（《Java后端调研报告》§2.c）。

## 4.4 冒烟测试清单（必做，按顺序）

> 这是**整个方案的最大不确定点**，M2 里程碑第一件事。逐项通过才算形态①成立（《Java后端调研报告》§2.a 结论 + §6-1/2 待核实项）。

准备一个最小 Spring Boot 应用（或直接用现有后端打 fat-jar）：
```bash
# 开发机（有网）打包：
mvn -o clean package -DskipTests     # 产物 backend.jar（含内嵌 Tomcat）
```
> 注意：开发机 Maven 打包用 JDK17 目标（`<java.version>17</java.version>`），避免 class 版本不兼容。

冒烟测试（在鸿蒙 PC 终端按序执行，**每步记录结果**）：

| # | 测试项 | 命令 | 通过标准 | 风险等级 |
|---|---|---|---|---|
| S1 | JDK 可运行 fat-jar | `java -jar backend.jar` | 应用启动、无 `UnsupportedClassVersionError` | 低 |
| S2 | 端口监听 | 启动日志出现 `Tomcat started on port(s): 8080` | 端口绑定成功 | **高** |
| S3 | 本机访问 | 另开终端 `curl http://127.0.0.1:8080/actuator/health`（或浏览器） | 返回 200 JSON | **高** |
| S4 | NIO/并发 | 并发请求 100 次（`ab -n 100 -c 10 http://127.0.0.1:8080/...`） | 无连接异常/崩溃 | 中 |
| S5 | HTTPS | 配置自签证书的 HTTPS 端口，`curl -k https://127.0.0.1:8443/...` | TLS 握手成功 | **高** |
| S6 | JDBC | 启动时连接数据库并执行 `SELECT 1` | 查询成功 | **高（最大不确定点）** |
| S7 | 中文编码 | 接口返回中文 + 日志输出中文 | 无乱码 | 中（4.5-2） |
| S8 | 前端访问（沙箱） | HAP 内 `fetch('http://127.0.0.1:8080/...')` | 成功返回 | **高**（4.6） |

- S1-S3 失败 → 形态①不可用，立即转 4.3.2 形态②。
- S5 失败但 S3 过 → 后端先只开 HTTP（开发期），生产 HTTPS 问题上报立项。
- S6 失败 → JDBC 驱动/本地 socket 适配问题：先换纯 Java 驱动（如 H2 内存库）验证链路，再排查具体驱动（4.5-3）。

## 4.5 已知坑（JDK 在鸿蒙的适配）

| # | 坑 | 现象/说明 | 处理 |
|---|---|---|---|
| 1 | JDK 内部 API 受限 | 反射调用 `sun.management.OperatingSystemImpl` 等抛 `IllegalAccessException`（《Java后端调研报告》§1.3-3） | 改用公开标准 API（如 `ManagementFactory.getOperatingSystemMXBean()`） |
| 2 | 中文编码 | 鸿蒙终端/IDE 与 Java 输出编码不匹配，中文极易乱码（《Java后端调研报告》§1.3-4） | 启动参数加 `-Dfile.encoding=UTF-8`；日志纯英文或统一 UTF-8；JVM 参数：`java -Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8 -jar backend.jar` |
| 3 | JNI 三方库 | 依赖 JNI/本地绑定的 Java 库（部分 JDBC 驱动、加密库、JNA）在鸿蒙 ARM 上需逐个移植（《Java后端调研报告》§1.3-2、《可行性报告》§4.3） | 逐个列出 JNI 依赖 → 有源码则按 5.3 工具链交叉编译 `.so` 并放好加载路径；无源码找纯 Java 替代 |
| 4 | 官方不鼓励 JDK 原生网络/IO 跑服务 | 官方建议优先用 @kit.NetworkKit 等 Kit 替代 JDK 原生调用（《Java后端调研报告》§1.3-6） | 理解这是"官方姿态"：形态①是自担风险的探索；形态②（Linux 子系统内）无此顾虑 |
| 5 | 内存/性能 | 无公开基准（待核实） | 冒烟时监控内存占用；应用瘦身（去掉无用依赖） |

## 4.6 前后端联调（HAP 沙箱访问本机后端 ⚠️ 必须 PoC 实测）

- **未知风险**：鸿蒙沙箱网络隔离行为缺少公开资料；社区反馈 WebView 访问 localhost/局域网服务有坑（《可行性报告》§5.2 表格最后一行）。
- **必须配置**：
  1. HAP 声明 `ohos.permission.INTERNET`（6.2.2 基础权限）。
  2. 明文 HTTP（API 10+ 需放行；API 23+ 用 `network_config.json`）——开发期 http://127.0.0.1 是否受明文策略限制**需实测**（《Java后端调研报告》§2.c）；若被拦，`AppScope/app.json5` 配置 `"network": { "cleartextTraffic": true }`（旧 API 位置）或 `src/main/resources/base/profile/network_config.json` 设 `cleartextTrafficPermitted: true`（API 23+ 位置）。
  3. 后端 CORS：若前端页面 origin 与后端不同源，Spring Boot 需放开 CORS（`@CrossOrigin` 或全局配置）。
- **联调失败预案**：
  1. 后端改监听 `0.0.0.0`（`--server.address=0.0.0.0`）排除回环限制；⚠️ 注意沙箱内是否允许 bind。
  2. 走 4.3.2 融合开发引擎（后端在子系统内，前端经 NAT 访问子系统 IP——IP 不固定，需运行时探测）。
  3. 退化为"后端在局域网服务器"（4.3.4）。
  4. 数据交换走共享文件/剪贴板兜底（仅测试期）。

---

# 5. C++ exe 迁移（关键章节）

## 5.1 前提（务必先与业务方确认）

1. **Windows exe 无法在鸿蒙直接运行**：无 Wine、无 WSL、无兼容层（《可行性报告》§2/§3.1）。**必须有源码重新编译为鸿蒙 ARM64 可执行文件**，别无他路。
2. **XPM 内核管控**：PC 25 镜像起，**未签名的可执行二进制无法执行**，`exec/spawn/fork` 会被内核拦截（《HNP文档》前言、《可行性报告》§2）：
   ```
   { "event_type": "get signature info failed", "code_type": "ELF", "pid": 10041, "comm": "electron",
     "filename": "/data/storage/el1/bundle/entry/resources/resfile/electron", ... }
   ```
   解法：**HNP（HarmonyOS Native Package）签名包**，系统针对"应用内调用二进制"提供的方案（《HNP文档》）。
3. **代码依赖面评估**：Win32 API 面越大，改写量越大（5.4 给出对照表）。

## 5.2 四条实现路线对比与推荐

| 路线 | 做法 | 适用场景 | 优势 | 风险/代价 | 推荐度 |
|---|---|---|---|---|---|
| **A. 独立 OHOS ARM64 ELF + HNP 打包，Electron spawn 调用** | 源码交叉编译为 ELF → HNP 打包 → 主进程 `spawn`/`execFile` | **exe 是独立命令行工具**（读文件、算结果、输出） | 官方 HNP fork 指南完整覆盖（《HNP文档》全文即此路线 Demo）；与 Electron 解耦、可单独测试 | 需适配 Win32→POSIX（5.4）；HNP 流程有 DevEco 流水线 hack（5.3.4） | **⭐⭐⭐ 推荐（默认）** |
| **B. 编译为 Node addon（.node），Electron require 调用** | 源码改造为 N-API addon → 鸿蒙工具链编译 → 放入 `libs/arm64-v8a`（3.7） | **exe 本质是库型逻辑**（被主进程高频调用、有函数式接口） | 调用成本最低（进程内）；官方有 addon 指导文档（sqlite3 为例） | 需把 main() 改成导出函数；node ABI 绑定 Electron 版本；UI/交互型工具不适合 | ⭐⭐⭐ 逻辑库型推荐 |
| **C. Java 后端 ProcessBuilder 调用** | fat-jar 里 `new ProcessBuilder(...)` 拉起 HNP 打包的 ELF | 调用点在 Java 侧 | Java 侧改动小 | **依赖 JDK 在鸿蒙的进程能力，未验证**（《可行性报告》§5.2 表格"应用内拉起后端 HNP 🟡 理论可行"）；JDK 沙箱内 spawn 二进制的 XPM/HNP 链路完全无公开案例 | ⭐ 谨慎 |
| **D. 逻辑用 NAPI/Rust 重写为 ArkTS 可调模块** | 重写核心逻辑为 Rust/NAPI 库，ArkTS/JS 通过桥接调用 | 源码不可得/老旧，且逻辑简单 | 摆脱 ELF 签名问题（NAPI 库随 HAP 签名） | **重写成本最高**；最后手段 | ⭐ 最后手段 |

> 组合建议：独立 CLI 工具走 A；库型逻辑走 B；两者并存时拆分为"B 的库 + A 的 CLI"。

## 5.3 路线 A 完整步骤（官方 HNP fork 指南落地）

### 5.3.1 步骤 1：交叉编译为 OHOS ARM64 ELF

**工具链**（官方原文，见《HNP文档》§二.1.1）：
> "应用可在鸿蒙Electron的指定目录下找到工具链，并进行如下配置"——**工具链位于鸿蒙 Electron 源码目录 `src/ohos_sdk/openharmony/native/llvm/bin` 下**；且"如果需要在Electron内部调用，则编译工具链需要使用Electron提供的指定版本"（官方原文，即工具链版本必须与所用 Electron 鸿蒙版匹配）。

官方给出的完整环境变量配置（直接复制，把 `{本地鸿蒙Electron源码目录}` 换成你的实际路径）：

```bash
export CC="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/clang --target=aarch64-linux-ohos"
export CXX="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/clang++ --target=aarch64-linux-ohos"
export LD="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/lld --target=aarch64-linux-ohos"
export STRIP="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-strip"
export RANLIB="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-ranlib"
export OBJDUMP="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-objdump"
export OBJCOPY="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-objcopy"
export NM="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-nm"
export AR="{本地鸿蒙Electron源码目录}/src/ohos_sdk/openharmony/native/llvm/bin/llvm-ar"
export CFLAGS="-fPIC -D__MUSL__=1"
export CXXFLAGS="-fPIC -D__MUSL__=1"
```

> ⚠️ 工具链来源待实测点：上表为官方原文（基于源码编译环境）。若你走**预编译包方案**（无源码目录），可改用 DevEco Studio 自带 native SDK 的同名工具（`sdk/default/openharmony/native/llvm/bin/clang`），但**目标三元组/版本是否与 Electron 34 的 musl 运行时匹配必须先用下方 hello 验证**；不匹配时需回退到源码编译环境（2.4）获取工具链。

**验证工具链 + 编译 hello 二进制**（官方 Demo，先跑通再编译真实工具；官方原文 `$CC $CFLAGS hello.c -o hello` 即可生成）：

```c
// hello.c
#include <stdio.h>
int main(int argc, char *argv[]) {
    printf("hello from C binary\n");
    for (int i = 1; i < argc; i++) printf("arg[%d] = %s\n", i, argv[i]);
    return 0;
}
```
```bash
$CC $CFLAGS hello.c -o hello
file hello
# 期望输出：ELF 64-bit LSB executable, ARM aarch64 ... (静态或带 musl 动态链接，按需)
```

> ⚠️ 工具链来源待实测点：预编译包方案下 `${OHOS_NATIVE}` 用 DevEco SDK 的 native 目录（`sdk/default/openharmony/native/llvm`）是否与 Electron 34 的 musl 运行时兼容，需先跑通 hello 验证。官方文档里的路径均基于源码编译环境（`src/ohos_sdk/openharmony/native/llvm`）。

**CMake 交叉编译**（若原项目用 CMake）：

```cmake
# toolchain-ohos.cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_C_COMPILER ${OHOS_NATIVE}/llvm/bin/clang)
set(CMAKE_CXX_COMPILER ${OHOS_NATIVE}/llvm/bin/clang++)
set(CMAKE_C_FLAGS "--target=aarch64-linux-ohos -fPIC -D__MUSL__=1 ${CMAKE_C_FLAGS}")
set(CMAKE_CXX_FLAGS "--target=aarch64-linux-ohos -fPIC -D__MUSL__=1 ${CMAKE_CXX_FLAGS}")
```
```bash
cmake -B build-ohos -DCMAKE_TOOLCHAIN_FILE=toolchain-ohos.cmake
cmake --build build-ohos
```

**静态/动态链接决策**：优先静态链接（`-static`），避免动态库在沙箱内的加载路径问题；若依赖 musl 动态库，把 `.so` 一并放入 HNP 包（《HNP文档》示例包内就放了 electron 全套 so）。

### 5.3.2 步骤 2：HNP 包目录结构与 hnp.json

**hnp 目录需要自行创建**（《HNP文档》§1.2 原文）。你的工具对应结构（`<name>` 与 hnp.json 的 name 一致）：

```
hnp/
├── bin/
│   └── mytool/                  # 包内目录（对应 hnp.json 的 name）
│       ├── mytool               # 编译产物（关键）
│       └── libmytool.so         # 动态依赖（如有）
└── hnp.json
```

官方原文示例（以 electron 二进制为例，把 electron 全套内容放入 `bin/electron/`；若你的工具只需单个二进制，放 `bin/<name>/<binary>` 即可，其余文件可省略）：

```
hnp
├── bin
│   └── electron
│       ├── locales (文件夹)
│       ├── chrome_100_percent.pak
│       ├── chrome_200_percent.pak
│       ├── electron (关键)
│       ├── icudtl.dat
│       ├── resources.pak
│       ├── snapshot_blob.bin
│       └── v8_context_snapshot.bin
└── hnp.json
```
> 官方说明：`electron` 中的文件可从自己工程的 `web_engine/src/main/resources/resfile/resources` 目录下取（《HNP文档》§1.2）。

**hnp.json**（《HNP文档》§1.2 原例，按你的工具改名；`name`/`version` 决定安装后的释放目录，见 5.3.5）：

```json
{
    "type": "hnp-config",
    "name": "mytool",
    "version": "1.0",
    "install": {
        "links": [
            {
                "source": "/bin/mytool",
                "target": "mytool"
            }
        ]
    }
}
```

**打包命令**（`hnpcli` 在 DevEco 安装目录 `sdk\default\openharmony\toolchains` 下）：

```bash
# Windows 开发机（在 toolchains 目录执行）
hnpcli pack -i 实际路径/hnp -o hnp包输出路径 -n mytool -v 1.0
# 生成 mytool.hnp；注意看输出是否有 error（《HNP文档》提示："执行hnpcli命令后注意查看信息，可能会出现打包命令执行error的情况"）
# 更多参数参考：https://gitee.com/openharmony/startup_appspawn/blob/master/service/hnp/pack/README_zh.md
```

### 5.3.3 步骤 3：集成到 Electron 工程

> 官方机制说明（《HNP文档》§1.1 原文）：**"当应用的HAP工程内存在hnp设置时，会在打包生成的HAP包中存在hnp目录，当应用HAP包安装到系统时，自动将HNP目录下的内容释放到系统目录中"**。释放位置分两类：
> - **公有 hnp 目录**（沙盒路径 `/data/service/hnp`，物理路径 `/data/app/el1/bundle/<userid>/hnppublic/`，经环境变量 `HNP_PRIVATE_HOME` 获取）；
> - **私有 hnp 目录**（沙盒路径 `/data/app`，物理路径 `/data/app/el1/bundle/<userid>/hnp/<bundlename>/`，经环境变量 `HNP_PUBLIC_HOME` 获取）。
> （注：官方原文中两处环境变量名与中文描述存在对调嫌疑，实操时以 `env | grep HNP` 实际输出为准——⚠️ 需实测。）

1. **`ohos_hap/electron/src/main/module.json5`** 的 module 内加：

```json5
"hnpPackages": [
  {
    "package": "mytool.hnp",
    "type": "private"
  }
]
```

2. **`ohos_hap` 目录下新建 `hnp/arm64-v8a/`**，放入 `mytool.hnp`（《HNP文档》§2.2）：

```
ohos_hap/
├── hnp/
│   └── arm64-v8a/
│       └── mytool.hnp
└── ...
```

### 5.3.4 步骤 4：DevEco 打包流水线修改（⚠️ 官方文档给出的 hack，随 DevEco 版本可能变化）

官方要求改两个文件并重启 DevEco（《HNP文档》§3）：

1. `<DevEco>\tools\hvigor\hvigor-ohos-plugin\src\builder\inner-java-command-builder\packing-tool-options.js` 增加：

```javascript
addHnpPath(t){return this.addFieldAndPath("--hnp-path",t);}
```

2. `<DevEco>\tools\hvigor\hvigor-ohos-plugin\src\tasks\base\base-pack-hap-task.js` 增加（**注意变量名，有的文件 o/a 位置不同**）：

```javascript
let hnpPath=path_1.default.resolve(process.cwd(),'hnp');if(fse.existsSync(hnpPath)){a.addHnpPath(hnpPath);}
```

3. **重启 DevEco Studio** 后重新 Build Hap(s)。

> 若 DevEco 升级，这两处修改可能被覆盖，需重新打补丁——**把这两行改动固化为脚本/文档**，升级后重放。

### 5.3.5 步骤 5：Electron 主进程调用

**安装后的二进制路径**（《HNP文档》§5 官方解释，两条路径的成因）：

> 1. HAP 包安装以后，系统会自动在系统的 `/data/app` 目录下创建 `<name>_<version>` 目录（`name`/`version` 即 hnp.json 中配置的 `name`/`version`），并将 hnp 包中的文件目录放在此路径下。所以最终可执行二进制的**沙箱物理路径**为：
>    `/data/app/<name>_<version>/bin/<name>/<binary>`
>    （官方示例：`/data/app/electron.org/electron_1.0/bin/electron/electron` 或 `.../bin/electron/hello`；其中 `electron.org` 为 bundle 名，`electron` 为 hnp.json 的 name，`1.0` 为 version）
> 2. 由于 hnp.json 中配置了软链接，所以会在 `/data/app/` 下生成一个**软链接路径** `bin/<name>`，链接到上面的沙箱物理路径。
> 3. **由于软链接路径调用权限受限（调试时可以，上架不行），所以建议应用使用沙箱物理路径**（《HNP文档》原文）。

汇总（以 name=mytool、version=1.0 为例）：

| 路径 | 用途 |
|---|---|
| `/data/app/bin/mytool/mytool`（软链接） | **仅调试可用，上架不行** |
| `/data/app/<bundleName>/mytool_1.0/bin/mytool/mytool`（物理路径） | **上架推荐**（官方建议） |

> 查看沙箱内实际路径：`nsenter -t <进程号> -m sh` 进入进程沙箱后 `ls /data/app`（《HNP文档》§1.1/§5）。

**spawn 调用示例**（《HNP文档》§二.3 原例改造：ipcMain.handle + contextBridge preload 完整链路）：

```javascript
// main.js —— 主进程：注册 IPC，拉起 HNP 打包的二进制
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// 优先物理路径（上架合规），开发期可注释换软链路径
const BIN = '/data/app/your.bundle.name/mytool_1.0/bin/mytool/mytool';

ipcMain.handle('run-mytool', async (_, args = []) => {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, {
      cwd: path.dirname(BIN),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.stderr.on('data', d => output += d.toString());
    child.on('error', err => reject(err.message));
    child.on('close', code => code === 0 ? resolve(output) : reject(`exit code ${code}\n${output}`));
  });
});

app.whenReady().then(() => {
  // 先建托盘再建窗口（3.3.6）
  const win = new BrowserWindow({ width: 1280, height: 800, webPreferences: { preload: __dirname + '/preload.js' } });
  win.loadFile('index.html');
});
```

```javascript
// preload.js —— 通过 contextBridge 安全暴露给渲染进程
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  runMytool: (args) => ipcRenderer.invoke('run-mytool', args)
});
```

```html
<!-- index.html —— 渲染进程调用 -->
<script>
  document.getElementById('run').onclick = async () => {
    try { document.getElementById('out').textContent =
      await window.api.runMytool(['--input', 'foo.txt']); }
    catch (e) { document.getElementById('out').textContent = 'error: ' + e; }
  };
</script>
```

**fork Node 子进程**（官方 Demo 另一分支）：需先把 **electron 二进制**也打成 HNP 包（《HNP文档》§1.2 原例就是把整个 electron 目录打进 hnp），然后在主进程 `fork(path.join(__dirname, 'child.js'))`，父子经 `process.send/on('message')` 通信。官方示例（《HNP文档》§4.1）：

```javascript
// main.js 片段
app.whenReady().then(() => {
  createWindow();
  const child = fork(path.join(__dirname, 'child.js'));
  child.on('message', (message) => console.log('主进程收到消息', message));
  child.send({ hello: 'from main process' });
});
```
```javascript
// child.js 片段
process.on('message', (message) => {
  console.log('子进程收到消息:', message);
  process.send({ hello: 'from child process', received: message });
  process.send({ status: 'child process started' });
});
```

### 5.3.6 调试技巧

| 技巧 | 命令/操作 |
|---|---|
| 关闭 XPM（仅调试） | `echo 0 > /proc/sys/kernel/xpm/xpm_mode`（《HNP文档》前言；需 root/主用户，重启失效） |
| 进入进程沙箱看路径 | `nsenter -t <进程号> -m sh`（《HNP文档》§1.1） |
| 查看 hnp 释放路径 | `HNP_PRIVATE_HOME` / `HNP_PUBLIC_HOME` 环境变量（《HNP文档》§1.1）；公有 `/data/service/hnp`、私有 `/data/app` |
| 验证 hnp 打包是否成功 | 打包后 `hnpcli` 输出无 error；安装 HAP 后 `hdc shell ls /data/app/*/mytool_1.0/bin/mytool/` |
| 主进程调试 | `--inspect=9229`（7.2）观察 spawn 调用栈 |
| 日志 | `hdc shell hilog -x -e mytool`（7.3） |

## 5.4 Windows API → OHOS/POSIX 适配要点

> 交叉编译 ≠ 直接能跑：**Win32 API 在 aarch64-linux-ohos 下不存在**，编译期就会报错。逐项替换（下表为主要映射，完整面按你的源码实际调用点排查）。

| Windows API / 概念 | 替换为 | 说明 |
|---|---|---|
| `CreateFile` / `ReadFile` / `WriteFile`（HANDLE） | `open()` / `read()` / `write()`（POSIX fd） | 注意 O_BINARY 无意义（无 CRLF 转换） |
| `GetFileSize` / `SetFilePointer` | `fstat` / `lseek` | |
| `GetSystemInfo` / `GlobalMemoryStatusEx` | `uname` / `sysinfo()` / `/proc/meminfo` | 内核为 Linux 系，`uname` 可用（《Electron调研报告》§4.4） |
| 注册表（RegOpenKeyEx 等） | **文件存储**（JSON/INI 到沙箱目录）；鸿蒙无注册表（《可行性报告》§3.3 沙箱说明） | 由 HAP 侧 `app.getPath('userData')` 传入路径 |
| 路径分隔符 `\` / `C:\...` | `/`；用参数传入（沙箱路径） | 不要在二进制里硬编码绝对路径 |
| 编码（GBK/ANSI） | **UTF-8**（musl 环境默认 UTF-8）；`MultiByteToWideChar` 等换 UTF-8 处理 | 《可行性报告》§4.3 中文编码坑同理 |
| `CreateProcess` / `ShellExecute` | `fork+exec` / `system`（限制：HNP 内二进制的子进程同样受 XPM 管控，能不打嵌套就不打） | 嵌套二进制需各自 HNP 打包 |
| `GetTickCount` / `QueryPerformanceCounter` | `clock_gettime(CLOCK_MONOTONIC)` | |
| Windows 线程/事件（CreateThread/Event） | `pthread` 系列 | |
| DLL 动态加载（LoadLibrary/GetProcAddress） | `dlopen`/`dlsym`；注意 musl 下 `dlopen(NULL)` 语义差异 | |
| 网络（Winsock） | POSIX socket（getaddrinfo 等）；或鸿蒙 `@ohos.net.*`（若走 NAPI 桥） | 独立 CLI 建议直接 POSIX |
| 控制台/UI（MessageBox、窗口句柄） | 无 UI 概念，CLI 用 stdout/exit code；需要 UI 则改成 Electron 侧展示 | exe 是工具类，UI 收敛到前端 |
| `std::filesystem`/C++17 | 直接可用（注意路径形式） | C++ 标准最低 17（《官方README》） |

**推荐实施顺序**：
1. 先编译 hello（5.3.1）验证工具链。
2. 用 `#ifdef`/编译报错扫出全部 Win32 调用点，建映射表。
3. 把"平台差异面"收进一个 `platform_win.cpp` / `platform_ohos.cpp`（抽象接口 + 两个实现），保持主逻辑干净。
4. 交叉编译出 ELF 后在**开发机先用 qemu-user（若有）或直接上真机 HNP 调试**验证行为等价（注意输出一致性回归）。

## 5.5 若 C++ 源码不可得的应急方案

| 方案 | 说明 | 成本 | 可行性 |
|---|---|---|---|
| 1. 找厂商要源码/ARM 版 | 外部工具供应商通常有源码，要求提供鸿蒙 ARM64 版或源码 | 商务 | 首选 |
| 2. 功能等价重写（路线 D） | 按行为规格用 C++/Rust/ArkTS 重写核心逻辑（NAPI 库或独立 ELF） | 高 | 逻辑简单时可行 |
| 3. 行为黑盒仿真 | 若 exe 仅做数据处理且输入输出可枚举，用 JS/Python 侧重新实现（单元级对拍验证） | 中 | 逻辑中等时可行 |
| 4. 虚拟机兜底 | 鸿蒙 PC 装 Win11 ARM 虚拟机（Oseasy/铠大师）跑原 exe，Electron 侧经网络/共享文件调用（性能损失约 20-30%，《可行性报告》§2） | 低 | **过渡期兜底**（体验差、非原生、上架受限） |
| 5. 云端执行 | exe 跑在 Windows 服务器，鸿蒙端远程调用 | 中 | 受网络/合规限制 |

---

# 6. 工程配置与构建

## 6.1 ohos_hap 壳工程目录结构说明

预编译包解压后的结构（《踩坑实录》§2.3 实测结构 + 《官方README》）：

```
ohos_hap/
├── AppScope/                     # 应用级配置
│   ├── app.json5                 # bundleName、应用名、版本等
│   └── resources/base/media/     # 应用图标（替换 app_icon）
├── electron/                     # entry 模块（PC 入口）
│   ├── src/main/
│   │   ├── ets/                  # ArkTS（AbilityStage、EntryAbility、pages）
│   │   ├── resources/zh_CN/element/string.json   # 应用名（改 EntryAbility_label）
│   │   └── module.json5          # ⚠️ 本文件是配置核心（6.2）
│   ├── libs/arm64-v8a/           # ⚠️ addon/原生 so 放这里（3.7）
│   └── build/default/outputs/default/   # HAP 产物目录（6.4）
├── web_engine/                   # Electron runtime HAR 模块
│   └── src/main/
│       ├── cpp/                  # 适配层源码
│       ├── ets/
│       │   ├── adapter/
│       │   │   ├── ElectronAppAdapter.ets   # autoStartupManager 报错位置（6.1.2）
│       │   │   └── AppWindowAdapter.ets     # 托盘强绑定注释位置（6.1.3）
│       │   ├── components/
│       │   │   └── WebWindow.ets            # 主进程 --inspect 参数位置（7.2）
│       │   └── common/CommandLineAdapter.ets # 模拟器白屏 --use-gl 修改位置（3.6）
│       ├── resources/
│       │   └── resfile/
│       │       └── resources/
│       │           └── app/                 # ⚠️ 业务产物放这里（3.5）
│       └── module.json5
├── hvigor/                       # 构建配置
├── build-profile.json5
├── oh-package.json5
└── hnp/arm64-v8a/                # HNP 包目录（5.3.3，需自建）
```

### 6.1.1 替换应用名与图标

- 应用名：`electron/src/main/resources/zh_CN/element/string.json` 中 `EntryAbility_label` 字段值（《官方README》§定制自己的鸿蒙版应用）。
- 图标：替换 `AppScope/resources/base/media/` 下图标文件。

### 6.1.2 已知壳层编译错误：autoStartupManager

初次编译报（《踩坑实录》§3.2）：

```
hvigor ERROR: ArkTS Compiler Error 10505001
'"@kit.AbilityKit"' has no exported member named 'autoStartupManager'. Did you mean 'startupManager'?
At File: .../web_engine/src/main/ets/adapter/ElectronAppAdapter.ets:10:10
```

处理：注释 `ElectronAppAdapter.ets` 中 `import { autoStartupManager } from '@kit.AbilityKit';` 及其调用处（自启动由系统管理，注释安全）（《踩坑实录》）。

### 6.1.3 不需要托盘/隐藏窗口时

注释 `web_engine/src/main/ets/adapter/AppWindowAdapter.ets` 的 `processMode` 与 `startupVisibility`（《官方README》§窗口显示隐藏）：

```ts
const options: StartOptions = {
  // processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
  // startupVisibility: param.show ? contextConstant.StartupVisibility.STARTUP_SHOW : contextConstant.StartupVisibility.STARTUP_HIDE,
  windowLeft: param.left - leftBorder,
  ...
}
```

## 6.2 module.json5 关键配置

### 6.2.1 基础结构与 deviceTypes

主配置在 `electron/src/main/module.json5`（《官方README》§首窗口指定大小）：

```json5
{
  "module": {
    "name": "pc_entry",
    "type": "entry",
    "srcEntry": "./ets/Application/AbilityStage.ets",
    "description": "$string:module_desc",
    "mainElement": "EntryAbility",
    "deviceTypes": ["2in1"],          // ⚠️ PC/2in1 必须声明；不要写成 phone
    "deliveryWithInstall": true,
    "installationFree": false,
    "pages": "$profile:main_pages",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "description": "$string:EntryAbility_desc",
        "icon": "$media:app_icon",
        "label": "$string:EntryAbility_label",
        "startWindowIcon": "$media:app_icon",
        "startWindowBackground": "$color:start_window_background",
        "launchType": "specified",
        "removeMissionAfterTerminate": true,
        "exported": true,
        "skills": [
          {
            "entities": ["entity.system.home", "entity.system.browsable"],
            "actions": ["action.system.home", "ohos.want.action.viewData"],
            "uris": []
          }
        ]
      }
    ]
  }
}
```

- **多实例**：不需要多实例时，去掉 `"multiAppMode"` 配置（《官方README》§多实例配置）。

### 6.2.2 requestPermissions 基础权限表

在 `module.json5` 的 module 内加 `requestPermissions`。**基础权限直接声明即可**（《官方README》§签名与权限）：

```json5
"requestPermissions": [
  { "name": "ohos.permission.INTERNET" },
  { "name": "ohos.permission.GET_NETWORK_INFO" },
  { "name": "ohos.permission.RUNNING_LOCK" },
  { "name": "ohos.permission.PREPARE_APP_TERMINATE" },
  { "name": "ohos.permission.FILE_ACCESS_PERSIST" },
  { "name": "ohos.permission.READ_PASTEBOARD",
    "reason": "$string:access_pasteboard" }
]
```

> `READ_PASTEBOARD` 等带 reason 的权限需在 string.json 提供理由文案。

### 6.2.3 ACL 权限（需邮件向华为申请，未获批先注释）

ACL 签名权限清单（《官方README》§签名与权限）：`SYSTEM_FLOAT_WINDOW`（悬浮窗）、`ACCESS_CERT_MANAGER`、`PRINT`、`ACCESS_BIOMETRIC`、`PRIVACY_WINDOW`、`WINDOW_TOPMOST`、`READ_WRITE_DOWNLOAD_DIRECTORY`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DESKTOP_DIRECTORY`、`LOCATION`、`MICROPHONE`、`CAMERA`、`ACCESS_BLUETOOTH`、`CUSTOM_SCREEN_CAPTURE` 等。

**申请流程**：邮件向华为申请 ACL 权限证书（邮件内容模板见《官方README》§签名与权限截图示例：说明 bundleName、所需权限、用途）。**未获批前把对应权限注释掉**，否则签名不通过（《Electron调研报告》§4.5）。典型声明（需 reason + usedScene）：

```json5
{
  "name": "ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY",
  "reason": "$string:reason_download",
  "usedScene": { "abilities": ["EntryAbility"], "when": "always" }
}
```

### 6.2.4 首窗口尺寸 metadata

首窗口尺寸只能在 `module.json5` 配置（《官方README》§首窗口指定大小）：

```json5
"abilities": [
  {
    ...
    "metadata": [
      { "name": "ohos.ability.window.height", "value": "800" },
      { "name": "ohos.ability.window.width",  "value": "1280" },
      { "name": "ohos.ability.window.left",   "value": "center" },
      { "name": "ohos.ability.window.top",    "value": "center" }
    ],
    ...
  }
]
```
> 不需要居中就只写 width/height。**窗口状态持久化**：`electron-window-state` 在鸿蒙失效（《可行性报告》§3.4），自行读写在 `app.getPath('userData')` 的 JSON。

## 6.3 签名

### 6.3.1 调试签名（DevEco 自动）

- DevEco Studio → File → Project Structure → Signing Configs → 勾选 "Automatically generate signature"，自动生成调试证书并签名（需登录华为开发者账号）。
- 自动签名适用于本机调试；`hdc app install` 的 HAP 需要**已签名**包。

### 6.3.2 正式签名（AGC，上架用）

流程（《厨房里的化学》上架实录 csdn_shangjia.txt）：
1. AGC 控制台（https://developer.huawei.com/consumer/cn/service/josp/agc/index.html）创建应用。
2. 生成**私钥（.p12）** → 用私钥生成**证书（.cer）**并下载。
3. 新建 **Profile（.p7b）** 并下载。
4. DevEco Signing Configs 选择 Manual，填入 p12/cer/p7b 与密码。
5. 命令行签名工具（DevEco 自带 `hap-sign-tool`，位于 SDK toolchains）：
   ```bash
   hap-sign-tool sign-app -keyAlias <别名> -signAlg SHA256withECDSA \
     -mode localSign -appCertFile <证书.cer> -profileFile <profile.p7b> \
     -inFile <unsigned.hap> -outFile <signed.hap> \
     -keystoreFile <私钥.p12> -keystorePass <密码> -keyPass <别名密码>
   ```

### 6.3.3 常见签名错误

| 错误 | 原因/处理 |
|---|---|
| **路径不能含中文** | p12/cer/p7b 及工程路径含中文会导致签名失败（《厨房里的化学》上架实录："存储路径不要有中文"）——**所有签名材料放纯英文路径** |
| OpenHarmony 签名 vs HarmonyOS 商用签名 | OpenHarmony 设备（如深开鸿 x86 桌面版）调试证书 ≠ 商用 HarmonyOS 证书；真机报 `The target device does not work with apps with an OpenHarmony signature` 时，用 HarmonyOS 证书签名（《Electron调研报告》§1.3） |
| ACL 权限未获批导致签名失败 | 注释掉 6.2.3 中未获批权限后重签 |
| 证书过期/包名不一致 | 检查 AGC 应用 bundleName 与 `AppScope/app.json5` 的 bundleName 一致 |

## 6.4 构建流程（DevEco）

1. DevEco Studio 打开 `ohos_hap` 工程（File → Open）。
2. 确认第 3.5 章同步脚本已把业务产物放入 `web_engine/src/main/resources/resfile/resources/app`；addon 已放 `electron/libs/arm64-v8a`（3.7）；HNP 包已放 `hnp/arm64-v8a`（5.3.3）。
3. 菜单 **Build → Build Hap(s)/APP(s) → Build Hap(s)**（《官方README》§编译未签名的hap包）。
4. 产物：`ohos_hap/electron/build/default/outputs/default/electron-default-unsigned.hap`（未签名）或 `electron-default-signed.hap`（已签名）。
5. 安装到设备（hdc 命令行）：

```bash
hdc app install <已签名hap路径>
# e.g.
hdc app install ohos_hap/electron/build/default/outputs/default/electron-default-signed.hap
# 覆盖安装：
hdc install -r <hap路径>
# 启动应用：
hdc shell aa start -b <bundleName> -a EntryAbility
# 卸载：
hdc shell pm uninstall <bundleName>
```

6. 命令行构建（CI 用，hvigorw）：
```bash
cd ohos_hap
./hvigorw assembleHap --mode module -p product=default
# Windows: hvigorw.bat assembleHap --mode module -p product=default
```

## 6.5 备选构建：@electron-ohos/electron-builder（方案二）

> 官方工具链清单中的方案二：升级方便、无需关心 ohos_hap 内部；不支持自动签名、部分配置仍需改 ohos_hap（《Electron调研报告》§2.3）。npm 包 `@electron-ohos/electron-builder`（latest 26.8.5）。

配置（upgrade_readme.md 原文整理）：

```json
// package.json
{
  "scripts": {
    "dist:ohos": "electron-builder-ohos --ohos"
  },
  "build": {
    "appId": "com.yourcompany.yourapp",        // 必填，映射 HAP bundleName，格式 xx.xx.xx
    "productName": "你的应用名",
    "asar": false,                              // 关键
    "ohos": {
      "target": ["hap"],
      "hvigorwPath": "D:/DevEco/deveco-studio/tools/hvigor/bin",
      "ohpmPath": "D:/DevEco/deveco-studio/tools/ohpm/bin",
      "sdkPath": "D:/DevEco/deveco-studio/sdk",
      "ohosHapPath": "D:/project/electron/v34.x/ohos_hap",
      "certPath": "D:/cert/debug.cer",
      "profile": "D:/cert/helloworld.p7b",
      "keyAlias": "helloworld",
      "keyPassword": "123456",
      "storeFile": "D:/cert/helloworld.p12",
      "storePassword": "123456"
    }
  }
}
```

- `ohosHapPath`：指向预编译包里的鸿蒙壳工程；升级 Electron 时只需换新壳工程路径（upgrade_readme.md 核心价值）。
- 密码也支持环境变量：`OH_KEY_PWD` / `OH_STORE_PWD`。
- 执行：`npm run dist:ohos`；产物手动 `hdc app install`（不支持自动签名/自动安装）。
- 安装：`npm install @electron-ohos/electron-builder --save-dev`。

## 6.6 完整实操路径：模板导入 → 前端产物 + 后端 fat-jar 组合 → 构建 HAP

> 本节把"拿到模板到跑起完整应用（前端 + SpringBoot 后端）"的每一步串起来，是第 2/3/4 章内容的落地执行版。**本地已备好离线模板副本**：`templates/ohos_electron_hap-main/`（188MB，内置 Electron 34 运行时：Chromium 132.0.6834.161 / Node v20.18.1，已从 `libelectron.so` 版本字符串核实；模板来源与使用说明见 `templates/README.md`）。

### 6.6.1 第一步：导入模板（获取方式三选一，地址已验证 2026-08）

**来源 A：本地离线副本（已下载，推荐先用它跑通流程）**
```bash
# 模板位置：<工作区>/templates/ohos_electron_hap-main/
# DevEco Studio → File → Open → 选择该目录（⚠️ 是 Open 导入，不是 New Project）
# 说明：templates/README.md 含全部下载地址、版本信息与使用说明
```

**来源 B：官方预编译包（正式开发用，需华为云账号）**
```bash
# 1) 华为云 CodeHub 下载 v34.6.3-20260105.1-release.zip（约数百 MB）
#    地址：https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home
#    （需华为云账号登录；Releases/产物区找形如 v34.6.3-20260105.1-release.zip 的文件，也有 E37 更新版）
# 2) 解压 → DevEco Studio → File → Open 导入（工程内即 ohos_hap 壳工程）
```

**来源 C：GitHub 社区镜像（无需账号，与官方模板同内容）**
```bash
# 镜像1（本模板来源）：https://github.com/ohosvscode/ohos_electron_hap
#   git clone https://github.com/ohosvscode/ohos_electron_hap.git
#   或 zip 直链：https://codeload.github.com/ohosvscode/ohos_electron_hap/zip/refs/heads/main
# 镜像2（备份）：https://github.com/ljlVink/ohos-cherrystudio-electron-base
#   zip 直链：https://codeload.github.com/ljlVink/ohos-cherrystudio-electron-base/zip/refs/heads/main
# 官方文档仓库（资料最全，含 API 索引/HNP 指南）：https://gitcode.com/openharmony-sig/electron
```

> 模板下载地址完整总表见 `templates/README.md`（4 个来源：华为云 CodeHub 官方 Release / gitcode 官方源码仓 / GitHub 双镜像，均标注账号要求与内容说明，2026-08 已验证可达）。

⚠️ 导入后先做三件事：① 确认 `electron/libs/arm64-v8a/` 有 `libelectron.so/libadapter.so/libffmpeg.so/libc++_shared.so`（运行时；注意 libelectron.so 160MB 不在 GitHub 仓库中，从原机器拷贝或官方包获取）；② `build-profile.json5` 的 SDK 版本与你安装的匹配；③ 配置调试签名（DevEco 自动签名，见 6.3.1）。

### 6.6.2 第二步：放置前端产物（Electron 应用代码）

```bash
# 1) 原始 Electron 工程编译（VSCode/WebStorm 侧）：
#    electron-builder 打包时设置 "asar": false（关键，壳工程要读拆包目录）
#    TS 项目先 tsc 编译为 JS
# 2) 把拆包后的 app 目录内容（含编译产物、资源、package.json）复制到：
cp -r <你的Electron工程>/dist/app/* \
      templates/ohos_electron_hap-main/web_engine/src/main/resources/resfile/resources/app/
# 3) 编辑 app/package.json：删除 devDependencies 字段（官方五步法第 4 步）
# 4) 按第 3 章清单做代码适配（process.platform、沙箱路径、权限、托盘等）
```

### 6.6.3 第三步：放置后端 fat-jar（三种策略，按推荐序）

| 策略 | 做法 | 优点 | 缺点/风险 | 适用 |
|---|---|---|---|---|
| **B. 独立进程运行（推荐 MVP）** | fat-jar 不放 HAP 内；鸿蒙 PC 上装 BiShengJDK17-OH（应用市场），终端 `java -jar app.jar` 启动；Electron 主进程启动时 `http` 探测 `127.0.0.1:<端口>`，未就绪弹提示/引导 | 简单可靠，不依赖 HNP/JDK 沙箱链路（该链路无公开案例） | 用户需手动启动后端（可写启动脚本/说明）；体验稍差 | 迁移初期、MVP |
| **A. fat-jar 放 HAP 内 + HNP 拉起（探索）** | fat-jar 放入 `web_engine/src/main/resources/resfile/resources/`（与 app 平级）；JDK 打成 HNP 包（第 5 章 HNP 流程，把 java 二进制 + libjvm.so 等一并打包）；Electron 主进程 spawn `/data/app/.../java -jar <沙箱内fat-jar>` | 一体安装、用户无感 | JDK 二进制巨大（数百 MB）；HNP 打包 JDK 无公开案例；沙箱内 JVM 启动参数/内存/类加载未知——**先 PoC** | 后期体验优化 |
| **C. 远程/融合开发引擎** | fat-jar 部署到远程服务器或融合开发引擎（openEuler 子系统，可 JDK21），前端通过 HTTP 调用 | 最稳、可 JDK21 | 依赖网络/子系统 | 后端上云或需 JDK21 |

策略 A 的 HAP 内资源放置（fat-jar 作为资源打包）：
```
web_engine/src/main/resources/resfile/resources/
├── app/                      # Electron 前端产物（6.6.2）
└── backend/                  # 新增：后端资源目录
    └── app.jar               # Spring Boot fat-jar
```
运行时在 Electron 主进程中用 `process.resourcesPath`（或壳工程注入的 resfile 路径）找到沙箱内 fat-jar 路径，配合 HNP 打包的 java 二进制执行（第 5.3 节 HNP 流程，把可执行文件换成 java 及 libjvm.so/lib/ 目录）。

### 6.6.4 第四步：工程配置（第 6.2 节落地）

1. `AppScope/app.json5`：bundleName 改为你的包名（与 AGC 一致）
2. `electron/src/main/module.json5`：应用名（EntryAbility_label）、首窗口尺寸 metadata、deviceTypes 保持 `["2in1"]`
3. `web_engine/src/main/module.json5`：requestPermissions 按需增删（第 6.2.2/6.2.3 权限表）
4. `electron/src/main/resources/zh_CN/element/string.json`：权限 reason 文案（README_PASTEBOARD 等）
5. 如需明文 HTTP 访问本机后端：`AppScope/app.json5` 加 `"network": { "cleartextTraffic": true }`（API 10~22）或 `network_config.json`（API 23+，见《配置详解》§3.6）

### 6.6.5 第五步：构建、签名、安装、验证

```bash
# 1) DevEco Studio：Build → Build Hap(s)/APP(s) → Build Hap(s)
#    产物：electron/build/default/outputs/default/electron-default-unsigned.hap
# 2) 签名（DevEco 自动签名 或 AGC 正式签名，见 6.3；⚠️ 路径不能含中文）
# 3) 连接鸿蒙 PC（开发者模式 + hdc 认证）：
hdc list targets                          # 确认设备在线
hdc app install <已签名hap路径>           # 安装
hdc shell aa start -a EntryAbility -b <bundleName>   # 启动（或桌面点击）
# 4) 验证清单：
#    □ 前端页面加载（首窗口尺寸、托盘、日志无报错）
#    □ 后端端口探测逻辑触发（策略 B：终端先启动 java -jar；策略 A：spawn 拉起）
#    □ 前端 → 后端接口联通（hilog 观察请求日志）
#    □ 权限弹窗正常（若声明了按需权限）
```

### 6.6.6 常见问题（本节专属）

| 问题 | 原因/解决 |
|---|---|
| 导入模板后构建报 `SDK version not match` | `build-profile.json5` 的 `compatibleSdkVersion` 与 DevEco 安装的 SDK 不一致，改成你的 SDK 版本（如 `6.0.0(20)`） |
| HAP 包巨大（>200MB） | 正常：libelectron.so 160MB + 后端 fat-jar；上架/分发走华为市场不限；本地安装用 `hdc app install` |
| 后端策略 B 下，应用启动后接口不通 | 先确认终端 `java -jar` 已启动且端口监听正常（`curl 127.0.0.1:<端口>`）；再查应用 INTERNET 权限与明文 HTTP 配置（6.6.4 第 5 条）；沙箱访问本机端口如仍失败，**这是已知最大不确定点**，改策略 C（远程/子系统）或融合开发引擎内跑后端 |
| 策略 A 下 spawn java 报 "get signature info failed" | JDK 二进制未打 HNP 包或 HNP 未随 HAP 安装，按第 5.3 节重走 HNP 流程 |

---

# 7. 测试与调试

## 7.1 渲染进程调试

```javascript
// 主进程内打开 DevTools（《官方README》§调试应用-渲染进程）
const { BrowserWindow } = require('electron');
const win = new BrowserWindow();
win.webContents.openDevTools();
```
- 渲染进程 console 日志会进 hilog（配合 3.3.9 的 console-message 桥接更清晰，markdownify 实践）。
- 页面级错误捕获（markdownify 实践，白屏排查必备）：
```html
<script>
  window.onerror = function (message, source, lineno, colno, error) {
    console.error('[renderer] window.onerror', (error && error.stack) || message);
  };
  window.addEventListener('unhandledrejection', e => console.error('[renderer] unhandledrejection', e.reason));
</script>
```

## 7.2 主进程调试（--inspect + hdc fport + chrome://inspect）

官方完整步骤（《官方README》§调试应用-主进程）：

1. 在 **`ohos_hap/web_engine/src/main/ets/components/WebWindow.ets`** 的 `vec_args` 中加入 `--inspect=9229`：

```ts
// WebWindow.ets onLoad 内
let resDir = '--bundle-installation-dir=' + getContext().resourceDir;
let inspect = '--inspect=9229';                    // 新增
let vec_args = ['--user-agent=Mozilla/5.0 ...', resDir, inspect];  // 加入
```

2. 重新打包安装，启动应用。
3. 端口转发：
```bash
hdc fport tcp:9229 tcp:9229
```
4. 开发机 Chrome 打开 `chrome://inspect` → Configure... → 确保有 `localhost:9229` → 出现调试目标后点 inspect。
5. ⚠️ 安全提示（《官方README》）：`--inspect`、`--remote-debugging-port`、`--disable-web-security`、`--no-sandbox` 等仅限开发调试，生产环境禁用。

## 7.3 日志（hilog）与崩溃定位

```bash
# 查看应用日志（按关键字过滤）
hdc shell hilog -x -e <关键字>
# 例：markdownify 项目过滤自己的日志前缀
hdc shell hilog -x -e markdownify
# 查看 GPU 相关（白屏排查）
hdc shell hilog -x -e use-gl
hdc shell hilog -x -e 'GPU state'
# 完整日志导出
hdc shell hilog -x > all.log
```
- **崩溃定位**：`so/node` 崩溃栈顶常见 `ld-musl-aarch64.so`（官方问题集 6.3 节，《Electron调研报告》§4.6）——崩溃堆栈 + 版本信息（日构建版本/commit-id）一起反馈官方问题集（《官方README》§问题定位）。
- 常见崩溃问题集与知识地图：华为开发者论坛《Electron开发HarmonyOS应用知识地图》总帖 6.3 节。

## 7.4 真机验收清单（按功能）

| 验收项 | 方法 | 通过标准 |
|---|---|---|
| 启动 | 冷启动/热启动各 5 次 | 无闪退、白屏 <3s 恢复 |
| 主界面渲染 | 打开主窗口 | 页面元素完整、无黑块 |
| 窗口操作 | 最小化/最大化/关闭/三键 | 行为正确；三键按 frame 配置显隐 |
| 托盘 | 关闭窗口 → 托盘 | 托盘图标存在、菜单可点（仅用支持 API） |
| 数据持久化 | 重启应用 | userData 沙箱内数据保留 |
| 剪贴板 | 复制/粘贴文本 | 先授权 pasteboard，读写成功 |
| 文件读写 | 打开/保存文件 | 沙箱路径内成功；公共目录需授权+ACL |
| 外链 | 点击外部链接 | 跳系统 Web Viewer 或应用内兜底 |
| 快捷键 | 全局快捷键 | globalShortcut 生效 |
| 后端联调 | 前端调用后端接口 | S1-S8（4.4）全过 |
| C++ 工具 | 触发工具功能 | 输出正确、无 XPM 拦截日志 |
| 权限弹窗 | 首次使用麦克风/相机/目录 | 弹窗出现或系统设置可授权 |
| 异常恢复 | 杀进程重启 | 无状态损坏 |

## 7.5 性能验证

- 预编译包**默认禁用硬件加速**（`app.disableHardwareAcceleration()`），渲染性能有折损（《Electron调研报告》§4.6、《可行性报告》§3.4）。
- 官方无公开基准（待核实）；建议自建基线：启动耗时、首屏时间、内存占用、CPU 占用，与 Windows 版对比记录。
- 坚盾守护模式（系统设置 → 隐私和安全 → 坚盾守护模式）下 **JIT + Wasm 被禁用**，JS 性能显著下降——按《官方README》§坚盾守护模式做兼容性评估（JS 性能评估 + Wasm 静态/运行时检查）。

---

# 8. 上架（可选章节）

> 前提：已有真实成功案例《厨房里的化学》（bundleName `com.chufang.electron_pro`）证明"开发→签名→AGC 上架→审核→发布"闭环成立（《可行性报告》§3.5）。上架流程约 1-2 天（同源）。

## 8.1 AGC 上架流程要点（csdn_shangjia.txt 实录）

1. 登录 AGC：https://developer.huawei.com/consumer/cn/service/josp/agc/index.html
2. 创建应用 → 生成私钥/证书/Profile（6.3.2）→ DevEco 配置正式签名 → 打出**已签名 HAP**。
3. AGC → 应用 → 版本管理 → 上传 HAP 包。
4. 填写应用介绍（概述/核心功能/技术特点/使用场景/目标用户）。
5. 上传应用图片（实录中准备 5 张截图/宣传图）。
6. 创建**隐私说明**（隐私政策）。
7. **本地应用无需备案**（《厨房里的化学》实录原文；若涉及网络服务按华为要求办理）。
8. 提交审核 → 预审 → 审核 → 发布。

## 8.2 审核常见打回（3.5 项）

- 高频打回点：**《审核指南》第 3.5 项**（审核指南：https://developer.huawei.com/consumer/cn/doc/app/50104-03）。"这种问题特别正常，经常会出现，我们只需要慢慢的深挖项目即可"（上架实录）——按指南完善功能后重新上传。
- 另一高频报错（官方 README §上架问题）：**"权限声明包含仅 2in1 设备使用的权限"**——两种解法：
  1. 不上 PAD：删除 `pad_entry` 模块；
  2. 同时上 PAD 和 PC：把仅 2in1 使用的权限从 `web_engine` 模块转移到 `pc_entry` 模块。

## 8.3 更新机制

- **autoUpdater 0/10 完全不可用**，应用更新只能走华为应用市场更新机制（《Electron调研报告》§4.1/§4.5）。代码里如有 autoUpdater 逻辑必须删除或屏蔽。
- 版本号管理：`AppScope/app.json5` 的 versionCode/versionName 递增后重新上架。

---

# 9. 风险清单与应急预案表

| # | 风险 | 触发信号 | 应急预案 | 触发条件 | 预估成本 |
|---|---|---|---|---|---|
| E1 | JDK 网络层不适配（形态①失败） | S2/S3 冒烟失败 | 转形态②融合开发引擎（4.3.2）；或后端远程（4.3.4） | M2 启动 2 天内 | +1-3 天 |
| E2 | 沙箱无法访问本机服务 | S8 失败 | 形态②（子系统内服务）；或改共享文件/剪贴板桥（仅测试）；最终形态④远程 | M2 联调期 | +3-5 天 |
| E3 | JDBC/驱动不兼容 | S6 失败 | 换纯 Java 驱动；驱动 JNI 重编译（4.5-3）；数据层抽象接口保留多实现 | M2 | +2-5 天 |
| E4 | 前端关键 Electron API 缺失 | 功能不可用 | 查 api_index 是否支持（77% 覆盖）；走替代实现（3.3 每项都有兜底）；功能降级 | M1 迭代期 | 每项 0.5-2 天 |
| E5 | 模拟器白屏 | 窗口无内容 | 改 CommandLineAdapter.ets 的 `--use-gl`（3.6）；换真机 | M1 | 0.5 天 |
| E6 | XPM 拦截二进制 | 日志出现 `get signature info failed` | 确认 HNP 打包与集成（5.3.2-5.3.4）；调试期可临时关 XPM（5.3.6） | M3 | 1-3 天 |
| E7 | addon 编译不过 | 编译错误 | 确认 C++≥17、工具链与 Node ABI 匹配（3.7）；找纯 JS 替代；官方 addon 文档（sqlite3 案例）逐条对照 | M1/M3 | 每模块 1-5 天 |
| E8 | C++ 源码不可得 | 盘点无源码 | 5.5 应急方案（商务要源码 → 重写 → 黑盒仿真 → 虚拟机兜底） | 盘点期即触发 | 高 |
| E9 | 上架审核打回（3.5 项/权限归属） | 审核退回 | 按指南完善；权限模块拆分（8.2） | 上架期 | 1-2 天/次 |
| E10 | 版本演进不兼容（DevEco 升级破坏 HNP hack） | 构建失败 | HNP 流水线修改脚本化重放（5.3.4）；锁定版本快照（10.3） | 升级期 | 0.5-1 天 |
| E11 | 整体不可行（探索失败） | 多里程碑受阻 | 走《替代方案报告》路线：ArkWeb 套壳 + 远程后端 / Win11 ARM 虚拟机 / 原生 ArkTS 渐进迁移 | 里程碑评审 | 重新立项 |

---

# 10. 附录

## 10.1 完整离线下载清单汇总表

> 与 2.2 节同一清单的汇总视图，打印后交下载负责人逐项勾销。

| # | 资源 | 版本/命名 | 来源 URL | 账号 | 用途 | 勾销 |
|---|---|---|---|---|---|---|
| 1 | DevEco Studio | 6.1.x（全平台） | developer.huawei.com/consumer/cn/deveco-studio/ | 华为开发者 | IDE/构建 | ☐ |
| 2 | HarmonyOS SDK 离线包 | API 20+/23 | DevEco 下载区 | 华为开发者 | SDK | ☐ |
| 3 | **Electron 鸿蒙版预编译包** | v34.6.3-20260105.1-release.zip | devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home | **华为云** | 壳工程+运行时 | ☐ |
| 4 | Node.js | v20.18.1 | nodejs.org/dist/v20.18.1/ 或 npmmirror | 无 | 前端构建 | ☐ |
| 5 | JDK 17（构建） | Temurin 17 | adoptium.net/temurin/releases/?version=17 | 无 | DevEco/hvigor | ☐ |
| 6 | npm 依赖 tgz 集 | 生产依赖全树 | npm pack（2.2.1） | 无 | 前端依赖 | ☐ |
| 7 | @electron-ohos/electron-builder | 26.8.x | npmjs.com/package/@electron-ohos/electron-builder | 无 | 方案二打包 | ☐ |
| 8 | Maven 离线仓库 | 全依赖+插件 | mvn dependency:go-offline（2.2.2） | 无 | 后端构建 | ☐ |
| 9 | 毕昇JDK17-OH | BiShengJDK17-OH | 鸿蒙应用市场（设备端） | 华为 | 后端运行 | ☐ |
| 10 | 鸿蒙原生工具链 | llvm (aarch64-linux-ohos) | DevEco SDK native 目录 / Electron 源码 | — | addon/C++ 编译 | ☐ |
| 11 | 官方文档整仓 | openharmony-sig/electron | gitcode.com/openharmony-sig/electron | GitCode 可选 | 离线查证 | ☐ |
| 12 | Ubuntu 22.04（备选） | 22.04 ISO + apt 包 | mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/ | 无 | 源码编译备选 | ☐ |
| 13 | 签名材料 | p12/cer/p7b | AGC 在线生成 | 华为开发者联盟 | 签名/上架 | ☐ |
| 14 | 前端源码/后端源码/C++源码 | 现有工程 | 公司内网 | — | 迁移对象 | ☐ |

## 10.2 常用命令速查

### hdc（设备调试）
```bash
hdc list targets                                  # 列出设备
hdc tconn <IP>:5555                               # 无线连接
hdc app install <hap路径>                          # 安装 HAP
hdc install -r <hap路径>                           # 覆盖安装
hdc uninstall <bundleName>                        # 卸载
hdc shell aa start -b <bundleName> -a EntryAbility # 启动应用
hdc shell pm uninstall <bundleName>               # pm 卸载
hdc shell hilog -x -e <关键字>                     # 日志过滤
hdc fport tcp:9229 tcp:9229                       # 端口转发（主进程调试）
hdc shell ls /data/app/*/<pkg>_1.0/bin/           # 查看 HNP 释放
hdc file recv <设备路径> <本地路径>                  # 拉取文件
hdc file send <本地路径> <设备路径>                  # 推送文件
```

### hilog（日志）
```bash
hdc shell hilog -x                                   # 实时全部日志
hdc shell hilog -x -e myapp                          # 按关键字过滤
hdc shell hilog -x -e 'GPU state'                    # 白屏排查
hdc shell hilog -x > all.log                         # 导出
```

### hvigor（命令行构建，CI）
```bash
cd ohos_hap
./hvigorw assembleHap --mode module -p product=default   # Linux/macOS
hvigorw.bat assembleHap --mode module -p product=default # Windows
```

### hnpcli（HNP 打包）
```bash
# 位于 DevEco: sdk/default/openharmony/toolchains/hnpcli
hnpcli pack -i <hnp目录> -o <输出目录> -n <包名> -v 1.0
```

### 交叉编译（C++/addon）
```bash
# 环境变量见 5.3.1 / 3.7；示例编译 hello：
$CC $CFLAGS hello.c -o hello
# addon 重编译：
cd node_modules/<mod> && npm_config_arch=arm64 node-gyp rebuild --target=20.18.1 --arch=arm64
```

### 鸿蒙设备端（终端内）
```bash
java -version                                      # 验证 BiShengJDK17
java -jar backend.jar --server.port=8080           # 启动后端
curl http://127.0.0.1:8080/actuator/health         # 冒烟
getprop persist.sys.dark_mode                      # 暗色模式检测
uname -a                                           # 内核信息
help -a > help.txt                                 # 鸿蒙命令全集
echo 0 > /proc/sys/kernel/xpm/xpm_mode             # 临时关 XPM（仅调试）
nsenter -t <pid> -m sh                             # 进入沙箱视角
```

## 10.3 参考资料与版本快照记录

**核心官方资源**
- 官方仓库：https://gitcode.com/openharmony-sig/electron （含 API 索引 1294/66、hnp、addon、升级、调试、日志、Deeplink 等文档）
- 华为云 CodeHub 预编译包：https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home
- 官方知识地图（持续更新）：https://developer.huawei.com/consumer/cn/forum/topic/0204203363319759021
- 官方开发指导：https://developer.huawei.com/consumer/cn/forum/topic/0204189796759316140
- 五步迁移 FAQ：https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575
- HNP 官方文档：https://gitee.com/openharmony/startup_appspawn/blob/master/service/hnp/pack/README_zh.md
- 签名：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing
- 应用沙箱目录：https://docs.openharmony.cn/pages/v4.1/zh-cn/application-dev/file-management/app-sandbox-directory.md

**环境/账号类**
- DevEco Studio：https://developer.huawei.com/consumer/cn/deveco-studio/
- 华为开发者联盟：https://developer.huawei.com/consumer/cn/
- AGC：https://developer.huawei.com/consumer/cn/service/josp/agc/index.html
- 华为云 CodeHub（需账号）：https://www.huaweicloud.com/product/codehub.html
- 融合开发引擎官方支持页：https://consumer.huawei.com/cn/support/content/zh-cn16091898/

**社区/实战（供查漏）**
- CHINER 元数建模适配记录、markdownify 迁移实践（atomgit.com/OpenHarmonyPCDeveloper/ohos_markdownify）、Electron35 迁移方案、厨房里的化学上架实录（来源见《可行性报告》§8 与《Electron调研报告》§7）

**版本快照记录表（迁移期间持续维护，用于 E10 风险追溯）**

| 组件 | 版本 | 日期 | 备注 |
|---|---|---|---|
| HarmonyOS 系统 | 6.1.0（API 23） | | 真机实测基准 |
| DevEco Studio | 6.1.x | | |
| Electron 鸿蒙版 | v34.6.3-20260105.1 | | 预编译包 |
| Node（内置） | 20.18.1 | | |
| BiShengJDK17-OH | 17.0.13+6 | | |
| Spring Boot | 3.5.x 或 4.0.x | | 按 4.2 决策 |
| @electron-ohos/electron-builder | 26.8.5 | | 方案二 |

---

*文档结束。迁移过程中任何与本文档冲突的官方更新，以官方仓库最新文档为准；本文档中所有 ⚠️ 标注项必须先真机实测，再据此更新对应章节。*
