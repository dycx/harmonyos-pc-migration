# DevEco Studio 工程配置文件详解（面向 Electron→鸿蒙PC 迁移团队）

> 适用读者：把 Windows Electron 应用迁移到鸿蒙 PC 的团队（零鸿蒙经验，公司内网、资料有限）。
> 本文档**自包含**：每个配置文件给出"完整字段说明 + 完整可复制示例"，重点讲透**权限配置**与**依赖配置**。
>
> **字段出处声明（重要）**：本文档中所有字段均有出处——① 官方 Electron 鸿蒙化 README 快照（`research/rawgitcode_electron_readme.md`，下称《官方README》）；② 华为官方《应用/服务签名-DevEco Studio》指引及 AGC 流程（素材转述）；③ 团队内部调研与基础文档（《鸿蒙PC开发基础文档》《鸿蒙PC迁移方案》《Electron鸿蒙化调研报告》及两份社区壳工程模板）；④ 通用 HarmonyOS 配置规范。
> 素材中**没有**出现、仅凭通用规范补充的字段，一律标注 **「⚠️ 通用配置，以官方文档为准」**；素材内部有出入或无法核实处标注 **「⚠️ 待核实」**。全文严禁编造字段名——凡未标注的字段，均能在上述素材中逐字找到。

---

## 目录

