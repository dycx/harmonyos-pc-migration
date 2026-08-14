# Electron 应用在 HarmonyOS（鸿蒙）PC 上运行的现状与方案调研报告

> 调研日期：2026-08-14（本环境当前时间）
> 调研方法：web_search 中英文多轮检索 + 直接抓取华为开发者论坛公开 API、GitCode/Gitee/华为云 CodeHub 公开文档、GitHub/CSDN/掘金/腾讯云/微信公众号等页面原文核实。
> 信息来源分级：官方（华为/OpenHarmony SIG 文档与论坛官方账号回复）＞ 厂商官网/官方公众号 ＞ 社区实战文章（标注"待核实"处为来源间有出入或无法直接核实）。

---

## 摘要（核心结论，先看这里）

1. **华为对 Electron 在 HarmonyOS NEXT 上运行的态度是"官方支持（以开源社区形式主导）"，不是"官方不反对的社区野方案"，也不是"完全不支持"**。证据链完整：华为开发者论坛存在官方"Electron 开发 HarmonyOS 应用知识地图"总帖、官方账号 "HarmonyOS技术支持"（Lv10）发布的《Electron框架HarmonyOS开发指导》明确写"当前 HarmonyOS Electron 框架已开源""开发者现在可以在 HarmonyOS 5.0 上放心地集成和使用"，官方源码仓 `openharmony-sig/electron`（GitCode）于 **2025 年 6 月开源至 OH 社区**，官方 Release 构建包在华为云 CodeHub 分发（需华为云账号）。同时官方建议："如果您在其他平台未使用过 Electron 框架，不建议您直接使用该框架"——即**支持已有 Electron 项目迁移，不建议新项目为此选型**。
2. **技术方案不是"把渲染层 Chromium 替换成 ArkWeb"**，而是**整套 Chromium+Electron 移植到 OH 平台**：华为/OpenHarmony 在 OH 上维护了独立的 **PC-Chromium**（与系统 WebView 用的 ArkWeb-Chromium 明确区分、分别命名），Electron 以 `libelectron.so + libadapter.so + ArkTS 壳工程` 形式接入，最终打成 **HAP 包**；Node.js 主进程能力（文件、网络、子进程等）映射到鸿蒙沙箱与系统能力，并通过新增 API（`systemPreferences.requestSystemPermission`、`BrowserWindow.windowInfo` 悬浮窗、`callArkTSFunction` 等）桥接 ArkTS/NAPI。官方提供三档 Electron 版本：**Electron 25（Chromium 114 / Node 18.18.2）、Electron 34（Chromium 132 / Node 20.18.1）、Electron 37（Chromium 138 / Node 22.16.0）**。工具链包括 DevEco Studio 打包方案与 npm 包 `@electron-ohos/electron-builder`。
3. **第三方公司确实在做鸿蒙版 Chromium/CEF/Electron**：**海泰方圆（红莲花）** 官方公布"基于高内核版本 Chromium114，已完成 CEF、Electron、Chromium 三大主流三方框架的鸿蒙化"，并与华为研发团队联合解决 Chromium 与 ArkTS/ArkUI 不兼容问题；其红莲花国密浏览器鸿蒙版是"第一款且唯一一款支持鸿蒙纯血系统的国密浏览器"（2024-06 HDC2024 发布，2024-11 获原生鸿蒙适配认证）。该方案**面向 ToB，未见开源**（"持续维护社区源代码"一说待核实）。
4. **已知限制**：官方 API 文档共 **1294 个 API，其中 998 个支持、296 个不支持（约 77% 支持率）**；`autoUpdater`（全部 10 个）、`TouchBar`/`Dock`（macOS 专属全部）、`inAppPurchase`、`Extensions` 完全不支持，`BrowserWindow`（56/198 不支持）、`app`（40/108）、`Tray`（25/35）、`clipboard`（7/19，RTF/FindText 等格式不支持）、`powerMonitor`（10/16）等大量残缺；**Node 原生模块（.node/.so）必须用鸿蒙交叉编译工具链重编译**；**运行时只有 arm64-v8a 架构的 so，x86 设备不能跑**；**模拟器支持差（安装即报错/白屏，需禁用 GPU 或真机）**；子进程执行命令需先把可执行文件打成 **hnp 包**；应用更新不能走 Electron 自带 autoUpdater，只能走华为应用市场。
5. **2024–2025（含 2026 上半年）真实可用性：已经"真实可用"，但生态仍偏早期**。官方开源后（2025-06）有完整文档、真实设备/模拟器可跑、**已有个人开发者应用通过 Electron 鸿蒙化真实上架华为 AppGallery（"厨房里的化学"，bundle id `com.chufang.electron_pro`）**，华为论坛官方明确答复"现有 Electron 项目适配 HarmonyOS 是完全可行的"。但**公开可查的大厂量产案例几乎没有**（QQ 鸿蒙版是 ArkTS 原生重写而非 Electron；"部分应用已先行启动适配"官方未点名），大量案例仍属教程/演示/个人项目级别（Pomotroid、KeeWeb、markdownify、轻画廊等）。

---

## 一、华为官方对 Electron 在 HarmonyOS NEXT 上运行的态度

### 1.1 结论

**官方支持，形式为"OpenHarmony SIG 开源 + 华为开发者论坛官方答疑 + 官方 Release 包分发"**，属于官方主导的适配方案，而非华为默许的第三方野路子。但华为同时明确：**不建议没有 Electron 经验的项目为此选型**。

### 1.2 关键事实与证据

