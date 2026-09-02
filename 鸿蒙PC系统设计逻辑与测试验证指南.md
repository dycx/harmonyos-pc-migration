# 鸿蒙 PC 系统设计逻辑与测试验证指南（进程管理 / 文件系统 / 应用管理）

> 面向从 Windows/Android 迁移的开发者。核心痛点：**应用数据在终端、文件管理器里"看不见"**——本文解释鸿蒙为什么这样设计（沙盒体系），并给出测试验证与问题定位的完整实操方法。
> 标注：✅ 官方确认｜🟡 需按版本/环境实测

---

## 0. 一句话结论（先读）

鸿蒙把"应用进程 + 应用数据"整体关进**独立沙箱**（独立的文件系统视图 + 进程命名空间）——这是**刻意的安全设计**，不是 bug：
- 应用视角的 `/data/storage/el2/base/files/xxx` **不是**系统终端的真实路径（终端看不到是正常的）
- 数据真实物理位置在 `/data/app/el2/100/base/<包名>/...`，普通 shell/文件管理器**无权限访问**
- **官方提供的查看通道**：`hdc shell -b <包名>`（进入该应用沙箱执行命令）、DevEco Device File Browser、应用自身导出
- 测试期请**放弃"从终端找文件"的思路**，改用第 5 章的沙箱感知工作流

---

# 第一部分：鸿蒙 PC 整体架构

## 1.1 分层（简版）

```
┌───────────────────────────────────────────┐
│ 应用层（HAP：ArkTS/JS/C++ 应用）           │
├───────────────────────────────────────────┤
│ 框架层（Kit：AbilityKit/ArkUI/NetworkKit…）│
├───────────────────────────────────────────┤
│ 系统服务层（AMS/文件服务/权限服务…）        │
├───────────────────────────────────────────┤
│ 内核层（微内核 + Linux 兼容层/驱动）        │
└───────────────────────────────────────────┘
```

## 1.2 三个"隔离"设计（理解鸿蒙的关键）

| 隔离 | 机制 | 效果 |
|---|---|---|
| **进程沙箱** | 每个应用进程运行在独立 mount/PID namespace + seccomp | 应用看不到系统全貌、其他应用 |
| **文件沙箱** | 应用只见 `/data/storage/el1|el2/...` 映射 | 应用数据互相隔离（第 3 章） |
| **权限模型** | 声明式权限（normal/basic/core 三级）+ 运行时授权 | 系统能力按需授予 |

> 类比：iOS 的沙盒 + Android 的 SELinux 加强版 + 桌面系统的多用户。Windows 上"装个软件就能读写整个磁盘"的模式在鸿蒙**不存在**。

---

# 第二部分：进程管理

## 2.1 应用进程模型

| 概念 | 说明 |
|---|---|
| **Ability 进程** | 每个应用（HAP）有独立的**主进程**（由系统按 Ability 启动）；UIAbility 通常运行在主进程 |
| **ExtensionAbility** | 部分扩展（如输入法/托盘等）可配置**独立进程**运行（`extensionAbilities` 配置） |
| **多实例** | `multiAppMode: multiInstance` 支持同一应用多进程实例（模板默认单实例） |
| **子进程** | 应用内 `spawn/fork` 出的进程 = 应用沙箱内的子进程（沙盒嵌套，权限受限——**JIT 默认被禁**，见专项文档） |
| **进程回收** | 系统按内存压力回收后台进程；`RUNNING_LOCK`（运行锁）可保后台持续运行（需声明权限） |

**进程树示意**：
```
system_server（系统服务）
└── app_process（应用进程宿主，每个应用一个）
    ├── ArkTS 主线程（UI/Ability）
    ├── Electron 运行时（若为 Electron 壳：Chromium 多进程模型——浏览器主进程/渲染/GPU）
    └── spawn 的子进程（如 java 后端，沙盒嵌套，JIT 受限）
```

## 2.2 后台与生命周期

