# Electron 鸿蒙模板编译错误排查手册

> 适用对象：下载官方/社区 Electron 鸿蒙壳工程模板后，在 DevEco Studio 导入编译报错的开发者
> 使用方式：**先看第 1 章"最可能的错误（按概率排序）"**；拿到具体报错后，用第 8 章"错误关键词速查表"快速定位；再按对应章节解决。
> 配套：《鸿蒙PC迁移实施手册.md》（第七部分工程配置）、《DevEcoStudio工程配置文件详解.md》
> 说明：本手册基于模板配置实测分析（2026-08 本地模板 `templates/ohos_electron_hap-main/`）+ 官方 FAQ + 社区案例整理。✅ 已确认｜🟡 需按你的实际环境核对

---

## 0. 模板真实配置速览（排查前提，先核对）

本地模板（GitHub 镜像，与官方模板同内容）的关键构建配置实测值：

| 配置项 | 模板实测值 | 你的环境应匹配 |
|---|---|---|
| `build-profile.json5` → `compatibleSdkVersion` | **`"5.0.3(15)"` + `compatibleSdkVersionStage: "beta6"`** | ⚠️ 与 DevEco 安装的 SDK 一致（官方示例要求 API 20+ / HarmonyOS 6.0.0+，见第 1 章） |
| `hvigor/hvigor-config.json5` → `modelVersion` | `"5.0.0"` | 与 DevEco 内置 hvigor 兼容（DevEco 6.x 可能需 5.1.x/6.x） |
| 工程级 `oh-package.json5` devDependencies | `@ohos/hypium: 1.0.6` | 需从 ohpm.openharmony.cn 下载（内网必失败） |
| `web_engine/oh-package.json5` dependencies | `inversify: ^6.0.1`、`reflect-metadata: ^0.1.13` | 需从 ohpm.openharmony.cn 下载（内网必失败） |
| `web_engine/oh-package.json5` devDependencies | `libadapter.so: file:./src/main/cpp/types/libadapter` | 本地路径，无需下载 |
| `electron/oh-package.json5` dependencies | `web_engine: file:../web_engine` | 本地路径，无需下载 |
| 运行时 so | `electron/libs/arm64-v8a/`（libelectron.so 160MB 等 5 个） | 缺 libc++_shared.so 时需从 SDK native 目录拷贝（官方 README） |

---

## 1. 最可能的错误（按概率排序，先看这里）

### 🔴 1.1 SDK 版本不匹配（最高概率）

**现象**（编译或安装阶段）：
- 构建报错：`compatibleSdkVersion and releaseType of the app do not match the apiVersion and releaseType on the device`（安装 HAP 到设备时）
- 或编译告警/报错：SDK 版本冲突（`compileSdkVersion`/`compatibleSdkVersion` 与 IDE 不一致）
- 或：工程同步失败，IDE 提示 SDK 版本无效

**原因**：模板声明 `compatibleSdkVersion: "5.0.3(15)"`（API 15，**beta6 阶段**），而：
- 你安装的 DevEco/SDK 是 6.x（API 20/21/23）——**版本向下兼容检查失败**
- 官方示例与最新模板要求 **API 20+ / HarmonyOS 6.0.0 Release / DevEco Studio 6.0.0+**（官方话题原话，✅）

**解决**（编辑工程根目录 `build-profile.json5`）：
```json5
{
  "app": {
    "products": [
      {
        "name": "default",
        "signingConfig": "default",
        "compatibleSdkVersion": "6.0.0(20)",   // ★改成你安装的 SDK 版本
        // "compatibleSdkVersionStage": "beta6", // ★删除或改为对应 stage（release 可整行删除）
        "runtimeOS": "HarmonyOS",
        "buildOption": { "nativeLib": { "collectAllLibs": true } }
      }
    ],
    // ... 其余保留
  }
}
```
⚠️ 版本号格式 `X.Y.Z(N)`，N 是 API 级别。**你的 SDK 版本怎么看**：DevEco → File → Project Structure → SDK Location（或 `sdk/default/openharmony/` 目录下的版本文件）。**不确定就打开一个 DevEco 新建的 HelloWorld 工程，照抄它的 compatibleSdkVersion。**

**关联问题**：若同时报 `useNormalizedOHMUrl can be true only when Compatible SDK Version is 5.0.0 (12) or later`，同样是 SDK 版本配置问题，改完 compatibleSdkVersion 即消失（官方 FAQ faqs-compiling-and-building-142）。

### 🔴 1.2 依赖下载失败（内网环境第二高概率）

**现象**：
- 构建报错：`ohpm install` 失败 / `Failed to resolve dependency: inversify` / `Error: ENOENT ... node_modules` / 网络超时
- 或：`ERR! code ENOENT`、`Can not find module 'inversify'`

