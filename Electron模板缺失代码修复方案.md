# Electron 鸿蒙模板「代码缺失」修复方案（StringUtil / so 导出）

> 针对两个编译错误的完整修复：① `StringUtil.filterFileDocs` 方法未定义；② `so export 的方法找不到`。
> 根因（✅ 已核实）：**GitHub 社区镜像模板提交的代码不完整**——GitHub issue #3（ohosvscode/ohos_electron_hap）原帖错误列表与本问题逐条一致，作者回复确认"提交的代码是不完整的，哪些成员根本你没提上来"。模板的 `.so` 运行时（libadapter.so，版权归属海泰方圆）与其 ArkTS 源码存在**版本不匹配/声明缺失**。

---

## 0. 修复总策略（先读）

| 策略 | 做法 | 适用 |
|---|---|---|
| **A. 换官方完整 Release 包（推荐，一劳永逸）** | 从华为云 CodeHub 下载官方 Release 包（代码与 so 配套完整，见下方"官方包下载指引"），替代当前镜像模板 | 有华为云账号、正式开发 |
| **B. 手工补齐缺失声明（本手册主体）** | 按第 1-2 章补全 5 处缺失代码，让当前模板编译通过 | 无账号/内网/先跑通流程 |

> 本手册给出策略 B 的完整补丁（可直接复制粘贴）。若你后续拿到官方包，这些补丁可作参考对比。

---

## 0.1 官方包下载指引（策略 A 具体操作）

**下载入口（Electron 34 Release，官方 CodeHub 仓库）**：
```
https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home?ref=electron34-release
```

**操作步骤**：
1. 用**华为云账号**登录上述链接（未登录会跳转 `auth.huaweicloud.com` 认证页；个人可免费注册）。
2. 在仓库 Releases/产物区下载形如 **`v34.8.1-20260429.1-release.zip`**（2026-04 版，教程实测所见）或 **`v34.6.3-20260105.1-release.zip`**（2026-01 版）的文件——**取最新日期版本**。
3. 解压后目录结构（教程实测）：
   ```
   v34.8.1-20260429.1-release/
   └── libelectron_132/
       └── libelectron/
           └── ohos_hap/        ← ★用 DevEco Studio 打开这个文件夹（File → Open）
   ```
4. DevEco 打开 `ohos_hap` 后：检查 `build-profile.json5` 的 `compatibleSdkVersion` 与你的 SDK 一致（见《编译错误排查手册》§1.1）、配置自动签名、Sync。

**版本矩阵（CodeHub 提供三档，按需选）**：

| Electron | Chromium | Node.js | 说明 |
|---|---|---|---|
| 25 | 114 | 18.18.2 | 老版本 |
| **34（推荐）** | 132 | 20.18.1 | 稳定与兼容兼顾，教程推荐 |
| 37 | 138 | 22.16.0 | 最新（2025-10 SIG 获批） |

> ⚠️ 若 34 分支的 ref 链接进不去，可在 CodeHub 项目主页找其他 release 分支（`?ref=electron25-release` / `?ref=electron37-release`），或查看仓库 Release 列表。具体文件名/日期以页面实际发布为准。
> ⚠️ 模拟器注意：Electron 鸿蒙模拟器目前仅支持 **ARM 架构 Mac**；Windows 用户请用鸿蒙 PC 真机调试。

---

## 1. 错误一修复：StringUtil.filterFileDocs 未定义

### 1.1 错误与根因

```
ArkTS:ERROR File: web_engine/src/main/ets/adapter/PasteBoardApadter.ets:255:33
  Property 'filterFileDocs' does not exist on type 'typeof StringUtil'
```

`PasteBoardApadter.ets`（读剪贴板文件 URI）调用了 `StringUtil.filterFileDocs(uri)`，但 `StringUtil.ts` 只定义了 `uriConvert(docs: string[]): string[]`——**`filterFileDocs` 方法缺失**（GitHub issue #3 错误第 4 条，逐字一致）。