- [0. 配置文件全景图](#0-配置文件全景图)
- [1. 应用级配置 AppScope/app.json5](#1-应用级配置-appscopeappjson5)
- [2. 模块级配置 module.json5（全文档核心）](#2-模块级配置-modulejson5全文档核心)
- [3. 构建与签名配置](#3-构建与签名配置)
- [4. 权限配置专章（全文档重点）](#4-权限配置专章全文档重点)
- [5. 依赖配置专章（全文档重点）](#5-依赖配置专章全文档重点)
- [6. 完整示例工程配置（可直接复制修改）](#6-完整示例工程配置可直接复制修改)
- [7. 配置错误排查 Q&A（15 条）](#7-配置错误排查-qa15-条)
- [8. 附录](#8-附录)

---

# 0. 配置文件全景图

一个鸿蒙工程包含两类配置：**应用级（AppScope，全 App 一份）**、**模块级（每个 module 一份）**，外加**工程级构建配置**（build-profile / oh-package / hvigor）。Electron 鸿蒙化的"壳工程"（ohos_hap）与标准 Stage 模型工程同构，只是多了 electron 运行时产物目录。

## 0.1 一个工程包含哪些配置文件

| 文件路径 | 作用 | 是否必须修改 |
|---|---|---|
| `AppScope/app.json5` | 应用"身份证"：bundleName（包名）、版本号、应用图标、应用名 | **必须**（改包名/版本/应用名） |
| `AppScope/resources/base/media/` | 应用级图标等图片资源 | **必须**（替换成自家图标） |
| `<module>/src/main/module.json5` | 模块能力声明：Ability 列表、设备类型、页面路由、**权限**、窗口尺寸 | **必须**（全文档最核心） |
| `<module>/src/main/resources/base/profile/main_pages.json` | 页面路由表（哪些 .ets 是页面） | 按需（入口页面固定） |
| `<module>/src/main/resources/base/element/string.json` | 字符串资源（应用名、**权限申请理由文案**） | **必须**（权限 reason 依赖它） |
| `<module>/src/main/resources/base/element/color.json` / `float.json` | 颜色 / 数值资源 | 按需 |
| `<module>/src/main/resources/zh_CN/element/string.json` | 中文（zh_CN）语言资源目录 | 按需（改应用名也在这） |
| `<module>/src/main/resources/base/profile/network_config.json` | 明文 HTTP 放行（**API 23 起**） | 开发期访问 http 内网服务时**必须** |
| `build-profile.json5`（工程根） | 工程级构建配置：签名配置、产品（SDK 版本）、模块列表 | **必须**（SDK 版本/签名） |
| `oh-package.json5`（工程根） | 工程级依赖声明（ohpm 三方库） | 按需 |
| `hvigorfile.ts`（工程根） | 工程级构建脚本入口（appTasks） | 一般不动 |
| `hvigor/hvigor-config.json5` | hvigor 构建引擎版本与插件声明 | 一般不动（升级 DevEco 时可能动） |
| `hvigorw` / `hvigorw.bat` | hvigor 命令行包装器（类似 gradlew） | 不动 |
| `<module>/build-profile.json5` | 模块级构建配置（srcDir、targets） | 一般不动 |
| `<module>/oh-package.json5` | 模块级依赖声明 | 按需 |
| `<module>/hvigorfile.ts` | 模块级构建脚本（hapTasks） | 一般不动 |
| `<module>/obfuscation-rules.txt` | 代码混淆规则（可选） | 可选 |

> 记忆锚点：**app.json5 = 应用信息；module.json5 = 模块能力（Ability + 权限 + 设备）；main_pages.json = 路由表；build-profile.json5 = SDK/签名；oh-package.json5 = 依赖；hvigorfile.ts = 构建声明**（《鸿蒙PC开发基础文档》§3.4.1）。

## 0.2 标准 Stage 模型工程目录树

```
MyApp/                                  # 工程根目录
├── AppScope/                           # 应用级配置（整个 App 一份）
│   ├── app.json5                       # ★应用级配置：bundleName（包名）、版本、应用图标/名称
│   └── resources/
│       └── base/
│           ├── element/string.json     #   应用名等字符串
│           └── media/                  #   图标等图片资源
│
├── entry/                              # 一个"模块"（module），对应一个 HAP 安装包
│   ├── src/main/
│   │   ├── module.json5                # ★模块级配置：Ability 列表、权限声明、设备类型、页面路由
│   │   ├── ets/                        #   ArkTS 源码目录
│   │   │   ├── Application/AbilityStage.ets   # 应用级生命周期入口
│   │   │   ├── entryability/EntryAbility.ets  # 主 UIAbility
│   │   │   └── pages/Index.ets         #   页面组件
│   │   └── resources/
│   │       ├── base/
│   │       │   ├── element/            #   字符串/颜色/数值（string.json、color.json）
│   │       │   ├── media/              #   图片
│   │       │   └── profile/main_pages.json   # ★页面路由表
│   │       └── rawfile/                #   原始文件：按原样打进 HAP
│   ├── build-profile.json5             #   模块构建配置
│   ├── oh-package.json5                #   模块依赖清单（ohpm 三方库，类似 package.json）
│   ├── hvigorfile.ts                   #   模块构建脚本
│   └── obfuscation-rules.txt           #   代码混淆规则（可选）
│
├── build-profile.json5                 # 工程级构建配置（产品/签名/SDK 版本）
├── oh-package.json5                    # 工程级依赖
├── hvigorfile.ts                       # 工程级构建脚本入口
├── hvigor/                             # hvigor 配置目录（构建引擎版本等）
└── hvigorw / hvigorw.bat               # hvigor 命令行包装器（类似 gradlew）
```

（结构来源：《鸿蒙PC开发基础文档》§3.4）

## 0.3 Electron 鸿蒙化壳工程（ohos_hap）目录树

预编译包解压后的结构（《鸿蒙PC迁移方案》§6.1 实测 + 《官方README》）：

```
ohos_hap/
├── AppScope/                     # 应用级配置
│   ├── app.json5                 # bundleName、应用名、版本等
│   └── resources/base/media/     # 应用图标（替换 app_icon）
├── electron/                     # entry 模块（PC 入口，模块名 pc_entry）
│   ├── src/main/
│   │   ├── ets/                  # ArkTS（AbilityStage、EntryAbility、pages）
│   │   ├── resources/zh_CN/element/string.json   # 应用名（改 EntryAbility_label）
│   │   └── module.json5          # ⚠️ 配置核心：首窗口尺寸 metadata 在这里配置
│   ├── libs/arm64-v8a/           # ⚠️ addon/原生 so 放这里
│   └── build/default/outputs/default/   # HAP 产物目录
├── web_engine/                   # Electron runtime HAR 模块
│   └── src/main/
│       ├── cpp/                  # 适配层源码
│       ├── ets/                  # adapter/、components/、common/ 等
│       ├── resources/resfile/resources/app/   # ⚠️ 业务产物（编译后的 JS）放这里
│       └── module.json5          # ⚠️ 权限（requestPermissions）默认在这里声明
├── chromium/                     # Chromium 模块（一般不动）
├── hvigor/                       # 构建配置
├── build-profile.json5
├── oh-package.json5
└── hnp/arm64-v8a/                # HNP 包目录（需自建，仅当要 exec 二进制时）
```

（结构来源：《鸿蒙PC迁移方案》§6.1.1 + 两份社区模板 `gh_ohosvscode_ohos_electron_hap.md` / `gh_ljlVink_ohos-cherrystudio-electron-base.md`）

> ⚠️ 关键区别（务必记牢）：壳工程里有两个 module.json5——
> - **`electron/src/main/module.json5`**：PC 入口模块（`"name": "pc_entry"`），**首窗口尺寸 metadata、入口 Ability、skills 在这里**；
> - **`web_engine/src/main/module.json5`**：Electron 运行时模块，**requestPermissions 权限默认在这里声明**（《官方README》§签名与权限："权限配置文件位置：ohos_hap\web_engine\src\main\module.json5 文件中 requestPermissions 字段"）。

---

# 1. 应用级配置 AppScope/app.json5

app.json5 是应用的"身份证"，全工程只有一份，位于 `AppScope/app.json5`。

## 1.1 完整示例（含注释）

```json5
{
  "app": {
    "bundleName": "com.example.myapp",  // 包名，全局唯一（上架后不可改！）
    "vendor": "example",                // 厂商名
    "versionCode": 1000000,             // 版本号（数字，上架时递增）
    "versionName": "1.0.0",             // 版本名（展示用）
    "icon": "$media:app_icon",          // 应用图标（$media: 引用 resources 资源）
    "label": "$string:app_name"         // 应用名（$string: 引用字符串资源）
  }
}
```

（示例来源：《鸿蒙PC开发基础文档》§3.4.1 ①，字段与注释逐字对照）

## 1.2 字段逐项说明

| 字段 | 取值示例 | 说明 | 备注 |
|---|---|---|---|
| `bundleName` | `com.example.myapp` | 应用包名，**全局唯一，上架后不可修改** | ⚠️ 必须与 AGC 控制台创建的应用 bundleName 一致，否则签名/上架报错（《鸿蒙PC迁移方案》§6.3.3） |
| `vendor` | `example` | 厂商/开发者标识 | 素材示例字段 |
| `versionCode` | `1000000` | 版本号，**数字**，每次上架递增 | 上架审核后不可回退（《鸿蒙PC迁移方案》§8.3） |
| `versionName` | `1.0.0` | 版本名，展示用字符串 | — |
| `icon` | `$media:app_icon` | 应用图标，引用 `AppScope/resources/base/media/` 下资源 | 替换图标 = 替换该目录下文件 |
| `label` | `$string:app_name` | 应用名，引用字符串资源 | 字符串定义在 `AppScope/resources/base/element/string.json` |

## 1.3 明文 HTTP（cleartextTraffic）——网络请求必须关注

鸿蒙对"非 HTTPS 明文 HTTP 请求"默认有限制。**按 API 版本有两套配置位置，别搞混**（《鸿蒙PC开发基础文档》§4.2.4、§2.4 Q&A）：

- **API 10 ~ API 22**：在 `AppScope/app.json5` 的 `app` 节点下声明 `network.cleartextTraffic`：

```json5
{
  "app": {
    "bundleName": "com.example.myapp",
    // ... 其他字段
    "network": { "cleartextTraffic": true }   // 允许所有明文 HTTP（开发期建议，生产用 HTTPS）
  }
}
```

- **API 23（HarmonyOS 6.1）起**：app.json5 里的 `cleartextTraffic` 不再生效，改用模块资源目录下的 `network_config.json`（见第 3 章 §3.6），可全局或**按域名**控制。

> ⚠️ 待核实：明文 HTTP 默认策略与配置位置随 API 版本（10/15/23）变化，社区说法不一（《鸿蒙PC开发基础文档》§4.2.4）；Electron 鸿蒙版壳工程内 `http://localhost` / `http://127.0.0.1` 访问本机服务是否受此限制**无公开结论，必须真机实测**（沙箱与外进程的 localhost 通路是调研报告明确的"最大不确定性"）。

## 1.4 多设备声明

⚠️ 说明：素材及 HarmonyOS 配置规范中，**设备形态（phone/tablet/2in1）不在 app.json5 里声明，而是在每个模块的 `module.json5` 的 `deviceTypes` 字段声明**（详见第 2 章 §2.2）。app.json5 本身没有"多设备"字段。迁移 PC 应用时，入口模块的 `deviceTypes` 写 `"2in1"`（双形态设备：PC + 平板，鸿蒙对"桌面设备"的官方叫法，见《鸿蒙PC开发基础文档》附录词汇表）。

---

# 2. 模块级配置 module.json5（全文档核心）

每个模块（module）产出一个 HAP。模块级配置位于 `<module>/src/main/module.json5`。对 Electron 壳工程来说，**入口模块是 `electron/src/main/module.json5`（模块名 pc_entry），运行时权限模块是 `web_engine/src/main/module.json5`**。

## 2.1 module 顶层字段

以下示例来自《官方README》§首窗口指定大小（原样结构），字段注释结合《鸿蒙PC开发基础文档》§3.4.1 ②：

```json5
{
  "module": {
    "name": "pc_entry",                    // 模块名（壳工程里 PC 入口模块叫 pc_entry；标准工程叫 entry）
    "type": "entry",                       // 模块类型：entry=应用入口模块，feature=功能模块
    "srcEntry": "./ets/Application/AbilityStage.ets",  // 应用级生命周期入口（全局初始化）
    "description": "$string:module_desc",  // 模块描述（引用字符串资源）
    "mainElement": "EntryAbility",         // 主 Ability 名称
    "deviceTypes": [ "2in1" ],             // ★支持的设备形态（2in1=PC/平板；可写多个：phone/tablet/2in1）
    "deliveryWithInstall": true,           // 安装时随应用一起交付
    "installationFree": false,             // 是否免安装（元服务才 true）
    "pages": "$profile:main_pages",        // 页面路由表引用（指向 resources/base/profile/main_pages.json）
    "abilities": [                         // Ability 列表（UIAbility 配置见 2.3）
      { /* ... 见 2.3 ... */ }
    ]
    // "requestPermissions": [ ... ]       // ★权限声明（见第 4 章，本章 2.6 给完整示例）
    // "multiAppMode": { ... }             // 多实例配置（见 2.5，不需要就删掉）
  }
}
```

### 字段逐项说明

| 字段 | 必填 | 说明 | 备注 |
|---|---|---|---|
| `name` | ✅ | 模块名。壳工程 PC 入口为 `pc_entry`，运行时模块为 `web_engine`；标准工程模板为 `entry` | 与 `build-profile.json5` 的 modules 配置对应 |
| `type` | ✅ | `entry`（应用入口模块）/ `feature`（功能模块） | — |
| `srcEntry` | ✅ | AbilityStage 源码路径，`./ets/Application/AbilityStage.ets` | 全工程唯一 |
| `description` | ✅ | 模块描述，`$string:xxx` 引用资源 | 字符串定义在模块的 string.json |
| `mainElement` | ✅ | 主 Ability 名称，必须与 abilities 里某个 `name` 一致 | 桌面图标点击拉起的就是它 |
| `deviceTypes` | ✅ | **支持的设备形态数组**。PC/2in1 必须写 `"2in1"`；不要只写 `"phone"` | ⚠️ 迁移方案明确："PC/2in1 必须声明；不要写成 phone"（§6.2.1） |
| `deliveryWithInstall` | ✅ | 是否随应用安装一起交付（true） | 素材原样 true |
| `installationFree` | ✅ | 是否免安装。**元服务才 true，普通应用 false** | 免安装形态（元服务）类比小程序/PWA |
| `pages` | ✅ | 页面路由表引用 `$profile:main_pages` | 指向 `resources/base/profile/main_pages.json` |
| `abilities` | ✅ | UIAbility 数组 | 见 2.3 |
| `requestPermissions` | ❌ | 权限声明数组 | **全文档重点，见第 4 章** |
| `multiAppMode` | ❌ | 多实例配置 | 见 2.5；不需要多实例就删掉（《官方README》§多实例配置） |

## 2.2 deviceTypes 重点说明："2in1"

- `"2in1"` 是鸿蒙对"桌面设备（PC + 平板双形态）"的官方叫法（《鸿蒙PC开发基础文档》附录词汇表）。
- Electron 壳工程模板的 `pc_entry` 模块 `deviceTypes` 就是 `["2in1"]`（《官方README》首窗口示例原样）。
- 若应用同时上手机/平板，可写多个：`["phone", "tablet", "2in1"]`（《鸿蒙PC开发基础文档》§3.4.1 ②）。
- ⚠️ 上架相关：若 `requestPermissions` 里声明了"仅 2in1 设备使用"的权限，上架 PC 应用市场会报错，处理见第 4 章 §4.7。

## 2.3 abilities 数组：UIAbility 配置

UIAbility 是"用户可见的窗口/任务入口"，类比 Electron 的 BrowserWindow + app 生命周期（《鸿蒙PC开发基础文档》§3.1.2）。完整示例（含首窗口尺寸 metadata，来自《官方README》§首窗口指定大小，原样 + 注释）：

```json5
"abilities": [
  {
    "name": "EntryAbility",                        // Ability 名（mainElement 引用它）
    "srcEntry": "./ets/entryability/EntryAbility.ets",  // Ability 实现源码
    "description": "$string:EntryAbility_desc",    // Ability 描述
    "icon": "$media:app_icon",                     // 图标
    "label": "$string:EntryAbility_label",         // 名称（改应用名 = 改这个资源，见 2.4）
    "startWindowIcon": "$media:app_icon",          // 启动窗口图标
    "startWindowBackground": "$color:start_window_background", // 启动窗口背景色
    "launchType": "specified",                     // 启动方式（壳工程模板取值 specified）
    "removeMissionAfterTerminate": true,           // 关闭后是否从任务中移除
    "exported": true,                              // 是否允许被其他应用拉起（深链必须 true）
    "metadata": [                                  // ★首窗口尺寸（只配置 width/height 则不居中）
      { "name": "ohos.ability.window.height", "value": "800" },
      { "name": "ohos.ability.window.width",  "value": "800" },
      { "name": "ohos.ability.window.left",   "value": "center" },
      { "name": "ohos.ability.window.top",    "value": "center" }
    ],
    "skills": [                                    // 声明如何被系统/其他应用拉起
      {
        "entities": [ "entity.system.home", "entity.system.browsable" ],
        "actions": [ "action.system.home", "ohos.want.action.viewData" ],
        "uris": []                                 // 深链 uri 列表（见 2.4.2）
      }
    ]
  }
]
```

### abilities 字段逐项说明

| 字段 | 说明 | 备注 |
|---|---|---|
| `name` | Ability 名称，`mainElement` 引用 | — |
| `srcEntry` | Ability 实现文件路径 | `./ets/entryability/EntryAbility.ets` |
| `description` | Ability 描述，`$string:xxx` | — |
| `icon` / `label` | 图标 / 名称资源引用 | 壳工程改应用名改的是 `label` 指向的 `EntryAbility_label` 资源（见 2.4） |
| `startWindowIcon` / `startWindowBackground` | 启动窗口图标 / 背景色 | 背景色用 `$color:start_window_background`（定义在 color.json） |
| `launchType` | 启动方式 | 壳工程模板取 `"specified"`；⚠️ 其他取值（standard/singleton）为通用配置，以官方文档为准 |
| `removeMissionAfterTerminate` | 是否在终止后移除任务记录 | 壳工程模板取 true |
| `exported` | 是否允许其他应用拉起 | **深链（DeepLink）必须 true**（《鸿蒙PC开发基础文档》§4.1 场景 18） |
| `metadata` | 键值对元数据 | **首窗口尺寸唯一配置位置**：`ohos.ability.window.width/height/left/top`，value 都是**字符串**（`"800"`、`"center"`）；不需要居中只写 width/height（《官方README》） |
| `skills` | 如何被系统/其他应用拉起 | 见 2.4.1 |

> ⚠️ **首窗口尺寸只能在 module.json5 配置**：Electron 侧代码（BrowserWindow 构造参数 / setBounds）对**首窗口**可能不生效（《鸿蒙PC开发基础文档》§5.3 Q15）。窗口状态持久化（记住上次尺寸位置）`electron-window-state` 在鸿蒙失效，需自己读写 `app.getPath('userData')` 下的 JSON（《鸿蒙PC迁移方案》§6.2.4）。

## 2.4 skills 与 uris（深链配置）

### 2.4.1 skills 结构

`skills` 声明"应用如何被拉起"：`entities`（实体）+ `actions`（动作）+ `uris`（URI 匹配）。

| 字段 | 取值示例 | 说明 |
|---|---|---|
| `entities` | `["entity.system.home", "entity.system.browsable"]` | 实体：`entity.system.home` = 桌面图标入口；`entity.system.browsable` = 可被浏览 |
| `actions` | `["action.system.home", "ohos.want.action.viewData"]` | 动作：`action.system.home` = 桌面启动；`ohos.want.action.viewData` = 查看数据 |
| `uris` | `[]` 或 `[{ "scheme": "myapp", "host": "open", "path": "id" }]` | 深链匹配规则 |

（字段与取值来源：《官方README》首窗口示例 + 《鸿蒙PC开发基础文档》§3.4.1 ② / §4.2.5）

### 2.4.2 uris 深链配置

自定义协议（如 `myapp://open?id=123`）让外部链接直接打开应用（《鸿蒙PC开发基础文档》§4.2.5）：

```json5
"skills": [
  {
    "entities": [ "entity.system.home" ],
    "actions": [ "action.system.home", "ohos.want.action.viewData" ],
    "uris": [
      { "scheme": "myapp", "host": "open", "path": "id" }   // myapp://open?id=...
    ]
  }
]
```

- 深链要求：`exported: true` + uris 声明（《鸿蒙PC开发基础文档》§4.1 场景 18）。
- ⚠️ uri 中 `scheme`/`host`/`path` 三个子字段的组合规则（哪些必填）为通用配置，以官方 DeepLink 文档为准（官方文档：《deep-linking-startup》，素材中的 electron-builder 配置示例 `upgrade_readme.md` 里只给了 `"scheme"`）。
- Electron 鸿蒙版同样在壳工程 module.json5 配置深链（《官方README》§Deeplink 使用指南有 Windows/macOS/Linux/OH 平台差异对照）。

## 2.5 multiAppMode（多实例）

- **作用**：声明应用是否支持多开（多实例）。Electron 壳工程模板默认带 `multiAppMode` 配置。
- **《官方README》原话**："如果应用不需要使用多实例，请将如下图所示的 'multiAppMode' 配置去掉"（§多实例配置）。
- 也就是说：**你的 Windows 应用如果本来就单实例，直接把 `multiAppMode` 整个节点删除即可**，不需要理解其内部字段。
- ⚠️ 通用配置（素材只有"删除"的指引，没有内部字段结构；字段以官方文档为准）：若需要多实例，`multiAppMode` 节点形如：

```json5
// ⚠️ 通用配置，以官方文档为准（素材未给出内部结构，仅指引"不需要就删掉"）
"multiAppMode": {
  "multiAppModeType": "multiInstance",   // 多实例模式：multiInstance / singleInstance
  "maxCount": 2                          // ⚠️ 最大实例数（可选字段，取值以官方文档为准）
}
```

> 多窗口 ≠ 多实例：同一应用开多个 `BrowserWindow` 是单实例内的多窗口，鸿蒙原生支持（《鸿蒙PC开发基础文档》§4.1 场景 21）；`multiAppMode` 控制的是"应用本身能否被再次拉起成第二个进程/任务"。

## 2.6 requestPermissions 完整示例（专章见第 4 章）

本章先给"能直接抄"的完整示例，字段逐项详解在第 4 章 §4.2。以下组合覆盖：基础权限（只写 name）、按需权限（name + reason + usedScene）：

```json5
"requestPermissions": [
  // —— 基础权限：声明即生效，无需弹窗、无需 ACL ——
  { "name": "ohos.permission.INTERNET" },
  { "name": "ohos.permission.GET_NETWORK_INFO" },
  { "name": "ohos.permission.RUNNING_LOCK" },
  { "name": "ohos.permission.PREPARE_APP_TERMINATE" },
  { "name": "ohos.permission.FILE_ACCESS_PERSIST" },
  // —— 按需/ACL 权限：需要 reason（+ 部分需要 usedScene）；ACL 需邮件申请证书，未获批先注释 ——
  {
    "name": "ohos.permission.READ_PASTEBOARD",
    "reason": "$string:access_pasteboard"          // 理由必须引用 string.json 里的资源
  },
  {
    "name": "ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY",
    "reason": "$string:reason_download",
    "usedScene": {
      "abilities": [ "EntryAbility" ],
      "when": "always"
    }
  },
  {
    "name": "ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY",
    "reason": "$string:reason_documents",
    "usedScene": {
      "abilities": [ "EntryAbility" ],
      "when": "always"
    }
  },
  {
    "name": "ohos.permission.READ_WRITE_DESKTOP_DIRECTORY",
    "reason": "$string:reason_desktop",
    "usedScene": {
      "abilities": [ "EntryAbility" ],
      "when": "always"
    }
  }
]
```

> 出处：《官方README》§签名与权限（ACL 示例原文，含 reason 资源名 `access_pasteboard`、`reason_download`、`reason_documents`、`reason_desktop`）；《鸿蒙PC迁移方案》§6.2.2/6.2.3。README 示例中 usedScene 的 abilities 写的是 `FormAbility`，本示例按壳工程实际主 Ability 名改为 `EntryAbility`。
> ⚠️ `READ_PASTEBOARD` 等需要 reason 的权限，对应文案必须写在 `resources/base/element/string.json` 里（见 3.7），否则编译/校验报错（《鸿蒙PC开发基础文档》§5.2 Q8-4）。

---

# 3. 构建与签名配置

## 3.1 build-profile.json5（工程级）——SDK 版本与签名

位于工程根目录，是**工程级**构建配置：签名配置（signingConfigs）、产品（products：SDK 版本）、模块列表（modules）。

### 3.1.1 完整示例（含注释）

```json5
{
  "app": {
    "signingConfigs": [],            // 签名配置（DevEco 自动生成/管理；手动签名时填入 p12/cer/p7b 信息）
    "products": [
      {
        "name": "default",                     // 产品名
        "signingConfig": "default",            // 使用的签名配置名（对应 signingConfigs 里的一项）
        "compatibleSdkVersion": "6.0.0(20)",   // 最低兼容 SDK（API 20，即 HarmonyOS 6.0）
        "runtimeOS": "HarmonyOS"               // 目标操作系统
        // ⚠️ 通用配置（素材未出现，以官方文档为准）：
        // "targetSdkVersion": "6.0.0(20)",    // 目标 SDK 版本（不写默认等于 compatibleSdkVersion）
      }
    ],
    // ⚠️ 通用配置（素材未出现完整结构，以官方文档为准）：
    // "buildOption": { "arkOptions": { ... } }   // 构建选项（ArkTS 编译参数、宏定义等）
  },
  // ⚠️ 通用配置（素材未出现完整结构，以官方文档为准；标准工程模板自动生成）：
  "modules": [
    {
      "name": "entry",               // 模块名（对应 module.json5 的 module.name）
      "srcDir": "./entry",           // 模块源码目录
      "targets": [                   // 构建目标（产物形态）
        { "name": "default", "applyToProducts": [ "default" ] }
      ]
    }
  ]
}
```

（`signingConfigs` / `products` / `name` / `signingConfig` / `compatibleSdkVersion` / `runtimeOS` 出处：《鸿蒙PC开发基础文档》§3.4.1 ④；`targetSdkVersion`、`modules`、`buildOption` 为 ⚠️ 通用配置标注）

### 3.1.2 字段逐项说明

| 字段 | 说明 | 备注 |
|---|---|---|
| `app.signingConfigs` | 签名配置数组。DevEco 自动签名时由 IDE 写入；手动签名时包含 p12/cer/p7b 与密码 | DevEco 界面操作：File → Project Structure → Signing Configs |
| `app.products[].name` | 产品名，通常 `default` | 构建命令 `-p product=default` 引用它 |
| `app.products[].signingConfig` | 产品使用的签名配置名 | 指向 signingConfigs 中一项的 name |
| `app.products[].compatibleSdkVersion` | **最低兼容 SDK 版本**，写法 `"6.0.0(20)"`（大版本(API 级别)） | ⚠️ 必须与 SDK 管理器里**实际安装**的 API 版本一致，否则构建失败（《鸿蒙PC开发基础文档》§5.2 Q7） |
| `app.products[].targetSdkVersion` | 目标 SDK 版本 | ⚠️ 通用配置，素材未出现，以官方文档为准 |
| `app.products[].runtimeOS` | 目标 OS，HarmonyOS 工程写 `"HarmonyOS"` | 素材示例字段 |
| `app.buildOption` | 构建选项（arkOptions 等） | ⚠️ 通用配置，素材未出现 |
| `modules[]` | 模块列表：`name`（模块名）+ `srcDir`（目录）+ `targets`（构建目标） | ⚠️ 通用配置，素材未出现完整结构，标准模板自动生成 |

> ⚠️ **版本格式提示**：`compatibleSdkVersion` 的字符串格式随 DevEco/SDK 版本变化（例如老版本可能写 `"5.0.0(12)"`），务必以你安装的 SDK 管理器里显示的版本为准，直接复制素材示例可能不匹配（《鸿蒙PC开发基础文档》§5.2 Q7）。

### 3.1.3 模块级 build-profile.json5

每个模块目录下还有一份模块级 `build-profile.json5`，配置该模块的构建目标（`targets`、`srcDir`、`name`）。标准工程模板自动生成，**一般不需要手改**。⚠️ 通用配置，以官方文档为准；其 `targets` 与工程级 `modules[].targets` 对应。

## 3.2 签名材料三件套：.p12 / .cer / .p7b

HAP 安装到设备/上架必须签名。签名需要三份材料：

| 材料 | 后缀 | 是什么 | 获取方式 |
|---|---|---|---|
| **私钥库** | `.p12` | 密钥库（含私钥与别名 keyAlias） | 自己用工具生成（DevEco 自动签名时自动生成） |
| **证书** | `.cer` | 应用签名证书 | 用私钥生成并下载（AGC / 自动签名） |
| **Profile** | `.p7b` | 应用配置文件（Profile，绑定 bundleName、证书、设备/权限） | 新建并下载（AGC / 自动签名） |

（三件套与获取流程出处：《鸿蒙PC迁移方案》§6.3.2 + 《鸿蒙PC开发基础文档》§2.5）

### 3.2.1 调试自动签名（本机调试，最快）

DevEco Studio → **File → Project Structure → Signing Configs → 勾选 "Automatically generate signature"**，自动生成调试证书与 Profile 并配置进工程（需登录华为开发者账号）（《鸿蒙PC迁移方案》§6.3.1、《鸿蒙PC开发基础文档》§5.1 Q4）。自动签名只适用于本机调试。

### 3.2.2 正式签名（AGC，上架用）

流程（《鸿蒙PC迁移方案》§6.3.2，依据《厨房里的化学》上架实录）：
1. AGC 控制台（https://developer.huawei.com/consumer/cn/service/josp/agc/index.html）创建应用；
2. 生成**私钥（.p12）** → 用私钥生成**证书（.cer）**并下载；
3. 新建 **Profile（.p7b）** 并下载；
4. DevEco Studio Signing Configs 选择 Manual，填入 p12/cer/p7b 与密码；
5. 也可命令行签名（CI 场景，见 3.2.3）。

### 3.2.3 命令行签名：hap-sign-tool

`hap-sign-tool` 位于 SDK toolchains（DevEco 自带），CI 用（《鸿蒙PC迁移方案》§6.3.2）。**素材中给出两种参数写法（不同版本工具参数名有差异）**，均列出：

```bash
# 写法 A（《鸿蒙PC迁移方案》§6.3.2）
hap-sign-tool sign-app -keyAlias <别名> -signAlg SHA256withECDSA \
  -mode localSign -appCertFile <证书.cer> -profileFile <profile.p7b> \
  -inFile <unsigned.hap> -outFile <signed.hap> \
  -keystoreFile <私钥.p12> -keystorePass <密码> -keyPass <别名密码>

# 写法 B（《鸿蒙PC开发基础文档》附录 A.7，java -jar 方式）
java -jar hap-sign-tool.jar sign-app \
  -keyAlias <证书别名> -signAlg SHA256withECDSA \
  -keystore <xxx.p12> -keystorepass <密码> -keypass <密码> \
  -appCertFile <证书.cer> -profileFile <profile.p7b> \
  -inFile <input.hap> -outFile <output-signed.hap>
```

> ⚠️ 两条硬性要求（两条素材一致）：
> 1. **所有路径不能含中文、不能含空格**——工程路径、签名文件路径、输出路径含中文时 `hap-sign-tool` 解析失败（《鸿蒙PC开发基础文档》§5.2 Q5；《鸿蒙PC迁移方案》§6.3.3："存储路径不要有中文"）。**整个工程放纯英文路径**，如 `D:\dev\MyApp`。
> 2. **执行环境 JDK 17**——DevEco/hvigor/hap-sign-tool 构建链基于 JDK 17，非 17 编译失败（《鸿蒙PC开发基础文档》§5.2 Q7）。

### 3.2.4 签名体系的两套证书（高频坑）

| 签名 | 用途 | 报错特征 |
|---|---|---|
| **OpenHarmony 签名** | 开源 OpenHarmony 设备（如深开鸿 x86 桌面版）调试 | 装到商用设备报 `The target device does not work with apps with an OpenHarmony signature. Sign the app with a HarmonyOS signature.` |
| **HarmonyOS 商用签名** | 商用 HarmonyOS NEXT 真机 / 上架 AGC | — |

**商用设备必须申请 HarmonyOS 签名（走 AGC）**（《Electron鸿蒙化调研报告》§1.3、《鸿蒙PC开发基础文档》§2.5）。另外：**证书过期 / 包名不一致**会签名失败——检查 AGC 应用 bundleName 与 `AppScope/app.json5` 的 `bundleName` 一致（《鸿蒙PC迁移方案》§6.3.3）。

## 3.3 hvigorfile.ts（app 级 / 模块级）与 hvigor 配置

hvigor 是鸿蒙的构建系统（类比 Gradle），`hvigorw` / `hvigorw.bat` 是其命令行入口（《鸿蒙PC开发基础文档》§3.5 工具表）。

### 3.3.1 模块级 hvigorfile.ts（素材原文）

```ts
// <module>/hvigorfile.ts
import { hapTasks } from '@ohos/hvigor-ohos-plugin';
export default {
  system: hapTasks,  // 声明这是 HAP 模块（构建系统是 hvigor，类似 Gradle）
  plugins: []
}
```

（出处：《鸿蒙PC开发基础文档》§3.4.1 ⑥）

### 3.3.2 工程级 hvigorfile.ts（app 级）

⚠️ 通用配置（素材只给了模块级示例；工程级入口结构以官方文档/模板为准）：

```ts
// 工程根 hvigorfile.ts —— ⚠️ 通用配置，以官方文档为准
import { appTasks } from '@ohos/hvigor-ohos-plugin';
export default {
  system: appTasks,   // app 级任务
  plugins: []
}
```

### 3.3.3 hvigor/hvigor-config.json5

⚠️ 通用配置（素材未出现完整内容；以下为通用规范，以官方文档/你工程的模板为准）：

```json5
// hvigor/hvigor-config.json5 —— ⚠️ 通用配置，以官方文档为准
{
  "modelVersion": "5.0.0",                     // hvigor 模型版本（与 DevEco 配套）
  "dependencies": {
    "@ohos/hvigor-ohos-plugin": "5.0.0"        // hvigor 的 ohos 插件版本（必须与 DevEco/hvigor 版本匹配）
  }
}
```

> ⚠️ **版本匹配是 hvigor 最常见的坑**：`hvigor-config.json5` 的 `modelVersion` 与 `@ohos/hvigor-ohos-plugin` 版本必须与所用 DevEco Studio 版本配套；升级 DevEco 后若构建报 hvigor 相关错误，先检查此文件（《鸿蒙PC开发基础文档》§5.2 Q7、§8 附录 Q&A）。内网场景此文件改动后无需联网（插件随 DevEco 自带）。

### 3.3.4 命令行构建（CI 用）

```bash
cd ohos_hap
./hvigorw assembleHap --mode module -p product=default   # Linux/macOS
hvigorw.bat assembleHap --mode module -p product=default # Windows
# 其他常用：
./hvigorw clean                        # 清理构建产物
./hvigorw assembleHap                  # 构建 HAP（产物在 entry/build/default/outputs/）
./hvigorw signHap                      # 单独签名（通常 DevEco 自动完成）
```

（出处：《鸿蒙PC迁移方案》§6.4、§10.2；《鸿蒙PC开发基础文档》附录 A.4）

## 3.4 obfuscation-rules.txt（混淆配置，简要）

- 位置：模块根目录（与 hvigorfile.ts 同级）。
- 作用：代码混淆规则（可选），DevEco 构建时按规则对 ArkTS/JS 代码做混淆（《鸿蒙PC开发基础文档》§3.4 目录树标注："代码混淆规则（可选）"）。
- 迁移团队提示：**发布（Release）构建才建议开混淆**；调试期保持默认。混淆规则语法与字段 ⚠️ 通用配置，以官方文档为准（素材未展开）。

## 3.5 资源文件体系：resources 目录

模块资源位于 `<module>/src/main/resources/`，按"限定符目录"组织（《鸿蒙PC开发基础文档》§3.4 目录树 + 《官方README》§定制应用）：

```
resources/
├── base/                          # 默认（无限定符）资源
│   ├── element/
│   │   ├── string.json            # 字符串（应用名、权限理由等）
│   │   ├── color.json             # 颜色（如 start_window_background）
│   │   └── float.json             # 数值/尺寸
│   ├── media/                     # 图片资源（图标等）
│   └── profile/
│       └── main_pages.json        # ★页面路由表
├── zh_CN/                         # 中文（zh_CN）限定符目录（多语言）
│   └── element/
│       └── string.json            # 中文文案（改应用名在这，见《官方README》）
└── rawfile/                       # 原样打包的原始文件（Web 静态资源）
```

### 3.5.1 main_pages.json（页面路由表）

```json
{
  "src": [
    "pages/Index",        // 首页
    "pages/About"         // 其他页面（对应 ets/pages/About.ets）
  ]
}
```

（出处：《鸿蒙PC开发基础文档》§3.4.1 ③）

### 3.5.2 改应用名/图标（Electron 壳工程速查）

- **应用名**：`electron/src/main/resources/zh_CN/element/string.json` 中 `EntryAbility_label` 字段的值（《官方README》§定制自己的鸿蒙版应用；社区模板 `gh_ohosvscode_ohos_electron_hap.md` 同文）。
- **图标**：替换 `AppScope/resources/base/media/` 下图标文件（《官方README》§替换图标）。

## 3.6 network_config.json（明文 HTTP，API 23+）

⚠️ 以下字段来自团队调研素材（《鸿蒙PC开发基础文档》§4.2.4，社区来源），官方文档路径随版本变化（"官方文档搜 network_config，路径随版本变化"，《鸿蒙PC开发基础文档》附录 B），**以官方文档为准**。

- 位置：`<module>/src/main/resources/base/profile/network_config.json`
- 生效版本：**API 23（HarmonyOS 6.1）起**；API 10~22 用 app.json5 的 `network.cleartextTraffic`（见第 1 章 §1.3）。

```json
{
  "network-config": {
    "cleartextTrafficPermitted": true,                              // 全局允许明文 HTTP（开发期）
    "domains": [                                                    // 按域名细化（可选）
      { "domain": "192.168.1.10", "cleartextTrafficPermitted": true },
      { "domain": "api.example.com", "cleartextTrafficPermitted": false }
    ]
  }
}
```

| 字段 | 说明 |
|---|---|
| `network-config.cleartextTrafficPermitted` | 全局明文 HTTP 开关（true=允许） |
| `network-config.domains[]` | 按域策略数组：`domain`（域名/IP）+ `cleartextTrafficPermitted`（该域是否允许明文） |

> 迁移提示：开发期访问内网 Spring Boot（`http://192.168.x.x:8080`）必须放行明文；生产强烈建议 HTTPS（《鸿蒙PC开发基础文档》§4.2.4）。

---

# 4. 权限配置专章（全文档重点）

## 4.1 权限体系总览：三级 + APL 概念

### 4.1.1 素材明确的"三级"体系（《鸿蒙PC开发基础文档》§2.4 + 《官方README》）

| 级别 | 含义 | 典型权限 | 获取方式 |
|---|---|---|---|
| **基础权限** | 低风险，声明即授权，无需用户弹窗 | `INTERNET`、`GET_NETWORK_INFO`、`RUNNING_LOCK`、`PREPARE_APP_TERMINATE`、`FILE_ACCESS_PERSIST`、`READ_PASTEBOARD` | `module.json5` 的 `requestPermissions` **声明即可** |
| **按需申请权限** | 中等风险，运行时弹窗询问用户 | `MICROPHONE`、`CAMERA`、`LOCATION`、`CUSTOM_SCREEN_CAPTURE`、`ACCESS_BLUETOOTH` | 声明 + 运行时调用授权 API（如 `systemPreferences.askForMediaAccess`）；授权弹窗**仅弹一次**，拒绝后需去「设置 → 隐私和安全」手动改 |
| **ACL 签名权限** | 高风险，需要证书背书 | `SYSTEM_FLOAT_WINDOW`、`READ_WRITE_DOWNLOAD/DOCUMENTS/DESKTOP_DIRECTORY`、`WINDOW_TOPMOST`、`PRIVACY_WINDOW`、`ACCESS_CERT_MANAGER`、`ACCESS_BIOMETRIC`、`PRINT` 等 | 声明 + **邮件向华为申请 ACL 证书**，签名时带上；**未获批时官方建议先注释掉**（否则签名失败/上架被拒） |

### 4.1.2 APL 等级（⚠️ 通用配置概念，以官方文档为准）

素材未直接出现 "APL" 一词，但三级体系对应鸿蒙官方权限模型的 **APL（Access Permission Level，权限申请等级）** 概念（⚠️ 通用配置，以官方文档为准）：

| APL 等级 | 说明 | 对应素材里的级别 |
|---|---|---|
| `normal` | 普通权限，**普通应用默认 APL = normal**，直接声明即可 | 基础权限 |
| `system_basic` | 系统基础权限，普通应用申请需 **ACL**（Access Control List）授权 | 按需/ACL 权限 |
| `system_core` | 系统核心权限，一般只授予系统应用 | — |

> 一句话理解：**普通应用默认 APL=normal；要声明 system_basic 及以上权限，必须走 ACL 申请（邮件向华为申请证书）**。这也是"ACL 权限未获批时签名不通过/安装报错"的根本原因。

## 4.2 requestPermissions 字段逐项详解

`requestPermissions` 是 `module.json5` 的 `module` 节点下的数组，每个元素是一个权限声明对象。字段如下：

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `name` | ✅ | `"ohos.permission.XXX"` | 权限名，**从官方权限文档复制，注意大小写与版本差异**（拼错/版本不对编译报错，见第 7 章 Q3） |
| `reason` | 部分必填 | `"$string:reason_xxx"` | 申请原因，**必须引用字符串资源**（`$string:` 前缀）；用于授权弹窗展示。按需/ACL 权限**必须有**，缺失会校验报错（《鸿蒙PC开发基础文档》§5.2 Q8）；基础权限（如 INTERNET）可不写 |
| `usedScene` | 部分必填 | 对象 | 使用场景声明，含 `abilities`（数组）+ `when` |
| `usedScene.abilities` | 视情况 | `["EntryAbility"]` | 使用该权限的 Ability 名列表（README 示例里写的是 `FormAbility`，壳工程里对应你自己的 Ability 名，如 `EntryAbility`） |
| `usedScene.when` | 视情况 | `"always"` / `"inuse"` | 使用时机：`always`=始终（后台也用，如目录权限）；`inuse`=仅使用时（如麦克风） |

**可省略字段的规则（素材归纳）**：
- 纯基础权限（INTERNET 等）：只写 `name` 即可（《鸿蒙PC迁移方案》§6.2.2）。
- 需要 reason 的权限：`READ_PASTEBOARD` 只写 `name + reason`（《官方README》ACL 示例）。
- 目录类 ACL 权限：`name + reason + usedScene`（《官方README》ACL 示例：`READ_WRITE_DOWNLOAD_DIRECTORY` 等带 `usedScene: { abilities: [...], when: "always" }`）。
- ⚠️ 通用规范补充（以官方文档为准）：`reason` 文案长度有限制、`when` 取值仅 `always`/`inuse` 两值（素材中出现的就是这两个值）。

## 4.3 基础权限速查表（直接声明即可）

以下 6 个权限是《官方README》§签名与权限表格中标注"**基础权限**"的权限，`requestPermissions` 里只写 `name` 即可生效：

| 权限名 | 一句话用途 | 是否需 reason |
|---|---|---|
| `ohos.permission.INTERNET` | 允许使用 Internet 网络 | 否 |
| `ohos.permission.GET_NETWORK_INFO` | 允许获取数据网络信息 | 否 |
| `ohos.permission.RUNNING_LOCK` | 允许获取运行锁，保证应用在后台持续运行 | 否 |
| `ohos.permission.PREPARE_APP_TERMINATE` | 允许应用关闭前执行自定义的预关闭动作 | 否 |
| `ohos.permission.FILE_ACCESS_PERSIST` | 允许应用支持持久化访问文件 Uri（配合目录权限使用） | 否 |
| `ohos.permission.READ_PASTEBOARD` | 允许应用读取剪贴板 | **是**（`$string:access_pasteboard`，README 示例如此） |

> ⚠️ 说明：`READ_PASTEBOARD` 在 README 表格里归"基础权限"，但在 ACL 示例里带 `reason` 且列入"需要 ACL 签名的权限"清单——素材存在这种交叉，稳妥做法：**声明时带上 reason；若签名报错再按 ACL 流程申请**（《官方README》§签名与权限）。Electron 侧读剪贴板前还需 `systemPreferences.requestSystemPermission('pasteboard')`（见 4.6.2）。

## 4.4 按需/ACL 权限速查表（需邮件向华为申请，未获批先注释）

以下权限全部来自《官方README》§签名与权限表格（含"权限说明"列原文），标注"**按需申请**"；Electron 壳工程里它们同时是"需要 ACL 签名的权限"（README 原文："electron中需要ACL签名的权限包括（如果未申请到证书导致签名未通过，可以暂时将这几个权限注释掉）"）。**未获批 ACL 证书前，把对应声明注释掉**，否则签名不通过。

| 权限名 | 一句话用途（README 原文） | 备注 |
|---|---|---|
| `ohos.permission.SYSTEM_FLOAT_WINDOW` | 允许应用使用全局悬浮窗的能力 | 悬浮窗（BrowserWindow `windowInfo.type='floatWindow'`）依赖 |
| `ohos.permission.ACCESS_CERT_MANAGER` | 允许应用进行查询证书及私有凭据等操作 | — |
| `ohos.permission.PRINT` | 允许应用获取打印框架的能力 | 打印功能 |
| `ohos.permission.ACCESS_BIOMETRIC` | 允许应用使用生物特征识别能力进行身份认证 | 指纹/人脸认证 |
| `ohos.permission.PRIVACY_WINDOW` | 允许应用将窗口设置为隐私窗口，禁止截屏录屏 | 隐私保护窗口 |
| `ohos.permission.WINDOW_TOPMOST` | 允许窗口置顶 | 置顶窗口 |
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | 允许应用访问公共目录下 Download 目录及子目录 | 建议与 `FILE_ACCESS_PERSIST` 同时申请 |
| `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | 允许应用访问公共目录下 Documents 目录及子目录 | 建议与 `FILE_ACCESS_PERSIST` 同时申请 |
| `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY` | 允许应用访问公共目录下 Desktop 目录及子目录 | 建议与 `FILE_ACCESS_PERSIST` 同时申请 |
| `ohos.permission.LOCATION` | 允许应用获取设备位置信息 | 精确定位 |
| `ohos.permission.APPROXIMATELY_LOCATION` | 允许应用获取设备模糊位置信息 | 模糊定位 |
| `ohos.permission.LOCATION_IN_BACKGROUND` | 允许应用在后台运行时获取设备位置信息 | 后台定位 |
| `ohos.permission.MICROPHONE` | 允许应用使用麦克风 | Electron 侧 `askForMediaAccess('microphone')` |
| `ohos.permission.CAMERA` | 允许应用使用相机 | Electron 侧 `askForMediaAccess('camera')` |
| `ohos.permission.ACCESS_BLUETOOTH` | 允许应用接入蓝牙并使用蓝牙能力（配对、连接外围设备等） | — |
| `ohos.permission.CUSTOM_SCREEN_CAPTURE` | 允许应用截取屏幕内容 | 截屏/录屏 |

> 注意：表格里 `LOCATION` 一族（LOCATION / APPROXIMATELY_LOCATION / LOCATION_IN_BACKGROUND）在 README 表格中同为"按需申请"；`MICROPHONE`/`CAMERA`/`ACCESS_BLUETOOTH`/`CUSTOM_SCREEN_CAPTURE` 同属按需申请（运行时弹窗），但在 Electron 壳工程签名时同样可能触发 ACL 校验——**统一按"先注释、获批后加回"处理最稳**。

## 4.5 ACL 申请流程：邮件 → 审批 → 签名

1. **邮件向华为申请**：说明 **bundleName、所需 ACL 权限清单、用途说明**（《官方README》§签名与权限给的是邮件内容截图示例，模板要点即这三项；《鸿蒙PC开发基础文档》§2.5 提及申请邮箱形如 `harmony_acl@huawei.com` 之类，"以官方指引为准"）。
2. **审批**：华为审核通过后，ACL 权限会被加入到你的签名 Profile/证书授权范围。
3. **签名**：获批后在 DevEco Signing Configs（或 AGC 配置）里勾选对应权限项，再打签名包。
4. **未获批前**：把对应权限从 `requestPermissions` **注释掉**，跑通无 ACL 版本，再逐个申请加回（《鸿蒙PC开发基础文档》§5.1 Q4、§5.2 Q8）。

> ⚠️ 邮件模板的准确措辞与邮箱地址请以华为官方最新指引为准（素材只确认了"bundleName + 所需权限 + 用途"三要素与截图示例）。

## 4.6 运行时动态授权（与静态声明的区别）

### 4.6.1 原生 ArkTS 方式：abilityAccessCtrl

⚠️ 以下为 HarmonyOS 通用 API（素材未出现代码，属通用规范），**以官方文档为准**。静态声明（module.json5）之外，按需权限（麦克风/相机/定位等）还需要在**运行时**调用授权 API 弹窗询问用户：

```ts
// ⚠️ 通用 API 示例，以官方文档为准
import { abilityAccessCtrl, Permissions, common } from '@kit.AbilityKit';

// 获取当前 UIAbility 上下文
const context = getContext(this) as common.UIAbilityContext;
const atManager = abilityAccessCtrl.createAtManager();

// 查询权限是否已授权
const grantStatus = atManager.checkAccessTokenSync(context.applicationInfo.accessTokenId,
  'ohos.permission.MICROPHONE');

// 向用户申请授权（弹出系统授权框）
atManager.requestPermissionsFromUser(context, ['ohos.permission.MICROPHONE', 'ohos.permission.CAMERA'])
  .then((result) => {
    // result.authResults: number[]，0=已授权，-1=拒绝
    if (result.authResults[0] === 0) {
      // 已授权，继续业务
    } else {
      // 被拒绝：引导用户去「设置 → 隐私和安全」手动开启
    }
  });
```

**与静态声明的区别**：
| 对比项 | 静态声明（module.json5） | 运行时动态授权（abilityAccessCtrl） |
|---|---|---|
| 作用 | 声明"应用需要哪些权限"，决定安装/签名/上架校验 | 在运行中向用户弹窗请求授权 |
| 是否弹窗 | 基础权限不弹窗；按需权限仍需运行时请求 | 弹窗询问 |
| 缺失后果 | 声明缺失 → 功能调用报错/校验失败 | 不请求 → 拿不到授权，功能不可用 |
| 关系 | **二者配合**：先声明，再运行时请求 | 依赖静态声明存在 |

### 4.6.2 Electron 壳工程侧：systemPreferences 系列接口（《官方README》§新增接口）

Electron 鸿蒙版把"运行时授权"封装成了 Electron API，**迁移时优先用这些**，不必写 ArkTS：

| 接口 | 参数 | 说明 |
|---|---|---|
| `systemPreferences.getMediaAccessStatus(mediaType)` | `'microphone'`/`'camera'`/`'screen'` | 查询权限状态；ohos 平台仅返回 `granted`/`denied` 两种 |
| `systemPreferences.askForMediaAccess(mediaType)` | `'microphone'`/`'camera'` | 请求媒体权限，`Promise<boolean>`；**授权弹窗仅弹一次**，拒绝后必须去「设置 → 隐私和安全」手动更改，promise 返回现有状态 |
| `systemPreferences.requestSystemPermission(permission)` | `location`/`camera`/`microphone`/`screen-capture`/`user-download-dir`/`user-desktop-dir`/`user-document-dir`/`bluetooth`/`pasteboard` | 请求系统权限（新增接口），`Promise<boolean>`；同样"弹窗仅弹一次，拒绝后手动改" |
| `systemPreferences.requestDirectoryPermission(path)` | 路径或 `null` | 请求目录权限；`null` 时同时请求下载/桌面/文档三目录，任一授权即 true |
| `systemPreferences.fileAccessPersist(paths)` | `string[]` | 对文件/目录做持久化授权（配合 `FILE_ACCESS_PERSIST`） |
| `systemPreferences.openApplicationInfoEntry()` | — | 打开系统设置中的应用信息页（引导用户手动开权限） |

> ⚠️ **授权弹窗只弹一次**：拒绝后系统**不再弹**，必须用户在「设置 → 隐私和安全」手动开启（README 多次强调）。所以"拒绝后的引导"体验（如弹窗提示 + `openApplicationInfoEntry()`）是迁移必做的交互。

### 4.6.3 代码示例（Electron 主进程）

```javascript
// Electron 主进程（渲染进程需经 IPC）
const { systemPreferences } = require('electron');

// 麦克风
systemPreferences.askForMediaAccess('microphone').then(granted => {
  console.log('microphone:', granted);
});

// 下载目录（ACL 权限 + 持久化授权）
systemPreferences.requestDirectoryPermission(null).then(granted => {
  console.log('directories:', granted);
});

// 剪贴板（读剪贴板前必须先申请）
systemPreferences.requestSystemPermission('pasteboard').then(granted => {
  console.log('pasteboard:', granted);
});
```

（示例结构来自社区模板 `gh_ohosvscode_ohos_electron_hap.md` §System Permission Request，参数清单来自《官方README》§新增接口）

## 4.7 Electron 壳工程权限特殊性

### 4.7.1 权限声明位置：web_engine 模块

壳工程的权限默认声明在 **`ohos_hap/web_engine/src/main/module.json5`** 的 `requestPermissions` 字段（《官方README》§签名与权限）。两份社区模板（`gh_ohosvscode_ohos_electron_hap.md` / `gh_ljlVink_ohos-cherrystudio-electron-base.md`）同文："Application permissions are configured in the `requestPermissions` field of the `web_engine/src/main/module.json5` file."

### 4.7.2 上架报错"权限声明包含仅 2in1 设备使用的权限"的两种解法（《官方README》§上架问题）

Electron 应用上架 PC 应用市场时若报权限归属错误，**检测应用权限声明中是否包含仅 2in1 设备使用的权限**，两种解决思路：

1. **针对不需要上 pad 的应用**：删除 `pad_entry` 模块；
2. **针对同时需要上 pad 和 pc 的应用**：将仅 2in1 使用的权限声明由 `web_engine` 模块**转移至 `pc_entry` 模块**（即 `electron/src/main/module.json5`）。

> 即：pad/PC 双端上架时，"仅 PC（2in1）用的权限"不能放在两个形态共用的 `web_engine` 运行时模块里，要挪到 PC 入口模块 `pc_entry`。

### 4.7.3 Electron 侧 systemPreferences 与原生权限的对应关系

| Electron 侧接口参数 | 对应的原生权限（module.json5 静态声明） | 级别 |
|---|---|---|
| `requestSystemPermission('microphone')` / `askForMediaAccess('microphone')` | `ohos.permission.MICROPHONE` | 按需/ACL |
| `requestSystemPermission('camera')` / `askForMediaAccess('camera')` | `ohos.permission.CAMERA` | 按需/ACL |
| `requestSystemPermission('screen-capture')` | `ohos.permission.CUSTOM_SCREEN_CAPTURE` | 按需/ACL |
| `requestSystemPermission('location')` | `ohos.permission.LOCATION`（+ `APPROXIMATELY_LOCATION`） | 按需/ACL |
| `requestSystemPermission('user-download-dir')` | `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | 按需/ACL |
| `requestSystemPermission('user-document-dir')` | `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | 按需/ACL |
| `requestSystemPermission('user-desktop-dir')` | `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY` | 按需/ACL |
| `requestSystemPermission('bluetooth')` | `ohos.permission.ACCESS_BLUETOOTH` | 按需/ACL |
| `requestSystemPermission('pasteboard')` | `ohos.permission.READ_PASTEBOARD` | 基础（建议带 reason） |

（对应关系依据：《官方README》§新增接口参数清单 + 第 4.3/4.4 节权限表）

> 迁移经验：**静态声明 + 运行时请求双管齐下**——module.json5 里声明（过签名/上架校验），业务代码里调 requestSystemPermission（过运行时授权）。只做一边都会出问题：只声明不请求 → 功能拿不到授权；只请求不声明 → 签名/校验阶段就失败。

## 4.8 权限配置自检清单（常见遗漏）

- [ ] ① **忘写 `reason`**：按需/ACL 权限没写 `reason`（或没在 string.json 里定义对应文案）→ 校验报错（第 7 章 Q3）。
- [ ] ② **`usedScene` 缺失**：目录类权限（READ_WRITE_*_DIRECTORY）没写 `usedScene.abilities` + `when`（官方示例用 `"always"`）。
- [ ] ③ **ACL 未获批就声明**：ACL 权限没申请到证书 → 签名失败/安装报错；**先注释，获批再加**。
- [ ] ④ **目录权限没配 `FILE_ACCESS_PERSIST`**：访问下载/文档/桌面公共目录，README 建议**同时申请** `READ_WRITE_*_DIRECTORY` + `FILE_ACCESS_PERSIST`，代码侧再调 `requestDirectoryPermission()` / `fileAccessPersist()` 做持久化授权。
- [ ] ⑤ **权限名拼错/版本不符**：从官方权限文档复制；API 版本不同权限名可能有差异（第 7 章 Q3）。
- [ ] ⑥ **声明了但没运行时请求**：按需权限必须在代码里调授权 API，弹窗才会出现。
- [ ] ⑦ **读剪贴板没先申请 pasteboard**：`clipboard.readText()` 前必须先 `requestSystemPermission('pasteboard')`（调研报告 §4.4）。
- [ ] ⑧ **声明了没用的权限**：上架审核会检查"权限声明与实际使用一致"，申请了未使用的权限可能被拒（《鸿蒙PC开发基础文档》§2.4 附近 Q&A）。
- [ ] ⑨ **2in1 专属权限放错模块**：pad/PC 双端上架时，仅 2in1 权限要放 `pc_entry` 模块（§4.7.2）。
- [ ] ⑩ **多实例不需要但没删 multiAppMode**：单实例应用留着 multiAppMode 会导致意外多开，删掉（§2.5）。

---

# 5. 依赖配置专章（全文档重点）

鸿蒙的依赖体系分三层，先记住这层关系（《鸿蒙PC开发基础文档》§3.6）：

| 层 | 是什么 | 怎么引入 | 类比 |
|---|---|---|---|
| **@kit.\*** | SDK 内置官方能力包 | **不需要也不应该写进 oh-package.json5**，直接 `import { xxx } from '@kit.XXXKit'` | 官方 NuGet / Electron 内置模块 |
| **ohpm 三方库** | OpenHarmony 生态的第三方库（`@ohos/xxx` 等） | `ohpm install <包名>`，写入 `oh-package.json5` 的 `dependencies` | npm |
| **HAR 包** | 共享代码/资源的模块包（含 ArkUI 组件） | 工程间依赖 / ohpm 依赖 | npm 包 / 组件库 |

## 5.1 oh-package.json5 详解

`oh-package.json5` 是模块/工程的依赖清单（类似 package.json），**工程根一份、每个模块一份**（《鸿蒙PC开发基础文档》§3.4 目录树）。

### 5.1.1 完整示例（含注释）

```json5
{
  "name": "entry",                    // 包名（模块名，须与 module.json5 的 module.name 一致）
  "version": "1.0.0",                 // 版本
  "description": "示例模块",           // 描述
  "main": "",                         // 入口文件（模块工程一般留空）
  "author": "",                       // 作者
  "license": "Apache-2.0",            // 许可证
  "dependencies": {
    // 三方库用 ohpm install 安装后自动出现，类似 npm 的 package.json
    // @ohos/lottie: "2.0.0"                        ← ohpm 安装的三方库（示例）
    // "@ohos/xxx": "file:../xxx"                   ← ⚠️ 本地路径引用（通用配置，以官方文档为准）
    // "har 包": 工程间依赖写在工程级 oh-package.json5 的 dependencies（⚠️ 通用配置，以官方文档为准）
  },
  "devDependencies": {
    // 开发期依赖（构建工具等），发布不打包
  }
}
```

（name/version/description/main/author/license/dependencies 出处：《鸿蒙PC开发基础文档》§3.4.1 ⑤）

### 5.1.2 字段逐项说明

| 字段 | 说明 | 备注 |
|---|---|---|
| `name` | 模块/工程名 | 模块级须与 `module.json5` 的 `module.name` 一致 |
| `version` | 版本号 | `1.0.0` |
| `description` / `main` / `author` / `license` | 元信息 | 模板自动生成 |
| `dependencies` | 运行时依赖：**ohpm 三方库** | 格式 `"包名": "版本号"`；⚠️ 本地/工程间依赖（`file:` 协议或 HAR 引用）为通用配置，以官方文档为准 |
| `devDependencies` | 开发期依赖 | 见 5.6：**壳工程里的 package.json 要删除 devDependencies**（官方五步迁移法第 4 步） |

### 5.1.3 ⚠️ 重点：@kit.xxx 不需要写进 dependencies

《鸿蒙PC开发基础文档》两处原文：
- §3.4.1 ⑤ 注释："注意：@kit.xxx 是 SDK 内置的，不需要也不应该写在这里"
- §3.6 提示："@kit.* 由 SDK 直接提供，**不需要 ohpm install**；ohpm 只装第三方库"

> ⚠️ 待核实/说明：部分 DevEco 版本在创建工程时会自动在 oh-package.json5 里写入 `"@kit.ArkUI": "1.0.0"` 之类条目（各版本行为不同）。**以你工程自动生成的为准**；手写依赖时不要主动加 @kit。

## 5.2 常用 @kit 官方依赖表

> ⚠️ 本表为**通用知识**（kit 清单会随版本演进），标注"以官方文档为准"；其中能力描述与 Electron 类比来自《鸿蒙PC开发基础文档》§3.6/§4.1 对照表。

| Kit | 提供能力 | 典型 API（素材出现） | 类比（Electron/Windows） |
|---|---|---|---|
| `@kit.ArkUI` | 声明式 UI 全部组件与状态管理 | 组件树/状态管理 | React/Vue + 样式系统 |
| `@kit.AbilityKit` | Ability 生命周期、Want、应用跳转、权限（abilityAccessCtrl） | `abilityAccessCtrl.createAtManager()` ⚠️ | app 生命周期 + 启动参数 |
| `@kit.NetworkKit` | HTTP/WebSocket 网络能力 | `http.createHttp().request(...)` | Electron net / fetch |
| `@kit.CoreFileKit` | 文件/目录读写（fs 模块） | `fs.openSync('/data/storage/el2/base/files/a.txt', fs.OpenMode.READ_WRITE)` | Node fs |
| `@kit.PasteboardKit` | 剪贴板 | `pasteboard.getSystemPasteboard().setData(...)` | Electron clipboard |
| `@kit.NotificationKit` | 系统通知 | `notificationManager.publish(request)` | Electron Notification / Windows Toast |
| `@kit.ArkData` | 关系型数据库（RDB，SQLite 内核）、首选项、分布式数据 | `relationalStore.getRdbStore(context, {...})` | better-sqlite3 + electron-store |
| `@kit.SQLiteKit` | SQLite 数据库 | — | better-sqlite3 |
| `@kit.DeviceInfoKit` | 设备信息 | `deviceInfo.deviceType`、`deviceInfo.osFullName` | os 模块 / systeminfo |
| `@kit.MediaKit` | 音视频采集播放 | — | MediaDevices / 媒体 API |
| `@kit.ScreenCaptureKit` | 屏幕采集 | — | desktopCapturer |
| `@kit.WindowKit` | 窗口管理（自由窗口/悬浮窗/子窗口） | `windowStage.createSubWindow()` | BrowserWindow / Win32 HWND |
| `@kit.WebKit` | ArkWeb 网页组件 | `Web({ src: $rawfile('web/index.html') })` | WebView / WebView2 |
| `@kit.BasicServicesKit` | 基础服务（设置、日志等） | — | 系统 API |
| `@kit.PrintKit` | 打印框架 | — | webContents.print() |

（表内"提供能力/类比"出处：《鸿蒙PC开发基础文档》§3.6 表格 + §4.1 场景对照；⚠️ kit 全量清单与版本以官方文档为准）

## 5.3 ohpm 包管理器命令速查

ohpm = OpenHarmony Package Manager（鸿蒙三方库包管理器，类比 npm）（《鸿蒙PC开发基础文档》§3.5 工具表）。

```bash
ohpm init                              # 初始化 oh-package.json5
ohpm install <包名>                    # 安装三方库（如 ohpm install @ohos/lottie）
ohpm install                           # 按 oh-package.json5 安装全部依赖
ohpm list                              # 列出已安装依赖
ohpm uninstall <包名>                  # 卸载依赖
ohpm install -g <包名>                 # ⚠️ 全局安装（通用命令，以官方文档为准）
# 注意：@kit.* 是 SDK 内置，不要 ohpm install
```

（init/install/list 出处：《鸿蒙PC开发基础文档》附录 A.5；uninstall、`-g` 为 ⚠️ 通用命令，以官方文档为准）

**仓库源与内网配置**：
- 默认仓库源：`ohpm.openharmony.cn`（⚠️ 通用配置，以官方文档为准）。
- **内网场景**：`ohpm install` 拉三方库失败时，**配置 ohpm 镜像源或离线仓库**（《鸿蒙PC开发基础文档》§5.2 Q7 方案 3："把 `.ohpm` 缓存目录拷到内网机"）。⚠️ 镜像源的具体配置方式（`.ohpmrc` 文件中的 `registry` 配置）为通用配置，以官方文档为准，示意如下：

```ini
# ~/.ohpmrc（或工程 .ohpmrc）—— ⚠️ 通用配置，以官方文档为准
registry=https://ohpm.openharmony.cn/ohpm/        # 默认官方源
# registry=http://<内网镜像服务器>:端口/           # 内网镜像源（替换成公司镜像地址）
```

## 5.4 三方库获取

- **OpenHarmony 三方库中心**：官方三方库平台，检索 `@ohos` 前缀库与社区 HAR（⚠️ 通用信息，以官方文档为准）。
- **`@ohos` 前缀库**：OpenHarmony 官方组织发布的三方库（如 `@ohos/lottie`，素材命令示例即此）。
- **社区 har**：`ohpm install` 安装的包本质是 HAR 格式。
- ⚠️ **内网场景**：先在有网机器上 `ohpm install` 拉全依赖后，把 **ohpm 缓存目录（`.ohpm`）整体拷贝**到内网机（《鸿蒙PC开发基础文档》§5.2 Q7）；或搭建内网 ohpm 私有仓库（通用做法，以官方文档为准）。同理，Electron 侧的 npm 依赖用 `npm pack` 离线方案（《鸿蒙PC迁移方案》§2.2.1）。

## 5.5 hvigor 构建依赖

hvigor 构建链的依赖配置集中在 `hvigor/hvigor-config.json5`（⚠️ 通用配置，以官方文档为准，见 §3.3.3）：
- `modelVersion`：hvigor 模型版本；
- `dependencies`：`@ohos/hvigor-ohos-plugin` 版本。

**版本必须与 DevEco Studio 配套**；`hvigorw` / `hvigorw.bat` 是构建包装器（类似 gradlew），由 DevEco 生成、随工程走，**不要手改**（《鸿蒙PC开发基础文档》§3.4 目录树）。

## 5.6 Electron 壳工程特有依赖

### 5.6.1 node_modules 放置位置（壳工程）

官方五步迁移法第 4 步（《Electron鸿蒙化调研报告》§2.2 原文）：**"将编译产物及 package.json 复制到 HarmonyOS 化 Electron 样例工程（删除 devDependencies）"**。

- 业务产物（编译后的 JS + package.json）放到：`web_engine/src/main/resources/resfile/resources/app`（《官方README》§编译未签名的hap包；两份社区模板同文）。
- `node_modules` 只保留**生产依赖**（含重编译后的 addon）（《鸿蒙PC迁移方案》§3.5 同步清单）。
- ⚠️ 三类依赖注意（《官方README》§资源替换 + 调研报告 §4.2）：
  1. **纯 JS 库**：直接用；
  2. **C++ addon（.node）**：必须用鸿蒙工具链（`aarch64-linux-ohos` 目标 clang/llvm）**重编译**，放 `ohos_hap/electron/libs/arm64-v8a`；C++ 标准最低 17；
  3. **含二进制 CLI 的库（esbuild 等）**：不能直接用，走 HNP 打包方案。

### 5.6.2 @electron-ohos/electron-builder（方案二）配置示例

`@electron-ohos/electron-builder` 是 electron-builder 的鸿蒙分支（npm 包，`latest 26.8.5`，《鸿蒙PC迁移方案》§6.5），配置在 Electron 工程自己的 `package.json`（素材 `research/upgrade_readme.md` 原文整理 + §6.5）：

```json
// Electron 工程 package.json（方案二：直接出 HAP）
{
  "scripts": {
    "dist:ohos": "electron-builder-ohos --ohos"
  },
  "build": {
    "appId": "com.yourcompany.yourapp",        // 必填，映射 HAP bundleName，格式 xx.xx.xx
    "productName": "你的应用名",                 // 映射 HAP 应用名
    "asar": false,                              // 关键：鸿蒙上必须 false（拆包拷贝）
    "ohos": {
      "target": ["hap"],                       // 打包类型
      "hvigorwPath": "D:/DevEco/deveco-studio/tools/hvigor/bin",  // hvigorw 工具路径
      "ohpmPath": "D:/DevEco/deveco-studio/tools/ohpm/bin",       // ohpm 工具路径
      "sdkPath": "D:/DevEco/deveco-studio/sdk",                   // SDK 路径
      "ohosHapPath": "D:/project/electron/v34.x/ohos_hap",        // 壳工程路径（升级时换这里）
      "certPath": "D:/cert/debug.cer",         // 签名证书（签名包必须）
      "profile": "D:/cert/helloworld.p7b",     // Profile（.p7b）
      "keyAlias": "helloworld",                // 密钥别名
      "keyPassword": "123456",                 // 别名密码（支持环境变量 OH_KEY_PWD）
      "storeFile": "D:/cert/helloworld.p12",   // 私钥库
      "storePassword": "123456"                // 私钥库密码（支持环境变量 OH_STORE_PWD）
      // 可选：额外权限（electron 框架不具备的权限）
      // "requestPermissions": [ { "name": "ohos.permission.xxx", "reason": "xxx",
      //                           "usedScene": { "abilities": ["FormAbility"], "when": "always" } } ],
      // 可选：深链 skills（打包时自动同步到 module.json5）
      // "skills": [ { "actions": ["example.want.action.viewData"],
      //              "uris": [{ "scheme": "www.example.com" }] } ]
    }
  },
  "devDependencies": {
    // ⚠️ 拷贝进壳工程前删除 devDependencies（官方五步第 4 步）
  },
  "dependencies": {
    // 仅生产依赖
  }
}
```

执行：`npm run dist:ohos`，产物在 `./dist/ohos-unpacked/` 下（upgrade_readme.md §2.3）。**注意**：方案二**不支持自动签名/自动安装**，产物需手动 `hdc app install`（《鸿蒙PC迁移方案》§6.5、《Electron鸿蒙化调研报告》§2.3）。

> ⚠️ 路径均不含中文（同签名要求）；`hvigorwPath`/`ohpmPath`/`sdkPath` 在 DevEco 安装目录或打包工具目录中找（upgrade_readme.md 原文）。

## 5.7 依赖配置常见错误

| # | 错误 | 现象 | 处理 |
|---|---|---|---|
| 1 | **hvigor 版本与 DevEco 不匹配** | 构建报 hvigor/插件错误 | 检查 `hvigor/hvigor-config.json5` 的 modelVersion 与 @ohos/hvigor-ohos-plugin 版本，与 DevEco 配套（§3.3.3） |
| 2 | **@kit 版本与 SDK 不匹配** | import 报错/编译失败 | @kit 由 SDK 内置，别手写版本；升级 SDK 后清理重新 Sync（§5.1.3） |
| 3 | **ohpm install 失败**（内网） | 拉包超时/404 | 配置镜像源或拷贝 `.ohpm` 缓存到内网机（§5.3） |
| 4 | **HAR 包未声明依赖** | 找不到模块 | 工程间依赖写在工程级 `oh-package.json5` 的 dependencies（⚠️ 通用配置，以官方文档为准） |
| 5 | **把 @kit 写进 dependencies** | 无直接报错但不符合规范 | 删掉（§5.1.3） |
| 6 | **devDependencies 没删**（壳工程） | 包体积大/依赖解析失败 | 拷贝进壳工程前删除 devDependencies（§5.6.1） |
| 7 | **addon 未重编译/架构不对** | 安装报 `install parse native so failed` | 用鸿蒙工具链重编译，放 `libs/arm64-v8a`（第 7 章 Q11） |
| 8 | **electron-builder 路径配错** | dist:ohos 失败 | 检查 hvigorwPath/ohpmPath/sdkPath/ohosHapPath 是否存在、无中文（§5.6.2） |

---

# 6. 完整示例工程配置（可直接复制修改）

> 本示例是一个**最小 Electron 壳工程**的全部核心配置文件，字段全部来自第 1-5 章素材，**可直接复制修改**（改 bundleName、应用名、权限即可）。JSON5 支持 `//` 注释，复制时保留注释便于维护。

## 6.1 AppScope/app.json5

```json5
{
  "app": {
    "bundleName": "com.yourcompany.yourapp",  // 改成你的包名（与 AGC 一致，上架后不可改）
    "vendor": "yourcompany",                  // 厂商
    "versionCode": 1000000,                   // 版本号（数字，上架递增）
    "versionName": "1.0.0",                   // 版本名
    "icon": "$media:app_icon",                // 图标（替换 AppScope/resources/base/media/ 下文件）
    "label": "$string:app_name"               // 应用名（AppScope/resources/base/element/string.json）
    // API 10~22 需要访问明文 HTTP 时追加：
    // "network": { "cleartextTraffic": true }
  }
}
```

## 6.2 electron/src/main/module.json5（PC 入口模块 pc_entry）

```json5
{
  "module": {
    "name": "pc_entry",                       // PC 入口模块名（模板固定）
    "type": "entry",
    "srcEntry": "./ets/Application/AbilityStage.ets",
    "description": "$string:module_desc",
    "mainElement": "EntryAbility",
    "deviceTypes": [ "2in1" ],                // ★PC/2in1 必须声明；不要写成 phone
    "deliveryWithInstall": true,
    "installationFree": false,
    "pages": "$profile:main_pages",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "description": "$string:EntryAbility_desc",
        "icon": "$media:app_icon",
        "label": "$string:EntryAbility_label",       // 改应用名 = 改这个资源
        "startWindowIcon": "$media:app_icon",
        "startWindowBackground": "$color:start_window_background",
        "launchType": "specified",
        "removeMissionAfterTerminate": true,
        "exported": true,
        "metadata": [                                 // ★首窗口尺寸（不需要居中只留 width/height）
          { "name": "ohos.ability.window.height", "value": "800" },
          { "name": "ohos.ability.window.width",  "value": "1280" },
          { "name": "ohos.ability.window.left",   "value": "center" },
          { "name": "ohos.ability.window.top",    "value": "center" }
        ],
        "skills": [
          {
            "entities": [ "entity.system.home", "entity.system.browsable" ],
            "actions": [ "action.system.home", "ohos.want.action.viewData" ],
            "uris": []                                // 深链示例：{ "scheme": "myapp", "host": "open", "path": "id" }
          }
        ]
      }
    ]
    // 单实例应用：不要 multiAppMode；需要多实例再加（见 2.5）
  }
}
```

## 6.3 web_engine/src/main/module.json5（权限声明模块，节选 requestPermissions）

```json5
{
  "module": {
    // ... 模块原有字段保持不变（name: "web_engine", type: "feature" 等）...
    "requestPermissions": [
      // —— 基础权限（声明即生效）——
      { "name": "ohos.permission.INTERNET" },
      { "name": "ohos.permission.GET_NETWORK_INFO" },
      { "name": "ohos.permission.RUNNING_LOCK" },
      { "name": "ohos.permission.PREPARE_APP_TERMINATE" },
      { "name": "ohos.permission.FILE_ACCESS_PERSIST" },
      {
        "name": "ohos.permission.READ_PASTEBOARD",
        "reason": "$string:access_pasteboard"
      },
      // —— 目录类 ACL 权限（未获批先注释；获批后取消注释）——
      {
        "name": "ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY",
        "reason": "$string:reason_download",
        "usedScene": { "abilities": [ "EntryAbility" ], "when": "always" }
      },
      {
        "name": "ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY",
        "reason": "$string:reason_documents",
        "usedScene": { "abilities": [ "EntryAbility" ], "when": "always" }
      },
      {
        "name": "ohos.permission.READ_WRITE_DESKTOP_DIRECTORY",
        "reason": "$string:reason_desktop",
        "usedScene": { "abilities": [ "EntryAbility" ], "when": "always" }
      }
      // —— 其他按需权限（按需加，未获批先注释）——
      // { "name": "ohos.permission.MICROPHONE",
      //   "reason": "$string:reason_mic",
      //   "usedScene": { "abilities": [ "EntryAbility" ], "when": "inuse" } },
      // { "name": "ohos.permission.CAMERA",
      //   "reason": "$string:reason_camera",
      //   "usedScene": { "abilities": [ "EntryAbility" ], "when": "inuse" } }
    ]
  }
}
```

## 6.4 build-profile.json5（工程级）

```json5
{
  "app": {
    "signingConfigs": [],                 // DevEco 自动签名会自动填充；手动签名在 IDE 里配
    "products": [
      {
        "name": "default",
        "signingConfig": "default",
        "compatibleSdkVersion": "6.0.0(20)",   // ⚠️ 改成你 SDK 管理器里实际安装的版本
        "runtimeOS": "HarmonyOS"
      }
    ]
  },
  "modules": [                            // ⚠️ 通用结构，模板自动生成
    { "name": "electron", "srcDir": "./electron", "targets": [ { "name": "default", "applyToProducts": [ "default" ] } ] },
    { "name": "web_engine", "srcDir": "./web_engine", "targets": [ { "name": "default", "applyToProducts": [ "default" ] } ] }
  ]
}
```

## 6.5 oh-package.json5（工程级）

```json5
{
  "name": "ohos_hap",
  "version": "1.0.0",
  "description": "Electron 鸿蒙化壳工程",
  "main": "",
  "author": "",
  "license": "Apache-2.0",
  "dependencies": {
    // 三方库（ohpm install 后自动出现）；@kit.* 不要写在这里
  },
  "devDependencies": {}
}
```

## 6.6 resources/base/profile/network_config.json（API 23+ 明文 HTTP）

```json
{
  "network-config": {
    "cleartextTrafficPermitted": true,
    "domains": [
      { "domain": "192.168.1.10", "cleartextTrafficPermitted": true }
    ]
  }
}
```

## 6.7 resources/base/element/string.json（权限 reason 文案 + 应用名）

```json
{
  "string": [
    { "name": "module_desc", "value": "PC 入口模块" },
    { "name": "EntryAbility_desc", "value": "主入口" },
    { "name": "EntryAbility_label", "value": "你的应用名" },
    { "name": "access_pasteboard", "value": "用于支持复制粘贴功能" },
    { "name": "reason_download", "value": "用于访问公共下载目录中的文件" },
    { "name": "reason_documents", "value": "用于访问公共文档目录中的文件" },
    { "name": "reason_desktop", "value": "用于访问公共桌面目录中的文件" },
    { "name": "reason_mic", "value": "用于语音输入与通话" },
    { "name": "reason_camera", "value": "用于拍摄与视频通话" }
  ]
}
```

> ⚠️ `EntryAbility_label` 在壳工程里位于 `electron/src/main/resources/zh_CN/element/string.json`（改应用名的位置，见 §3.5.2）；权限 reason 文案应放在对应模块的 `resources/base/element/string.json`（base 目录，不限语言）。

## 6.8 复制后的必改清单（最小动作）

1. `app.json5`：bundleName、vendor、版本号；
2. `AppScope/resources/base/media/`：换图标；`string.json`：换应用名；
3. `electron/src/main/module.json5`：窗口尺寸 metadata（可选）；
4. `web_engine/src/main/module.json5`：按第 4 章自检清单增删 requestPermissions；
5. `build-profile.json5`：compatibleSdkVersion 对齐本机 SDK；
6. 签名：DevEco 自动签名 → 构建 → `hdc app install`。

---

# 7. 配置错误排查 Q&A（15 条）

> 每条：**问题 → 原因 → 解决方案**。依据《鸿蒙PC开发基础文档》第 5 章 Q&A、《鸿蒙PC迁移方案》§6.3.3/§8、《官方README》与两份社区模板整理。

### Q1. 安装报 INSTALL_PARSE_FAILED / 签名不匹配
- **原因**：①设备已装同名应用但签名不同（调试/发布签名切换过）；②包名冲突；③OpenHarmony 签名包装到 HarmonyOS 设备。
- **解决**：先卸载旧包再装；`hdc app uninstall com.example.myapp` → `hdc app install xxx-signed.hap`；确认整条链用同一个签名配置重新构建；临时改 bundleName 验证是否包名冲突（《鸿蒙PC开发基础文档》Q12）。

### Q2. 报错 "The target device does not work with apps with an OpenHarmony signature"
- **原因**：OpenHarmony 调试证书 ≠ HarmonyOS 商用证书。
- **解决**：商用 HarmonyOS 设备必须用 **HarmonyOS 签名**（AGC 申请），不能用 OpenHarmony 工具链签的包（《Electron鸿蒙化调研报告》§1.3）。

### Q3. 权限声明报错：编译报错 / 运行时权限不生效
- **原因**：①权限名拼写错误或该权限不存在于当前 API 版本；②ACL 权限没拿到证书；③按需权限缺 `reason` 或 `usedScene`。
- **解决**：权限名从官方权限文档复制（注意版本差异）；补全 `reason: "$string:xxx"` + `usedScene: { abilities: [...], when: "always"|"inuse" }`；reason 文案写在 string.json；ACL 未获批先注释（《鸿蒙PC开发基础文档》Q8）。

### Q4. hvigor 构建失败：JDK 版本不匹配 / 找不到 SDK
- **原因**：①构建机 JDK 非 17；②`compatibleSdkVersion` 与已装 SDK 不匹配；③依赖拉取失败（内网）。
- **解决**：确认 `java -version` 为 17.x；`compatibleSdkVersion` 写法（如 `"6.0.0(20)"`）与 SDK 管理器实际安装一致；内网配 ohpm 镜像源或拷贝 `.ohpm` 缓存；`./hvigorw clean` 后再 `assembleHap`（《鸿蒙PC开发基础文档》Q7）。

### Q5. hap-sign-tool 解析失败 / 找不到文件
- **原因**：**签名工具对中文路径/空格敏感**。
- **解决**：整个工程放纯英文路径；.cer/.p12/.p7b 文件名与路径均不含中文和空格；执行环境 JDK 17（《鸿蒙PC开发基础文档》Q5、《鸿蒙PC迁移方案》§6.3.3）。

### Q6. ohpm install 失败（内网 / 超时 / 404）
- **原因**：无法访问默认仓库源；或需要镜像。
- **解决**：配置镜像源（`.ohpmrc` 的 registry）或把有网机器上的 `.ohpm` 缓存目录拷到内网机；`@kit.*` 不要 ohpm install（§5.3）。

### Q7. requestPermissions 格式错误 / 校验不过
- **原因**：reason 没带 `$string:` 前缀、usedScene 结构不对、when 取值非法。
- **解决**：按第 4 章 §4.2 字段表逐项核对；`reason` 必须 `"$string:资源名"`；`when` 只取 `"always"`/`"inuse"`（素材出现值）。

### Q8. 2in1 上架报错："权限声明包含仅 2in1 设备使用的权限"
- **原因**：权限声明中包含了仅 2in1 设备使用的权限。
- **解决**：①不上 pad：删除 `pad_entry` 模块；②pad/PC 双上：把仅 2in1 权限从 `web_engine` 模块转移到 `pc_entry` 模块（《官方README》§上架问题、《鸿蒙PC迁移方案》§8.2）。

### Q9. ACL 权限导致签名失败
- **原因**：声明了 ACL 权限但未申请到证书。
- **解决**：把未获批的 ACL 权限从 requestPermissions **注释掉**，重签；再走邮件申请流程逐个加回（§4.5）。

### Q10. TS 编译报错 TS2367 / 找不到类型 'ohos'
- **原因**：代码/三方库硬编码平台判断（如 `process.platform === 'win32'` 分支），鸿蒙版 TS 类型声明里没有该平台枚举。
- **解决**：不要硬编码平台字符串，运行时动态判断 `process.platform`；用鸿蒙适配版 Electron 源码的 `electron.d.ts` 替换 `node_modules/electron/electron.d.ts`（《鸿蒙PC开发基础文档》Q6、《鸿蒙PC迁移方案》§3.4）。⚠️ 待核实：platform 实际返回值为 'openharmony'/'ohos'/'linux' 三者说法不一，目标版本上实测。

### Q11. 安装报 "install parse native so failed"
- **原因**：HAP 内 `.so` 架构不匹配（x86 的 so 放进 arm64 工程）、so 未放对目录，或模拟器兼容问题。
- **解决**：确认 so 为 **arm64-v8a**、放在 `libs/arm64-v8a/`；native 模块用鸿蒙工具链重编译；模拟器失败换真机或加 `--disable-gpu`（《鸿蒙PC开发基础文档》Q10、Q13）。

### Q12. 模拟器黑屏 / 无法运行
- **原因**：Electron 鸿蒙版模拟器支持差；GPU 加速在模拟器不可用。
- **解决**：首选真机调试；必须模拟器时加 `--disable-gpu` / `app.disableHardwareAcceleration()`（预编译包默认已禁用）；⚠️ 待核实：DevEco 6.x 的 2in1 模拟器支持情况新旧说法矛盾，以当前版本实测为准（《鸿蒙PC开发基础文档》Q13）。

### Q13. 编译报 "autoStartupManager" 不存在（壳工程）
- **原因**：`@kit.AbilityKit` 的导出成员名随版本变化，壳工程适配层引用了旧名。
- **解决**：注释 `web_engine/src/main/ets/adapter/ElectronAppAdapter.ets` 中 `import { autoStartupManager } from '@kit.AbilityKit';` 及其调用处（自启动由系统管理，注释安全）（《鸿蒙PC迁移方案》§6.1.2）。

### Q14. 窗口不显示 / 尺寸不生效
- **原因**：①窗口显示/隐藏与托盘强绑定，没建托盘时行为异常；②首窗口尺寸只能走 module.json5 metadata。
- **解决**：需要托盘则先 `new Tray()` 再建窗口；不需要托盘则注释 `AppWindowAdapter.ets` 的 `processMode`/`startupVisibility`；首窗口尺寸在 `metadata` 配 `ohos.ability.window.width/height/left/top`（§2.3、《鸿蒙PC开发基础文档》Q15）。

### Q15. 授权弹窗不出现 / 拒绝后无法再授权
- **原因**：按需权限没在运行时调授权 API；或弹窗只弹一次，之前拒绝过。
- **解决**：Electron 侧调 `systemPreferences.askForMediaAccess` / `requestSystemPermission`；拒绝后必须引导用户去「设置 → 隐私和安全」手动开启（可用 `openApplicationInfoEntry()` 直达）（§4.6）。

---

# 8. 附录

## 8.1 字段速查表（所有配置文件关键字段一行说明）

| 文件 | 关键字段 | 一行说明 |
|---|---|---|
| `AppScope/app.json5` | `bundleName` | 包名，全局唯一，上架后不可改，须与 AGC 一致 |
| | `versionCode` / `versionName` | 版本号（数字递增）/ 版本名 |
| | `icon` / `label` | 图标 / 应用名（`$media:` / `$string:` 资源引用） |
| | `network.cleartextTraffic` | 明文 HTTP 放行（**API 10~22** 在此；API 23+ 用 network_config.json） |
| `module.json5` | `module.name` / `type` | 模块名 / 类型（entry=入口，feature=功能） |
| | `deviceTypes` | 设备形态数组，PC 写 `"2in1"` |
| | `deliveryWithInstall` / `installationFree` | 随安装交付 / 是否免安装（元服务才 true） |
| | `pages` | 页面路由表引用（`$profile:main_pages`） |
| | `abilities[]` | UIAbility 列表（name/srcEntry/icon/label/startWindow*/launchType/exported） |
| | `abilities[].metadata` | 首窗口尺寸：`ohos.ability.window.width/height/left/top` |
| | `abilities[].skills` | 拉起声明：entities/actions/uris（深链） |
| | `multiAppMode` | 多实例配置（不需要就删） |
| | `requestPermissions[]` | 权限声明：`name` +（`reason`）+（`usedScene.abilities`/`when`） |
| `build-profile.json5` | `app.signingConfigs` | 签名配置（DevEco 管理） |
| | `app.products[].compatibleSdkVersion` | 最低兼容 SDK，写法 `"6.0.0(20)"`，须与已装 SDK 一致 |
| | `app.products[].runtimeOS` | 目标 OS（HarmonyOS） |
| | `modules[]` | 模块列表：name/srcDir/targets（⚠️ 通用结构） |
| `oh-package.json5` | `dependencies` | ohpm 三方库；**@kit.\* 不写这里** |
| `hvigorfile.ts` | `system` | 模块级 `hapTasks`；工程级 `appTasks`（⚠️ 通用） |
| `hvigor/hvigor-config.json5` | `modelVersion` / `dependencies.@ohos/hvigor-ohos-plugin` | hvigor 模型版本 / 插件版本，须与 DevEco 配套（⚠️ 通用） |
| `network_config.json` | `network-config.cleartextTrafficPermitted` / `domains[]` | 全局/按域名明文 HTTP 策略（API 23+，⚠️ 以官方文档为准） |
| `main_pages.json` | `src[]` | 页面路由表 |
| `obfuscation-rules.txt` | — | 混淆规则（可选，⚠️ 通用） |

## 8.2 内网离线配置物料清单（提前下载）

> 依据《鸿蒙PC迁移方案》§10.1 完整离线下载清单（节选与本文档相关的构建配置物料）。**公司内网优先在有网机器下载后拷贝**；官方文档链接见 §8.3。

| # | 物料 | 版本/命名 | 来源 | 账号 | 用途 | 勾销 |
|---|---|---|---|---|---|---|
| 1 | DevEco Studio | 6.1.x（全平台） | developer.huawei.com/consumer/cn/deveco-studio/ | 华为开发者 | IDE/构建（内含 hvigor、ohpm、hdc、hap-sign-tool） | ☐ |
| 2 | HarmonyOS SDK 离线包 | API 20+/23 | DevEco 下载区 | 华为开发者 | SDK（compatibleSdkVersion 对齐它） | ☐ |
| 3 | **Electron 鸿蒙版预编译包** | v34.6.3-20260105.1-release.zip 等 | 华为云 CodeHub（devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858） | **华为云** | 壳工程 + 运行时（本文档所有 module.json5 的对象） | ☐ |
| 4 | Node.js | v20.18.1 | nodejs.org/dist/v20.18.1/ 或 npmmirror | 无 | 前端构建 | ☐ |
| 5 | JDK 17（构建） | Temurin 17 | adoptium.net/temurin/releases/?version=17 | 无 | DevEco/hvigor/hap-sign-tool 运行 | ☐ |
| 6 | npm 依赖 tgz 集 | 生产依赖全树 | `npm pack`（有网机器） | 无 | 前端依赖离线安装 | ☐ |
| 7 | ohpm 缓存 | `.ohpm` 目录 | 有网机器 `ohpm install` 后拷贝 | 无 | 三方库离线安装（§5.3） | ☐ |
| 8 | @electron-ohos/electron-builder | 26.8.x | npmjs.com/package/@electron-ohos/electron-builder | 无 | 方案二打包 | ☐ |
| 9 | 鸿蒙原生工具链 | llvm（aarch64-linux-ohos） | DevEco SDK native 目录（`sdk/default/openharmony/native/llvm`） | — | addon/C++ 重编译 | ☐ |
| 10 | 官方文档整仓 | openharmony-sig/electron | gitcode.com/openharmony-sig/electron | GitCode 可选 | 离线查证（1294 API 索引、权限、签名） | ☐ |
| 11 | 签名材料 | p12/cer/p7b | AGC 在线生成 | 华为开发者联盟 | 签名/上架（**路径不能含中文**） | ☐ |
| 12 | ACL 权限证书 | — | 邮件向华为申请（bundleName + 权限 + 用途） | 华为 | 高风险权限签名（§4.5） | ☐ |

## 8.3 官方文档入口（联网后核对用）

> ⚠️ 以下链接需联网；内网环境以本文档内容为准。链接路径来自调研报告快照（2026-08），页面可能改版。

- 应用/服务签名（DevEco Studio）：`developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing`
- 应用沙箱目录：`docs.openharmony.cn`（app-sandbox-directory）
- 明文 HTTP（network_config.json，API 23 起）：官方文档搜 "network_config"（路径随版本变化）
- Electron 鸿蒙化官方仓库：`gitcode.com/openharmony-sig/electron`（权限/窗口/HNP/Deeplink 全套文档）
- 深链：官方文档搜 "deep-linking-startup"
- 上架审核指南：`developer.huawei.com/consumer/cn/doc/app/50104-03`
- AGC：`developer.huawei.com/consumer/cn/service/josp/agc/index.html`

## 8.4 本文档"以官方文档为准/待核实"标注清单（汇总）

> 排查任何"配置了却没生效"的问题，先看这一节：这些点素材未覆盖或素材间有出入，**必须实测或查官方文档**。

**⚠️ 通用配置，以官方文档为准（素材未出现）：**
1. `targetSdkVersion`、`modules` 块、`buildOption`（build-profile.json5）——§3.1；
2. 模块级 build-profile.json5 的 targets/srcDir 结构——§3.1.3；
3. 工程级 hvigorfile.ts 的 `appTasks`——§3.3.2；
4. `hvigor/hvigor-config.json5` 的 modelVersion 与插件版本写法——§3.3.3；
5. `multiAppMode` 内部字段（multiAppModeType/maxCount）——§2.5；
6. APL 等级概念（normal/system_basic/system_core）——§4.1.2；
7. `reason` 文案长度限制、`usedScene.when` 取值全集——§4.2；
8. abilityAccessCtrl 运行时授权 API 代码——§4.6.1；
9. ohpm 默认仓库源、`.ohpmrc` registry、`ohpm uninstall`/`install -g`、HAR 工程间依赖声明方式——§5.3/§5.4/§5.7；
10. @kit 全量清单与版本、部分 DevEco 版本自动写入 @kit 依赖的行为——§5.2/§5.1.3；
11. obfuscation-rules.txt 规则语法——§3.4；
12. network_config.json 字段（素材为社区来源）——§3.6。

**⚠️ 待核实（素材内部有出入/无公开结论）：**
1. `process.platform` 实际返回值（'openharmony'/'ohos'/'linux' 三说并存）——§7 Q10；
2. 明文 HTTP 默认策略与配置位置随 API 版本变化；沙箱访问 localhost 本机服务是否受限——§1.3/§3.6；
3. 模拟器对 Electron 应用的可用性（新旧说法矛盾，按当前 DevEco 版本实测）——§7 Q12；
4. ACL 申请邮箱与邮件模板措辞（素材只确认 bundleName + 权限 + 用途三要素）——§4.5；
5. `READ_PASTEBOARD` 归类（README 表格列基础权限、ACL 示例又列入 ACL 清单）——§4.3。

---

*文档结束。本文档所有字段出处：官方 README 快照、团队调研与基础文档、两份社区壳工程模板（`research/` 目录）；凡未标注 ⚠️ 的字段均可在上述素材中逐字找到。迁移过程中与官方最新文档冲突处，以官方文档为准；所有 ⚠️ 标注项须在目标真机/目标版本上实测后再据此更新。*