- 鸿蒙 PC 上应用切后台后：任务保留（多任务视图），可被系统回收
- 需要常驻（如后端服务进程）：`RUNNING_LOCK` + 后台长时任务（`ohos.permission.RUNNING_LOCK`，模板已声明）
- ⚠️ Electron 壳工程注意：窗口关闭 ≠ 进程退出（托盘常驻模式，模板 main.js 已处理）；应用退出逻辑需显式 `app.quit()`

## 2.3 进程查看命令

```bash
# 查看设备上所有进程（宿主视角）
hdc shell ps -ef
# 过滤某应用进程
hdc shell ps -ef | grep <bundleName>
# 查看某应用进程详情（含沙箱 PID）
hdc shell ps -ef | grep <包名关键词>
# 查看命令可用性
hdc shell help -a          # 鸿蒙内核命令集（toybox 提供），与 Linux 有差异
```

## 2.4 进程与沙箱的对应（理解"看不到数据"的关键）

**每个应用进程有一个独立的文件系统视图**（mount namespace）：
- 应用进程内：`/data/storage/el2/base/files/` 指向自己的数据目录
- 系统 shell（hdc shell 无 -b 参数）：宿主视图，**看不到**应用 namespace 内的 `/data/storage/...`
- 这就是"终端里找不到应用数据"的根本原因——**不是数据丢了，是视角不同**

---

# 第三部分：文件系统（重点）

## 3.1 目录体系总览

| 分区/目录 | 性质 | 谁可写 |
|---|---|---|
| `/system` `/vendor` 等 | 系统分区 | **只读**（无 root 概念，普通用户不可改） |
| `/data/app/el1/bundle/public/<pkg>` | 应用安装包释放 | 系统 |
| `/data/app/el1\|el2/<userid>/base/<pkg>` | **应用数据（沙盒真实位置）** | 仅该应用 |
| `/data/service/...` | 系统服务数据 | 系统服务 |
| `/data/local/tmp` | 调试临时目录 | **hdc user 版可读写**（中转站） |
| 公共目录（Download/Documents/Desktop） | 用户可见 | 授权应用可读写（ACL + 授权） |

## 3.2 ★应用沙箱路径映射表（官方 README 原文 ✅）

应用进程内看到的路径（`/data/storage/...`）→ 真实物理路径：

| 应用沙箱路径 | 物理路径 | 说明 |
|---|---|---|
| `/data/storage/el1/bundle` | `/data/app/el1/bundle/public/<PACKAGENAME>` | 应用安装包目录（**只读**，含 resfile 释放的 resources） |
| `/data/storage/el1/base` | `/data/app/el1/<USERID>/base/<PACKAGENAME>` | el1 级加密数据（设备级，解锁前可访问） |
| `/data/storage/el2/base` | `/data/app/el2/<USERID>/base/<PACKAGENAME>` | el2 级加密数据（**用户级，应用主要数据区**） |
| `/data/storage/el1/database` | `/data/app/el1/<USERID>/database/<PACKAGENAME>` | el1 数据库目录 |
| `/data/storage/el2/database` | `/data/app/el2/<USERID>/database/<PACKAGENAME>` | el2 数据库目录 |

（USERID 当前固定为 **100**）

**应用内常用子目录（getContext() API ↔ 路径）**：

| ArkTS API | 沙箱路径 | 用途 |
|---|---|---|
| `context.filesDir` | `/data/storage/el2/base/files` | 文件数据（Electron 的 userData 也在这） |
| `context.cacheDir` | `/data/storage/el2/base/cache` | 缓存（可清理） |
| `context.databaseDir` | `/data/storage/el2/base/database` | 数据库 |
| `context.preferencesDir` | `/data/storage/el2/base/preferences` | Preferences |
| `context.resourceDir` | `/data/storage/el1/bundle/.../resources` | 资源（只读，resfile 在这） |
| Electron `app.getPath('userData')` | `/data/storage/el2/base/files`（默认） | Electron 用户数据 |

## 3.3 各视角能看到什么（测试痛点根源）

