# 面向 HarmonyOS PC 的桌面应用开发替代技术路线调研报告

> 调研时间：2026-08-14 ｜ 调研范围：官方文档、GitHub/Gitee、Qt Wiki、Eclipse 官方刊物、华为开发者社区、主流技术社区
> 用户背景：想做鸿蒙 PC 上的 App，理想形态是"Electron 前端 + JDK21 & SpringBoot 后端（前后端都跑在本机）"。

---

## 0. 结论速览（TL;DR）

1. **鸿蒙上不存在 Electron**，Electron 官方只支持 macOS/Windows/Linux；鸿蒙上也不存在官方 JVM 运行时，Spring Boot 后端**无法直接在本机（HAP 沙箱）内运行**。这是两条硬约束。
2. **官方唯一推荐的桌面应用开发方式**是 ArkTS + ArkUI（声明式 UI，类似 SwiftUI/Compose），当前主流 API 为 **API 23（HarmonyOS 6.1.0）**，HarmonyOS 7.0 已于 2026-06 发布开发者 Beta。
3. **PC 端能力已基本就绪**：自由窗口/多窗口/多实例、键鼠（hover/滚轮/快捷键）、系统托盘（Desktop Extension Kit）、拖放（含跨设备）等官方 API 均已提供，但"套壳 App"拿到的系统集成能力仍不如原生 ArkTS。
4. **ArkWeb（Web 组件）可以完整加载本地打包的 React/Vue/H5 资源**，并提供双向 JSBridge（`javaScriptProxy`/`@NativeCall` + `runJavaScript`），这是"WebView 套壳"路线的技术底座；差距主要在**没有 Node.js 主进程**、无 Electron 生态、且自研内核与 Chromium 非 100% 兼容。
5. **Flutter（ohos 分支）**：可用但非上游官方，默认分支 3.7.12-ohos-1.0.4（2026-08 仍在更新），3.22.1-ohos-0.1.0 分支已出现；插件生态与稳定性仍是短板。
6. **Tauri**：官方不支持，但 **Eclipse Oniro 项目已于 2026-04 完成 Tauri/Ionic-Capacitor 到 OpenHarmony 的移植**（含 `cargo tauri ohos dev`），Tauri 主仓也已合入修复 PR，属于"实验性可用、值得跟踪"。
7. **Qt**：官方自 Qt 6.12 起提供 HarmonyOS 目标（arm64-v8a，配合 DevEco Studio 6.1.0 + SDK API 23），是目前最成熟的 C++ 路线。
8. **推荐路径（对"已有 Web 前端 + Spring Boot 后端"团队）**：① 短期——ArkWeb 套壳保留 Web 前端 + 后端改远程/云端（或经官方"融合开发引擎"虚拟机在 PC 上跑 Linux 服务，属尝鲜）；② 中期——核心页面渐进迁移为原生 ArkTS/ArkUI，后端逻辑用 ArkTS/NAPI（或 Rust via NAPI）重写，实现真正的本机离线运行；③ 关注——Tauri-ohos（Oniro）与 Flutter-ohos 3.22 分支作为"少改代码"备选。

---

## 1. HarmonyOS 官方推荐的桌面应用开发方式：ArkTS + ArkUI

### 1.1 官方技术栈与 API 版本现状

