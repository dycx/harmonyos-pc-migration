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

## 与官方预编译包的关系

- 本模板内置运行时与官方 E34（`v34.6.3-20260105.1-release.zip`，华为云 CodeHub）同源同版本（Chromium 132 / Node 20.18.1）
- ⚠️ 严谨起见：正式开发时建议从华为云 CodeHub（需华为云账号）下载官方 Release 包替换/核对运行时，链接：
  https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home
- 本副本价值：**无需华为云账号即可离线获得 E34 壳工程 + 运行时**，适合公司内网场景先跑通流程

## 注意

- 仅 arm64-v8a（鸿蒙 PC 真机/2in1 设备），x86 模拟器不可用
- 运行时 .so 大（160MB+），HAP 包会较大，属正常
- 模板内置示例应用（`app/main.js`）为 Electron 25 声明（package.json 示例），**内置 so 实际为 E34**，以运行时为准
