# HarmonyOS PC 迁移专项：SSH/SFTP（sshj）、SQLite、线程与锁

> 适用对象：Windows Electron 应用迁移至鸿蒙 PC（JDK17 + SpringBoot 后端）
> 配套文档：《鸿蒙PC迁移专项_后端部署与网络证书方案.md》（后端部署/网络/证书）、《鸿蒙PC迁移方案_Electron_SpringBoot_CPP.md》（总方案）
> 标注约定：✅ 有依据｜🟡 需实测｜⚠️ 风险点

---

## 0. 结论速览

| 问题 | 结论 | 风险 |
|---|---|---|
| **sshj（SFTP）** | 依赖全部纯 Java（BouncyCastle + JDK17 内置 EdDSA），**理论上可运行**；但依赖鸿蒙 JDK 的 Socket/JCE 可用性（无公开案例），**必须 PoC**；不可用时有成熟替换方案（JSch/MINA SSHD/Node ssh2） | 🟡 中 |
| **SQLite（Java 侧）** | xerial sqlite-jdbc 带 **native .so**，鸿蒙 ARM64 **无已测试的适配包**（JNI 需重编译，高风险）；**最佳替代 = H2 纯 Java（MODE=SQLite 兼容）**；Node 侧 node-sqlite3 有官方适配示例 | ⚠️ 高（native） |
| **线程与锁** | JVM 线程/锁是 JVM 内部机制（pthread/futex），毕昇 JDK17 为鸿蒙编译，**预期正常**；需按沙箱环境显式设置 CPU/内存/GC 参数；**JIT 在"坚盾守护模式"下被禁用**（性能大降） | 🟡 低-中 |

---

## 1. SFTP 功能（sshj）在鸿蒙上的可用性与替换方案

### 1.1 sshj 是什么、依赖什么

sshj（`com.hierynomus:sshj`）是 Java 的 SSH/SFTP/SCP 客户端库（JSch 的现代替代）。关键依赖（以 0.3x 版本为例）：

| 依赖 | 实现方式 | 鸿蒙风险 |
|---|---|---|
| `org.bouncycastle:bcprov-jdk18on` | **纯 Java** JCE provider（BouncyCastle 有可选 native 加速，默认不用） | ✅ 低（纯字节码） |
| `org.bouncycastle:bcpkix-jdk18on` | 纯 Java（PKIX 证书处理） | ✅ 低 |
| `net.i2p.crypto:eddsa`（旧版） | 纯 Java（Ed25519）；**新版 sshj 已移除该依赖**，改用 JDK 15+ 内置 EdDSA（JEP 339，JDK17 自带） | ✅ 低 |
| `org.slf4j` | 纯 Java 日志门面 | ✅ 低 |
| 传输层 | Java 标准 `java.net.Socket`（TCP）+ JCE 加密（AES/ChaCha20 等） | ⚠️ **关键依赖点**：鸿蒙 JDK 的 socket/JCE 适配（见 1.3） |

**核心判断**：sshj 本身**没有 JNI/native 依赖**（搜索未发现任何鸿蒙专用 native 组件），其运行只依赖两件事：① JVM 的 TCP socket 能力；② JVM 的加密算法（JCE：AES-GCM、ChaCha20-Poly1305、EdDSA、RSA 等）。这两件都是 JDK 标准能力。

### 1.2 成功案例

**没有公开成功案例**。检索"sshj/JSch + 鸿蒙/HarmonyOS"未发现任何移植或运行案例（2026-08）。这与整体现状一致：鸿蒙 PC + 毕昇 JDK17 生态刚起步，SFTP 这类"网络 + 加密"组合属于**无先例、需自行验证**的领域。

### 1.3 可用性判定：三层验证（PoC 必做）

按依赖顺序逐层验证，哪层失败就定位到哪层：

```
第 1 层：JDK 网络基础（socket）
  → 终端 java -jar 一个最小 ServerSocket 程序，curl 本机端口
  → 再测出站 TCP：new Socket("你的sftp服务器", 22) 能否 connect
  （依据：《Java后端调研报告》§2.a——"java.net.ServerSocket/NIO Selector 依赖 JDK 本地 socket 实现在鸿蒙上的适配，未见官方说明"）

第 2 层：JCE 加密算法自检
  → 运行下方 CryptoCheck，确认 AES/GCM、ChaCha20、EdDSA、RSA 可用
  → 若某算法缺失（如 ChaCha20），sshj 连接时会报 NoSuchAlgorithmException，
    可尝试在 sshj 配置中指定其他算法（SSH 算法协商）

第 3 层：最小 sshj 连接测试
  → 用 1.5 的示例代码连一台测试 SFTP 服务器（或本地 OpenSSH）
  → 验证：密钥认证（RSA/Ed25519）、密码认证、ls/get/put
```