**原因**：模板的 `web_engine` 模块依赖 `inversify`（DI 库）和 `reflect-metadata`（Reflect 元数据），工程级依赖 `@ohos/hypium`（测试框架）——lock 文件（✅ 已实测）显示全部从 **`https://ohpm.openharmony.cn/ohpm/...`** 下载。**公司内网/离线环境无法访问该域名 → ohpm 安装失败 → 编译失败。**

**解决**（三选一）：
```bash
# 方案 A：内网 ohpm 镜像（推荐，团队用）
# 在 ~/.ohpmrc 或工程 .ohpmrc 配置：
#   registry=https://<内网镜像>/ohpm/
# 然后重新 Sync（DevEco: File → Sync and Refresh Project）

# 方案 B：可联网机器预下载缓存，拷入内网
# 可联网机器执行：
ohpm install                       # 先生成 ~/.ohpm 缓存
# 把 ~/.ohpm 整个目录拷到内网开发机同位置，再 DevEco Sync
# （详见《鸿蒙PC迁移实施手册》第二部分 1.2 离线清单）

# 方案 C：跳过测试依赖（hypium 只用于 ohosTest）
# 若只是主工程编译，可把工程级 oh-package.json5 的 devDependencies 里的 hypium 注释掉：
"devDependencies": {
  // "@ohos/hypium": "1.0.6"      // 仅测试用，先注释
}
```
⚠️ `inversify`/`reflect-metadata` 是 web_engine 的**运行依赖**（适配层代码 import 了），不能注释，必须方案 A/B 解决。

### 🟡 1.3 hvigor 版本/模型不匹配

**现象**：
- `hvigor ERROR: Failed to load plugin '@ohos/hvigor-ohos-plugin'` 
- 或：`The hvigor version (X.X.X) does not match the modelVersion (5.0.0)`
- 或：`Unsupported modelVersion`

**原因**：`hvigor/hvigor-config.json5` 的 `modelVersion: "5.0.0"` 是模板创建时的 hvigor 模型；DevEco 6.x 内置 hvigor 版本可能不同（模型版本演进）。

**解决**：
```json5
// hvigor/hvigor-config.json5
{
  "modelVersion": "5.1.0",        // ★改为 DevEco 对应版本（不确定→新建 HelloWorld 工程照抄）
  "dependencies": {}
}
```
🟡 若报 `@ohos/hvigor-ohos-plugin` 版本问题：检查 `hvigor/hvigor-wrapper.js` 或工程级 `oh-package.json5` 是否声明了插件版本，DevEco 6.x 一般内置插件，删掉显式声明即可。

### 🟡 1.4 ArkTS 壳层源码与 SDK API 不匹配（autoStartupManager 类错误）

**现象**：
- 编译报错：`Cannot find name 'autoStartupManager'` / `Property 'xxx' does not exist on type 'yyy'`
- 位置在：`web_engine/src/main/ets/adapter/ElectronAppAdapter.ets` 等适配层文件

**原因**：模板适配层代码按旧 SDK API 编写，新版 SDK 中部分 API 改名/移动（如 `autoStartupManager` 从某 Kit 迁出）。这是**模板与 SDK 版本组合**问题——官方新 Release 包（华为云 CodeHub 的 v34.6.3 等）通常已适配新 SDK，GitHub 镜像可能滞后。

**解决**：
1. **优先**：换用华为云 CodeHub 官方 Release 包（与你的 SDK 版本配套的最新版），而不是旧镜像。
2. 若必须用当前模板：按报错位置**注释或改写**对应 API 调用（如 `ElectronAppAdapter.ets` 中 autoStartupManager 相关代码块注释掉，等适配方案明确再恢复）。⚠️ 改前先确认该能力是否被你的业务用到（autoStartupManager = 开机自启/常驻管理，多数应用用不到）。
3. 检索该 API 在新 SDK 的替代（DevEco 内按 F1 看 API 文档）。

### 🟡 1.5 TS 类型错误（electron.d.ts 相关）

**现象**：`TS2339: Property 'requestSystemPermission' does not exist on type 'SystemPreferences'`、`TS2367`（平台枚举比较）等。
**原因**：业务代码用的是开源 Electron 的类型声明，鸿蒙版新增 API 不在其中（《Electron鸿蒙化调研报告》§2.2 五步法）。
**解决**：把鸿蒙版 `electron.d.ts` 替换业务工程的类型声明（官方迁移 FAQ 标准做法）：
```bash
# 从官方仓库/Release 包取鸿蒙版 electron.d.ts：
#   <release包>/.../src/electron/electron.d.ts
# 覆盖业务工程 node_modules/electron/electron.d.ts
# 或用 patch-package 固化，避免 npm install 后丢失
```
（完整 TS 错误对照表见《鸿蒙PC迁移实施手册》第三部分 1.4）