| 视角 | 看到的路径 | 能否看到应用数据 |
|---|---|---|
| **应用进程内**（代码/日志打印） | `/data/storage/el2/base/files/xxx` | ✅ 自己的数据 |
| **hdc shell（无 -b）** | 宿主根视角 `/` | ❌ `/data/app/el2/100/base/<pkg>` 无权限（permission denied） |
| **hdc shell -b <pkg>**（API 15+） | **进入该应用数据目录** | ✅ 可读可写（前提：**可调试应用** = debug 签名安装） |
| **鸿蒙 PC 终端/文件管理器** | 用户公共目录 | ❌ 应用沙盒不可见（设计如此） |
| **DevEco Device File Browser** | 应用数据（可调试应用） | ✅ 官方 GUI |
| **root 视角** | 物理全路径 | ⚠️ 鸿蒙 NEXT 消费者设备无 root（hdc root 仅工程机/部分开发版） |

## 3.4 公共目录（用户可见区）

| 目录 | 沙箱外位置（文件管理器可见） | 应用访问 |
|---|---|---|
| Download | `/storage/Users/currentUser/Download` 等 | `READ_WRITE_DOWNLOAD_DIRECTORY`（ACL）+ 授权 |
| Documents | 同用户目录下 | `READ_WRITE_DOCUMENTS_DIRECTORY`（ACL）+ 授权 |
| Desktop | 同用户目录下 | `READ_WRITE_DESKTOP_DIRECTORY`（ACL）+ 授权 |

> **测试技巧**：需要"从文件管理器肉眼看到"的调试产物（截图、导出文件、日志）→ 让应用**主动写到公共目录**（授权后），这是唯一"用户可见"的落盘方式。Electron 侧用 `systemPreferences.requestDirectoryPermission()` 触发授权。

---

# 第四部分：应用管理

## 4.1 安装与卸载

```bash
hdc app install <xxx.hap>        # 安装（需签名：调试签名或发布签名）
hdc app uninstall <bundleName>   # 卸载（清除应用全部数据）
hdc list targets                 # 查看已连接设备
hdc shell aa start -a EntryAbility -b <bundleName>   # 启动应用
```

- 安装包（HAP）签名体系：**调试签名**（DevEco 自动生成，可用于 Device File Browser/-b 沙箱访问）vs **发布签名**（AGC，上架用）
- ⚠️ 可调试判定：`hdc shell -b` 与 Device File Browser 仅对**调试签名安装**的应用开放沙箱；release 签名应用沙箱对调试工具不可见（安全设计）

## 4.2 HAP 结构与安装释放

```
HAP（zip 结构）
├── module.json5 / resources / ets 产物…
├── libs/arm64-v8a/*.so        → 释放到安装包目录（应用只读）
└── resources/resfile/...      → resfile 资源随包释放（只读；Electron 前端/后端 jar 在此）
安装后：
  /data/storage/el1/bundle/<pkg>/entry/resources/resfile/...  （应用只读视角）
```

## 4.3 应用数据生命周期

| 操作 | 数据去向 |
|---|---|
| 卸载应用 | **沙盒数据全部清除**（el1/el2 base/database/cache） |
| 应用更新 | 数据保留（安装包目录替换） |
| 清缓存（系统设置） | el2/base/cache 清除 |
| 恢复出厂/换机 | 需云备份或迁移工具（无 root 直拷通道） |

⚠️ **测试提醒**：反复 `hdc app uninstall + install` 会清掉应用数据——需要保留数据验证时用**覆盖安装**（同签名同版本号或更高版本直接 install）。

## 4.4 权限与签名（与应用管理相关部分）

- 权限声明在 module.json5（详见《DevEcoStudio工程配置文件详解》）
- 权限分级决定授权方式：基础（声明即用）/按需（运行时弹窗）/ACL（system_basic+，邮件申请）
- 签名是"可调试性"的门槛：**测试请统一用调试签名安装**（否则沙箱工具不可用）

---

# 第五部分：测试验证与问题定位实操（痛点解决方案）

## 5.1 查看应用数据的官方通道（按推荐序）

### ① hdc shell -b <bundleName>（命令行进沙箱，✅ API 15+）