```java
// CryptoCheck.java —— 第 2 层验证：JCE 算法自检（JDK17，编译运行于鸿蒙 PC）
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import java.security.*;
public class CryptoCheck {
  public static void main(String[] args) throws Exception {
    String[] ciphers = {"AES/GCM/NoPadding", "ChaCha20-Poly1305"};
    for (String c : ciphers) {
      try {
        KeyGenerator kg = c.startsWith("AES") ? KeyGenerator.getInstance("AES")
                                              : KeyGenerator.getInstance("ChaCha20");
        Cipher cipher = Cipher.getInstance(c);
        System.out.println("OK   " + c);
      } catch (Exception e) {
        System.out.println("FAIL " + c + " -> " + e);
      }
    }
    System.out.println("EdDSA available: " + (KeyPairGenerator.getInstance("Ed25519") != null));
    System.out.println("RSA  available: " + (KeyPairGenerator.getInstance("RSA") != null));
  }
}
```

### 1.4 替换方案（若验证失败或不想冒险）

| 方案 | 说明 | 适用 | 推荐度 |
|---|---|---|---|
| **A. JSch**（同族替换） | 更老的 SSH/SFTP 库，依赖更少（仅 JCE + 少量 BC），纯 Java | sshj 因依赖问题失败时，JSch 依赖面更小，成功率更高 | ⭐⭐⭐ |
| **B. Apache MINA SSHD** | 纯 Java、模块化（sshd-sftp 模块），Spring 生态常用 | 需要更可控的 SFTP 实现 | ⭐⭐⭐ |
| **C. Node ssh2（跨栈，重要备选）** | **Electron 主进程的 Node.js 环境**使用 npm `ssh2` 库（纯 JS，SFTP 支持成熟），通过 IPC 暴露给渲染层；Java 后端通过本地 HTTP 调用 Electron 的 SFTP 能力 | 若鸿蒙 JDK 网络/JCE 不可用（第 1.3 层验证失败），**Node 侧是独立于 JVM 的通道**——Chromium/Node 的网络栈是官方移植验证过的（Electron 鸿蒙版进程通信可用） | ⭐⭐⭐（兜底） |
| **D. 鸿蒙原生** | @kit.NetworkKit 仅 HTTP/WebSocket，**无 SSH/SFTP 系统能力** | 不适用 | ❌ |

**方案 C 的架构形态（若走此路）**：
```
前端（渲染层）──IPC──> Electron 主进程（Node：ssh2 库）
                              │  SFTP 到远程服务器
Java 后端（本地 HTTP 调用主进程暴露的 /sftp 接口，或前端直接调）
```
⚠️ 方案 C 需改造：Java 的 SFTP 调用点改为 HTTP 请求本地 Node 服务；复杂度中等，但绕开了 JVM 网络不确定性。

### 1.5 最小 sshj 验证代码（第 3 层用）

```java
// 依赖：com.hierynomus:sshj:0.38.0（Maven Central）
import net.schmizz.sshj.SSHClient;
import net.schmizz.sshj.sftp.SFTPClient;
import net.schmizz.sshj.transport.verification.PromiscuousVerifier;

public class SftpCheck {
  public static void main(String[] args) throws Exception {
    SSHClient ssh = new SSHClient();
    ssh.addHostKeyVerifier(new PromiscuousVerifier()); // 仅测试用！生产必须校验证书
    ssh.connect("your-sftp-host", 22);                  // 第 1 层：socket
    ssh.authPassword("user", "pass");                    // 或 authPublickey("user", loadKeys(...))
    try (SFTPClient sftp = ssh.newSFTPClient()) {
      System.out.println(sftp.ls(".").size() + " entries");  // 第 3 层：SFTP 生效
    }
    ssh.disconnect();
  }
}
```
生产注意：`PromiscuousVerifier` 仅 PoC；生产用 `KnownHostsVerifier`（文件放在沙箱 `el2/base/files/.ssh/known_hosts`，与第 5 章证书方案同理）。

---

## 2. SQLite 数据库：适配现状与最佳替代

### 2.1 各方位的适配现状（事实核查）

