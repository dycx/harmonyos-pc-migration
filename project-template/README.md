# 鸿蒙 PC 项目模板（Electron 前端 + Java 后端）

> 基于 Electron 34（Chromium 132 / Node 20.18.1）官方壳工程制作的开箱即用模板：
> 简单前端页面 + 可运行的 Java 后端（零依赖 demo，开箱即用）+ 完整权限配置。
> 你的正式项目可直接复制本目录，按下方"三步替换"改造成自己的应用。

## 目录结构

```
project-template/
├── AppScope/                        # 应用级配置（bundleName/应用名/图标）
├── electron/                        # 入口模块（ArkTS + 运行时 so）
│   └── libs/arm64-v8a/              # Electron 运行时（libelectron.so 等，160MB 不随 git 上传）
├── web_engine/                      # Web 引擎模块
│   └── src/main/
│       ├── module.json5             # ★权限配置（已精简：6 基础 + JIT）
│       └── resources/resfile/resources/
│           ├── app/                 # ★前端产物（模板自带可运行示例）
│           │   ├── main.js          #   主进程入口：只做引导与装配（托盘→注册IPC→建窗→等后端）
│           │   ├── preload.js       #   安全桥：window.desktop（窗口三键）/ window.api（业务与系统交互）
│           │   ├── logger.js        #   统一日志前缀 [app][模块]
│           │   ├── ipc/             #   ★业务模块：channels.js 契约 / register.js 统一注册 / process-manage.js
│           │   ├── platform/        #   ★平台差异：index.js 归一化+能力探测 / generic / windows / ohos
│           │   ├── package.json
│           │   └── renderer/index.html   #   自检页面（链路自检 + 平台能力面板）
│           └── backend/app.jar      # ★后端 jar（模板自带零依赖 demo，3KB）
├── backend-demo/                    # demo 后端源码（零依赖，javac 构建）
│   ├── src/demo/backend/DemoBackend.java
│   └── build-backend.sh             # 构建脚本 → demo-backend.jar
├── backend-springboot/              # ★正式后端骨架（SpringBoot 3.4，替换 demo 用）
│   ├── pom.xml
│   └── src/main/java/...            # Application + DemoController + application.yml
├── build-profile.json5 / hvigor*    # 工程构建配置（SDK 版本注意见下）
└── 其余官方模板文件（chromium/docs 等，勿删）
```

## 主进程模块化骨架（ipc/ + platform/）

**为什么**：把界面按钮/系统交互的响应函数放在独立模块里，迁移到鸿蒙后容易"点了没反应"（打包漏文件、`process.platform` 分支、
循环 require、注册时机、preload 未生效——五类原因）。模板已按"业务模块 + 平台适配层"重构，**一份代码两端通用**：

| 规则 | 做法 |
|---|---|
| 业务模块不碰平台 | `ipc/process-manage.js` 里不出现 `process.platform`，差异全部走 `platform.xxx` |
| 不做循环 require | 窗口等对象由 `main.js` **注入取值函数**（`getMainWindow: () => mainWindow`） |
| 通道名不写错 | 主进程/preload/渲染层共用 `ipc/channels.js` 的常量 |
| 不静默失效 | 统一经 `ipc/register.js` 注册：出入口日志 + `{ok,data／error}` 结构 + 启动打印通道清单 |
| 不支持的能力要降级 | `platform/*` 抛 `E_UNSUPPORTED` → 渲染层把按钮置灰（见自检页"平台能力面板"） |
| 平台实现可缺失 | 找不到 `platform/<name>.js` 时自动落到 `platform/generic.js`，应用不会起不来 |

新增一个按钮的完整流程（4 步）：
`ipc/channels.js` 加常量 → `ipc/process-manage.js` 加一行 `handle(...)` → `preload.js` 暴露方法 → 渲染层调用。

**构建期防复发**（防止某个 .js 没打进包）：
```bash
node scripts/check-app-manifest.js <源app目录> project-template/web_engine/src/main/resources/resfile/resources/app
# 输出：[清单校验] ✅ 一致（退出码 0）；缺文件时逐条列出并退出码 1
```
并确保 electron-builder 用 **`asar:false`** + `files: ["**/*.js", ...]` 通配白名单。

> 完整说明（含定位五步法、平台差异速查表、迁移改造步骤）见根目录
> **《鸿蒙PC迁移专项_主进程模块化与平台差异适配方案.md》**。

## 三步替换成你的项目

### ① 替换前端
```bash
# 你的原始 Electron 工程（开发机）：
#   electron-builder 打包设 asar:false → 拿拆包后的 app 目录全部内容
cp -r <你的工程>/dist/app/*  web_engine/src/main/resources/resfile/resources/app/
# 注意：app/package.json 删除 devDependencies
# 你的 main.js 可基于模板版改（模板版已含后端拉起/域名映射/托盘逻辑，见 CONFIG 区）
```

### ② 替换后端
```bash
# 方案 1：先用 demo（零依赖，开箱即用）验证链路 —— 已就位，无需操作
# 方案 2：正式 SpringBoot（backend-springboot/）：
cd backend-springboot && mvn clean package -DskipTests
cp target/app.jar ../web_engine/src/main/resources/resfile/resources/backend/app.jar
```

### ③ 改应用标识
```bash
# AppScope/app.json5       → bundleName 改成你的（com.xxx.xxx，与 AGC 一致）
# AppScope/.../string.json → app_name 改成应用名
# electron/src/main/resources/zh_CN/element/string.json → EntryAbility_label（桌面显示名）
# AppScope/resources/base/media/ → 替换图标
```

