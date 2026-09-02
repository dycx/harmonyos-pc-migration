# 鸿蒙 PC 沙盒 JIT 与 so 加载限制：解决方案专项

> 针对实测发现的两个严重问题：① 沙盒内 **JIT 被禁止**（Java 后端 HotSpot JIT 无法使用）；② **加载 so 有严格限制**（SQLite native 库受影响）。
> 调研时间：2026-08-19（含 2026-08-11 实测文档、2026-08-19 官方 FAQ）
> 标注：✅ 已确认｜🟡 需实测/以申请结果为准｜⚠️ 风险

---

## 0. 结论速览

| 问题 | 机制 | 解法 | 风险 |
|---|---|---|---|
| **沙盒禁 JIT** | 鸿蒙沙盒默认**不允许映射可写可执行匿名内存**（W^X 策略），JIT 依赖它 → 沙盒内 JVM/V8 无法 JIT | ① 申请 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（system_basic，**仅 2in1/PC/平板**，ACL 渠道）；② **Java 后端用终端直接启动（命令执行器直接启动的进程有 JIT 权限）——绕开沙盒**；③ JVM `-Xint` 解释执行兜底 | 权限申请可能被拒（Chromium 场景反馈 system_core/白名单）；-Xint 性能降 5-10 倍 |
| **so 加载受限** | 沙箱管控：**非应用市场来源的 so/二进制需要二进制签名**；随 HAP 打包的 so（应用签名内）不受额外限制 | ① **sqlite native so 随 HAP 打包进 `libs/arm64-v8a/`**（应用签名内，与 addon 同机制）；② 外部 so 用官方**二进制签名工具**签名；③ **换 H2 纯 Java（零 so）彻底规避** | 重编译链路需实测；H2 需要 SQL 迁移 |

**架构结论（重要）**：你方案的**形态 A（终端 `java -jar` 启动后端）天然规避 JIT 限制**——沙盒只禁"fork 出的子进程"的 JIT，命令执行器直接启动的进程有 JIT 权限（✅ 2026-08-11 实测）。形态 B（应用内 HNP 拉起 JVM）是 fork 子进程 → **JIT 必被禁**，只能走权限申请或 -Xint。

---

## 1. 机制确认：鸿蒙沙盒为什么禁 JIT

### 1.1 沙盒 W^X 策略（✅ 多来源确认）

| 来源 | 内容 |
|---|---|
| 社区提问（itying，2026） | "鸿蒙手机版采用类似 iOS 的做法，**不允许应用映射可执行匿名内存**，且限制 fork+exec"——问 PC 版是否保留 |
| 实测文档（dsh-ohos-patch，2026-08-11，OpenHarmony arm64） | 沙箱（seccomp/安全模块）**拦截 `mmap(PROT_EXEC)`/`mprotect(PROT_EXEC)`** 分配；V8 崩溃 `Check failed: 12 == errno`；**只有命令执行器直接启动的进程有 JIT 权限，它 fork 的所有子孙进程都没有**（嵌套沙箱） |
| Qt/Electron 上架经验（CSDN，2026） | 权限 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` = "允许应用申请**可写可执行匿名内存**"，用于动态代码生成 |

**机理**：JIT 编译器（HotSpot C1/C2、V8、JSVM）需要把编译出的机器码写入**匿名可执行内存**（mmap RWX 或 W^X 切换）。鸿蒙沙盒默认禁止这一行为 → JIT 无法工作。**注意：文件映射的可执行段（.so 的 .text，RX）不受此限制**——所以 JVM 解释器、预编译代码都能运行，只有"运行时生成代码"被禁。

### 1.2 Java（HotSpot）受影响程度

- **解释执行**：不需要可写可执行内存 → **不受影响**（JVM 可以 -Xint 运行）
- **C1/C2 JIT**：需要代码缓存（CodeCache = 可写可执行内存）→ **沙盒内默认被禁**（用户实测确认）
- **GC/线程**：与 JIT 无关，不受影响
- 结论：JVM 本身能跑，但**默认开启的 JIT 在沙盒内不可用**——这正是用户实测看到的"JIT 被禁止"

---

## 2. 解法一：申请特殊权限 `ALLOW_WRITABLE_CODE_MEMORY`

### 2.1 权限信息（✅ 上架经验文核实）

| 项 | 内容 |
|---|---|
| 权限名 | `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` |
| 含义 | 允许应用申请**可写可执行匿名内存**（动态代码生成） |
| 权限级别 | system_basic |
| 授权方式 | system_grant（系统授权） |
| **设备范围** | **仅平板、PC/2in1 设备应用可申请**（✅ 正好是鸿蒙 PC 场景） |
| 适用场景 | 仅限**应用自带引擎的即时编译**（JIT：实时渲染、动态解析），**禁止用于热更新** |
| 特殊要求 | 需**主动适配坚盾模式**（避免闪退） |
| 已知问题 | 申请被拒后移除权限 → Chromium 视频播放提示"版本过低"（低版本内核无 JIT 的降级表现） |

### 2.2 申请路径

```text
1. APL 提升：普通应用 APL=normal；system_basic 权限需 ACL 申请
   → 邮件向华为申请（说明 bundleName、所需权限、用途：应用自带引擎 JIT）