| 使用方 | 现状 | 判定 |
|---|---|---|
| **Java 后端（xerial sqlite-jdbc）** | `org.xerial:sqlite-jdbc` 的驱动内含 **native 库**（Windows `.dll`/Linux `.so`/macOS `.dylib`），通过 JNI 调用 SQLite C 库。**官方包没有鸿蒙 ARM64 构建**；JNI 库在鸿蒙上"基本需要逐个移植，暂无通用适配方案"（《Java后端调研报告》§1.3） | ⚠️ **不可直接用**；需源码重编译（探索性，无案例） |
| **Electron 主进程（node-sqlite3）** | **有官方鸿蒙适配示例**：《Electron加载Addon指导文档》以 node-sqlite3 为例给出完整编译适配流程（C++≥17，鸿蒙工具链交叉编译 .node 放 libs/arm64-v8a）（《Electron鸿蒙化调研报告》§4.2、《官方README》§Electron加载Addon指南） | ✅ 有官方路线（Node 侧） |
| **鸿蒙原生（ArkData RDB）** | `@kit.ArkData` 关系型存储基于 **SQLite 内核**（`relationalStore`/`@kit.SQLiteKit`），系统级支持 | ✅ 但仅 ArkTS 应用侧可用，**Java 后端无法调用** |
| **better-sqlite3（Node）** | 同 node-sqlite3 需交叉编译；无官方适配示例 | 🟡 需自行编译 |

**结论**：**"Java 后端直接用 SQLite"目前没有"已被测试可正常工作"的适配包**。若坚持 Java 侧 SQLite，只有两条路：① sqlite-jdbc 源码 + 鸿蒙 NDK 重编译（无公开案例，风险高）；② 把数据库访问挪到 Electron 的 Node 侧（node-sqlite3 官方示例路线，但 Java 调用 Node 需要架构改造）。

### 2.2 最佳替代方案：H2 数据库（纯 Java，推荐）

**H2**（`com.h2database:h2`）是纯 Java 嵌入式数据库（零 native 依赖），且提供 **SQLite 兼容模式**（`MODE=SQLite`），迁移成本最低：

```yaml
# 依赖（pom.xml）—— 纯 Java，鸿蒙 JDK17 直接可用
com.h2database:h2:2.3.232
```
```java
// JDBC 连接：SQLite 兼容模式（H2 会兼容大部分 SQLite 方言）
String url = "jdbc:h2:/data/storage/el2/base/files/db/appdb;MODE=SQLite;AUTO_SERVER=TRUE";
// 说明：
//  - MODE=SQLite：启用 SQLite 兼容模式（类型亲和性、AUTOINCREMENT 等）
//  - 文件放沙箱目录（与 jar 部署形态一致，见《后端部署与网络证书方案》§4.3）
//  - AUTO_SERVER=TRUE：允许同一文件多连接（可选）
Connection conn = DriverManager.getConnection(url, "sa", "");
```

**迁移要点（从 SQLite 迁 H2）**：

| SQLite 写法 | H2（MODE=SQLite）写法 | 说明 |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | 兼容 | MODE=SQLite 下自动处理 |
| `TEXT`/`BLOB`/`REAL`/`INTEGER` | 兼容 | 类型亲和性已模拟 |
| `PRAGMA journal_mode=WAL` | 不适用（H2 有自己的 MVStore 事务） | 删除 PRAGMA 语句，或启动时忽略 |
| `sqlite_master` 查询 | 换 `INFORMATION_SCHEMA.TABLES` | 系统表名不同 |
| `INSERT OR REPLACE` | 兼容（MODE=SQLite） | — |
| 日期函数 `date('now')` | 兼容（MODE=SQLite 提供） | — |

**数据迁移**：开发期用工具导出 SQLite 为 SQL 脚本 → H2 `RUNSCRIPT` 导入；或写一次性迁移程序（JDBC 双源复制）。

**H2 vs 其他替代**：

| 替代 | 纯 Java | SQLite 兼容 | 说明 |
|---|---|---|---|
| **H2** | ✅ | ✅（MODE=SQLite） | **首选**：功能全、兼容模式、单 jar 几 MB |
| HSQLDB | ✅ | 部分 | 语法差异更大 |
| Derby（JavaDB） | ✅ | ❌ | 功能全但方言差异大 |
| 文件 + 内存（自研） | ✅ | — | 简单场景（少量配置/打点）可用，无 SQL |
| sqlite-jdbc 重编译 | ❌（native） | ✅ 原生 | 探索性、高风险 |