- 官方唯一推荐的应用开发语言/框架组合是 **ArkTS（TypeScript 超集）+ ArkUI（声明式 UI）**，UI 描述方式与 SwiftUI/Jetpack Compose 同构（`@Entry @Component struct ... build()`）。官方定位文档：[ArkUI简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/arkui-overview)。
- **版本线（截至 2026-08）**：
  - HarmonyOS 6.0（2025-10-22 正式发布并开启公测）——[华为正式发布HarmonyOS 6（雷峰网）](https://www.leiphone.com/category/industrynews/kWBFR4wylPLZZ2wX.html)、[HarmonyOS 6 正式发布，鸿蒙电脑更智慧更好玩（C114）](https://www.c114.com.cn/news/126/a1299223.html)
  - API 21 ≈ HarmonyOS 6.0.1（2025-11-25 随 Mate 80 首发）
  - **API 23 ≈ HarmonyOS 6.1.0（当前主流，配套 DevEco Studio 6.1.0）**；存量设备中 API 23 占比已突破 23%，5.x 快速淘汰——[华为鸿蒙存量设备 API 版本使用数据更新（IT之家）](https://www.ithome.com/0/945/550.htm)
  - **HarmonyOS 7.0 Developer Beta 1 于 2026-06 发布**（主打"快启内核"、Agent 架构）——[华为发布鸿蒙7操作系统（新浪）](https://finance.sina.cn/2026-06-12/detail-iniceimi3422168.d.html?vt=4)、[HarmonyOS 7开发者Beta正式启动（宁夏日报）](https://szb.nxrb.cn/xxxb/pc/con/202606/18/content_202978.html)
  - 官方版本总览：[所有HarmonyOS开发套件版本](https://developer.huawei.com/consumer/cn/doc/doccenter-release-notes/overview-allversion)

### 1.2 PC 端（鸿蒙电脑）适配情况

- **鸿蒙电脑（HarmonyOS PC）**：2025-05-19/20 首批两款设备发布——[鸿蒙正式亮相电脑端（人民网）](http://finance.people.com.cn/n1/2025/0519/c1004-40483164.html)、[华为正式推出鸿蒙电脑（中新网）](http://www.chinanews.com.cn/cj/2025/05-19/10418404.shtml)。
- **官方 PC 开发入口**：[鸿蒙电脑应用开发入门（华为开发者联盟）](https://developer.huawei.com/consumer/cn/multidevice/pc/get-started/)；DevEco Studio 提供 PC 模拟器与 PC SDK 包。
- **多窗口/多任务**：官方窗口体系支持 **全屏、自由窗口（freeform）、悬浮窗**等窗口模式，PC 上支持多窗口、多实例、拖拽缩放、最小化/最大化/关闭，见官方文档 [窗口模式简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/window-mode-overview)、[自由窗口简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/freeform-window-overview)、[窗口模式（多设备）](https://developer.huawei.com/consumer/cn/doc/doccenter-multi-device/bpta-multi-device-window-mode)、[管理应用窗口（Stage 模型）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-v5/application-window-stage-V5)。
- **键鼠交互**：ArkUI 支持鼠标 hover、滚轮、键盘快捷键等桌面事件（社区实战：[鸿蒙PC开发从入门到实战](https://blog.csdn.net/m0_59315734/article/details/157620002)）；"一次开发、多端部署"的多设备适配官方实践：[【大展鸿图】鸿蒙 7.0 多端适配最佳实践（InfoQ）](https://xie.infoq.cn/article/7d7c51f1fb499781e650b5cd1)。
- **系统托盘/状态栏**：官方提供 **Desktop Extension Kit（桌面拓展服务）**，含 `StatusBarViewExtensionAbility`、`statusBarManager`——[Desktop Extension Kit 简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/statusbar-extension-introduction)、[StatusBarViewExtensionAbility](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/statusbar-extension-ability)；社区已有"最小化到托盘/托盘菜单"教程（[ai6s 教程（88）](https://ai6s.net/6a3d02d8662f9a54cb8454d0.html)）。
- **文件拖放**：ArkUI 官方拖拽事件（组件内/跨应用，基于 UDMF 统一数据定义）——[拖拽事件（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/apis-arkui/arkui-ts/ts-universal-events-drag-drop)、[拖拽控制](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/ts-universal-attributes-drag-drop)；社区实践含"文件拖入应用"与"跨设备键鼠穿越"（[鸿蒙 ArkTS 跨端拖拽实战](https://harmonyosdev.csdn.net/6a4f71c9662f9a54cb8d6a05.html)）。
- **开发体验与学习成本**：DevEco Studio 6.1 + 模拟器/真机；ArkTS 语言门槛低于 C++，但 ArkUI 组件体系、状态管理（@State/@Prop/@Link 等）、Stage 模型、权限/签名/上架流程需要全新学习；社区普遍反馈"从 Web 前端转鸿蒙原生"成本明显高于"套壳"。

### 1.3 官方"迁移指南"与迁移工具现状

- **没有面向 Web/Electron 应用的一键迁移工具**。官方提供的相关材料：
  - [H5适配HarmonyOS开发指导（官方 FAQ）](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-arkweb-179)；
  - [Web组件对H5、常用框架VUE、React的页面支持情况（官方 FAQ，含本地与网络端页面）](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs-V5/faqs-arkweb-38-V5)；
  - 旧的"兼容 JS 的类 Web 开发范式"（JS UI，已被 ArkTS 取代）——[UI开发(兼容JS的类Web开发范式)概述](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/ui-js-overview)；
  - 官方元服务（原子化服务）本质是 Web 技术栈轻应用，参考 [元服务 Web 组件指南](https://developer.huawei.com/consumer/cn/doc/atomic-guides/atomicserviceweb-guidelines)。
- 社区存在大量"Electron → 鸿蒙"迁移实践文章（多为 WebView + IPC 架构改造），例如 [Electron 与鸿蒙 DevEco Studio 的融合实战：从 WebView 到安全 IPC 架构迁移指南（腾讯云）](https://cloud.tencent.com/developer/article/2605535)、[react项目通过electron迁移鸿蒙PC（华为开发者问答）](https://developer.huawei.com/consumer/cn/forum/topic/0207208651943134252?fid=0109140870620153026)——但均非官方工具。

---

## 2. ArkWeb（Web 组件）：浏览器内核容器能力评估（"WebView 套壳"路线）

### 2.1 能力定位与内核

- ArkWeb 是 **HarmonyOS NEXT 上唯一官方支持的 Web 渲染引擎**（官方：[ArkWeb简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-component-overview)）。多方社区深度解析称其采用**华为自研内核**（多进程架构、安全策略严格，非 Android WebView 式 Chromium 移植）——[《HarmonyOS技术精讲-ArkWeb》开篇：ArkWeb引擎全景解析](https://harmonyosdev.csdn.net/6a42268110ee7a33f283b3fb.html)、[鸿蒙NEXT ArkWeb揭秘：原生与Web融合的艺术](https://blog.csdn.net/feathersong/article/details/151726545)。（"完全自研 vs 深度魔改 Chromium"的官方口径未见明确披露，见"待核实"。）

### 2.2 能否加载本地打包的 H5/React/Vue？

- **可以**。标准做法：资源放入 `entry/src/main/resources/rawfile/`，用 `Web({ src: $rawfile('web/index.html') })` 加载（官方模式，教程见[从零开始写 HarmonyOS Web 容器：先让 ArkWeb 加载本地 H5（掘金）](https://juejin.cn/post/7660146827875500066)）；官方 FAQ 明确"支持 H5、Vue、React 的本地与网络页面"。
- **生产级更优做法**：ArkWeb 提供请求拦截能力（`onInterceptRequest` / `WebResourceHandler` C API）实现"虚拟 localhost 源"——Eclipse Oniro 团队为 Capacitor 移植就是这么做的：用拦截器把 `http://localhost` 请求映射到应用 rawfile（经 Resource Manager），并做路径穿越校验与 MIME 检测，从而绕过 file:// 协议下的 CORS/Service Worker 限制——[Eclipse 官方刊物：Bringing Ionic and Tauri to OpenHarmony](https://newsroom.eclipse.org/eclipse-newsletter/2026/april/bridging-ecosystem-divide-bringing-ionic-and-tauri-openharmony)、[ArkWeb_Scheme_Handler（C API 官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/capi-arkweb-scheme-handler-h)。
- 注意：ArkWeb 默认启用严格同源策略与安全策略，`fetch` 跨域需后端 CORS 或走 ArkTS 原生侧转发。

### 2.3 与原生 ArkTS 的互调（JSBridge）

- **JS → ArkTS**：`javaScriptProxy` / `registerJavaScriptProxy`（新版可用 `@NativeCall` 装饰器），在 JS 侧绑定为 `window.xxx` 对象。
- **ArkTS → JS**：`runJavaScript()`（异步，须在 `onPageEnd` 之后调用）。
- 传参需字符串序列化（官方限制：不支持非字符串参数）；另有 `WebMessagePort`（postMessage 通道）可用于双向消息。
- 官方 FAQ：[How do HTML5 pages interact with ArkTS?](https://developer.huawei.com/consumer/cn/en/doc/harmonyos-faqs-V5/faqs-arkweb-1-V5)；社区踩坑实录（JSBridge 卡 UI、runJavaScript 拿不到返回值）：[华为开发者问答](https://developer.huawei.com/consumer/cn/forum/topic/0203219368443403143?fid=0109140870620153026)、[ArkWeb JSBridge 主线程卡顿](https://developer.huawei.com/consumer/cn/forum/topic/0208218974124493081?fid=0109140870620153026)。

### 2.4 与 Electron 方案的差距（Node.js 能力缺失如何弥补？）

| 维度 | Electron | ArkWeb 套壳 |
|---|---|---|
| 渲染 | Chromium | 华为自研 Web 内核（非 Chromium 完全兼容，WebGPU 等能力待跟进）|
| 主进程 | Node.js（文件系统、子进程、系统 API 全能力）| **无 Node 主进程**；ArkTS/NAPI 承担原生能力 |
| 进程模型 | 多进程自由 | 应用沙箱（mnt/pid namespace + SELinux + seccomp），能力受限（[鸿蒙 PC 沙箱详解](https://gitcode.csdn.net/69f77a270a2f6a37c5a7b1cf.html)）|
| 系统集成 | 托盘/快捷键/协议/自动更新生态成熟 | 官方 API 逐项补齐中（Desktop Extension Kit、托盘、拖放）|
| 生态 | Electron 海量插件 | 无对应生态，靠 NAPI 自建 |

**Node.js 能力缺失的弥补路径**：
1. **NAPI + C/C++（或 Rust）**：把文件、网络、计算能力写成 native 模块供 ArkTS 调用；OpenHarmony 官方支持 Rust（Tier 2）与 Node-API 绑定（`@ohos-rs` 生态，Tauri 移植即基于此）。
2. **Node.js 本体已可移植**：nodejs/node PR #58350「build: add support for OpenHarmony operating system」已于 2025-05-21 合入主仓（arm64）——[PR #58350](https://github.com/nodejs/node/pull/58350)。但**在 HAP 应用沙箱内运行 Node 进程并非官方支持的模式**，需自研打包与签名方案（待核实/高成本）。
3. **能力上移 ArkTS**：把原 Node 侧的本地服务逻辑改写为 ArkTS 后台任务/Ability。
4. **后端外置**：Spring Boot 改跑在局域网/云端，ArkWeb 页面直接 fetch（配 CORS）。

---

## 3. Flutter 在 HarmonyOS 上的支持现状

- **主体仓库**：`openharmony-sig/flutter_flutter`（托管于 Gitee，非 Flutter 上游官方）——[Gitee 仓库](https://gitee.com/openharmony-sig/flutter_flutter)。关键事实（2026-08-14 实测 Gitee API）：
  - 默认分支：**3.7.12-ohos-1.0.4**（2026-08-05 仍有更新，1.2k star）；
  - 已出现 **3.22.1-ohos-0.1.0** 分支（上游 3.22 线）；
  - 命令：`flutter create --platforms ohos`、`flutter build hap --release`，产物 `entry-default-signed.hap`；需 DevEco/OpenHarmony SDK + JDK17 + node/ohpm/hvigor。
- **文档**：`flutter_samples/ohos/docs`（[参考文档](https://gitee.com/openharmony-sig/flutter_samples/tree/master/ohos/docs)）；社区有 [Flutter-OH 升级指导](https://openharmonycrossplatform.csdn.net/69bc95e00a2f6a37c598bb01.html)。
- **成熟度评估**：可用但**非稳定正式支持**。风险点：① 版本滞后于上游 Flutter；② 插件生态缺口大，需要自行移植插件；③ 社区反馈问题多（如 [已有Flutter项目鸿蒙化后白屏](https://developer.huawei.com/consumer/cn/forum/topic/0202180215413837553?fid=0109140870620153026)、[分支管理混乱讨论](https://bbs.itying.com/topic/677e044951ce9c0219d58363)）；④ Flutter 官方对 OpenHarmony 无正式承诺。
- 顺带：**React Native** 同样走社区路线（RN-OH，跟踪上游 0.8x）——[React Native 版本选择指南：0.83.X 发布，RN-OH 何去何从（知乎）](https://zhuanlan.zhihu.com/p/2000874888450314837)。

---

## 4. Tauri 在 HarmonyOS 上的支持现状（2026-08 视角：已非"完全不支持"）

- **Tauri 官方**：不支持 HarmonyOS（官方平台仅 Windows/macOS/Linux）。Electron 同理（其 README 仅列三大桌面平台）。
- **重大进展（实验性）**：Eclipse Oniro 项目于 2026-04 官方宣布完成 **Tauri 与 Ionic/Capacitor 到 OpenHarmony 的移植**——[Eclipse Newsletter（2026-04）](https://newsroom.eclipse.org/eclipse-newsletter/2026/april/bridging-ecosystem-divide-bringing-ionic-and-tauri-openharmony)：
  - Tauri：Rust 核心通过 **NAPI 绑定**重定义为"guest library"，采用 **Window Adoption 模式**（Rust 侧接管 ArkTS 提供的 window stage），CLI 增加 `cargo tauri ohos dev`；
  - 验证案例：Lichess（React + Capacitor 重型应用）在 OpenHarmony 上以接近原生性能运行；
  - 移植周期仅数周（借助 AI 编码）。
- **Tauri 主仓已有合入修复**：[tauri-apps/tauri PR #15237「fix(cli): bump @ohos-rs/ability to resolve white screen issue」](https://github.com/tauri-apps/tauri/pull/15237)（2026-04-14 合入，明确在 **HarmonyOS PC** 上测试通过；配套示例仓 [Islatri/tauri-ohos-test](https://github.com/Islatri/tauri-ohos-test)）。
- **结论**：Tauri 在鸿蒙上已从"不可能"变为"实验性可用、上游尚未官方承诺"。对"Rust 后端 + Web 前端"团队是强备选，但生产风险高（无官方版本/API 稳定性保障）。

---

## 5. Qt for HarmonyOS 及其他 C++ 方案

- **Qt 官方**：Qt 6.12（Beta2 起）在线安装器提供 **HarmonyOS 目标（arm64_v8a）**，配合 DevEco Studio 6.1.0 + SDK API 23 可交叉编译并产出 HAP（工具链含 `harmonydeployqt`、`QT_HARMONYOS_*` CMake 变量）——[Qt Wiki：Qt for HarmonyOS development with 6.12.0 Beta2](https://wiki.qt.io/index.php?title=Qt_for_HarmonyOS_development_with_6.12.0_Beta2)、[Qt Wiki：Building Qt for HarmonyOS](https://wiki.qt.io/index.php?title=Building_Qt_for_HarmonyOS)。Qt 侧甚至已实现 **系统托盘**（`QOhosSystemTrayIcon`）——[Qt Class Reference](https://contribute.qt-project.org/doc/d5/db0/classQT__BEGIN__NAMESPACE_1_1QOhosSystemTrayIcon.html)。
- **社区版**：徐建国持续维护 "Qt For OpenHarmony"（Alpha v8）——[腾讯云开发者社区](https://cloud.tencent.cn/developer/article/2624906)。
- **其他**：
  - 纯 C/C++：可通过 NAPI/系统接口直接开发（无 UI 框架），成本最高；
  - **仓颉（Cangjie）语言**：华为自研编程语言（2025-06 发布），支持鸿蒙应用开发，生态处于早期，暂不作为主选；
  - Rust：OpenHarmony 官方 Tier 2 支持 + `@ohos-rs` 绑定，适合做 NAPI 原生模块而非整 UI。

---

## 6. 综合对比与推荐路径

### 6.1 对比表（方案 × 关键维度）

| 方案 | 前端技术 | 后端承载方式（本机） | 开发成本 | 性能 | 系统集成能力（PC） | 风险 |
|---|---|---|---|---|---|---|
| **A. 原生 ArkTS/ArkUI**（官方推荐） | ArkTS 全量重写（不复用 React/Vue） | ArkTS/NAPI 改写后端逻辑（或调远程） | 高（前端+后端双重重写） | 最高（原生渲染） | 最强（窗口/托盘/拖放/多端） | 低（官方路线，生态持续投入） |
| **B. ArkWeb 套壳**（Web 前端保留） | 现有 React/Vue/H5 打包进 rawfile/虚拟 localhost | ① 远程/局域网 Spring Boot（最省事）② 融合开发引擎/VM 里跑 Linux 服务（尝鲜）③ 后端逻辑改 ArkTS/NAPI | 中低（前端零改写，需写 ArkTS 壳层 + JSBridge + 原生能力封装） | 中（自研内核渲染，接近 Chromium 日常场景；大数据量/复杂 Web 特性受限） | 中（托盘/窗口等经壳层调官方 API，受沙箱限制） | 中（内核非 Chromium 100% 兼容；JSBridge 性能/卡顿问题需治理；上架审核看形态） |
| **C. Flutter（ohos 分支）** | Dart（需从 React/Vue 改写） | 无本机 Java；Dart/NAPI 或远程 | 中高（语言切换） | 中高（自绘引擎，PC 端细节待打磨） | 中（插件生态缺口，需自行移植） | 高（非官方 fork、版本滞后、白屏等已知问题） |
| **D. Tauri（Oniro 实验移植）** | 现有 Web 前端保留（Rust 侧原生） | Rust 后端（需改写 Spring Boot 逻辑） | 中（前端保留 + Rust 后端改写） | 中高（WebView 渲染 + Rust 核心） | 中（Window Adoption 模式，能力在补齐） | 高（非上游稳定支持、文档少、仅社区验证） |
| **E. Qt for HarmonyOS（C++）** | QML/Widgets（需全量重写） | C++ 后端改写 | 高 | 高 | 强（Qt 官方持续适配，已有托盘） | 中（Qt 官方支持仍属新目标，API 23 起步；团队需 C++ 能力） |
| **F. Electron（理想形态）** | React/Vue 保留 | Node.js 主进程 + 本机 JVM/Spring Boot | — | — | — | **不存在**（官方不支持；鸿蒙无 Node 主进程、无 JVM） |

### 6.2 对"Web 前端（React/Vue）+ Spring Boot 后端"团队的推荐路径

**第一步（能上线、成本最低）：ArkWeb 套壳（方案 B）**
- 前端：现有 Web 应用构建产物打入 rawfile（或实现虚拟 localhost 拦截器解决 CORS/Service Worker）；
- 壳层：ArkTS 写一个 Web 容器页 + JSBridge（`javaScriptProxy`/`runJavaScript`），把需要强系统能力的操作（托盘、窗口、文件、通知）暴露给 H5；
- 后端：Spring Boot 短期内**跑在云端或局域网**（本机鸿蒙 PC 无 JVM）。若必须"本机"，可用华为官方 2026-04 上线的**"融合开发引擎"**（鸿蒙 PC 应用市场尝鲜专区，轻量虚拟化、可运行 Linux 服务，支持共享文件夹/快照）——[PChome 报道](https://article.pchome.net/info/12453.html)；或 VM 方案（体验较差，见 [鸿蒙PC安装虚拟机跑 IDEA+SpringBoot 讨论](https://bbs.itying.com/topic/697bd89bc504c50058fd2420)）。

**第二步（半年内）：核心功能渐进原生（方案 A + B 混合）**
- 把高频、重交互页面迁移为 ArkTS/ArkUI；H5 保留长尾页面（ArkWeb 内嵌）；
- 后端逻辑按"本地能力"优先级重写为 ArkTS/NAPI（或 Rust NAPI），彻底摆脱对 JVM 的依赖，实现离线可用。

**第三步（跟踪项）**：关注 Tauri-ohos（Oniro）与 Flutter-ohos 3.22 分支的稳定化进度；若团队强 C++ 背景，Qt 6.12+ 是原生级备选。

---

## 7. 不确定 / 待核实项清单

1. **ArkWeb 内核技术细节**："华为完全自研" vs "深度定制 Chromium" 无官方明确口径（社区文章倾向"自研"，官方文档未披露）→ 影响 Web 特性兼容性评估。
2. **HAP 沙箱内运行 Node.js/自研可执行文件的合法性**：Node.js 已支持 OpenHarmony 构建目标（arm64），但"应用内嵌 Node 进程"是否满足华为应用市场审核/沙箱策略，未见官方明文。
3. **本机 JVM/Spring Boot**：鸿蒙 PC 无官方 Java 运行时；"融合开发引擎"（2026-04 尝鲜版 1.0.0.17）仅媒体确认，官方文档与长期支持政策待跟进。
4. **系统托盘/Desktop Extension Kit 的 API 覆盖面与版本门槛**（官方 API 文档确认存在，但"最小化到托盘"的完整官方示例较少，社区多靠 Window 能力组合实现）。
5. **ArkWeb 对复杂 Web 特性的支持边界**：WebGPU 等尚在讨论（[华为开发者问答](https://developer.huawei.com/consumer/cn/forum/topic/0208215361061922306?fid=0109140870620153026)）；大型企业级 Web 应用（强依赖旧 Chromium 特性）官方明确"不适合"。
6. **Flutter-ohos 3.22 分支成熟度**：仅见分支存在，未见稳定性公告。
7. **Tauri-ohos**：上游未正式承诺支持，PR 为 CLI 模板级修复，长期维护性未知。
8. 本文所引官方文档页（developer.huawei.com 的 doccenter/faqs 类页面）为 JS 渲染，正文细节系通过检索快照/社区转载交叉验证，个别表述可能存在时效差。

---

## 8. 主要参考链接（按问题归类）

**Q1 官方开发方式 / PC 适配**
- [ArkUI简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/arkui-overview)
- [鸿蒙电脑应用开发入门](https://developer.huawei.com/consumer/cn/multidevice/pc/get-started/)
- [窗口模式简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/window-mode-overview) ｜ [自由窗口简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/freeform-window-overview)
- [Desktop Extension Kit 简介](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/statusbar-extension-introduction)
- [拖拽事件（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/apis-arkui/arkui-ts/ts-universal-events-drag-drop)
- [华为正式发布HarmonyOS 6（雷峰网）](https://www.leiphone.com/category/industrynews/kWBFR4wylPLZZ2wX.html) ｜ [鸿蒙正式亮相电脑端（人民网）](http://finance.people.com.cn/n1/2025/0519/c1004-40483164.html)
- [HarmonyOS 7开发者Beta正式启动（宁夏日报）](https://szb.nxrb.cn/xxxb/pc/con/202606/18/content_202978.html)
- [所有HarmonyOS开发套件版本](https://developer.huawei.com/consumer/cn/doc/doccenter-release-notes/overview-allversion)

**Q1 官方迁移材料**
- [H5适配HarmonyOS开发指导（FAQ）](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-arkweb-179)
- [Web组件对H5、VUE、React的页面支持情况（FAQ）](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs-V5/faqs-arkweb-38-V5)
- [兼容JS的类Web开发范式概述](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/ui-js-overview)

**Q2 ArkWeb**
- [ArkWeb简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-component-overview)
- [ArkWeb引擎全景解析（CSDN/HarmonyOS社区）](https://harmonyosdev.csdn.net/6a42268110ee7a33f283b3fb.html)
- [从零开始写 HarmonyOS Web 容器：加载本地 H5（掘金）](https://juejin.cn/post/7660146827875500066)
- [ArkWeb_Scheme_Handler（C API）](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/capi-arkweb-scheme-handler-h)
- [HTML5 页面与 ArkTS 交互 FAQ](https://developer.huawei.com/consumer/cn/en/doc/harmonyos-faqs-V5/faqs-arkweb-1-V5)

**Q3 Flutter**
- [openharmony-sig/flutter_flutter（Gitee）](https://gitee.com/openharmony-sig/flutter_flutter)
- [flutter_samples ohos 文档](https://gitee.com/openharmony-sig/flutter_samples/tree/master/ohos/docs)

**Q4 Tauri**
- [Eclipse Newsletter：Bringing Ionic and Tauri to OpenHarmony（2026-04）](https://newsroom.eclipse.org/eclipse-newsletter/2026/april/bridging-ecosystem-divide-bringing-ionic-and-tauri-openharmony)
- [tauri PR #15237（HarmonyOS PC 白屏修复）](https://github.com/tauri-apps/tauri/pull/15237)

**Q5 Qt/C++**
- [Qt for HarmonyOS development with 6.12.0 Beta2（Qt Wiki）](https://wiki.qt.io/index.php?title=Qt_for_HarmonyOS_development_with_6.12.0_Beta2)
- [Building Qt for HarmonyOS（Qt Wiki）](https://wiki.qt.io/index.php?title=Building_Qt_for_HarmonyOS)
- [QOhosSystemTrayIcon（Qt 类参考）](https://contribute.qt-project.org/doc/d5/db0/classQT__BEGIN__NAMESPACE_1_1QOhosSystemTrayIcon.html)

**其他**
- [nodejs/node PR #58350：OpenHarmony 构建支持（已合入）](https://github.com/nodejs/node/pull/58350)
- [鸿蒙 PC 应用沙箱与非沙箱环境（AtomGit/CSDN）](https://gitcode.csdn.net/69f77a270a2f6a37c5a7b1cf.html)
- [华为鸿蒙PC端上线"融合开发引擎"支持运行 Linux 环境（PChome）](https://article.pchome.net/info/12453.html)
- [鸿蒙PC安装虚拟机跑 IDEA+SpringBoot（IT营）](https://bbs.itying.com/topic/697bd89bc504c50058fd2420)