2. 在 module.json5 声明：
```
```json5
"requestPermissions": [
  { "name": "ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY" }
]
```
```text
3. 适配坚盾模式（该模式默认禁 JIT；有权限的应用也需处理"坚盾开启时"的降级路径）
4. 真机验证：java -jar 启动后确认 HotSpot 打印 JIT 编译日志（-XX:+PrintCompilation）
```

### 2.3 ⚠️ 不确定性（务必以申请结果为准）

上架经验文"注意事项"原文："该权限实际属于 system_core 级别，普通应用无法申请，仅限预置系统应用或白名单授权应用使用"——与正文"system_basic"矛盾，**反映 Chromium（Electron）场景下实际授予可能更严**（白名单/预置通道）。对 Java 后端场景的授予情况**无公开案例**。因此：
- 申请了 ≠ 一定批：做好被拒预案（第 3 章）
- Electron 上架应用能跑 Chromium JIT（厨房里的化学等案例）→ 官方模板/上架通道可能已处理，可参照官方 Electron 模板的权限声明确认它是否声明了该权限

---

## 3. 解法二（Java 后端主路径）：终端直接启动 = 天然有 JIT

### 3.1 依据（✅ 实测文档核心结论）

> "**只有'命令执行器直接启动的那一个进程'有 JIT 权限，它 fork 的所有子孙进程都没有**。"

即：鸿蒙 PC 的**终端里直接运行 `java -jar app.jar`** 的 JVM 进程——由终端（命令执行器）直接启动 → **JIT 可用**；而由应用 fork/spawn 出来的进程（形态 B：HNP JDK 由 Electron 拉起）→ JIT 被禁。

### 3.2 对你架构的含义（重要更新）

| 后端形态 | JIT 可用性 | 说明 |
|---|---|---|
| **A. 终端 `java -jar` 启动（推荐不变）** | ✅ **JIT 可用** | 命令执行器直接启动；无需申请特殊权限 |
| B. HAP 内 HNP JDK 由应用拉起 | ❌ JIT 被禁 | fork 子进程；需权限申请或 -Xint |
| C. 融合开发引擎（openEuler 子系统） | ✅ JIT 可用 | Linux 子系统内，无此沙盒限制 |

**结论：形态 A 不只是"最稳"，在 JIT 层面也是唯一零门槛的本机后端路径——维持形态 A 作为后端运行方式，无需为 JIT 申请权限。**

形态 A 的操作（实施手册已有，此处强调）：
```bash
# 鸿蒙 PC 终端（开发者终端/应用市场 BiShengJDK17-OH 安装后）：
java -jar /data/storage/el2/base/files/backend/app.jar --server.port=8080
# 验证 JIT 生效：启动日志出现 "Using default compiler" 无异常；或 -XX:+PrintCompilation 观察编译输出
# （若在受限通道启动出现崩溃/无法 JIT，参考沙盒实测结论换通道）
```

### 3.3 兜底：-Xint 解释执行（若必须在沙盒内跑 JVM）

```bash
java -Xint -jar app.jar    # 完全禁用 JIT（C1/C2 均关）
# 或：-XX:-UseCompiler（等价）
```
- ✅ 不分配可写可执行内存 → 沙盒内可运行
- ⚠️ 性能：解释执行约为 JIT 的 1/5~1/10；SpringBoot 启动慢（可达分钟级）、高并发吞吐显著下降——**仅作沙盒内兜底，生产不推荐**
- 可选调优：`-XX:CompileThreshold` 无效（解释模式）；减少反射/动态代理使用；用 `-Xshare:auto` + CDS（JDK 12+ 默认开启 AppCDS 部分能力）缓解启动慢

### 3.4 AOT 预编译（探索性，不推荐生产）

JDK 17 `jaotc`（实验性）：把类预编译为 .so（.text 只读可执行 = 文件映射，不受 W^X 限制）→ 运行时加载。但：jaotc 覆盖有限（G1/部分场景）、与 SpringBoot 动态加载不匹配、维护成本高——**结论：不值得，用形态 A 或 -Xint**。

---

## 4. 解法三（Electron/前端侧说明）

- Electron 壳工程（Chromium V8）同样依赖 JIT：**前端 JS 性能在无权限时会显著下降**（V8 解释执行 + 无 WASM JIT）
- 官方 Release 模板是否已声明 `ALLOW_WRITABLE_CODE_MEMORY`：**检查你模板的 module.json5 权限列表**（有则随包声明；无则说明官方模板依赖其他机制或接受降级）
- 若前端业务强依赖 JS 性能/WebAssembly：走第 2 章权限申请；否则先跑通功能再优化

---

## 5. so 加载限制：机制与解决方案（SQLite 相关）

### 5.1 机制确认（✅ 官方 FAQ，2026-08-19 更新）

官方 FAQ《IDE应用调用插件包二进制及so文件的权限与签名要求》原文要点：
- "应用在 HarmonyOS 中运行时受到沙箱权限管控，**调用非应用市场的扩展程序或二进制可执行文件需要相应的权限和签名支持**"
- "插件包的来源无限制，**但是插件包中的二进制文件需要具备签名**"
- 工具：**二进制签名工具**（对二进制/so 签名）+ **申请二进制证书**（AGC）
- 弱沙箱权限 + 「设置-隐私和安全-运行来自非应用市场的扩展程序」开启后可拉起**已签名**二进制

**推论（对 sqlite 场景）**：
1. **随 HAP 打包的 so（`libs/arm64-v8a/`）在应用签名体系内 → 正常加载**（Electron 的 libadapter.so/libelectron.so 与官方 sqlite3 addon 示例即此路径）
2. **运行期外部带入的 so**（沙箱 files 目录、运行时下载/解压）→ **默认禁止，需二进制签名 + 证书**（类似 XPM 对 ELF 的管控延伸到 so）
3. Java `System.loadLibrary` 加载的 so 属于"进程内加载"——其 so 文件若在应用签名目录内应可行；在外部目录则受管控

### 5.2 解决方案（按推荐序）

| 方案 | 做法 | 适用 | 风险 |
|---|---|---|---|
| **① sqlite so 随 HAP 打包（首选）** | sqlite-jdbc native 源码用鸿蒙工具链交叉编译（aarch64-linux-ohos）→ 产物放 `electron/libs/arm64-v8a/` → Java `-Djava.library.path` 指向沙箱内该目录 | Java 后端必须 SQLite | 重编译工程量大、无公开案例（JNI + JVM 加载链路需实测） |
| **② 外部 so 用二进制签名工具** | 编译后对 so 做二进制签名（申请二进制证书）→ 放入沙箱目录加载 | so 无法随包时 | 签名链路新、需实测 |
| **③ 换 H2 纯 Java（推荐，零 so）** | 数据库层换 H2（`MODE=SQLite`），**无任何 native 依赖** → 完全规避 so 加载限制 | 可接受 SQL 迁移 | SQL 方言差异（实施手册已有对照表） |
| **④ Node 侧 node-sqlite3** | Electron 主进程用官方适配的 node-sqlite3 addon（随 HAP 打包，官方示例路径） | 数据库访问可移到 Node 侧 | 架构改造大 |

**结论：Java 后端用 SQLite 的两条可行路 = ①（重编译随包，探索性）或 ③（H2 迁移，稳妥）。** 若你实测发现 sqlite-jdbc 的 so 即使随包也无法被 JVM 加载（JNI 链路问题），**直接走 ③**。

---

## 6. 对整体方案的影响与更新

1. **后端运行形态定案：形态 A（终端启动）**——同时解决 JIT 权限问题（终端进程有 JIT）与 so 加载问题（不涉及沙盒内 JVM 加载 so 的未知链路），维持实施手册推荐不变；形态 B 降级为"探索项"（需权限申请 + JIT 不可用时 -Xint）。
2. **SQLite 决策前置**：若后端数据量/场景允许，**优先 H2**；坚持 SQLite 则投入 sqlite-jdbc 重编译 PoC（预算 1-2 周，失败即转 H2）。
3. **权限申请并行启动**：无论形态 A/B，Electron 壳若需 Chromium JIT（前端复杂 JS/WASM），**尽早邮件申请 `ALLOW_WRITABLE_CODE_MEMORY`**（审批周期不可控，先提交）。

---

## 7. 实测清单（新增/更新）

| # | 实测项 | 验证方法 | 影响 |
|---|---|---|---|
| J-1 | 终端启动 java -jar 的 JIT 是否生效 | 启动日志 / `-XX:+PrintCompilation` | 形态 A 定案 |
| J-2 | 应用沙盒内（HNP 拉起）JVM 的 JIT 行为 | 对比形态 A/B 启动日志 | 形态 B 可行性 |
| J-3 | `ALLOW_WRITABLE_CODE_MEMORY` 申请结果 | 邮件申请 → 授权后重测 J-2 | 沙盒内 JIT |
| J-4 | -Xint 下 SpringBoot 启动时间/吞吐 | 实测基线对比 | 兜底可行性 |
| S-1 | sqlite so 随 HAP 打包 + JVM System.load 链路 | 最小 JDBC 连接测试 | SQLite 路线 |
| S-2 | 外部 so 二进制签名工具流程 | 官方工具 + 证书 | so 分发路线 |
| S-3 | H2 在鸿蒙 JDK17 运行 + MODE=SQLite | 最小连接 + SQL 兼容测试 | H2 路线定案 |

---

## 8. 参考资料

- 官方 FAQ《IDE应用调用插件包二进制及so文件的权限与签名要求》（2026-08-19）：https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-access-control-23
- 官方文档《JSVM-API 申请JIT权限指导》：https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/jsvm-apply-jit-profile
- 实测文档《OpenHarmony 沙箱环境工作注意事项》（2026-08-11）：https://github.com/shenjackyuanjie/dsh-ohos-patch/blob/main/docs/ohos-sandbox-notes.md
- Electron/Qt 上架经验（ALLOW_WRITABLE_CODE_MEMORY 细节）：https://blog.csdn.net/qq_41308872/article/details/155055709
- 华为论坛《python wheel so 无权限》：https://developer.huawei.com/consumer/cn/forum/topic/0207212322440081360
- 二进制签名工具（官方）：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/binary-sign-tool
- 申请二进制证书（AGC）：https://developer.huawei.com/consumer/cn/doc/app/agc-help-binary-cert-0000002408063605
- 应用程序包集成 bin 文件（PC/2in1）：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hap-bin

*本专项基于 2026-08 公开资料与实测文档整理；权限授予结果、JVM 沙盒内行为等以真机实测为准（第 7 章清单），实测后请回填本文档。*