## 关键配置说明

### 权限（web_engine/src/main/module.json5，已精简）
| 权限 | 说明 |
|---|---|
| INTERNET / GET_NETWORK_INFO / RUNNING_LOCK / PREPARE_APP_TERMINATE / FILE_ACCESS_PERSIST / READ_PASTEBOARD | 基础权限，声明即生效 |
| **ALLOW_WRITABLE_CODE_MEMORY** | ★JIT 权限（应用内拉起 Java/JS 引擎需要）。system_basic 级，**需 ACL 邮件向华为申请**；未获批不影响形态 A 开发（终端启动），形态 B 需 -Xint 降级 |
| 其余 16 个（悬浮窗/目录/定位/相机等） | 已注释，**用到再启用**（取消注释 + ACL 申请；未获批保持注释否则签名不过） |

### main.js CONFIG（app/main.js 顶部）
```javascript
VIRTUAL_DOMAIN: 'app.localhost',   // 前端访问域名（webRequest 重定向到 127.0.0.1:8080）
BACKEND_PORT: 8080,                 // 后端固定端口
USE_EMBEDDED_BACKEND: false,        // ★后端形态：false=终端启动(开发)；true=应用内拉起(上架，需 JIT 权限)
EMBEDDED_JAVA: '/data/app/bin/java',// 形态 B 的 JDK 路径（HNP 打包后）
WINDOW: {
  frame: false,                     // ★★ 无边框：关掉系统标题栏与窗口边框（"模板窗口成了应用外框"的解法）
  startMaximized: true,             // ★★ 启动即铺满屏幕（首窗口尺寸另见 electron/src/main/module.json5）
},
DEV_DISABLE_WEB_SECURITY: false,    // 仅开发期兜底，上架必须 false（且鸿蒙上未必生效）
USE_APP_SCHEME: false,              // true=用 app:// 特权协议加载页面，让页面有真实 origin（跨域带 Cookie 前置条件）
```

### 窗口形态（鸿蒙 vs Windows 的关键差异）
- Electron 的 `frame` 在鸿蒙上映射为**系统窗口装饰**：`frame:true` → 系统标题栏 + 窗口边框出现（看起来像"模板窗口成了应用的外框"）。
  模板已改为 **`frame:false` + 页面自绘标题栏**（拖动区用 `-webkit-app-region: drag`，三键经 `preload.js` → IPC）。
- **首窗口的启动尺寸由 `electron/src/main/module.json5` 的 `ohos.ability.window.*` 决定**，`new BrowserWindow({width,height})` 对首窗口不生效。
- 想用系统三键：在 `loadFile/loadURL` 之前调 `win.setWindowButtonVisibility(true)`。

### 跨域 / 登录跳转（重要）
`webSecurity:false` 只是开发期兜底（官方列为风险参数），且在鸿蒙上未必生效；`file://` 页面的 Origin 是 `null`，**带 Cookie 的跨域/登录请求必然失败**。
自检页已加 `origin` chip：显示"origin=null ⚠️"就说明还没满足前置条件。完整分场景方案见根目录
**《鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md》**（含 XHR / 整页跳转 / 弹窗 / 自定义协议回调 / 证书五类场景与三件套解法）。

### SDK 版本（编译报错先查这里）
`build-profile.json5` 的 `compatibleSdkVersion` 模板值为 `5.0.3(15)` beta——**改成你 DevEco 安装的 SDK 版本**（如 `6.0.0(20)`），详见仓库根《Electron模板编译错误排查手册.md》。

## 构建与安装

```bash
# 1) DevEco Studio 打开本目录（File → Open）
# 2) 检查/修改 build-profile.json5 的 compatibleSdkVersion
# 3) File → Project Structure → Signing Configs → 自动签名（需登录华为账号）
# 4) Build → Build Hap(s)/APP(s) → 产物 electron/build/default/outputs/default/electron-default-unsigned.hap
# 5) 连接鸿蒙 PC（开发者模式）：
hdc list targets
hdc app install <签名后的hap>
```

## 链路自检（装好后）
打开应用 → 首页四个 chip 逐个变绿 + 自动请求 `http://app.localhost/api/ping`（经域名映射 → 127.0.0.1:8080）：
- `前端页面 ✅` / `页面 origin ✅`（若显示 `origin=null ⚠️`，说明页面还是 `file://`，跨域带 Cookie 必失败）
- `域名映射 ✅` / `后端服务 ✅`
- **形态 A（默认）**：需先在鸿蒙终端 `java -jar <backend>/app.jar`（demo jar 拷到用户目录），点按钮验证 /api/hello
- **形态 B**：改 `USE_EMBEDDED_BACKEND=true` + JDK HNP 打包（见仓库根实施手册 §5）后自动拉起
- 标题栏为**自绘**（无边框窗口）：按住标题栏可拖动窗口，右侧三键 = 最小化/最大化/关闭（经 `preload.js` → IPC）

## 版本与来源
- Electron 34（Chromium 132.0.6834.161 / Node v20.18.1）壳工程（官方模板社区镜像，缺失代码已修复，见仓库根《Electron模板缺失代码修复方案.md》）
- 官方 Release 包（正式开发建议核对）：`https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home?ref=electron34-release`
- ⚠️ libelectron.so（160MB）不随 git 上传：从本仓库 templates/ 目录拷贝，或从官方包提取