### 1.2 修复（编辑 `web_engine/src/main/ets/utils/StringUtil.ts`，在 `uriConvert` 方法后追加）

```typescript
  // ★补丁：readPasteBoardURI 依赖的缺失方法（单个文件 URI → 路径字符串）
  static filterFileDocs(uri: string): string {
    // 处理中文乱码 + URI → 系统路径（与 uriConvert 同一逻辑，单值版）
    let path = decodeURI(uri);
    let fileUriObj = new fileUri.FileUri(path);
    return fileUriObj.path;
  }
```

> 依据：调用处 `fileData = StringUtil.filterFileDocs(recordData.uri)`（uri 为 string，返回值赋给 string）；逻辑与既有 `uriConvert` 一致（decodeURI + FileUri.path）。

---

## 2. 错误一修复（同批）：CommonInterface 缺失声明

GitHub issue #3 的同批错误还有 4 处（**编译时一起报**，一并修复）：

```
1. BatteryAdapter.ets:35   Module '"../interface/CommonInterface"' has no exported member 'BatteryInfo'
2. OcrAdapter.ets:32       has no exported member 'OcrAdapterImage'
3. OcrAdapter.ets:32       has no exported member 'TextWord'
4. PowerMonitorAdapter.ets:62/65/69  Property 'PowerMonitor' does not exist on type 'NativeContext'
```

### 2.1 修复（编辑 `web_engine/src/main/ets/interface/CommonInterface.ts`）

**① 文件顶部 import 区追加**（TextWord 复用 SDK OCR 类型，需按你的 SDK 调整包名）：

```typescript
// 已存在的 import 保持不变，追加：
import type textRecognition from '@kit.CoreVisionKit';   // ⚠️ API 版本不同包名可能为 @ohos.ai.ocr 等，按你的 SDK 调整
```

**② 在 `export interface WindowBound { ... }` 之后追加 BatteryInfo**（字段已从 BatteryAdapter 用法逐项核实）：

```typescript
export interface BatteryInfo {
  batterySOC: number;
  chargingStatus: number;
  isBatteryPresent: boolean;
  estimatedRemainingChargeTime: number;
  nowCurrent: number;
  remainingEnergy: number;
}
```

**③ 追加 OcrAdapterImage**（字段已从 convertImagePixelMap 实现核实：`requestImage.width/height/buff`）：

```typescript
export interface OcrAdapterImage {
  width: number;
  height: number;
  buff: ArrayBuffer;
}
```

**④ 追加 TextWord**（OcrAdapter 中 `let word1: TextWord = word`，word 为 SDK 识别结果对象。**优先用类型别名**，编译不过换宽松接口）：

```typescript
// 方案 1（推荐）：直接复用 SDK 类型
export type TextWord = textRecognition.Word;

// 方案 2（备选，若方案 1 报类型不兼容）：宽松接口
// export interface TextWord {
//   value: string;
//   [key: string]: string | number | Object | undefined;
// }
```

**⑤ 追加 PowerMonitor 接口，并给 NativeContext 加成员**（用法已核实：`OnSuspend()/OnResume()/OnPowerStateChanged()`）：

```typescript
export interface PowerMonitor {
  OnSuspend: () => void;
  OnResume: () => void;
  OnPowerStateChanged: () => void;
}
```
在 `export interface NativeContext {` 内（任意位置）追加一行：
```typescript
  PowerMonitor: PowerMonitor;
```

### 2.2 修复后验证

重新 Sync + Build。若仍有缺失成员报错，说明你的模板版本还有其他遗漏：**按报错文件/行号，把缺失的类型/方法补到 CommonInterface.ts 或对应工具类**（模式同上：从调用处用法反推结构）。

---

## 3. 错误二：so export 的方法找不到

### 3.1 两种场景判定