```bash
# 进入可调试应用的沙箱数据目录执行命令（单次）
hdc shell -b com.yourcompany.yourapp ls
hdc shell -b com.yourcompany.yourapp ls files
hdc shell -b com.yourcompany.yourapp cat files/logs/app.log

# API 26+：交互式会话（默认工作目录=应用数据目录根）
hdc shell -b com.yourcompany.yourapp
# 然后像普通 shell 一样：ls / cd files / cat xxx
```
**前提**：应用以**调试签名**安装（DevEco run 默认即是）。这是定位"数据在哪/有没有写对"的第一工具。

### ② DevEco Studio Device File Browser（GUI）

- DevEco → View → Tool Windows → Device File Browser（或连接设备后的文件浏览器）
- 选择已连接设备 + 应用 → 直接浏览应用沙箱目录（files/cache/database），可导出到本地
- ⚠️ 同样仅对**可调试应用**（部分版本仅 debug 包）

### ③ 应用主动导出到公共目录（用户可见）

```javascript
// Electron 渲染层/主进程：先申请目录权限，再写文件
// （Electron 鸿蒙版：systemPreferences.requestDirectoryPermission('documents')）
// 然后 fs.writeFile 到沙箱内路径即可；若要公共目录需配合 ACL 权限
```
ArkTS 侧：`fileIo` + 授权弹窗 → 写 Download 等 → **文件管理器可见**（适合截图/导出报告类调试产物）

### ④ hdc file recv（拉取到电脑，注意权限边界）

```bash
# ✅ 可拉取：/data/local/tmp 等 hdc 有权限的路径
hdc file recv /data/local/tmp/xxx.log ./

# ❌ 常见失败：直接拉应用沙箱路径（user 版 hdc 无权限）
hdc file recv /data/app/el2/100/base/<pkg>/files/xxx ./    # permission denied
```
**中转法**：应用把调试文件写到 `/data/local/tmp` 不可行（应用无该目录权限）——反向：把需要导出的文件由应用写到**公共目录**，再 `hdc file recv /storage/Users/currentUser/Download/xxx`（公共目录 hdc 一般可读，🟡 实测）。

### ⑤ 日志（看不到文件时的主力手段）

```bash
# 实时看某应用日志（hilog）
hdc shell hilog | grep <bundleName或关键词>
hdc shell hilog -x | grep xxx          # 退出时清缓冲
# 应用侧埋点：console.log/console.error（Electron 渲染层与主进程都会进 hilog）
# ArkTS 侧：hilog.info(0x0000, 'TAG', 'msg')
```
**日志规范建议**（解决"看不见"的工程手段）：
- 关键数据写入打点：`console.log('[data] 保存路径=', filePath)` → hilog 可查
- 错误全链路打点：catch 里必打 `error + stack`
- 启动阶段打点（应用是否起来、后端端口探测结果等）——模板 main.js 已示范 `[backend]` 前缀

### ⑥ 界面显示法（你已在用的方法）

自检页/调试页显示：当前路径、读写结果、后端状态——保留在正式版里做成"关于/诊断"页，测试和线上问题定位都好用（模板 renderer/index.html 已示范）。

## 5.2 问题定位工作流（建议固化）

```
现象（页面报错/功能异常）
  │
  1. hilog 看应用日志（5.1⑤）—— 80% 问题在此定位（JS 异常/网络失败/权限拒绝）
  │
  2. 需要看落盘数据 → hdc shell -b <pkg>（5.1①）ls/cat 沙箱目录
  │      ├─ 文件在 → 数据问题（内容/路径）→ 用 ① cat 或 ② 导出
  │      └─ 文件不在 → 写入逻辑问题 → 回 1 看日志
  │
  3. 需要肉眼确认 → 应用导出到公共目录（5.1③）文件管理器查看
  │
  4. 网络类问题 → hdc fport 端口转发 + 本地抓包工具（5.3）
```

## 5.3 常用调试命令速查