**若必须保持 SQLite 文件格式**（如旧数据直接可用）：备选路线 = Node 侧 node-sqlite3（官方适配示例）读写 SQLite 文件，Java 后端通过本地 HTTP 调用 Node 暴露的数据库接口（与 1.4 方案 C 同一架构模式）；或数据一次性迁移到 H2。

---

## 3. Java 线程与锁在鸿蒙上的运行与 JVM 参数

### 3.1 原理分析：线程与锁在鸿蒙 JVM 中的实现

| 机制 | 实现 | 鸿蒙上的情况 |
|---|---|---|
| Java 线程（`Thread`） | HotSpot JVM 线程 → OS 线程（pthread） | 毕昇 JDK17 为鸿蒙（musl libc）编译，pthread 由 musl 提供，**JVM 层已适配**（BiShengJDK17-OH 能跑多线程 Java 程序，工具类程序实测可用） |
| `synchronized` / 锁 | JVM 内建：偏向锁→轻量级锁→重量级锁（monitor → pthread_mutex/futex） | 纯 JVM 机制 + futex（musl 支持），**预期正常** |
| `java.util.concurrent`（Lock/线程池/并发容器） | 基于上述原语 + `sun.misc.Unsafe`（CAS） | CAS 是 CPU 指令（ARM64 LSE/ldxr-stxr），JVM 已适配 |
| GC 线程 | JVM 内部线程（G1/Parallel 等） | 同 JVM 线程，正常 |
| JIT 编译线程 | C2/C1 编译器线程 | **坚盾守护模式（系统安全模式）下 JIT 被禁用**，退化为解释执行，性能显著下降（《Electron鸿蒙化调研报告》§4.6） |
| 虚拟线程（JDK21） | 不可用 | JDK17 无虚拟线程（Spring Boot 3.2+ 的虚拟线程特性需要 JDK21） |

**预期结论**：线程创建/调度/锁竞争是 JVM 内部机制 + 标准 pthread/futex，毕昇 JDK17 编译时已适配，**正常使用的概率高**；但**无公开的压力测试案例**，建议按 3.4 验证。真正需要关注的不是"能否用"，而是"参数是否按鸿蒙 PC 环境调优"（3.3）。

### 3.2 已知风险点（需实测/注意）

1. **CPU 核数检测**：JVM 启动时读取 `/proc/cpuinfo` 等检测 CPU；沙箱内该文件可能受限/不准确 → 用 `-XX:ActiveProcessorCount` 显式指定。
2. **沙箱 rlimit**：应用沙箱（HNP 拉起形态）可能有进程数/线程数/文件描述符限制（`ulimit`），线程池过大可能创建线程失败（`OutOfMemoryError: unable to create native thread`）→ 控制线程池大小 + 显式参数。
3. **内存**：JVM 堆 + 元空间 + JIT 码缓存 + 线程栈；鸿蒙 PC 24GB 内存一般充裕，但沙箱可能有内存上限（cgroup）→ `-Xmx` 固定 + `-XX:+UseContainerSupport`。
4. **JIT 性能**：坚盾守护模式禁用 JIT/Wasm（系统级开关，用户可在设置开启）→ 需评估应用在该模式下的性能，必要时提示用户关闭该模式或优化解释执行性能。
5. **编码/时区等杂项**：与线程无关但影响运行（《Java后端调研报告》§1.3：中文输出编码问题；建议 `-Dfile.encoding=UTF-8`）。

### 3.3 JVM 参数建议（按场景给出完整启动命令行）

**通用基线（所有形态）**：
```bash
java -jar app.jar \
  -Xms512m -Xmx2g \                        # 固定堆：避免动态伸缩抖动（按业务实际调整）
  -XX:ActiveProcessorCount=8 \             # ★显式指定 CPU 数（鸿蒙 PC 常见 8 核；沙箱检测可能不准）
  -XX:+UseContainerSupport \               # 尊重沙箱 cgroup 限制（若沙箱有内存/CPU 配额）
  -Xss512k \                               # 线程栈 512k（默认 1M；线程多时省内存，递归深则调回 1M）
  -XX:CICompilerCount=2 \                  # JIT 编译线程数（限制编译线程，配合小核数）
  -Djava.util.concurrent.ForkJoinPool.common.parallelism=8 \   # 并行流/CompletableFuture 默认并行度
  -Dfile.encoding=UTF-8 \                  # 中文输出编码（鸿蒙已知坑）
  -XX:+ExitOnOutOfMemoryError              # OOM 直接退出便于守护进程拉起（可选）
```