| 场景 | 现象 | 原因 |
|---|---|---|
| **编译期** | ArkTS 报 `Cannot find ... in libadapter.so` / import 的模块没有导出成员 | `index.d.ts`（`web_engine/src/main/cpp/types/libadapter/index.d.ts`）**只声明了 `getNativeContext` 一个导出**（✅ 本地实测），若 ArkTS 代码直接调用 `adapter.其他方法()` 会报找不到；或 d.ts 与 so 实际注册的方法名不一致 |
| **运行期** | 应用启动/调用时崩溃：`dlopen failed` / `cannot locate symbol` / `napi_register_module` 失败 | libadapter.so 依赖的系统符号（`OH_CommonEvent_*`、`OH_Ability_*` 等，✅ nm 实测有 100+ 个 U 符号）在当前设备系统库中不存在——**so 编译 SDK 版本 > 设备系统版本**；或 so 与 ArkTS 代码版本不匹配（模板镜像的 so 与源码不同步） |

### 3.2 定位方法

```bash
# 1) 看 so 实际导出的 NAPI 注册符号（设备/开发机均可）：
nm -D electron/libs/arm64-v8a/libadapter.so | grep -i "napi\|Register"
#    期望看到：_ZN4ohos7adapter10life_cycle8RegisterEP10napi_env__P12napi_value__ 等注册入口

# 2) 核对 d.ts 声明 vs so 注册（编译期报错时）：
#    index.d.ts 只有 getNativeContext → 若代码还 import 了别的，先补 d.ts 声明
#    （注意：NAPI 方法名注册在 so 内部，动态符号表看不到方法名，属正常；方法是否可用需真机跑）

# 3) 运行期报 dlopen/符号错误时，检查设备系统版本 ≥ so 编译版本：
#    DevEco 安装包要求：API 20+ / HarmonyOS 6.0.0+（官方示例要求，✅）
```

### 3.3 解决

| 场景 | 解决 |
|---|---|
| 编译期缺声明 | 补 `index.d.ts`（把 ArkTS 用到的 native 方法声明补全）；或把调用改走 `getNativeContext()` 返回的 NativeContext 成员（第 2 章已补 PowerMonitor 等） |
| 运行期符号找不到 | **根本解法：换与设备系统版本配套的官方 Release 包**（模板镜像的 so 与代码/系统版本不匹配，手工修风险大）；临时可用 `app.disableHardwareAcceleration()` 类降级配置排查（预编译包默认带） |
| 分不清 | 先做第 3.2 的 nm 检查 + 真机最小运行验证（空壳 HAP 能否启动），确定是编译期还是运行期 |

---

## 4. 预防与根治建议

1. **优先换官方 Release 包**（策略 A）：官方包代码与 so 配套、版本明确（v34.6.3 = E34/Chromium 132/Node 20.18.1），GitHub 镜像（含本模板）是社区翻版，**已证实存在缺失**（issue #3）与版权混用（so 归属海泰方圆）。
2. **记录模板指纹**：换模板后记录 `libadapter.so` 的 sha256 + 源码 commit，出现"方法找不到"类错误时能快速判断是否版本错配。
3. 补齐后若遇到**新的**缺失成员：按第 2.2 节模式（调用处用法反推结构）补 CommonInterface，并把补丁回传仓库（本手册即补丁记录）。

---

## 5. 相关资源

- GitHub issue #3（同批错误原帖）：https://github.com/ohosvscode/ohos_electron_hap/issues/3
- 官方 Release 包（华为云 CodeHub）：https://devcloud.cn-north-4.huaweicloud.com/codehub/project/b19f5ea8ffd4492ea8c06ca2ebf3f858/codehub/2821214/home
- 本地模板位置：`templates/ohos_electron_hap-main/`（修复前先备份要改的 2 个文件）
- 排查手册：《Electron模板编译错误排查手册.md》

*本修复方案基于本地模板实测（StringUtil.ts / CommonInterface.ts / index.d.ts / nm 符号表）+ GitHub issue 原帖核实。字段结构均从调用处用法反推并标注依据；若你的模板版本不同，以报错行号为准按同模式补齐。*