```bash
# 设备与安装
hdc list targets                      # 设备列表
hdc app install app.hap               # 安装
hdc app uninstall com.xxx             # 卸载
hdc shell aa start -a EntryAbility -b com.xxx   # 启动
hdc shell aa force-stop com.xxx       # 强停（杀进程）

# 进程
hdc shell ps -ef | grep com.xxx       # 找进程 PID

# 沙箱（★调试签名应用）
hdc shell -b com.xxx ls               # 进应用数据目录执行
hdc shell -b com.xxx cat files/xxx.log

# 文件
hdc file recv /data/local/tmp/x ./    # 拉取（限 hdc 有权限路径）
hdc file send ./x /data/local/tmp/    # 推送（限 /data/local/tmp 等）

# 日志
hdc shell hilog                       # 全量日志
hdc shell hilog | grep KEYWORD        # 过滤

# 网络调试
hdc fport tcp:9229 tcp:9229           # 端口转发（Electron 主进程 --inspect 调试用）
hdc fport ls                          # 查看转发

# 系统信息
hdc shell param get const.product.name   # 设备名
hdc shell uname -a                       # 内核信息
```

## 5.4 常见"看不见"问题与对策

| 现象 | 原因 | 对策 |
|---|---|---|
| 终端 ls 找不到应用目录 | 沙箱隔离（宿主视角无权限） | `hdc shell -b <pkg>`（调试签名） |
| hdc file recv 报 permission denied | user 版 hdc 权限边界 | 走 -b 通道/公共目录中转/DevEco 浏览器 |
| nsenter 进沙箱 Permission denied | user 版无权限 | 不要用 nsenter，用官方 `-b` 参数 |
| Device File Browser 看不到数据 | 应用为 release 签名（非可调试） | 测试期统一调试签名；或 DevEco run 部署 |
| 卸载重装后数据没了 | 卸载清沙盒 | 覆盖安装保留数据 |
| 日志里中文乱码 | 编码问题 | 打印前 UTF-8 处理（Java 侧 -Dfile.encoding=UTF-8） |
| 写文件成功但"找不到" | 写进了沙箱内（用户不可见区） | 需要用户可见 → 写公共目录 + 授权 |

---

# 第六部分：附录

## 6.1 术语速查（本文相关）

| 术语 | 含义 |
|---|---|
| el1/el2 | 加密层级：el1 设备级（解锁前可访问），el2 用户级（应用数据主区） |
| USERID | 多用户 ID（当前固定 100） |
| 可调试应用 | 调试签名安装的应用（沙箱对调试工具开放） |
| resfile | HAP 内资源文件（安装释放，只读） |
| hdc | HarmonyOS Device Connector（调试连接工具） |
| toybox | 鸿蒙 shell 命令集（类 BusyBox） |
| RUNNING_LOCK | 运行锁（后台常驻） |

## 6.2 参考

- hdc 官方文档（含 `-b` 沙箱参数）：https://device.harmonyos.com/cn/docs/apiref/harmonyos-guides/hdc
- DevEco Device File Explorer（GUI 沙箱浏览）：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-device-file-explorer
- 官方 README 沙箱路径表（本仓库 research/rawgitcode_electron_readme.md）
- 沙盒取文件社区讨论：https://bbs.itying.com/topic/67e1b958687c4e0048a856ca

*本文基于官方文档与社区实测整理；`-b` 沙箱访问与 Device File Browser 的可用性取决于应用签名类型与系统版本，请以你的真机实测为准。*

---

# 附录 A：Electron 应用各类数据「写在哪 / 怎么验证」对照清单

> 针对本仓库迁移项目的具体数据类型，给出：写入方式 → 沙箱路径 → 物理路径 → 验证命令。
> 沙箱内路径以 Electron userData 默认映射为准（= el2/base/files）；后端形态 A（终端启动）数据在用户目录，形态 B（应用内拉起）数据在应用沙箱。

## A.1 前端 Electron（运行在应用沙箱内，✅ 路径官方 README 确认）