| 证据 | 内容 | 来源 |
|---|---|---|
| 官方知识地图总帖 | 《Electron开发HarmonyOS应用知识地图》：明确"Electron 允许您维护一个 JavaScript 代码库，并创建可以在 Windows、macOS、Linux 和 HarmonyOS 上运行的跨平台应用程序"；开篇即写"如果您在其他平台未使用过 Electron 框架，不建议您直接使用该框架"；全文列出的 API 文档、环境搭建、HAP 构建、关键能力适配、跨语言扩展、调试问题集全部指向官方仓库与官方问答 | [华为开发者联盟论坛 - Electron开发HarmonyOS应用知识地图](https://developer.huawei.com/consumer/cn/forum/topic/0204203363319759021?fid=0109140870620153026) |
| 官方技术支持账号 | 作者 "HarmonyOS技术支持"（Lv10、587 粉丝）发布《Electron框架HarmonyOS开发指导》，原文："**HarmonyOS Electron框架已获得HarmonyOS生态合作伙伴的支持，当前HarmonyOS Electron框架已开源**""**开发者现在可以在 HarmonyOS 5.0 上放心地集成和使用 HarmonyOS Electron**""**HarmonyOS Electron已于2025年6月开源至OH社区**"，并给出完整编译/打包/签名/权限/窗口指导 | [华为开发者联盟论坛 - Electron框架HarmonyOS开发指导](https://developer.huawei.com/consumer/cn/forum/topic/0204189796759316140?fid=0109140870620153026) |
| 官方迁移 FAQ | 《已有Electron项目，如何适配HarmonyOS PC》：官方给出 Electron 25/34/37 版本矩阵、五步迁移方法论、TS 编译报错对照表；FAQ 明确"HarmonyOS平台输出的字段是 openharmony"（与另一官方文档"ohos"矛盾，见待核实 1） | [华为开发者联盟论坛 - 已有Electron项目，如何适配HarmonyOS PC](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575) |
| 早期状态答复 | 《Electron鸿蒙化》帖（创建于 2025-04-30）：官方答复"**HarmonyOS已经支持Electron，部分应用已先行启动适配。目前该过程还在beta阶段，尚未公开发布**"；FAQ"是否支持 electron-builder 打包？——目前不支持，可以使用 DevEco Studio 打包"。可见 2025 年中前是内测/伙伴阶段，2025-06 开源后转为公开 | [华为开发者联盟论坛 - Electron鸿蒙化](https://developer.huawei.com/consumer/cn/forum/topic/0204181390529189966) |
| 官方仓库与 Release | 源码仓 `openharmony-sig/electron`（GitCode/AtomGit，含 1294 API 文档、hnp/子进程/三方库/升级等文档）；Release 构建包在华为云 CodeHub（`devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858`，需华为云账号登录下载） | [GitCode - openharmony-sig/electron（Electron鸿蒙化指导文档）](https://gitcode.com/openharmony-sig/electron) 、[华为云 CodeHub Release 构建包仓库](https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home) |
| OpenHarmony SIG 决策记录 | OpenHarmony 架构 SIG 第 182 次会议纪要（2025-10-21）：议题 2"跨平台 CEF/Chromium 框架申请新增 Chromium 138 版本"、议题 3"跨平台 Electron 框架申请新增 Electron 37 版本"均获批；遗留问题要求"Electron 给外部伙伴使用需要先孵化毕业，有完善的版本发布流程、完整的 CI 流程"；并明确"清晰区分 **ArkWeb-Chromium** 和 **PC-Chromium** 的定位，依据定位重新命名" | [OpenHarmony 架构SIG第182次会议纪要（dev 邮件列表）](https://lists.openatom.io/hyperkitty/list/dev@openharmony.io/thread/KWEY4NJGZ675UWMFP6Z6OPZL6D2M2NRK/) |
| 真实用户答复 | electerm 作者（Windows/Linux/macOS/Loongarch 终端模拟器，已移植 Android）询问"harmony 可以实现吗，有计划支持吗"；官方账号答复"尊敬的开发者……**现有Electron项目适配HarmonyOS是完全可行的**。适配核心思路是：将原始Electron项目的编译产物同步到鸿蒙Electron工程壳中，替换不兼容的Native模块，最终通过DevEco Studio构建为HAP包" | [华为开发者联盟论坛 - 如何移植一个nodejs web app](https://developer.huawei.com/consumer/cn/forum/topic/0208219932397903413?fid=0109140870620153026) |

### 1.3 措辞上的精确表述

严格说，华为的"官方支持"是通过 **OpenHarmony 社区（openharmony-sig 组织，华为工程师主导）** 落地的开源方案，而非 HarmonyOS 商业 SDK 内置能力。有两层需要区分：
- **OpenHarmony（开源）**：Electron 鸿蒙化在此开源、可自由获取源码/Release 包。
- **HarmonyOS NEXT 商用系统**：官方文档称"在 HarmonyOS 5.0 上放心集成使用"，但实际调试中，OpenHarmony 设备（如深开鸿 K-HOS 等 x86 桌面版）与商用 HarmonyOS NEXT 存在**签名体系差异**——论坛开发者用 OpenHarmony 设备调试时报错 `The target device does not work with apps with an OpenHarmony signature. Sign the app with a HarmonyOS signature`，官方引导申请 HarmonyOS 证书签名。上架商用市场走华为 AGC（AppGallery Connect）。（参见[论坛提问帖](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575)、[开发指导帖](https://developer.huawei.com/consumer/cn/forum/topic/0204189796759316140?fid=0109140870620153026)）

---

## 二、"Electron 鸿蒙化"的实际技术方案与工具链

### 2.1 结论

**常见做法的描述"把渲染层 Chromium 换成 ArkWeb"是不准确的**。华为/OpenHarmony 的官方方案是**把整套 Electron（Chromium 渲染 + Node.js 主进程 + Electron 壳）移植到 OH**：
- 渲染层：使用移植版 **Chromium（PC-Chromium，官方与 ArkWeb-Chromium 明确区分）**，编译产物为 `libelectron.so / libadapter.so / libffmpeg.so / electron / icudtl.dat / v8_context_snapshot.bin / *.pak / locales`。
- 接入方式：**不再是 `npm install electron`**，而是"以 libelectron.so、libadapter.so 与 ArkTS 源码为核心接入"——即官方提供一个 **ohos_hap 壳工程**（ArkTS Ability 工程），把 Electron 产物与业务代码放进 `web_engine/src/main/resources/resfile/resources/app/`，用 DevEco Studio 构建成 HAP。
- 主进程能力：Node.js（v18/20/22）能力保留（fs、net、child_process 等），但受鸿蒙沙箱约束；**执行外部命令/二进制需先打成 hnp 包**（鸿蒙 HAP 内可执行二进制的打包与签名方案，官方有专门文档）。
- 桥接鸿蒙原生能力：通过**新增 Electron API**（`systemPreferences.requestSystemPermission / requestDirectoryPermission / fileAccessPersist / openApplicationInfoEntry`、`BrowserWindow.windowInfo` 悬浮窗等）、**callArkTSFunction 接口**（JS↔ArkTS 交互）、**aki 框架**（C++↔ETS）等。
- 与 ArkWeb 的关系：ArkWeb 是鸿蒙系统 WebView（供普通 ArkTS 应用嵌网页用）；Electron 鸿蒙化并不依赖 ArkWeb，而是自带的 PC-Chromium。社区有"用 ArkWeb 承载 UI + NAPI 桥接 Node 能力"的替代思路（见 electerm 回复中的建议），但**官方 Electron 鸿蒙化不走这条路**。

### 2.2 官方迁移五步方法论（原帖内容）

1. 分析依赖，对不满足的依赖进行适配和替换；
2. 业务代码适配 HarmonyOS（权限判断、平台判断、沙箱路径等差异点）；
3. TypeScript 项目编译为 JavaScript；
4. 将编译产物及 package.json 复制到 HarmonyOS 化 Electron 样例工程（删除 devDependencies）；
5. 安装依赖并启动工程，异常则回退到第 1 步。

最佳实践：原始 Electron 工程与鸿蒙 Electron 工程分开维护（VSCode/WebStorm + DevEco Studio 双工程）；`electron-builder` 打包时设置 `asar: false` 拆包后拷贝 app 产物；**C/C++ Native 模块用鸿蒙工具链重编译后放入 `ohos_hap\electron\libs\arm64-v8a`**，并修改引入路径。（来源：[已有Electron项目，如何适配HarmonyOS PC](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575)）

### 2.3 工具链清单（支持什么、不支持什么）

| 工具 | 说明 | 支持 | 不支持/注意 |
|---|---|---|---|
| **官方源码仓** `openharmony-sig/electron` | Electron 鸿蒙化主仓（gitcode.com），含 docs/api（1294 API、66 模块）、hnp 打包、子进程、三方库、升级、日志、DeepLink 等文档 | 源码编译（Ubuntu 22.04，>200–300GB 磁盘，>32GB 内存，x86_64）；分支对应版本（如 `132.0.6834.161` 对应 Electron34） | 仅 Linux_x86 交叉编译；编译产物仅 arm64-v8a so |
| **Release 构建包**（华为云 CodeHub） | 免编译直接开发：`v34.6.3-20260105.1-release.zip` 等 | 解压后 `ohos_hap` 壳工程 + libelectron 产物；含 `app.disableHardwareAcceleration()` 等开箱配置 | 需华为云账号登录下载；"内测权限"类资源在早期需申请 |
| **DevEco Studio 方案（方案一）** | 以 DevEco Studio 为核心打开 ohos_hap 工程，一键 Build Hap(s) | 项目结构直观、一键打包运行、可调试 ArkTS | 需手动迁移业务代码、升级时替换内容多 |
| **`@electron-ohos/electron-builder`（方案二）** | electron-builder 的鸿蒙分支（npm 26.8.5；仓库 OpenHarmonyPCDeveloper/ohos-electron-builder），配置 `"ohos": {target:"hap", hvigorwPath, ohpmPath, sdkPath, ohosHapPath}` 后 `npm run dist:ohos` 直接出 HAP | 升级方便、无需关心 ohos_hap 内部 | 不支持自动签名、手动 `hdc install`、配置项有限（部分仍需改 ohos_hap）；官方早期答复"不支持 electron-builder 打包"指的是开源版 electron-builder，鸿蒙分支后来已发布 |
| **签名/权限** | DevEco Studio 自动/手动签名；`module.json5` 的 requestPermissions | 基础权限（INTERNET、GET_NETWORK_INFO、RUNNING_LOCK、PREPARE_APP_TERMINATE、FILE_ACCESS_PERSIST、READ_PASTEBOARD）；按需申请权限 | ACL 签名权限（SYSTEM_FLOAT_WINDOW、READ_WRITE_DOWNLOAD/DOCUMENTS/DESKTOP_DIRECTORY 等）需邮件向华为申请证书 |
| **hnp 打包** | HAP 内可执行二进制（鸿蒙 HNP 包）的打包/签名/调用 | `child_process.exec / execFile / fork / spawn`、调用 Rust/C/C++ 二进制 | 必须先打 hnp 包，不能直接跑普通 ELF |
| **三方库编译** | C/C++ addon（.node）、V8 原生扩展、Rust（通过 node 插件）、koffi 等 | 有官方指南（node-sqlite3 为例），C++ 标准最低 17 | 未适配鸿蒙的 addon 无法直接使用；`esbuild` 类二进制库不能直接用（走 hnp） |
| **ArkTS 调用** | `callArkTSFunction` 接口、Electron 调用 ETS（aki 框架）、adapter 编写 | JS↔ArkTS/ETS 双向调用，示例含获取设备唯一标识、无 UI 快捷截屏、应用间跳转 | — |
| **社区模板** `ohosvscode/ohos_electron_hap`（GitHub，2025-07 建仓，52 stars）与 `ljlVink/ohos-cherrystudio-electron-base` | 两个仓库 README 逐字节相同，是同一份"官方 ohos_hap 模板"的社区镜像/翻版，含 AppScope/chromium/electron/web_engine/hvigor 结构、悬浮窗与权限示例、`--inspect=9229` 调试 | 快速起步、结构即官方壳工程 | 非官方维护，内容 = 官方 README 的英文版翻译；无独立技术贡献 | [ohos_electron_hap](https://github.com/ohosvscode/ohos_electron_hap)、[ohos-cherrystudio-electron-base](https://github.com/ljlVink/ohos-cherrystudio-electron-base) |
| **官方 API 文档** | `docs/api/index.md`：1294 个 API，66 个模块，逐项标注"鸿蒙支持/不支持" | 998 个 API 支持（约 77%） | 296 个不支持（详见第四节） | [官方 API 索引](https://gitcode.com/openharmony-sig/electron/blob/master/docs/api/index.md) |

### 2.4 版本矩阵（官方原帖表格）

| | Electron 25 | Electron 34 | Electron 37 |
|---|---|---|---|
| Chromium | 114 | 132 | 138 |
| Node.js | 18.18.2 | 20.18.1 | 22.16.0 |
| 源码分支特征 | `xxx/114.0.5735.248-xxx` | `xxx/132.0.6834.161-xxx` | `xxx/138.0.7204.45-xxx` |

官方建议：考虑三方库对 Node/Chromium 版本的兼容性选择；以尽快迁移为目的可选与现有平台版本接近的版本，否则推荐更新版本。（来源：[已有Electron项目，如何适配HarmonyOS PC](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575)、[如何配置HarmonyOS Electron编译环境](https://developer.huawei.com/consumer/cn/forum/topic/0201208607403321011)）

---

## 三、第三方公司：海泰方圆"红莲花"鸿蒙版 Chromium/CEF/Electron

### 3.1 结论

**海泰方圆（北京海泰方圆科技股份有限公司）是公开信息最明确、走"ToB 商用"路线的鸿蒙版 Chromium/CEF/Electron 第三方厂商**。方案是**把 Chromium 系框架（Chromium、CEF、Electron）整体移植到鸿蒙**，配合国密算法做安全能力，服务政企/信创客户。**未开源**（公开渠道未见其 CEF/Electron 鸿蒙版源码或开放许可），商用以项目制/授权为主。

### 3.2 关键事实

- **三大框架鸿蒙化**：官方新闻稿原文——"海泰方圆目前基于高内核版本 **Chromium114**，已完成**三大主流三方框架 CEF、Electron、Chromium 的鸿蒙化**，其中包含 components、contents、服务、IPC、沙箱等一系列组件模块，目前众多主流应用软件已使用三大三方框架进行了鸿蒙原生应用开发"；"通过与华为研发团队的强强联合，系统解决开源 Chromium 内核与鸿蒙平台 **ArcTS、ArkUI** 以及其它鸿蒙底层框架不兼容的技术瓶颈，**破解移动平台不能使用 Electron 和 CEF 框架的业内历史难题**"。（来源：[红莲花・鸿蒙版Chromium、CEF、Electron 激活应用迁移"极速乐章"](https://www.haitaichina.com/qyxw/1937.htm)（官网直连 503，内容经[微信公众号转载《会员风采：红莲花国密浏览器鸿蒙版重磅发布》](https://mp.weixin.qq.com/s/UezPXJB51u3m8-peK2JsYA)核实））
- **产品**：红莲花国密浏览器鸿蒙版——2024-06-22 HDC2024 上发布，宣称"**第一款且唯一一款支持鸿蒙纯血系统的国密浏览器**"；2024-11-14 在华为"企业工作必备应用鸿蒙化论坛"上**获原生鸿蒙适配认证，是国内首家、独家通过兼容性测试的 Chromium 内核全功能浏览器**，并获"华为智慧办公最佳战略合作伙伴""鸿蒙先锋-生态贡献奖"。
- **特色能力**：国密算法、USBKey 硬件双向认证、NPAPI 插件、应用接续/跨端流转、丰富扩展、开发者工具、国密证书管控、报文加密、环境检查。
- **开源与商用**：海泰方圆公开表述"将针对原生鸿蒙系统特性持续提升红莲花国密浏览器性能，**持续维护 Chromium、CEF、Electron 鸿蒙版的社区源代码**，全力支撑鸿蒙三方应用厂商进行鸿蒙化创新"——"社区源代码"表述含混，**是否提供可获取的开放源码/商用授权 SDK 待核实**；其商业模式为面向政企的密码全能力（协同签名、智能密码钥匙等）+ 信创项目。（来源：[再取新突破｜海泰红莲花国密浏览器获原生鸿蒙适配认证（百家号）](https://baijiahao.baidu.com/s?id=1816243731160519248)、[华为&海泰｜共建开放共享的智慧办公新生态](https://www.haitaichina.com/qyxw/1903.htm)）

### 3.3 成熟度评估

- **成熟度**：红莲花浏览器是**已商用、已认证**的成熟产品（2024 年即发布）；但其"Chromium/CEF/Electron 鸿蒙化框架"本身作为 ToB 能力，公开案例只有红莲花自身与"众多主流应用软件"的笼统表述（**具体客户名单未公开，待核实**）。
- 注意区分：海泰红莲花是**浏览器产品**（Chromium 系），其"Electron 鸿蒙化"是面向第三方桌面软件厂商的框架能力，**不是开源项目**；与华为官方 openharmony-sig 开源 Electron 是两条线，能力范围可能重叠（Chromium 同为 114 起始）。

---

## 四、已知限制（重点，含量化数据）

### 4.1 API 支持率（官方 API 索引逐项统计，最硬的数据）

官方 `docs/api/index.md` 共 **1294 个 Electron API、66 个模块**，逐项标注"鸿蒙支持/不支持"。统计结果：

- **支持 998 个（约 77%），不支持 296 个（约 23%）**；完全支持的模块 30 个。

**完全不支持的模块（鸿蒙上调用即无效）：**

| 模块 | 不支持/总数 | 说明 |
|---|---|---|
| autoUpdater | 10/10 | **应用自动更新完全不可用**，更新必须走华为应用市场（论坛官方也确认"发布到应用市场后更新走华为市场"） |
| Dock / TouchBar 系 | 11/11、12/12 | macOS 专属，鸿蒙无对应概念 |
| inAppPurchase | 8/8 | macOS 内购，鸿蒙无 |
| Extensions | 7/7 | — |

**部分不支持的常用模块：**

| 模块 | 不支持/总数 | 举例（不支持项） |
|---|---|---|
| BrowserWindow | 56/198 | 窗口 Tab 化、flashFrame、hookWindowMessage、sheet 事件、swipe/rotate-gesture 等 |
| app | 40/108 | activate/second-instance/continue-activity 等事件、getApplicationInfoForProtocol 等 |
| systemPreferences | 26/36 | getAccentColor/getColor/getEffectiveAppearance/canPromptTouchID 等（鸿蒙新增了 requestSystemPermission 等替代） |
| Tray | 25/35 | 托盘大量事件（double-click、drag/drop、balloon 系、mouse-down 等）不支持；**基本托盘可用但交互残缺** |
| Notification | 11/22 | actions、reply、sound、subtitle、toastXml 等不支持 |
| clipboard | 7/19 | readRTF/writeRTF、readFindText/writeFindText、Bookmark 等不支持；**文本/图片/FileNameW 文件路径格式支持** |
| powerMonitor | 10/16 | lock-screen、shutdown、thermal-state、getSystemIdleState/getSystemIdleTime 等不支持 |
| nativeImage | 6/23 | — |
| **globalShortcut** | **0/5** | **全局快捷键全部支持**（少有的完整模块） |

（来源：[官方 API 索引](https://gitcode.com/openharmony-sig/electron/blob/master/docs/api/index.md)）

### 4.2 Node.js 原生模块（addon）

- 鸿蒙 Electron **不兼容未适配的 C/C++ addon**，需用鸿蒙编译工具链（`aarch64-linux-ohos` 目标的 clang/llvm，来自 Electron 源码 `src/ohos_sdk/openharmony/native/llvm`）重编译 `.node/.so`，放入 `ohos_hap\electron\libs\arm64-v8a`；**C++ 标准最低 17**。
- 常见坑：webpack 打包会把 require('.node') 内联解析 → 需配置 `externals` 保留运行时 require；`sqlite3` 有官方适配示例（[Electron加载Addon指导文档](https://gitcode.com/openharmony-sig/electron/tree/master/docs/electron-loading-addon-guide)）。
- **Node 版本由适配版决定**（18/20/22），不能随便换；NodeJS.Platform 类型声明中没有 'ohos'，TS 硬编码平台判断会编译报错（TS2367），官方建议用 `process.platform` 动态判断。
- **process.platform 实际返回值存在来源冲突**：官方 FAQ 一处置"openharmony"、官方 README 另一处置"ohos"、社区文章称实测为 'linux'（内核 Linux 导致）——**待核实 1**。

### 4.3 Chromium 内核版本与渲染

- 三档：**Chromium 114 / 132 / 138**（对应 Electron 25/34/37），远低于 Electron 上游最新（Electron 37 是 2025-06 上游版本，同步尚可；114 则较老）。
- 前端库需检查其依赖的浏览器 API 是否被所选 Chromium 支持（官方迁移检查点）。
- **6.0 以下版本暂不支持 WebGL**（开发者联盟反馈）。
- **模拟器/GPU**：模拟器运行报 `code:9568347, error: install parse native so failed`；ARM Mac 模拟器跑 PC 应用会黑屏，需 `--disable-gpu`/`app.disableHardwareAcceleration()` 或换真机；预编译包默认已含 `disableHardwareAcceleration`（性能有折损）。（来源：[electron是否能在模拟器上运行](https://developer.huawei.com/consumer/cn/forum/topic/0201192388807366340?fid=0109140870620153026)、[【Electron鸿蒙化】编译环境篇（Harmony PC 社区）](https://harmonypc.csdn.net/691fbf6082fbe0098cad6fdc.html)）

### 4.4 窗口管理与系统集成

- **窗口显示/隐藏与托盘强绑定**："出于 OH 系统限制原因，窗口的显示隐藏与应用托盘强绑定，因此在启动应用前，为了保证窗口创建正常，需要先创建托盘"；不需要托盘时须手工注释 `AppWindowAdapter.ets` 的 `processMode/startupVisibility`。
- 首窗口尺寸/位置只能通过 `module.json5` 的 `ohos.ability.window.width/height/left/top` metadata 配置；三键行为与 frame 属性相关，无边框窗口默认无三键（可改 WebAbility.ets）。
- **悬浮窗**：新增 `BrowserWindow.windowInfo.type`（mainWindow/subWindow/floatWindow），支持透明/透明度。
- **剪贴板**：文本/图片/文件（FileNameW 格式 Buffer）读写 OK；**必须先 `systemPreferences.requestSystemPermission('pasteboard')` 申请权限**；跨设备剪贴板（PC↔PAD）系统级支持。
- **文件拖放**：用 `webUtils.getPathForFile(file)` 获取路径；**要求 API Version 20 / HarmonyOS 6.0.0 / DevEco Studio 6.0 / Electron 34**（说明新能力随系统版本滚动）。
- **托盘**：基本 Tray 可用（官方给 gitee 示例 [communication-electron-tray-demo](https://gitee.com/scenario-samples/communication-electron-tray-demo)），事件类 API 大量不支持（见 4.1）。
- **截屏/录屏/录音/摄像头**：官方有对应示例帖；截屏需调用系统原生截图能力（Electron 本身无截图接口）；涉及 `CUSTOM_SCREEN_CAPTURE` 等权限。
- **执行命令行**：主进程 `exec` 可用（示例：`exec('uname -a')`）；完整命令清单 `help -a > help.txt`；命令行为鸿蒙内核（HongMeng Kernel）命令集，与 Windows/Linux 不同（如 `wmic`→`uname`）。
- **应用间跳转/DeepLink**：基于 Electron 跳转其他应用、`deeplink`（自定义协议）有官方文档，需 `module.json5` 配置。

### 4.5 沙箱、签名、上架

- 应用运行在**鸿蒙沙箱**：`/data/storage/el1|el2/...` 映射到真实物理路径；用户数据默认 `--user-data-dir=/data/storage/el2/base/files`；Windows 绝对路径全部失效。
- 权限分"基础权限/按需申请/ACL 签名权限"，ACL 权限需邮件向华为申请证书，未获批时官方建议先注释掉。
- **上架**：Electron 应用可上架华为 PC 应用市场（有真实案例，见第五节）；上架报错多为"权限声明包含仅 2in1 设备使用的权限"（PAD/PC 双端需拆分模块）；**应用更新走华为市场更新机制**（autoUpdater 不可用）。
- **签名体系**：OpenHarmony 签名 ≠ HarmonyOS 商用签名，OpenHarmony 设备（如开鸿 x86 桌面版）调试与商用 HarmonyOS NEXT 存在证书差异（见 1.3）。

### 4.6 性能与稳定性

- 官方无公开性能基准数据（**待核实**）；社区经验：预编译包默认禁用硬件加速 → 渲染性能下降；GPU 加速在模拟器上不可用、真机可用。
- **坚盾守护模式**（高安全模式）：**全面禁用 JIT + 暂停 WebAssembly**（当前版本 Wasm 依赖 JIT），JS 性能显著下降，需做兼容性评估。
- 常见崩溃问题官方有问题集：启动白屏定位、`so/node` 崩溃栈顶 `ld-musl-aarch64.so`、无法监听触摸滑动事件等（知识地图 6.3 节）。
- 社区实测（[掘金：Electron 跑鸿蒙 PC 上 4 个 API 行为差异](https://juejin.cn/post/7658239747224453171)，2026-07，作者自研"雷达鸭"）：`process.platform` 返回 'linux'、`nativeTheme.themeSource` 返回 undefined（暗色模式失效）、`shell.openExternal` 静默失败、`powerMonitor suspend` 实为"息屏"而非睡眠——**该文与官方文档（platform='ohos'/'openharmony'）冲突，且为单篇文章，真实性待核实（待核实 2）**，但其"文档没写全、行为与 Windows 不同"的方向与官方 FAQ 一致，迁移时应实测。

---

## 五、2024–2025（至 2026 年中）是否真实可用 + 案例

### 5.1 结论

**真实可用，但处于"官方开源 + 社区繁荣、大厂案例缺位"的早期阶段。** 判断依据：
- 官方开源（2025-06）+ 官方文档齐全（1294 API 索引、编译/HAP/签名/权限/调试/三方库/hnp 全套文档）+ 官方 Release 包持续发布（v34.6.x-2026xxxx.N-release）。
- **已有真实上架案例**（见下），说明从"打包→签名→AGC 上架→审核"全链路可行。
- 但：模拟器支持差、x86 不可用、部分资源需华为云账号/内测权限、大厂量产案例无公开信息。

### 5.2 时间线

| 时间 | 事件 |
|---|---|
| 2024-06-22 | 海泰方圆在 HDC2024 发布红莲花国密浏览器鸿蒙版，宣称完成 CEF/Electron/Chromium 鸿蒙化 |
| 2024-11-14 | 红莲花国密浏览器获"原生鸿蒙适配认证"（国内首家 Chromium 内核全功能浏览器过测） |
| 2025-04-30 | 华为开发者论坛"Electron鸿蒙化"帖创建，官方答复处于 beta/未公开阶段 |
| 2025-06 | **HarmonyOS Electron 开源至 OH 社区**（官方开发指导帖确认） |
| 2025-10-21 | OpenHarmony 架构 SIG 182 次会议批准 Electron 37 / Chromium 138 新增版本 |
| 2025-2026 | 官方知识地图持续更新（2026-01-09 更新）；大量社区实战文章（Pomotroid、KeeWeb、markdownify、轻画廊等）；"厨房里的化学"上架 AppGallery |
| 2026-07 | electerm 作者询问支持，官方答复"完全可行"；掘金出现 4 API 行为差异实测文 |

### 5.3 真实案例（公开可查）

**已上架应用：**
- **"厨房里的化学"**（bundle：`com.chufang.electron_pro`）：个人开发者用 Electron 鸿蒙化打包 HAP，经 AGC 签名、审核后**真实上架华为 AppGallery**，作者写了《上架操作全流程》（签名→AGC 上传→审核）——这是目前最有力的"真实可用"证据。[AppGallery 上架链接](https://appgallery.huawei.com/app/detail?id=com.chufang.electron_pro&channelId=SHARE&source=appshare) 、[上架全流程教程（CSDN）](https://blog.csdn.net/feng8403000/article/details/161547810)

**实战迁移/适配案例（社区级）：**
- electron-markdownify（Markdown 编辑器）→ OpenHarmony Electron HAP 完整迁移（[CSDN 实践](https://blog.csdn.net/lbcyllqj/article/details/161285985)，产物 [ohos_markdownify](https://gitcode.com/OpenHarmonyPCDeveloper/ohos_markdownify)）
- Pomotroid（桌面番茄钟）适配复盘（[CSDN](https://blog.csdn.net/lbcyllqj/article/details/161397309)）
- KeeWeb（密码管理器）适配教程（[博客园](https://www.cnblogs.com/yangykaifa/p/19354150)）
- 轻画廊桌面版（[腾讯云开发者](https://cloud.tencent.com.cn/developer/article/2595675)）
- "雷达鸭"（掘金作者产品，见 4.6）
- 大量演示/教学项目：水果消消乐、打地鼠、五子棋、日历、心率监测（Heartratemonitoring）、AI 英语单词记忆卡等（教程性质，不一一列举）

**生态/社区组织：**
- OpenHarmonyPCDeveloper（AtomGit 组织）：ohos-electron-builder、ohos_markdownify 等；"鸿蒙PC开发者社区"（harmonypc.csdn.net）活跃。
- OpenHarmony 跨平台框架 SIG 群：KMP、Cordova、RN、Flutter、Ionic、Chromium、Electron、Qt 九大仓库矩阵（[CSDN 综述](https://blog.csdn.net/weixin_45822171/article/details/161238414)），Electron 定位"桌面 PC 应用、迁移成本低、性能中"。

### 5.4 大厂/成熟产品案例（重点回答）

- **未检索到公开的、可点名的大厂 Electron 鸿蒙化量产应用**。官方"部分应用已先行启动适配"未点名（**待核实 3**）。
- 对照：**QQ 鸿蒙版是 ArkTS 原生重写**（论坛有人问"QQ 项目的 oh 版本是基于 arkts 重新开发的吗"，未获直接否定；业界公开信息 QQ/微信鸿蒙版均为原生 ArkTS），WPS 鸿蒙版亦为原生——**主流大厂优先选原生 ArkTS，而非 Electron**，这与华为"不建议新项目用 Electron"的立场一致。
- 海泰红莲花浏览器是成熟 ToB 产品，但它是 Chromium 系浏览器，不是 Electron 应用案例。

---

## 六、待核实清单（来源冲突/无法核实处）

1. **`process.platform` 在鸿蒙 Electron 中的实际返回值**：官方 FAQ 称 "openharmony"（[论坛帖](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575)），官方 README 称 "ohos"（[GitCode README](https://gitcode.com/openharmony-sig/electron/blob/master/README.md)），社区实测文称 "linux"（[掘金](https://juejin.cn/post/7658239747224453171)）——可能与版本/构建方式有关，需在目标版本上实测。
2. **掘金《4 个 API 行为差异》的可信度**：nativeTheme 返回 undefined、shell.openExternal 静默失败、powerMonitor suspend=息屏、platform='linux' 等均为单篇文章自述（作者产品"雷达鸭"），无第二来源印证，且与官方文档冲突；建议作为"迁移前必须实测"的提醒，而非定论。
3. **"部分应用已先行启动适配"具体是哪些应用**：官方未点名，公开渠道无清单。
4. **海泰方圆 CEF/Electron 鸿蒙版的开源/商用条件**：官方公众号称"持续维护……社区源代码"，但未给仓库地址/许可证/授权方式；官网直连 503 无法抓取更多细节；是否可第三方授权商用、收费模式未知。
5. **大厂量产案例**：截至调研时点无公开信息；不排除有未公开的政企/信创项目。
6. **性能基准**：官方无公开 benchmark；社区仅定性（禁用硬件加速后性能下降）。
7. **Electron 37 正式 Release 是否已发布**：SIG 182（2025-10-21）批准时仍有"孵化毕业/CI 流程"遗留问题；官方知识地图版本表格已列 Electron37（Chromium138/Node22.16.0），但论坛答疑 2025 年还有"当前没有 39 版本""是否有编译好的 39.8.5"等提问，说明版本发布节奏与上游不同步。
8. **模拟器支持现状**：2024-2025 帖子普遍报告模拟器不可用（安装报错/白屏），但 2026 年"厨房里的化学"教程显示可在 2in1 模拟器演示——模拟器能力可能随 DevEco 6.x 改善，**新旧矛盾，需按当前 DevEco 版本实测**。
9. **@electron-ohos/electron-builder 的成熟度**：官方知识地图将其列为方案二（"升级相对方便"），但官方早期 FAQ 又称"不支持 electron-builder 打包"——鸿蒙分支发布后已改变，两者时间线不同，引用时需注意。
10. **openharmony-sig/electron 仓库的 star/fork 与许可证**：GitCode API 需 private-token，未取得；许可证未在 README 中体现（Electron 上游 MIT，Chromium BSD，OH 化改动归属 OpenHarmony 许可体系，**待核实**）。

---

## 七、附：对"能否在鸿蒙 PC 上跑 Electron"的总判断（给决策者）

- **能跑**：官方开源方案 + 真实上架案例证明全链路（开发→打包→签名→上架→运行）可行。
- **适合谁**：已有存量 Electron 桌面应用的团队（尤其是 ToB/信创/国产化替代场景），迁移成本相对低（复用 JS 业务代码）。
- **不适合谁**：新项目选型、重度依赖 Node 原生模块/系统级能力（托盘交互、自动更新、WebGL 早期版本、性能敏感）的应用、x86 平台需求。
- **成本预期**：需要 Ubuntu 22.04 交叉编译环境（≥32GB 内存/≥200GB 磁盘）、ARM 真机或云调试、华为开发者证书/ACL 权限申请；每个 Node 原生模块都要单独适配重编译，是主要工作量。
- **与 ArkWeb 方案的关系**：若只是"Web 页面套壳"，走 ArkTS+ArkWeb 更轻；Electron 鸿蒙化的价值在于"保留下沉 Node 主进程能力"与"复用 Electron 代码"。

---

## 附：主要信息来源汇总（按可信度排序）

**官方（华为/OpenHarmony）**
- [Electron开发HarmonyOS应用知识地图 - 华为开发者联盟](https://developer.huawei.com/consumer/cn/forum/topic/0204203363319759021?fid=0109140870620153026)
- [Electron框架HarmonyOS开发指导 - 华为开发者联盟（官方账号"HarmonyOS技术支持"）](https://developer.huawei.com/consumer/cn/forum/topic/0204189796759316140?fid=0109140870620153026)
- [已有Electron项目，如何适配HarmonyOS PC - 华为开发者联盟](https://developer.huawei.com/consumer/cn/forum/topic/0202206298304106575)
- [Electron鸿蒙化 - 华为开发者联盟](https://developer.huawei.com/consumer/cn/forum/topic/0204181390529189966)
- [如何配置HarmonyOS Electron编译环境 - 华为开发者联盟](https://developer.huawei.com/consumer/cn/forum/topic/0201208607403321011)
- [如何移植一个nodejs web app - 华为开发者联盟](https://developer.huawei.com/consumer/cn/forum/topic/0208219932397903413?fid=0109140870620153026)
- [electron是否能在模拟器上运行 - 华为开发者联盟](https://developer.huawei.com/consumer/cn/forum/topic/0201192388807366340?fid=0109140870620153026)
- [GitCode - openharmony-sig/electron（官方源码与 README）](https://gitcode.com/openharmony-sig/electron)（正文：raw.gitcode.com/openharmony-sig/electron/raw/master/README.md）
- [OpenHarmony 架构SIG第182次会议纪要（2025-10-21）](https://lists.openatom.io/hyperkitty/list/dev@openharmony.io/thread/KWEY4NJGZ675UWMFP6Z6OPZL6D2M2NRK/)
- [@electron-ohos/electron-builder（npm registry 元数据）](https://www.npmjs.com/package/@electron-ohos/electron-builder)
- [官方 HAP 工程结构/权限/窗口文档（README 内嵌）](https://gitcode.com/openharmony-sig/electron/blob/master/README.md)

**厂商（海泰方圆）**
- [红莲花・鸿蒙版Chromium、CEF、Electron 激活应用迁移"极速乐章" - 海泰方圆官网](https://www.haitaichina.com/qyxw/1937.htm)（503，内容经转载核实）
- [会员风采：红莲花国密浏览器鸿蒙版重磅发布 - 微信（关键信息基础设施安全保护联盟转载）](https://mp.weixin.qq.com/s/UezPXJB51u3m8-peK2JsYA)
- [再取新突破｜海泰红莲花国密浏览器获原生鸿蒙适配认证 - 百家号](https://baijiahao.baidu.com/s?id=1816243731160519248)
- [花开·松山湖｜红莲花国密浏览器鸿蒙版重磅发布 - 海泰方圆](https://www.haitaichina.com/qyxw/1826.htm)

**社区/实践**
- [Electron 跑鸿蒙 PC 上，这 4 个 API 的行为跟 Windows 完全不一样 - 掘金](https://juejin.cn/post/7658239747224453171)
- [Electron35 项目适配鸿蒙 PC 端完整方案：迁移流程与避坑指南 - CSDN](https://blog.csdn.net/m0_59315734/article/details/157737347)
- [Electron 鸿蒙开发踩坑实录 - CSDN](https://blog.csdn.net/TrisighT0/article/details/157026337)
- [【Electron鸿蒙化】编译环境篇 - Harmony PC 开发者社区](https://harmonypc.csdn.net/691fbf6082fbe0098cad6fdc.html)
- [鸿蒙PC：electron-markdownify 迁移 OpenHarmony Electron HAP 实践 - CSDN](https://blog.csdn.net/lbcyllqj/article/details/161285985)
- [厨房里的化学生态用鸿蒙PC的Electron框架实现——上架操作全流程 - CSDN](https://blog.csdn.net/feng8403000/article/details/161547810)
- [一文看懂 OpenHarmony 跨平台框架生态：9 大仓库全解析 - CSDN](https://blog.csdn.net/weixin_45822171/article/details/161238414)
- [GitHub - ohosvscode/ohos_electron_hap](https://github.com/ohosvscode/ohos_electron_hap)、[GitHub - ljlVink/ohos-cherrystudio-electron-base](https://github.com/ljlVink/ohos-cherrystudio-electron-base)
- [Electron for HarmonyOS：跨平台底层原理探析 - 腾讯云开发者](https://cloud.tencent.cn/developer/article/2605534)

*调研原文快照与原始抓取数据保存在 `research/` 目录（华为论坛话题全文/回帖 JSON、官方 README、API 索引、各文章正文文本）。*