### 🟡 1.6 签名相关错误

**现象**：
- `hap-sign-tool` 报错 / `Signing failed`
- 安装时报 `The target device does not work with apps with an OpenHarmony signature. Sign the app with a HarmonyOS signature`（OpenHarmony 设备 vs 商用 HarmonyOS 签名体系差异，✅ 官方论坛确认）

**解决**：
1. 中文路径：**工程路径、签名材料路径、输出路径都不能含中文**（hap-sign-tool 解析问题，上架实录确认）。
2. 调试签名：DevEco → File → Project Structure → Signing Configs → 勾选 Automatically generate signature（需登录华为账号）。
3. OpenHarmony 签名 → HarmonyOS 签名：申请 HarmonyOS 证书（AGC），在签名配置里换成 HarmonyOS 的 p12/cer/p7b。
4. ACL 权限未获批导致签名失败：先注释掉 `module.json5` 里的 ACL 权限（详见《配置详解》§4）。

### 🟡 1.7 native so 相关问题

**现象**：
- 模拟器安装报错：`code:9568347, error: install parse native so failed`
- 运行崩溃：找不到 `libc++_shared.so`
- 仅 arm64：x86 模拟器无法安装/运行

**解决**：
1. **模拟器基本不可用**（官方确认支持差）：Electron 壳工程是 **arm64-v8a only**，x86 模拟器装不了——**直接用鸿蒙 PC 真机调试**（《Electron鸿蒙化调研报告》§4.3）。
2. `libc++_shared.so` 缺失：从 HarmonyOS SDK native 目录拷贝到 `electron/libs/arm64-v8a/`：
   ```
   <SDK>/native/llvm/lib/aarch64-linux-ohos/libc++_shared.so
   → electron/libs/arm64-v8a/libc++_shared.so
   ```
3. 白屏（真机/模拟器）：预编译包默认禁硬件加速；模拟器黑屏加 `--disable-gpu`（见实施手册调试章）。

### 🟡 1.8 环境版本错误

**现象**：`JDK version mismatch`、DevEco 打不开工程/同步失败。
**解决**：DevEco 构建要求 **JDK 17**（官方 FAQ：非 17 导致编译失败）；DevEco 版本 ≥6.0.0（模板要求 API 20+/DevEco 6.0.0+）。检查 DevEco 自带 JBR 或系统 JAVA_HOME。

---

## 2. 排查流程（决策树）

```
拿到编译错误
│
├─ 错误含 "compatibleSdkVersion" / "apiVersion" / "releaseType"
│    → 第 1.1 节（改 build-profile.json5）
│
├─ 错误含 "ohpm" / "resolve" / "ENOENT" / "Can not find module" / 网络超时
│    → 第 1.2 节（依赖下载，内网镜像/离线包）
│
├─ 错误含 "hvigor" / "modelVersion" / "plugin"
│    → 第 1.3 节（hvigor 版本）
│
├─ 错误含 "Cannot find name" / "Property ... does not exist"（位置在 web_engine/electron 的 ets 目录）
│    → 第 1.4 节（壳层 API 适配）
│
├─ 错误含 "TS2339" / "TS2367" / "TS2345" 等 TS 编号
│    → 第 1.5 节（electron.d.ts 替换 + 实施手册 TS 对照表）
│
├─ 错误含 "sign" / "hap-sign-tool" / "signature"
│    → 第 1.6 节（签名）
│
├─ 错误含 "native so" / "parse native" / "libc++"
│    → 第 1.7 节（so/模拟器）
│
├─ 错误含 "JDK" / "version"
│    → 第 1.8 节（环境版本）
│
└─ 其他/不确定
     → 第 3 章"需要你贴出错误信息的姿势" + 第 8 章关键词表
```

---

## 3. 拿到错误信息后如何快速定位（给排查者的模板）

把完整错误贴给我时，尽量包含：
1. **错误发生的阶段**：Sync 同步 / Build Hap / 安装到设备 / 运行
2. **完整错误文本**（Build 窗口 + `View → Tool Windows → Build Output` 或 Terminal 里 `hvigorw` 输出）
3. **DevEco 版本 + SDK 版本**（Help → About；File → Project Structure）
4. **是否内网环境**（能否访问 ohpm.openharmony.cn）
5. **模板来源**（华为云 CodeHub 官方包 / gitcode 官方仓 / GitHub 镜像）

---

## 4. 模板自检清单（还没报错/想预防，先过一遍）