**GC 选择**（按内存规模）：
```bash
# 方案 1：默认 G1（推荐，延迟均衡）—— 2G 堆以上
#   （G1 是 JDK17 默认，一般无需显式指定；小内存场景 G1 有额外开销）
# 方案 2：小堆/低延迟抖动场景（<1G）：
-XX:+UseParallelGC
# 方案 3：吞吐优先、堆很小（<512M，如边缘设备）：
-XX:+UseSerialGC
```

**线程相关调优（若业务多线程/锁竞争明显）**：
```bash
-XX:+UseBiasedLocking \    # ⚠️ JDK 15 起默认禁用偏向锁；JDK17 显式开启对"单线程持有锁"场景
                           # 有收益，但对高竞争场景无益——先用默认，实测后再决定
-XX:ThreadStackSize=512    # 同 -Xss
-XX:ParallelGCThreads=8 -XX:ConcGCThreads=2   # GC 线程数（配合 ActiveProcessorCount）
```

**启动参数注入方式**（按后端形态）：
- 形态 A（终端）：命令行直接带（如上）
- 形态 B（HNP 拉起）：Electron 主进程 spawn 的 args 数组里加（见《后端部署与网络证书方案》§1.3 代码）
- 形态 C（融合开发引擎）：引擎内 java 命令带
- 或统一用环境变量：`JAVA_TOOL_OPTIONS="-Xmx2g -XX:ActiveProcessorCount=8 ..."`（JVM 自动读取，跨形态最省事）

### 3.4 验证方案（压力测试清单）

```java
// ThreadCheck.java —— 线程/锁冒烟（鸿蒙 PC 上运行）
// 1) 线程创建/销毁：循环 new Thread + join，1000 次，无异常
// 2) 锁竞争：N 线程对 AtomicLong/ReentrantLock 累加 1e6 次，验证最终值正确
// 3) 线程池：Executors.newFixedThreadPool(16) 提交 1000 任务
// 4) 记录：Runtime.getRuntime().availableProcessors() 返回值（核对 ActiveProcessorCount）
```
对照项：Windows 上跑同样代码的时间 vs 鸿蒙 PC 上（性能差异预期 10-30% 内属正常，JIT 预热后对比）。

---

## 4. 待实测清单汇总（本专项）

| # | 实测项 | 归属问题 | 影响 |
|---|---|---|---|
| 1 | 鸿蒙 JDK17 出站 TCP socket（连 sftp 服务器 22 端口） | sshj | 决定 sshj/JSch 是否可用 |
| 2 | JCE 算法自检（AES-GCM/ChaCha20/Ed25519/RSA） | sshj | 决定加密算法协商 |
| 3 | 最小 sshj 连接 + ls/get/put | sshj | SFTP 功能可用性 |
| 4 | sqlite-jdbc native 加载（若尝试重编译） | SQLite | 决定是否走 H2 |
| 5 | H2 在鸿蒙 JDK17 上运行 + MODE=SQLite 兼容验证 | SQLite | H2 方案落地 |
| 6 | 线程压力测试（3.4）+ `availableProcessors()` 返回值 | 线程 | 参数调优依据 |
| 7 | 沙箱内线程/文件描述符 rlimit（HNP 形态） | 线程 | 线程池上限 |
| 8 | 坚盾守护模式下 JIT 禁用的性能影响 | 线程 | 性能预期 |

---

## 5. 附录：依赖坐标速查

```xml
<!-- Maven 依赖（全部 Maven Central，离线可先 dependency:go-offline 打包） -->
<!-- SFTP：sshj（先 PoC）或 JSch / MINA SSHD（替换） -->
<dependency>
  <groupId>com.hierynomus</groupId>
  <artifactId>sshj</artifactId>
  <version>0.38.0</version>
</dependency>
<!-- 或 JSch：com.github.mwiede:jsch:0.2.18（纯 Java，维护中） -->
<!-- 或 MINA：org.apache.sshd:sshd-sftp:2.13.2（纯 Java） -->

<!-- SQLite：首选 H2（纯 Java） -->
<dependency>
  <groupId>com.h2database</groupId>
  <artifactId>h2</artifactId>
  <version>2.3.232</version>
</dependency>
<!-- 若坚持 sqlite-jdbc（需鸿蒙重编译 native，探索性）：org.xerial:sqlite-jdbc:3.46.1.3 -->
```

*本专项基于公开资料整理；第 4 章实测完成前，各结论以"预期 + 待实测"为准，实测结果请回填本文档。*