| 数据类型 | 写入方式（代码） | 沙箱路径 | 物理路径 | 验证命令（hdc shell -b） |
|---|---|---|---|---|
| Electron userData（配置/本地存储/localStorage） | `app.getPath('userData')` | `/data/storage/el2/base/files` | `/data/app/el2/100/base/<pkg>/files` | `hdc shell -b <pkg> ls files` |
| 前端日志（console 输出） | `console.log/error` | 不进文件，进 hilog | — | `hdc shell hilog -x -e <关键词>` |
| 渲染层 IndexedDB/缓存 | Chromium 默认 | `el2/base/files/<app>/IndexedDB` 等 | 同上 | `hdc shell -b <pkg> find files -name "*IndexedDB*"` |
| 下载/导出文件（用户可见） | 写公共目录（需授权） | — | `/storage/Users/currentUser/Download` 等 | 文件管理器直接看；`hdc file recv` 可拉 |
| Electron 崩溃转储 | `app.getPath('crashDumps')` | `el2/base/files/Crashpad` 等 | 同上 | `hdc shell -b <pkg> ls files` |
| 前端包内资源（只读） | resfile | `/data/storage/el1/bundle/.../resfile/resources/app` | `/data/app/el1/bundle/public/<pkg>/...` | `hdc shell -b <pkg> ls`（可见 resfile？🟡实测，通常只读） |

## A.2 后端 Java（形态 A：终端启动 = 用户目录；形态 B：应用沙箱）

| 数据类型 | 写入方式 | 形态 A 路径（终端/用户目录） | 形态 B 沙箱路径 | 验证命令 |
|---|---|---|---|---|
| 后端日志（logback/log4j） | `logging.file.path` | `<用户目录>/backend/logs/`（终端可见） | `/data/storage/el2/base/files/logs` | A：`hdc file recv`/终端 cat；B：`hdc shell -b <pkg> cat files/logs/xxx.log` |
| 数据库（H2 等） | JDBC URL 指定 | `<用户目录>/backend/db/` | `/data/storage/el2/base/files/db/`（或 database/） | 同上对应 |
| 配置文件/证书 | 随 jar 或显式路径 | `<用户目录>/backend/certs/` | `el2/base/files/certs/`（或 resfile 只读拷贝） | 同上 |
| 打点/运行数据 | 代码写文件 | 用户目录 | 沙箱 files | 同上 |
| stdout/stderr | 控制台 | 终端可见 | 被 Electron spawn 捕获 → 主进程 console → hilog | `hdc shell hilog -x -e backend` |

## A.3 C++ 工具输出

| 数据类型 | 说明 | 验证 |
|---|---|---|
| stdout | spawn 捕获 → Electron 主进程日志 → hilog | `hdc shell hilog -x -e <关键词>` |
| 输出文件 | 工具自身写文件路径需显式传入沙箱/用户目录路径（HNP 进程无默认工作目录概念） | 按 A.1/A.2 对应路径验证 |

## A.4 测试验证速查（按数据类型）

```bash
# 1) 先确认进程在跑（形态 B 后端）：
hdc shell ps -ef | grep java          # 或 grep <pkg>

# 2) 后端日志（形态 B）：
hdc shell -b com.yourcompany.yourapp cat files/logs/spring.log

# 3) 前端 userData（localStorage 等）：
hdc shell -b com.yourcompany.yourapp ls files

# 4) 数据库文件：
hdc shell -b com.yourcompany.yourapp ls files/db

# 5) 形态 A（终端启动）后端日志（用户目录，终端/hdc 可见）：
hdc shell ls /storage/Users/currentUser/   # 找你的部署目录（🟡 路径以实际用户目录为准）

# 6) 全链路日志一把梭：
hdc shell hilog -x -e 'backend|renderer|data'
```

## A.5 工程建议（避免"看不见"的三个约定）

1. **统一日志前缀**：前端 `[renderer]/[main]`、后端 `[backend]`、C++ `[tool]`——hilog 一条命令全过滤（模板已示范）。
2. **关键数据双通道**：重要运行数据（后端启动参数、数据库路径、端口）启动时打日志 + 诊断页展示（界面可见）。
3. **测试期固定调试签名**：保证 `hdc shell -b` 与 Device File Browser 可用；上架前再切发布签名做最终验证（发布签名下用诊断页 + hilog 兜底）。