```bash
# 1) SDK 版本：build-profile.json5 的 compatibleSdkVersion 与 DevEco 一致（第 1.1 节）
# 2) 依赖：能访问 ohpm.openharmony.cn，或已配镜像/离线缓存（第 1.2 节）
# 3) 运行时 so 完整：electron/libs/arm64-v8a/ 下 5 个文件（含 libc++_shared.so）
# 4) 签名：自动签名已配置（登录华为账号）
# 5) 路径：工程路径无中文、无空格
# 6) JDK：DevEco 构建 JDK = 17
# 7) 真机：鸿蒙 PC/2in1（arm64），不是 x86 模拟器
```

---

## 5. 已知模板组合问题（来源备注）

| 组合 | 问题 | 状态 |
|---|---|---|
| GitHub 镜像模板 + DevEco 6.x SDK | SDK 版本 5.0.3(15) 不匹配（1.1）+ 壳层 API 可能滞后（1.4） | 🟡 建议改用官方 Release 包 |
| 官方 v34.6.3 Release + DevEco 6.0+ | 官方配套，最稳 | ✅ 首选 |
| 任何模板 + 内网无 ohpm | 依赖解析失败（1.2） | ✅ 有解（镜像/离线包） |
| 模板 + OpenHarmony 设备 | 签名体系差异（1.6） | ✅ 有解（HarmonyOS 证书） |

---

## 6. 官方资源（需要联网时用）

- 官方源码仓（含 docs、Release 说明）：https://gitcode.com/openharmony-sig/electron
- 官方 Release 包（华为云 CodeHub，需账号）：https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home
- 华为官方 FAQ：
  - SDK 版本不匹配：https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs-V14/faqs-app-debugging-22-0000001940675226-V14
  - build-profile 配置错误：https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs-V5/faqs-project-management-2-V5
  - useNormalizedOHMUrl 错误：https://developer.huawei.com/consumer/en/doc/harmonyos-faqs/faqs-compiling-and-building-142
- 本地模板副本：`templates/ohos_electron_hap-main/`（含 lock 文件可核对依赖版本）

---

## 7. 常见问题 FAQ

**Q1：改了 compatibleSdkVersion 后 Sync 又恢复原值？**
A：确认改的是**工程根目录** build-profile.json5（不是模块目录下的）；改后 File → Sync and Refresh Project。

**Q2：报错信息里有 "ArkTS" 字样，是不是代码问题？**
A：ArkTS 是鸿蒙的 TS 超集。壳层 ets 文件报错多为 API 版本问题（1.4）；业务代码报错多为类型问题（1.5）。先看文件路径判断是壳工程还是你的业务代码。

**Q3：为什么别人能编译过，我报错？**
A：大概率是环境差异：SDK 版本（1.1）、依赖网络（1.2）、JDK 版本（1.8）。先跑第 4 章自检清单。

**Q4：构建过了但安装失败（parse native so failed）？**
A：真机检查（arm64 + HarmonyOS 6.0+）；模拟器基本不支持（1.7）。

**Q5：每次 Sync 都慢/卡？**
A：首次 Sync 会下载 hvigor 依赖；内网环境配置镜像后做一次全量 Sync 缓存（1.2 方案 B）。

---

## 8. 错误关键词速查表

| 错误信息关键词 | 章节 | 一句话解法 |
|---|---|---|
| `compatibleSdkVersion` / `apiVersion` / `releaseType` / `do not match` | 1.1 | build-profile.json5 改 SDK 版本 |
| `useNormalizedOHMUrl` | 1.1 | 同上 |
| `Incorrect settings found in the build-profile.json5` | 1.1/1.3 | 检查 build-profile 格式与 SDK 版本 |
| `ohpm` / `Failed to resolve` / `ENOENT` / `Can not find module` / `404` | 1.2 | 依赖下载：镜像/离线包 |
| `hvigor` / `modelVersion` / `Failed to load plugin` | 1.3 | hvigor-config.json5 版本对齐 |
| `autoStartupManager` / `Cannot find name`（ets 文件） | 1.4 | 壳层 API 适配（注释/换官方包） |
| `TS2339` / `TS2367` / `TS2345` / `TS2554` / `TS2346` | 1.5 | 换鸿蒙版 electron.d.ts |
| `hap-sign-tool` / `Signing failed` / `signature` | 1.6 | 签名配置/中文路径/证书类型 |
| `parse native so failed` / `code:9568347` | 1.7 | 换真机（arm64） |
| `libc++_shared.so` | 1.7 | SDK native 目录拷贝 |
| `JDK` / `version mismatch` | 1.8 | DevEco 构建 JDK 用 17 |

---

*本手册基于 2026-08 模板实测配置与公开资料整理；拿到你的具体报错后，按第 3 章格式补充信息即可精确定位。*
