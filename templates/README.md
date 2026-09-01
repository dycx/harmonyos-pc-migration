# 鸿蒙 Electron 壳工程模板（本地离线副本）

## 模板来源与版本

| 项目 | 内容 |
|---|---|
| 来源 | GitHub 社区镜像 `ohosvscode/ohos_electron_hap`（官方 ohos_hap 壳工程模板的社区镜像，与官方模板 README 逐字节一致） |
| 下载时间 | 2026-08-14 |
| **内置运行时版本** | **Electron 34（Chromium 132.0.6834.161 / Node.js v20.18.1）** —— 与官方版本矩阵的 E34 一致（从 `libelectron.so` 版本字符串核实） |
| 目录 | `ohos_electron_hap-main/`（188MB） |

## 目录结构

```
ohos_electron_hap-main/
├── AppScope/                  # 应用级配置（app.json5、资源）
├── chromium/                  # Chromium 模块
├── electron/                  # Electron 主模块（HAP 入口）
│   ├── libs/arm64-v8a/        # ★运行时 so：libelectron.so(160MB)/libadapter.so/libffmpeg.so/libc++_shared.so/libextractor.so
│   └── src/main/              # module.json5、resources（应用名/图标）
├── web_engine/                # Web 引擎模块（权限声明、资源承载）
│   └── src/main/resources/resfile/resources/app/   # ★你的 Electron 应用产物放这里（当前是示例 main.js）
├── hvigor/                    # 构建配置
├── build-profile.json5        # 工程构建配置
├── hvigorfile.ts              # 构建脚本
├── oh-package.json5           # 依赖配置
└── QUICKSTART.md / README.md  # 快速开始说明
```

## 使用方式（三步）

1. **DevEco Studio 导入**：File → Open → 选择 `ohos_electron_hap-main` 目录（不是新建工程）
2. **替换应用代码**：把 Electron 应用编译产物（`asar: false` 拆包后的全部文件 + package.json，**删除 devDependencies**）复制到 `web_engine/src/main/resources/resfile/resources/app/`
3. **构建安装**：Build → Build Hap(s)/APP(s) → Build Hap(s)，产物在 `electron/build/default/outputs/default/electron-default-unsigned.hap`；签名后 `hdc app install <hap路径>`

## 与官方预编译包的关系 / 模板下载地址（详细）

### 下载地址总表

| # | 来源 | 地址 | 账号要求 | 内容 | 备注 |
|---|---|---|---|---|---|
| ① | **华为云 CodeHub（官方 Release 包，Electron 34 分支）** | https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home?ref=electron34-release | **华为云账号**（登录后可下载 Release 产物） | `v34.8.1-20260429.1-release.zip`（2026-04，最新）或 `v34.6.3-20260105.1-release.zip`（E34 完整壳工程 + 运行时，数百 MB）；其他分支 `?ref=electron25-release` / `?ref=electron37-release` | **正式开发首选**（代码与 so 配套完整，无镜像缺失问题）；解压后 `libelectron_132/libelectron/ohos_hap` 即壳工程，用 DevEco 打开；完整指引见《Electron模板缺失代码修复方案》§0.1 |
| ② | **官方源码仓库（gitcode，OpenHarmony SIG）** | https://gitcode.com/openharmony-sig/electron | GitCode 账号（公开可浏览，clone 可选） | Electron 鸿蒙化主仓：README、docs/api（1294 API 索引）、HNP/子进程/三方库/升级等全部官方文档；壳工程在源码目录 `src/ohos/app/` | 需要配合源码编译产物使用；**文档资料最全** |
| ③ | **GitHub 社区镜像（本模板来源）** | https://github.com/ohosvscode/ohos_electron_hap | 无 | E34 壳工程 + 运行时（本目录即此来源） | 与官方模板 README 逐字节一致；zip 直链：https://codeload.github.com/ohosvscode/ohos_electron_hap/zip/refs/heads/main |
| ④ | **GitHub 社区镜像（同模板另一账号）** | https://github.com/ljlVink/ohos-cherrystudio-electron-base | 无 | 同上（README 逐字节相同，同一模板） | 备份渠道；zip 直链：https://codeload.github.com/ljlVink/ohos-cherrystudio-electron-base/zip/refs/heads/main |

### 推荐获取方式

1. **有华为云账号**（正式开发）：地址 ① 下载官方 Release 包，解压后用 DevEco Studio 导入（File → Open 选择工程目录）。
2. **无华为云账号/内网**（先跑通流程）：地址 ③（或 ④）git clone 或下载 zip，即本目录内容；运行时 `libelectron.so`（160MB，超 GitHub 限制未入库）从原机器拷贝，或对照地址 ① 获取官方包后替换。
3. **需要全部官方文档**：地址 ② clone 整个仓库留档（含 API 索引、HNP 指南、升级指南等，与 `research/` 目录互为补充）。

### 版本说明

- 本模板内置运行时：**Electron 34（Chromium 132.0.6834.161 / Node v20.18.1）**（从 `libelectron.so` 版本字符串核实）
- 官方版本矩阵（《Electron鸿蒙化调研报告》§2.4）：Electron 25（Chromium 114 / Node 18.18.2）、Electron 34（Chromium 132 / Node 20.18.1）、Electron 37（Chromium 138 / Node 22.16.0）
- ⚠️ 严谨起见：正式开发时建议从地址 ① 下载官方 Release 包核对/替换运行时，与本地模板保持一致或升级到更新版本

## 注意

- 仅 arm64-v8a（鸿蒙 PC 真机/2in1 设备），x86 模拟器不可用
- 运行时 .so 大（160MB+），HAP 包会较大，属正常
- 模板内置示例应用（`app/main.js`）为 Electron 25 声明（package.json 示例），**内置 so 实际为 E34**，以运行时为准
