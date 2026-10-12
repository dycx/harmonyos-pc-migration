# 鸿蒙 PC 专项：Java 子进程「线程卡死 / 无日志失败」根因与解决方案

> **触发问题**：Electron 用 `spawn` 拉起的 Java 后端（毕昇 JDK17，musl）在鸿蒙 PC 上运行一段时间后，**线程任务像被掐掉**——界面进度卡住、**Electron 本身完全正常**、**后端日志没有任何异常记录**、**约 10s 出现且不固定**、**每次都在处理 zstd 压缩包时发生**。
> **本文定位**：把「内存限制 / CPU 限制 / 线程数限制」这些笼统猜测收敛成**两条可判定的路径**，并给出官方的可观测手段与合规解法。
> **证据等级**：✅官方明文 ｜ ✅官方源码（文件:行号）｜ 🟡推断（附推理链）｜ ⚠️需真机实测 ｜ ❓未找到
> **版本**：v1.0（编写时未接触真机；三份调研报告见 §10）

---

## 0. 结论速览

### 0.1 先看一张判定表

| 卡住时 java 进程**还在**吗 | 指向 | 概率 |
|---|---|---|
| **在** | **CPU 被压制/降级**（§2 调度降级 + §3 能效模式）→ 线程拿不到时间片 | ★★★★★ |
| **在** | **JNI Critical Section 锁死 GC**（§6.5 B′，进程活着但整个 JVM 停摆） | ★★★★☆ |
| **在** | Java 层无限自旋（§6.5 D′，CPU 打满但不推进） | ★★☆☆☆ |
| **不在** | **被 SIGKILL**（§4 RSS 越限 / 线程超限 / 泄漏判定；或 §6.5 A′ 内核 OOM killer） | ★★★★☆ |
| **不在** | 原生 malloc 返回 0 → NULL 解引用 **SIGSEGV**（§6.5 A′，已实测复现） | ★★★☆☆ |

**一条命令定性**：
```bash
hdc shell "ps -ef | grep -i java"      # PID 在 = 压制/GC 锁死；没了 = 被杀/崩溃
```
**外加一个 5 秒行为测试**：卡住时用鼠标点一下 Electron 窗口（让它重新获得焦点）→ **立刻恢复 ⇒ 基本确认是能效模式**（§3）。

**再加一条 10 秒判据**（区分"压制"与"GC 锁死"）：
```bash
hdc shell "top -H -p <java_pid>"
#   全部线程 ~0% CPU        → 压制（§2/§3）
#   单线程 ~100% 单核        → 自旋（§6.5 D′）
#   有线程在 native 且 GC 停摆 → §6.5 B′（用 jcmd Thread.print 确认）
```

### 0.2 ★ 本次最重要的新证据（代码级）

**Electron `child_process.spawn` 出来的 java 进程，不在鸿蒙的进程模型里** —— 因此它**拿不到"跟随宿主"的待遇**，被调度到 CPU cgroup 的**根组**，而聚焦的 Electron 主进程拿的是 `top-app` 组。

> 这解释了「**Electron 界面流畅、java 却像冻住**」这个最反常的现象。（依据见 §2，官方源码 `supervisor.cpp:349-365` + `cgroup_adjuster.cpp:155-195`）

### 0.3 两条重要认知纠正

**① 「JVM 没有 OOM 记录」不代表内存没问题。**
鸿蒙按**进程 RSS/PSS** 判罚，而 `-Xmx` 只管 Java 堆；**zstd-jni 的缓冲区走 native 内存**（JNI `malloc`），不占 Java 堆 → **JVM 不抛 OOM，系统却判定超限**。这两件事同时成立、完全自洽。

**② 常规的 JVM 内存管控参数对 JNI `malloc` 全部无效**（详见 §7.4）：
`-XX:MaxDirectMemorySize`（只管 `java.nio` direct buffer）、`-XX:NativeMemoryTracking`（官方明说**追踪不了 JNI 分配**）、`-XX:+HeapDumpOnOutOfMemoryError` / `+ExitOnOutOfMemoryError`（只在 **Java** OOM 上触发）—— **四个都救不了原生 malloc 失败**。
唯一有效的是 **`-XX:ErrorFile=<绝对路径>/hs_err_%p.log`**（默认写子进程 CWD，沙箱内你找不到）。

### 0.4 ★ 流式压缩的原生内存实测（决定一切的硬数字）

`ZstdOutputStream` 不调 `setPledgedSrcSize` → **永远按该 level 的最大 windowLog 分配**。实测 `ZSTD_sizeof_CCtx()`：

| level | MiB / 单条流 | level | MiB / 单条流 |
|---|---|---|---|
| **3（默认档）** | **3.49** | **19** | **89.50** |
| 9 | 14.74 | 22 | **833.6** |

→ **16 条并发流 @ level 19 ≈ 1.4 GiB 纯 malloc（不吃 `-Xmx`）；64 条 ≈ 5.6 GiB。**
→ **`level 3` 与 `level 19` 差 25 倍** —— 这是最容易调的一个旋钮。（完整表见 §7.3.1）

### 0.5 ★★ 完整决策树（按这条走，不需要反复问我）

```
卡住的那一刻
│
├─【第 1 步】hdc shell "ps -ef | grep -i java"
│   │
│   ├── PID 没了（进程已死）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
│   │   │                                                    ┃
│   │   ├─ Electron 日志有 "[backend] exited: code=null signal=SIGKILL"
│   │   │      → 被 SIGKILL。继续 ↓
│   │   ├─ hdc shell "dmesg | grep -iE 'out of memory|killed process|oom'"
│   │   │      有输出  → 【内核 OOM killer】→ 走 §7.2 + §7.3（压内存）
│   │   │      无输出  → 继续 ↓
│   │   ├─ hdc shell "hidumper -e --list java -n 20"
│   │   │      有记录  → 【管控查杀】看 reason 列：
│   │   │                ThreadKiller / TooManyReadyThreads → §7.2③ 线程池收敛
│   │   │                RssThresholdKiller / LowMemoryKill / OomKiller → §7.2①②+§7.3
│   │   │                CPUHighload → §7.1
│   │   │      无记录  → 【快速泄漏 / RSS 突增类】（官方说这类无维测信息）→ §7.2+§7.3
│   │   └─ signal=SIGSEGV / 找到 hs_err_pid*.log
│   │          → 【原生崩溃】→ ① 确认编译参数含 -Bsymbolic（§7.3.4）
│   │                        ② 走 §7.3 压原生内存 + 给 Zstd* 全部 close()
│   │
│   └── PID 还在（进程活着）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
│       │                                                    ┃
│       ├─【第 2 步】鼠标点一下 Electron 窗口（5 秒测试）
│       │      立刻恢复 → 【能效模式】→ §7.1① setPowerSaveMode + §7.1② 长时任务
│       │      不恢复   → 继续 ↓
│       │
│       ├─【第 3 步】hdc shell "top -H -p <pid>"
│       │   │
│       │   ├─ 所有线程 ≈0% CPU
│       │   │   │
│       │   │   ├─ hdc shell "hidumper --cpuusage <pid>" ≈0
│       │   │   │   └─ 且 /proc/<pid>/cgroup 在 /dev/cpuctl 根（Electron 在 top-app）
│       │   │   │        → 【调度降级】→ §7.1
│       │   │   └─ hdc shell "jcmd <pid> Thread.print" | grep -A5 GCLocker
│       │   │        大量线程停在 GCLocker::stall_until_clear
│       │   │          → 【JNI Critical Section 锁死 GC】→ §7.3（降并发是主解）
│       │   │
│       │   ├─ 单线程 ≈100% 单核
│       │   │   → 【Java 层自旋】（zstd-jni 游标不推进）→ 降级版本 / 换纯 Java 实现
│       │   │
│       │   └─ 线程大量 WAITING / BLOCKED
│       │       → 【应用自身死锁 / 线程池饱和】→ jstack 找锁环
│       │
│       └─【第 4 步】/proc/<pid>/task/*/wchan 出现 pipe_write
│               → 【stdio 管道写满】→ stdio:'ignore' 或重定向到文件（§6.5 C′）
│
└─ 都排除了？
    → 跑 §6.7 的实验矩阵，用"变量隔离法"逐个排除
```

> 📌 **注意**：机制可以**叠加**。例如"能效模式压制"与"GC 锁死"可能同时存在——现象都是"活着但不动"，靠第 3 步的 CPU 占用区分。

---

## 1. 由现场事实能直接排除什么（省掉一半排查）

你提供的四条事实，本身就排除了一批候选：

| 现场事实 | 排除了什么 | 为什么 |
|---|---|---|
| **Electron 界面完全正常** | ❌ **memmgr / LowMemoryKiller 查杀** | 官方 `low_memory_killer.cpp:78-124` 是**遍历整个 bundle 的每个 PID 逐个杀**（`BundlePriorityInfo{map<pid, ProcessInfo> procs_}`）→ 它一旦动手，**Electron 会一起死** |
| **没有任何异常记录** | ❌ **`RLIMIT_AS`（地址空间上限）触顶** | 那会导致 `malloc` 返回 NULL → zstd 返回 `ZSTD_error_memory_allocation` → Java 抛 `ZstdException`/OOM → **必然有日志** |
| **应用在前台** | ⚠️ **弱化但不排除**能效模式 | 能效模式的触发条件是「**未获取系统焦点**」，不是"退到后台"。你在另一个窗口看日志就满足条件（§3） |
| **每次都在 zstd 压缩时** | ✅ **强因果**：zstd 是唯一的「CPU 密集 + native 内存密集」阶段 | 其它阶段是 I/O 或轻计算，压制/内存压力都暴露不出来 |

> ⚠️ **另一条排除**：OpenHarmony **不设置** `RLIMIT_NPROC` / `RLIMIT_AS` / `RLIMIT_STACK`（全仓 `setrlimit` 只有 `init.cfg:70-71` 的 `NICE=40`、`NOFILE=32768`）→ 你之前查到的"**沙箱 rlimit 线程数上限**"在开源版**不成立**。同理，"只杀线程不杀进程"在**内核层面不存在**（`SIGKILL`/`tgkill` 终结整个线程组）。

---

## 2. ★ 机制一：spawn 的子进程被 CPU 调度降级（代码级证据）

这是最贴切你现象的一条。

### 2.1 鸿蒙的进程模型只认识"自己人"

```cpp
// supervisor.cpp:349-365（官方源码）
void Supervisor::ReloadChildProcess() {
    std::vector<AppExecFwk::ChildProcessInfo> childProcess;
    appManager_->GetAllChildrenProcesses(childProcess);   // ← 只返回 OH 原生子进程
    for (...) {
        procRecord->processType_ = ProcRecordType::CHILD;  // ★ CHILD 只在此处赋值
        procRecord->hostPid_ = process.hostPid;
    }
}
```

**而「子进程跟随宿主调度」的前提，正是 `processType_ == CHILD` 且 `hostPid_` 匹配**（`cgroup_adjuster.cpp:112-128`）。

`GetAllChildrenProcesses` 对应的是 ArkTS 的 `@ohos.app.ability.childProcessManager`。**Electron 的 `child_process.spawn` 走 POSIX fork/exec，不在此列** → 不被标记为 CHILD → **不跟随宿主**。

### 2.2 调度组怎么算：只有"聚焦进程"和"承载 Ability 的进程"有好待遇

```cpp
// cgroup_adjuster.cpp:155-195（官方源码）
SchedPolicy group = SP_DEFAULT;
...
else if (source == ADJS_PROCESS_CREATE)              group = SP_DEFAULT;  // 新建进程
else if (app.focusedProcess_->GetPid() == pr.GetPid()) group = SP_TOP_APP; // ★ 只有聚焦进程
else if (pr.abilities_.size() == 0)                  group = SP_DEFAULT;  // ★ 不承载 Ability → 根组
```

cgroup 配置（`cgroup_action_config.json`）：挂在 **`/dev/cpuctl`**（cpu）+ **`/dev/cpuset`**（cpuset），子组 `background / foreground / system-background / top-app`，**而 `sp_default` 的 path 是空串 `""` = 根目录**。

**推论**：一个**不承载 Ability、又没被识别为 CHILD** 的 java 后端进程 → 落 `SP_DEFAULT`（`/dev/cpuctl` 根）；而聚焦的 Electron 主进程拿 `SP_TOP_APP`。
→ **同一个应用里，UI 进程和你的后端跑在不同的 CPU 调度组里。**

### 2.3 验证（一条对照即可）

```bash
hdc shell "cat /proc/<javaPid>/cgroup"
hdc shell "cat /proc/<electronMainPid>/cgroup"          # 对照
hdc shell "cat /dev/cpuctl/cpu.shares"                   # 根组权重
hdc shell "cat /dev/cpuctl/top-app/cpu.shares"           # top-app 权重
```
**若 java 在 `/dev/cpuctl/`（根）而 Electron 在 `/dev/cpuctl/top-app/` ⇒ 降级结论在实机成立。**

❓ **未找到**：各组 `cpu.shares` 的**具体数值**（官方称由 init/产品侧维护）——需实机读，不要采信网上的数字。

---

## 3. ★ 机制二：PC 端「能效模式」（官方明文，10–15 秒）

华为官方支持文档《华为鸿蒙电脑如何开启/关闭能效模式》原文：

> 能效模式是通过**限制或减少应用程序的活动**，来达到降低功耗…**电脑中的所有应用(除系统进程外)默认开启**…
> 当应用处于下列场景时，就会自动进入能效模式状态：**场景一：应用程序失去焦点，窗口部分遮挡，10-15秒**；场景二：失去焦点+全部遮挡，10-15秒；场景三：最小化，10-15秒。
> **当应用下存在多个子进程时…打开父节点应用下任意一个进程的能效模式功能，父节点应用的能效模式会自动打开。**

**★★ 关键吻合**：官方 API 文档里，能效模式的适用场景**明确点名「压缩、解压缩」**等耗时较长的计算任务 —— 与「每次卡住都在处理 zstd 压缩包」严丝合缝。

| 你的现象 | 能效模式的解释 |
|---|---|
| **~10s** | 官方触发窗口正是 **10–15 秒** |
| **不固定** | 取决于何时失焦 |
| **Electron 正常** | UI 进程负载轻，被压制也不明显 |
| **每次都在 zstd** | zstd 是唯一的 CPU 密集段，只有它会被压制暴露出来 |
| **无任何日志** | 没有异常可报，只是拿不到 CPU 时间片 |

**验证**：
1. **行为测试（5 秒）**：卡住时点一下 Electron 窗口 → **恢复即确认**
2. **API 测试**（ArkTS 侧，需声明 `ohos.permission.BACKGROUND_MANAGER_POWER_SAVE_MODE`，**normal 级、免 ACL**）：
   ```ts
   await backgroundProcessManager.isPowerSaveMode(javaPid)   // true ⇒ 被压制
   ```
3. `hdc shell "hidumper --cpuusage <javaPid>"` → CPU ≈ 0 佐证

### 3.1 PC 特有的坑：应用"自认为在前台"

> 官方文档：PC/2in1 上，**不支持 phone 的应用窗口从前台进入后台状态时，不会驱动 UIAbility 为后台状态**。

→ 应用可能**自认为一直在前台**，实际已被判定失焦并进入能效模式。**不要用"我的应用在前台"来排除它**，要用上面的行为测试/API 验证。

---

## 4. 机制三：内存与管控类（若进程确实消失了）

### 4.1 官方点名的 kill 原因

`dfx/appkilled-guidelines.md` 的 kill 原因表里逐字列有：

| kill reason | 含义 | 处置建议（官方原文） |
|---|---|---|
| **`ThreadKiller`** | 单进程**线程超限** | 「尝试减少应用创建的线程数量」 |
| **`TooManyReadyThreads`** | 单进程**就绪线程过多** | 同上 |
| `RssThresholdKiller` | 应用 **RSS 超阈值** | — |
| `LowMemoryKill` / `OomKiller` | 低内存 | — |
| `CPUHighload` | 应用**后台 CPU 高负载** | — |
| `ResourceLeak(ThreadLeak/PSSLeak)` | 资源泄漏 | — |

触发场景原文：「应用的内存、CPU和IO类负载超过一定限额，**文件句柄和线程数量超标**」。

### 4.2 ★★ 两条高价值官方线索（建议优先验证）

**① 「应用的 RSS 内存超过 4GB」是官方点名的"无详细维测信息"场景**

`appkilled-guidelines.md:28` 原文：
> 系统对应用进行管控时，部分场景无法提供详细的维测信息，比如 LowMemoryKiller、**应用的RSS内存超过4GB**、快速泄漏等。

→ zstd 多线程把 RSS 推过 4GB 是现实路径，而且**恰好不产生维测信息**。

**② 原生内存泄漏判定会「同时触发管控」**

官方《Resource Leak》文档（可抓取的逐字转载）：Native 内存以「应用平均动态峰值」为基线，**60s 轮询**，**峰值超基线 2 倍 → 判定泄漏，同时触发管控**。

→ 完美解释「**平时正常、一压 zstd 就出事、不固定**」。

### 4.3 为什么 JVM 侧没有 OOM 记录

| 层 | 限制手段 | zstd 缓冲区算不算 |
|---|---|---|
| Java 堆 | `-Xmx` / `-XX:MaxDirectMemorySize`（只管 `ByteBuffer.allocateDirect`） | ❌ **不算** |
| **native** | JNI `malloc` → **完全不受 JVM 参数约束** | ✅ **算** |
| 系统判罚 | **进程 RSS/PSS** | ✅ 算 |

→ **JVM 不抛 OOM，系统仍判超限**，两件事同时成立。

### 4.4 ❓ 未找到（不要采信网上的数字）

- `ThreadKiller` / `RssThresholdKiller` / `CPUHighload` 的**源码实现位置**与**具体阈值**
- 社区转载称「单进程线程数阈值 700 / FD 阈值 5000」（源自官方《Resource Leak》文档的转载），**官方站点 JS 渲染抓不到原文，需实测**
- 官方是否支持「**只杀某应用某个子进程而保留父进程**」——现有证据（memmgr 整 bundle 全杀、appkilled reason 全是应用级）**都不支持**"父活子死"
- `maxChildProcess` 缺省默认 1（`app-configuration-file.md:119`，范围 0–512）——若你的场景有多的 fork，值得一并确认

---

## 5. ★ 为什么「完全没有日志」——四个机制叠加

| # | 机制 | 出处 |
|---|---|---|
| 1 | **SIGKILL 官方不生成维测信息** | `appkilled-guidelines.md:12` 原文：「系统…**通常通过服务进程向应用发送 SIGKILL 信号（信号值是 9）**来实施终止的。操作系统对 SIGKILL 的默认行为是**不生成栈日志等维测信息**的，导致应用闪退时 faultlogger 中无日志。」 |
| 2 | **鸿蒙的查杀是用户态 `kill(pid, SIGKILL)`**，不是内核 cgroup OOM killer | `kernel_interface.cpp:375-396`。**⇒ cgroup 的 `oom_kill` 计数不会因它增加**，⚠️ 不要把它当主要证据 |
| 3 | **`dmesg_restrict=1`** + `/proc/kmsg` 0440 | `init.cfg:11` → 内核 OOM、cgroup 拒绝 fork 这类 `pr_info`，开发者看不到 |
| 4 | **模板只打印 exit code，不打印 signal** | `main.js:193`：`child.on('exit', (code) => ...)`。**被信号杀死时 `code` 为 `null`**，会显示成 `[backend] exited: null`，极易被忽略 |

---

## 6. ★ 判别方法：一页命令清单

> **在"卡住的那一刻"执行，先不要重启应用。**

```bash
# ── 0) 定性：进程还在吗
PID=$(hdc shell "pidof java" | tr -d '\r'); echo "java pid = [$PID]"
#    空 → 被杀（走 §6.2） ；有值 → 被压制（走 §6.1）

# ── 6.1 若进程【还在】━━━━━━━━━━━━━━━━━━━━━━━━━━━
hdc shell "cat /proc/$PID/status | grep -E 'State|Threads|VmRSS|VmSize'"
#   State: S/R → 活着（但可能拿不到 CPU）; D → 卡在内核 ; T → 被 SIGSTOP/freezer
#   Threads: 记下数值

# ★ 调度降级对照（§2 的直接验证）
hdc shell "cat /proc/$PID/cgroup"
hdc shell "cat /proc/$(hdc shell pidof electron | tr -d '\r' | cut -d' ' -f1)/cgroup"
hdc shell "cat /dev/cpuctl/cpu.shares; cat /dev/cpuctl/top-app/cpu.shares"

# ★ CPU 占用（区分"压制"与"在算"）
hdc shell "hidumper --cpuusage $PID"        # ≈0 → 被压制

# ★ 能效模式（ArkTS 侧一次调用，最直接）
#    await backgroundProcessManager.isPowerSaveMode(<javaPid>)   → true ⇒ 压制确认

# ── 6.2 若进程【没了】━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ★★ 官方专治"无 faultlog 的异常退出"（API 22+）
hdc shell "hidumper -e --list java -n 20"
#    输出列：time / foreground / reason / record_id / process_name
#    ★ 官方样例里就有一行 foreground=True + LowMemoryKill —— 前台应用确实会被杀
hdc shell "hidumper -e --print java"        # 取故障日志正文

# ★ 内存管控服务日志（tag MemMgr，domain 0xD001799）
hdc shell "hilog -x | grep -iE 'MemMgr|has been Killed|killing pid|minPrio|current buffer'"
#    ★ 注意 "has been Killed" 是 ERROR 级，只看应用自己的 INFO 日志必然漏掉

# ★ 内核侧
hdc shell "dmesg | tail -300 | grep -iE 'lowmem|oom|kill|memory'"
hdc shell "ls -l /dev/memcg/"

# ── 6.3 通用：资源与上限 ━━━━━━━━━━━━━━━━━━━━━━━━
hdc shell "cat /proc/$PID/limits"                    # Max address space / Max processes
hdc shell "cat /proc/$PID/smaps_rollup | grep -E 'Rss|Anonymous'"   # Anonymous ≈ 堆+native
hdc shell "hidumper --mem $PID"
hdc shell "hidumper -p $PID --thread"                # API 26：查线程泄漏
hdc shell "hidumper -p $PID --fd"                    # 查 fd 泄漏
hdc shell "ls -l /data/log/faultlog/faultlogger/ | tail"
hdc shell "ls -l /data/storage/el2/log/resourcelimit/ 2>/dev/null"
```

### 6.4 判读表

| 观测结果 | 结论 |
|---|---|
| PID 在 + `hidumper --cpuusage` ≈ 0 + **重新聚焦后恢复** | **能效模式**（§3）✅ 最可能 |
| PID 在 + `/proc/pid/cgroup` 在 `/dev/cpuctl` 根，Electron 在 `top-app` | **调度降级**（§2） |
| PID 在 + `Threads` 卡在固定值不再增长 | **线程创建失败被静默吞掉**（§7.4） |
| PID 在 + 线程大量 `WAITING`/`BLOCKED` | 应用自身死锁/线程池饱和 |
| PID 没了 + `hidumper -e --list` 有记录 | **管控查杀** → 看 `reason` 列 |
| PID 没了 + hilog 有 `has been Killed` | **memmgr 查杀**（但注意：它通常连 Electron 一起杀） |
| PID 没了 + 两处都无记录 | 快速泄漏 / RSS 突增类管控（官方说这类无维测信息） |

### 6.5 ★ 另外三个机制（zstd 侧调研新发现，都能解释"无日志"）

前面 §2–§5 讲的是**鸿蒙系统侧**的原因。zstd-jni 源码级调研**又找到三个"库/用法侧"的机制**，每个都配了一条最小验证。**它们与系统侧原因并不互斥，可能叠加。**

#### 机制 A′：原生内存耗尽 → 内核 OOM killer `SIGKILL`，或 NULL 解引用 `SIGSEGV`

**先说一条被实测复现的崩溃路径**（这条解释了"为什么 Java 层什么都不抛"）：

| 环节 | 事实 |
|---|---|
| `ZstdOutputStreamNoFinalizer.java:86` | `this.stream = createCStream();` —— **不检查返回值是否为 0** |
| 对照 `ZstdCompressCtx.java:35-41` | 那里**是检查的** |
| 原生 `compress/zstd_compress.c:708-711` | `ZSTD_CCtx_setParameter()` **第一行就裸解引用 `cctx->streamStage`，没有 NULL 检查**（`ZSTD_CCtx_reset` 同，`:1367-1373`） |
| **实测** | `ZSTD_CCtx_setParameter(NULL, ...)` → **exit 139 (SIGSEGV)**；`ZSTD_CCtx_reset(NULL,...)` → 同样；`ZSTD_freeCStream(NULL)` → 安全返回 0 |

→ **原生 `malloc` 失败（内存紧张）→ `createCStream` 返回 0 → 紧随其后的 `setLevel()` 直接段错误，Java 层什么都不抛。**
（这正是 Oracle 文档描述的"malloc 返回值未检查 → crash"场景。所谓"约 10 秒"，正好是并发流的 workspace 全部 malloc 完、RSS 越过配额的时间尺度。）

**最小验证（三条，都不用改代码）**：
```bash
# ① 卡住时进程还在不在
hdc shell "ls /proc/<java_pid>"
# ② ★ 唯一能找到 SIGKILL 证据的地方
hdc shell "dmesg | grep -iE 'out of memory|killed process|oom'"
# ③ 去【子进程 CWD】找 JVM 崩溃文件（不在你的应用目录！）
hdc shell "find / -name 'hs_err_pid*.log' -newermt '-1 day' 2>/dev/null"
```

#### 机制 B′：★★ JNI Critical Section 锁死 GC → 整个 JVM 停顿

**这是"进程活着、无异常、无日志、整体卡住"的完美解释之一。**

| 事实 | 出处 |
|---|---|
| `compressByteArray0` 先 `GetPrimitiveArrayCritical(dst)`、再 `GetPrimitiveArrayCritical(src)`，**然后才** `ZSTD_compress2(...)` | `jni_fast_zstd.c:611-639`；`jni_outputstream_zstd.c:66-74` 同样 |
| `GetPrimitiveArrayCritical` 会拿 **GCLocker** | Shipilëv：「GCLocker is a lock that **prevents GC from running** when JNI critical is acquired」 |
| → **多线程同时持有时 GC 完全停摆**，其他线程卡在 `GCLocker::stall_until_clear` | — |
| 上游 issue | **#346**，维护者 **2026-08-27 明确拒绝修**（「We don't want to add more overhead (by memcpy)」） |
| JEP 423 的 region pinning 能缓解，但需 **JDK 22+** | **你的 JDK 17 没有** |

**最小验证**：
```bash
hdc shell "jcmd <java_pid> Thread.print" | grep -A5 -iE "GCLocker|stall_until_clear"
#   大量线程停在 GCLocker::stall_until_clear ⇒ 确诊
# 配合 -Xlog:gc* 看是否密集出现 "Pause Young (GCLocker Initiated GC)"
```
**反向验证（最有说服力）**：**把并发降到 1~2 跑同一份数据**——不卡了 ⇒ 强烈指向 B′（或 A′）。

#### 机制 C′：Electron `spawn` 的 stdio 管道写满 → Java 阻塞在 `write(2)`

| 事实 | 出处 |
|---|---|
| 【Node 官方文档原话】「By default, pipes for stdin/stdout/stderr are established… These pipes have limited capacity. **If the subprocess writes to stdout in excess of that limit without the output being captured, the subprocess blocks, waiting for the pipe buffer to accept more data.**」 | Node.js `child_process` 文档 |
| 管道缓冲 64 KiB；若开始处理压缩包时打进度日志 → **约 10 秒累积到 64 KiB → Java 卡在 `write()`** | — |
| 「日志里没有异常」也说得通 —— **异常根本没发生** | — |

**最小验证**：
```bash
hdc shell "ls -l /proc/<java_pid>/fd/1 /proc/<java_pid>/fd/2"     # 指向 pipe:[NNN]？
hdc shell "cat /proc/<java_pid>/task/*/wchan"                    # 出现 pipe_write ⇒ 确诊
```
**零成本对照**：`stdio: 'ignore'`，或把 stdout/stderr 重定向到**文件**，再跑一次 → 不卡了就是它。
> ✅ **模板已经挂了 `child.stdout/stderr.on('data')`**，管道是被消费的，所以**大概率不是你**——但如果你实际代码改动过，值得一排。

#### 补充机制 D′：zstd-jni Java 层的**无限自旋**（无异常、无日志，但吃满 CPU）

`ZstdOutputStreamNoFinalizer.java:418-426` 的 `while (srcPos < srcSize)`、`:457-463` 的 `do{...}while(size>0)`、`ZstdInputStreamNoFinalizer.java:155-164` 的 `while(result==0)` **都没有"无进展即报错"保护**（对比 `readInternal` 内层 `:180` 是有 `&& lastDstPos < dstPos` 保护的）。
→ native 不推进游标又返回非 error → **纯 CPU 自旋**，无异常无日志。

**最小验证**：`hdc shell "top -H -p <java_pid>"` —— **某线程 ~100% 单核 ⇒ D′**（或"极慢不是死锁"）；**~0% CPU 且进程活着 ⇒ A′/B′/C′ 之一**。

> 📌 **已知同类 issue**：`#119`「**线程 dump 永久停在 `ZstdOutputStream.compressStream(Native Method)`**」（close 顺序 bug，1.4.4-10 修）；`#298`「**workers=4 后 stuck，实为极慢不是死锁**」。

### 6.6 一条被**主动排除**的路径（省得你去查）

**zstd workspace `malloc` 失败 → `ZstdIOException("Allocation error : not enough memory")`（错误码 64）** —— 这条链路完整、**必然留日志**。你说"没有任何异常日志"，正好把它排除。

同理被排除的还有：Java 堆 OOM（会有 `OutOfMemoryError` + stack trace）、数据损坏（会有 `ZstdException`）。

### 6.7 ★★ 一次跑完的实验矩阵（变量隔离法）

> **这一节是为"测试链路长、无法频繁反馈"设计的。**
> 一次上机按下面的顺序跑 8 组，每组只改**一个变量**，就能把 5 条机制逐个锁定或排除。
> 建议**先做 E0（取证准备）**，否则每组跑完都没有数据。

#### E0（前提，必做）：先把取证能力打开

```js
// main.js —— ① 打印信号；② 顺手把后端输出落文件（同时排除管道问题）
const fs = require('fs');
const logFd = fs.openSync('/data/storage/el2/base/files/backend.log', 'a');
const child = spawn(CONFIG.EMBEDDED_JAVA, args, { stdio: ['ignore', logFd, logFd] });
child.on('exit', (code, signal) =>
  console.error(`[backend] exited: code=${code} signal=${signal}`));
```
```bash
# ③ JVM 参数（追加到 CONFIG.JVM_ARGS）
-XX:ErrorFile=/data/storage/el2/base/files/hs_err_%p.log
-Xlog:gc*:file=/data/storage/el2/base/files/gc.log:time,uptime,level,tags
```
> ⚠️ `-XX:NativeMemoryTracking` 对本问题**无效**（追踪不了 JNI 分配），别指望它。

#### E1–E8 实验矩阵

| # | 只改这一个变量 | 若**不再卡** | 若**仍然卡** | 耗时 |
|---|---|---|---|---|
| **E1** | **并发度降到 1**（信号量=1） | ⇒ **并发相关**：原生内存(A′) 或 GCLocker(B′) | ⇒ 与并发无关 → 做 E5 | 短 |
| **E2** | **压缩 level 3 → 1**，或 `setWindowLog(20)` | ⇒ **原生内存**（A′）：每次分配量是关键 | ⇒ 内存不是主因 | 短 |
| **E3** | `stdio: 'ignore'`（或重定向到文件，见 E0） | ⇒ **stdio 管道写满**（C′） | ⇒ 排除 C′ | 短 |
| **E4** | **加大 `-Xmx`**（如 2g → 6g） | ⚠️ **大概率无效**（原生内存不吃堆）——若真有效，说明是 Java 堆/GC 问题 | ⇒ 与 Java 堆无关 | 中 |
| **E5** | 系统设置里**手动关闭能效模式**，或跑之前/期间持续让窗口保持焦点 | ⇒ **能效模式** | ⇒ 排除能效模式 | 中 |
| **E6** | ArkTS 侧对 java PID 调 `setPowerSaveMode(EFFICIENCY_MODE)` | ⇒ **确认能效模式**（这是最权威的确认方式） | ⇒ 排除 | 中 |
| **E7** | 整个后端**完全不用 zstd**（临时降级为 gzip/none） | ⇒ **确认与 zstd 强相关**，走 §7.3 | ⇒ **不是 zstd 的问题** → 回到系统侧（§2/§3） | 长 |
| **E8** | 前端/其它无关业务**停掉**，只跑 zstd 压测 | ⇒ 说明是**资源竞争**（多方同时吃 CPU/内存） | ⇒ 单任务也会卡 | 中 |

#### 判读组合（一次测试即可定性）

| E1 | E2 | E5/E6 | E7 | 结论 |
|---|---|---|---|---|
| 不卡 | — | — | — | **并发相关** → 优先 A′/B′，走 §7.3 |
| 卡 | 不卡 | — | — | **原生内存量**是主因 → 走 §7.3（降 level/限窗） |
| 卡 | 卡 | 不卡 | — | **能效模式/调度降级** → 走 §7.1 |
| 卡 | 卡 | 卡 | 不卡 | **与 zstd 强相关但非并发/非内存** → 怀疑 GCLocker(B′) 或自旋(D′)，抓 `jcmd Thread.print` |
| 卡 | 卡 | 卡 | 卡 | **与 zstd 无关** → 回到系统侧，做 §8 待确认清单 |

#### 每组都要抓的证据（一次上机全部收齐）

```bash
# 卡住瞬间（每组都跑，存成一份）
PID=$(hdc shell "pidof java" | tr -d '\r')
{
  echo "=== pid=$PID ==="
  hdc shell "cat /proc/$PID/status | grep -E 'State|Threads|VmRSS|VmSize'"
  hdc shell "cat /proc/$PID/cgroup"
  hdc shell "cat /proc/$PID/limits"
  hdc shell "hidumper --cpuusage $PID"
  hdc shell "hidumper -e --list java -n 20"
  hdc shell "dmesg | tail -200 | grep -iE 'oom|kill|memory'"
  hdc shell "hilog -x | grep -iE 'MemMgr|has been Killed|killing pid'"
} > eN-$(date +%s).txt
```
外加：`/data/storage/el2/base/files/{backend.log, gc.log, hs_err_*.log}`、以及**卡住时的 `top -H -p <pid>` 快照**。

---

## 7. 解决方案

### 7.1 路径①：CPU 被压制/降级

| # | 措施 | 权限门槛 | 说明 |
|---|---|---|---|
| **① 能效模式豁免 java 进程** | `backgroundProcessManager.setPowerSaveMode(javaPid, PowerSaveMode.EFFICIENCY_MODE)` | `ohos.permission.BACKGROUND_MANAGER_POWER_SAVE_MODE` = **normal 级、免 ACL**，仅 PC/2in1 | ★ 最直接。配套 `isPowerSaveMode(pid)` 先验证 |
| **② 申请长时任务保活** | `startBackgroundRunning` + `module.json5` 的 `backgroundModes: ["taskKeeping"]` | `KEEP_BACKGROUND_RUNNING` = **normal、system_grant、免 ACL**；官方明文「**对 PC/2in1 设备，应用不需要申请 ACL 权限**」 | 申请后**整个应用下所有进程都不会被挂起** |
| ③ 业务结束主动 `stopBackgroundRunning` | — | — | 长时任务必须在业务结束时停，否则上架审核有问题 |
| ④ 注册状态回调 | `on('continuousTaskCancel'/'continuousTaskSuspend'/'continuousTaskActive')` 并打印 `reason` | — | 拿到"何时被挂起"的时间线 |

**② 的业务类型必须选 `TASK_KEEPING`（计算型）** —— 官方规格表里它**没有对应的取消/暂停原因**，比音视频/定位类稳。
⛔ **不要用 `DATA_TRANSFER` 冒充**：官方明文「业务类型与申请的不一致 → 退后台会被挂起或终止」。
⛔ **短时任务没用**：单次 ≤3 分钟、单日 ≤10 分钟配额。

### 7.2 路径②：内存 / 管控类查杀

| # | 措施 |
|---|---|
| ① **把 RSS 压到 4GB 以下**（官方点名的"无维测信息"阈值） |
| ② **收紧 zstd 原生内存**（见 §7.3） |
| ③ **Java 线程池收敛**：固定大小 + 有界队列 + 明确拒绝策略（不要静默丢弃） |
| ④ 加 JVM 参数让原生内存可见（见 §7.4） |

### 7.3 ★★ zstd 使用姿势（实测数据，很可能是真正的解药）

#### 7.3.1 先看实测的原生内存表（`ZSTD_sizeof_CCtx()`，编译本仓库 vendored zstd 实测）

| level | MiB / 单条流 | level | MiB / 单条流 |
|---|---|---|---|
| 1 | 1.31 | 12 | 44.74 |
| **3（默认档）** | **3.49** | 15 | 68.74 |
| 5 | 5.24 | **19** | **89.50** |
| 9 | 14.74 | 20 / 21 / 22 | **193.5 / 385.5 / 833.6** |

**★ 为什么会"永远选最大档"**：`ZstdOutputStream` 没有 `setPledgedSrcSize` → 源码传 `ZSTD_CONTENTSIZE_UNKNOWN` → 命中 `tableID=0`（default 表，`compress/zstd_compress.c:7759-7786`）→ **流式压缩永远按该 level 的完整 windowLog 分配**（窗口表见 `compress/clevels.h:25-130`）。

**换算**：
- **16 条并发流 @ level 19 ≈ 1.4 GiB 纯 `malloc`**
- **64 条 ≈ 5.6 GiB**
- 全部走 `malloc`（`common/zstd_deps.h:66-68`），**完全不吃 `-Xmx`**
- 一次性 API `Zstd.compress(dst,src,level)` 实测（1 MiB 输入）：level1 = 0.56 MiB → **level19 = 17.25 MiB**

#### 7.3.2 ★ 必须改的四条

| # | 规则 | 原因 |
|---|---|---|
| **①** | **所有 `Zstd*` 对象必须 `close()`** | 维护者确认（issue #156）：**native 内存随存活流数线性增长，close 即回收**；只用 `flush()` 不 `close()` 会泄漏（issue #175） |
| **②** | **用信号量把并发数钉死**（而不是靠线程池大小） | 内存 = 并发数 × 上表数值。**这是唯一能把原生内存钉死的办法** |
| **③** | **显式 `setWindowLog()` 限窗 / 降低 level** | level 是内存的一阶决定因素（level 3 与 19 差 **25 倍**） |
| **④** | **不要每个任务 `new` 一个上下文** | `Zstd.compress(...)` 每次都 create/free 一个 CCtx；应换成**长期存活的 `ZstdCompressCtx`** |

#### 7.3.3 ★ 两个容易致命的用法错误

**错误一：跨线程共享 `ZstdCompressCtx`**（**不受保护**）

`AutoCloseBase.java:27-40` 的 `acquireSharedLock()` **不是互斥锁**，只是一个「共享计数锁」（CAS +1），语义仅为"有活跃使用者时 `close()` 抛异常"。而 `ZstdCompressCtx.compressByteArray()`（`ZstdCompressCtx.java:691-710`）**只调它、没有 `synchronized`** → **两个线程可以同时进同一个原生 `ZSTD_CCtx`**。

- 后果：**静默数据损坏 / SIGSEGV**（不是卡死）
- 官方 Javadoc（`ZstdCompressCtx.java:31-34`）：「**One such context is required for each thread - put this in a ThreadLocal**」
- 维护者 luben（issue #363）：「single instance of `ZstdOutputStream` should not be used concurrently… **it may work in certain situations but it's unsupported mode**」
- ✅ 对照：`ZstdOutputStream` 系列的 `write/flush/close` **都是 `synchronized`**，Java 侧已串行化

**错误二：`nbWorkers` 同时推高线程数和内存**

`ZSTD_c_nbWorkers` 会**按核数创建原生线程** → **一脚可能同时踩两条线**（`ThreadKiller` 线程超限 + 内存阈值）。官方手册原文：「More workers improve speed, but also **increase memory usage**」。

#### 7.3.4 ⚠️ 请确认你的交叉编译命令

本仓库 `make_so_cross.sh` / `make_so.sh` 里带了这两个链接参数：
```
-Wl,--version-script=./libzstd-jni.so.map -Wl,-Bsymbolic
```
**它们用于防止 libzstd-jni 与系统 libzstd 的符号串扰（issue #327 就是这类 SIGSEGV，1.5.6-7 修复）。**
如果你是自己手写的编译命令且**漏了这两个**，等于重新打开了那类崩溃。
另外注意：仓库脚本**没有加 `-DNDEBUG`** → 产出的 .so 里 **assert 是活的**，异常时会 `SIGABRT` 而不是静默。

### 7.4 可观测性建设（必做，否则下次还是"无日志"）

**① Electron 侧——先把信号打出来**（`main.js:193`）
```js
child.on('exit', (code, signal) =>
  console.error(`[backend] exited: code=${code} signal=${signal}`));
//  ★ 被信号杀死时 code=null、signal='SIGKILL'；原来的写法只会打 "exited: null"
```
> ✅ 模板已挂 `child.stdout/stderr.on('data')`，管道是被消费的。（若你的实际代码没有消费，会多一个"管道写满阻塞"的机制——见 §6.5）

**② JVM 侧——★ 注意：上一版我给的两个参数是无效的，这里更正**

| 参数 | 对 JNI `malloc` 失败是否有效 | 说明 |
|---|---|---|
| `-XX:MaxDirectMemorySize` | ❌ **无效** | 官方文档：「Sets the maximum total size of the **`java.nio` package, direct-buffer allocations**」——**只管 `ByteBuffer.allocateDirect`** |
| `-XX:NativeMemoryTracking` | ⚠️ **定位不到 zstd** | 官方文档：「**cannot track native memory allocated outside of the JVM, for example by JNI code**」。只能拿它算「RSS − NMT」的差值 |
| `-XX:+HeapDumpOnOutOfMemoryError` | ❌ **无效** | 只在 **Java `OutOfMemoryError`** 上触发；原生 malloc 失败不产生它 |
| `-XX:+ExitOnOutOfMemoryError` | ❌ **无效** | 同上 |
| **`-XX:ErrorFile=<绝对路径>/hs_err_%p.log`** | ✅ **有效且必须加** | 默认写到**子进程的 CWD**（沙箱内你根本找不到）；SIGSEGV 时会写 |

> issue #156 报障人原话与本故障现象一致：「going well beyond the jvm's -mx value. **When it crashes there is no heap dump**」。

**建议的启动参数**：
```bash
-XX:ErrorFile=/data/storage/el2/base/files/hs_err_%p.log \     # ★ 唯一有效的崩溃取证
-Xlog:gc*:file=/data/storage/el2/base/files/gc.log:time,uptime,level,tags \
-XX:NativeMemoryTracking=summary -XX:+PrintNMTStatistics \     # 仅作 RSS 差值参考
-XX:+HeapDumpOnOutOfMemoryError                                # 仅覆盖 Java 堆 OOM（仍值得留）
```
> 粗分法仍然可用：**原生 ≈ `smaps_rollup` 的 Anonymous − `MemoryMXBean.getHeapMemoryUsage().getUsed()`**，按秒打日志，差值增速即原生增速。
> ⚠️ 另注：**zstd-jni 没有把 `ZSTD_sizeof_CCtx` / `ZSTD_estimateCStreamSize` 导出给 Java**，所以运行时无法从 Java 侧查询原生占用——只能靠上面这个差值法。

**③ ArkTS 侧——订阅死因事件**（无日志场景下**唯一能拿到死因的正规途径**）
```
HiAppEvent 订阅：APP_KILLED / RESOURCE_OVERLIMIT / APP_FREEZE
（事件异步，下次启动才送达）
```

**④ 用官方工具例行巡检**
```bash
hdc shell "hidumper -e --list java -n 20"     # 异常退出记录（保留 30 天）
hdc shell "hidumper -p <pid> --thread"        # 线程泄漏（API 26）
hdc shell "hidumper -s 1909"                  # MemMgrService
```

### 7.5 ★ 无条件加固（不管最终是哪条根因，改了都只有好处）

> **这一节是给"测试链路长、想一次性改到位"的场景准备的。** 下面 10 条互相独立，可以一次性全做，
> 做完再测——即使没定位到唯一根因，也大概率把问题压下去，而且每一条都是正当的工程实践。

| # | 加固项 | 针对的机制 | 成本 |
|---|---|---|---|
| **1** | **所有 `Zstd*` 对象 `close()`**（用 try-with-resources） | A′ 原生内存泄漏（issue #156/#175） | 低 |
| **2** | **用信号量把 zstd 并发数钉死**（如 4），而不是靠线程池大小 | A′ / B′ | 低 |
| **3** | **降压缩级别**（19 → 3 或 1）或**显式 `setWindowLog()`** | A′（内存差 25 倍） | 低 |
| **4** | **`ZstdCompressCtx` 放 `ThreadLocal`**，不要跨线程共享 | 静默数据损坏 / SIGSEGV（issue #363） | 低 |
| **5** | **不要每任务 `new` 上下文**，改长期存活复用 | A′ + GC 压力 | 中 |
| **6** | **`child.on('exit', (code, signal))` + 后端输出落文件** | 可观测性（否则永远"无日志"） | 低 |
| **7** | **JVM 加 `-XX:ErrorFile=<绝对路径>` + `-Xlog:gc*`** | 崩溃取证 / GCLocker 取证 | 低 |
| **8** | **申请 `TASK_KEEPING` 长时任务** + **`setPowerSaveMode(javaPid, EFFICIENCY_MODE)`** | §2 调度降级 + §3 能效模式 | 中 |
| **9** | **Java 线程池收敛**：固定大小 + 有界队列 + 明确拒绝策略（不要静默丢弃） | §4 ThreadKiller / 线程池吞异常 | 低 |
| **10** | **核对交叉编译参数含 `-Wl,-Bsymbolic` 与 `--version-script`** | issue #327 类符号串扰 SIGSEGV | 低 |

**组合效果预估**：`1+2+3` 三条一起做，zstd 的原生内存占用通常能降一个数量级（level 19→3 差 25 倍，并发减半再减半）。
**若做完这 10 条仍复现**，说明根因在系统侧（§2 调度降级 / §3 能效模式）或与 zstd 无关，按 §0.5 决策树继续。

---

## 8. 待确认清单（上机后逐条销项）

| # | 项 | 怎么测 |
|---|---|---|
| 1 | **卡住时 java 进程在不在** | `pidof java` —— **最高优先级** |
| 2 | **重新聚焦窗口能否恢复** | 鼠标点一下 Electron 窗口（5 秒） |
| 3 | java 与 Electron 的 **cgroup 归属**是否不同 | `/proc/<pid>/cgroup` 对照 |
| 4 | **能效模式**是否开启 | `backgroundProcessManager.isPowerSaveMode(pid)` |
| 5 | **线程数峰值**是多少、是否触顶 | `/proc/pid/status` 的 `Threads` + `hidumper -p <pid> --thread` |
| 6 | **RSS 峰值**是否接近/超过 4GB | `memory.max_usage_in_bytes` / `hidumper --mem` / smaps_rollup |
| 7 | 有无 `[backend] exited: code=... signal=...` | 先按 §7.4① 改日志 |
| 8 | `hidumper -e --list` 有无记录 | 直接跑 |
| 9 | `/dev/memcg/` 下有 v1 还是 v2 文件 | `hdc shell "ls /dev/memcg/"`（❓ OH 的 cgroup 版本官方未公开说明） |
| 10 | 坚盾模式是否开启（会禁 JIT） | 系统设置 |

---

## 9. 诚实说明：本文**未**断言的

| 项 | 状态 |
|---|---|
| `ThreadKiller`/`RssThresholdKiller` 的**具体阈值** | ❓ 未找到官方公开数值（社区转载称线程 700 / FD 5000，**未证实**） |
| 官方能否「只杀子进程、保留父进程」 | ❓ 未找到；现有证据**都不支持**该路径 |
| OpenHarmony 的 memcg 是 cgroup v1 还是 v2 | ❓ 一份报告据 `memmgrservice.cfg` 判为 v1，另一份**未确认** → **以真机 `ls /dev/memcg/` 为准** |
| 各组 `cpu.shares` 具体数值 | ❓ 需实机读 |
| 华为 5 篇稳定性文档正文（《应用被查杀类问题分析方法》等） | ❓ 标题确认存在，**全站 JS 渲染抓不到** |
| zstd 单上下文的具体内存数值 | ❓ 本轮未取得；应用官方 `ZSTD_estimateCCtxSize()` 自行估算，不要套用网上数字 |
| 「退后台多久被挂起」的精确秒数 | ❓ 官方只说"由系统定义"，但 PC 能效模式给了 **10–15 秒**的明确窗口 |

---

## 10. 出处与产出物

**本专项配套调研报告（仓库内，全部带官方源码出处）**
| 文件 | 内容 |
|---|---|
| 《鸿蒙子进程管控与异常退出痕迹_补充调研.md》 | ★ spawn 子进程不进鸿蒙进程模型（代码级）、cgroup 降级、MemMgr 日志、`hidumper -e` |
| 《鸿蒙应用冻结与后台任务管理机制调研.md》 | 能效模式、长时任务 `TASK_KEEPING`、挂起粒度、类似案例 |
| 《鸿蒙应用资源限制与无日志被杀根因调研.md》 | 官方 kill 原因表、SIGKILL 无日志、隐藏可观测手段 |
| 《鸿蒙原生内存OOM管控_专项补充调研.md》 | memcg 路径与读法、堆/原生分账、zstd 内存预算 |
| **《zstd-jni原生内存与并发调研.md》** | ★ **实测** `ZSTD_sizeof_CCtx` 分 level 内存表、复现 NULL 解引用 SIGSEGV、GCLocker 机制、21 条上游 issue |

**官方依据（关键几条）**
- `dfx/appkilled-guidelines.md:12,28` —— SIGKILL 不生成维测信息；**RSS>4GB 属无维测信息场景**
- `dfx/hidumper.md` —— **`hidumper -e --list` 专治"无 faultlog 的异常退出"**（API 22+）
- `task-management/background-task-overview.md:12,17` —— 挂起粒度与资源配额（**前台只 warning、后台直接终止**）
- `continuous-task.md:35,91` —— `TASK_KEEPING` 与「PC/2in1 免 ACL」；「整个应用下的所有进程均不会被挂起」
- OpenHarmony `resourceschedule_*` 源码 —— `supervisor.cpp:349-365`、`cgroup_adjuster.cpp:112-128,155-195`、`low_memory_killer.cpp:78-124`、`kernel_interface.cpp:375-396`
- 华为官方支持文档《华为鸿蒙电脑如何开启/关闭能效模式》—— 能效模式 10–15 秒触发、父子进程共享
- zstd 官方手册 <https://facebook.github.io/zstd/zstd_manual.html>

---

## 附录 A ★ 上机命令总表（一页速查，按用途分组）

> 标注：【OH】= 鸿蒙特有 ｜【L】= 标准 Linux ｜【权限】= 需要特殊权限

### A.1 定性（最先跑这几条）

| 目的 | 命令 | 判读 |
|---|---|---|
| **进程还在吗** | `hdc shell "ps -ef \| grep -i java"` 或 `hdc shell "pidof java"` | 空 = 已死；有值 = 活着 |
| **卡住时点一下窗口** | （手工操作） | 恢复 ⇒ 能效模式 |
| **CPU 占用** | `hdc shell "hidumper --cpuusage <pid>"`【OH】 | ≈0 ⇒ 压制/GC 锁死；单核 100% ⇒ 自旋 |
| **逐线程 CPU** | `hdc shell "top -H -p <pid>"`【L】 | 区分自旋 vs 压制 |
| **进程状态/线程数** | `hdc shell "cat /proc/<pid>/status \| grep -E 'State\|Threads\|VmRSS\|VmSize'"`【L】 | `T`=被停；`D`=内核等待；线程数对照阈值 |

### A.2 调度与 CPU（§2 / §3）

| 目的 | 命令 | 判读 |
|---|---|---|
| **cgroup 归属** | `hdc shell "cat /proc/<java_pid>/cgroup"`【L】<br>`hdc shell "cat /proc/<electron_pid>/cgroup"` | java 在 `/dev/cpuctl` 根、Electron 在 `top-app` ⇒ 降级成立 |
| CPU 组权重 | `hdc shell "cat /dev/cpuctl/cpu.shares"`【OH】<br>`hdc shell "cat /dev/cpuctl/top-app/cpu.shares"` | ❓ 具体值需实机读 |
| **能效模式查询** | ArkTS：`await backgroundProcessManager.isPowerSaveMode(pid)`【权限】`ohos.permission.BACKGROUND_MANAGER_POWER_SAVE_MODE`（normal 免 ACL，仅 PC/2in1） | `true` ⇒ 被压制 |
| **能效模式豁免** | ArkTS：`setPowerSaveMode(pid, PowerSaveMode.EFFICIENCY_MODE)` | 解法本身 |

### A.3 内存（§4 / §6.5 A′）

| 目的 | 命令 | 判读 |
|---|---|---|
| RSS/虚拟内存 | `hdc shell "cat /proc/<pid>/status \| grep -E 'VmRSS\|VmSize'"`【L】 | RSS 接近/超 4GB ⇒ 官方点名场景 |
| **匿名内存**（≈堆+native） | `hdc shell "cat /proc/<pid>/smaps_rollup \| grep -E 'Rss\|Anonymous'"`【L】 | 与 heapUsed 相减估原生占用 |
| 上限 | `hdc shell "cat /proc/<pid>/limits"`【L】 | `Max address space` = unlimited ⇒ 排除 RLIMIT_AS |
| memcg 文件 | `hdc shell "ls /dev/memcg/"`【OH】 | 判定 v1(`memory.oom_control`) 还是 v2(`memory.events`) |
| OOM 计数（v1） | `hdc shell "cat /dev/memcg/<userId>/memory.oom_control"`【OH】 | ⚠️ **鸿蒙查杀走用户态 `kill()`，此计数不会增加**，别当主证据 |
| 内存峰值 | `hdc shell "cat /dev/memcg/<userId>/memory.max_usage_in_bytes"`【OH】 | 与故障时刻对齐 |
| 内存明细 | `hdc shell "hidumper --mem <pid>"`【OH】 | 含 `Total Pss by OOM adjustment` |
| 堆快照 | `hdc shell "hidumper -p <pid> --mem-smaps -v"`【OH】（需 debug 版应用） | — |

### A.4 死亡取证（§5 / §6.5 A′）

| 目的 | 命令 | 判读 |
|---|---|---|
| **★ 异常退出记录** | `hdc shell "hidumper -e --list java -n 20"`【OH, API22+】 | 含 `time/foreground/reason/record_id`；**官方样例里有 `foreground=True` + `LowMemoryKill`** |
| 故障详情 | `hdc shell "hidumper -e --print java"`【OH】 | — |
| **内核 OOM** | `hdc shell "dmesg \| grep -iE 'out of memory\|killed process\|oom'"`【L】 | **唯一能找到 SIGKILL 证据的地方** |
| 内存管控日志 | `hdc shell "hilog -x \| grep -iE 'MemMgr\|has been Killed\|killing pid\|minPrio'"`【OH】domain `0xD001799`，**ERROR 级** | 出现 `has been Killed !` ⇒ memmgr 动手 |
| 冻结检测 | hilog domain **`0xD002D01`**（FreezeDetector）【OH】 | — |
| JVM 崩溃文件 | `hdc shell "find / -name 'hs_err_pid*.log' -newermt '-1 day' 2>/dev/null"`【L】 | 在**子进程 CWD**，不在应用目录 |
| faultlog | `hdc shell "ls -l /data/log/faultlog/faultlogger/ \| tail"`【OH】 | — |
| 资源超限 | `hdc shell "ls -l /data/storage/el2/log/resourcelimit/ 2>/dev/null"`【OH】 | `RESOURCE_OVERLIMIT_*` |
| 系统事件列表 | `hdc shell "hidumper -e --list"`【OH】 | — |

### A.5 线程与 GC（§6.5 B′/D′）

| 目的 | 命令 | 判读 |
|---|---|---|
| **线程栈** | `hdc shell "jcmd <pid> Thread.print" \| grep -A5 -iE 'GCLocker\|stall_until_clear'"`【L】 | 大量线程停在此 ⇒ **GC 被 JNI Critical 锁死** |
| 线程泄漏 | `hdc shell "hidumper -p <pid> --thread"`【OH, API26】 | — |
| fd 泄漏 | `hdc shell "hidumper -p <pid> --fd"`【OH】 | — |
| GC 日志 | `-Xlog:gc*:file=...:time,uptime,level,tags` | 密集 `Pause Young (GCLocker Initiated GC)` ⇒ B′ |
| 管道阻塞 | `hdc shell "cat /proc/<pid>/task/*/wchan"`【L】 | 出现 `pipe_write` ⇒ stdio 管道写满 |
| 后端内存服务 | `hdc shell "hidumper -s 1909"`【OH】 | MemMgrService |

### A.6 一次收全的取证脚本（卡住瞬间执行）

```bash
#!/bin/bash
PID=$(hdc shell "pidof java" | tr -d '\r'); TS=$(date +%Y%m%d-%H%M%S); OUT="capture-$TS"
{
  echo "===== java pid=[$PID]  $(date) ====="
  echo "--- 进程状态 ---";      hdc shell "cat /proc/$PID/status | grep -E 'State|Threads|VmRSS|VmSize'"
  echo "--- cgroup 归属 ---";   hdc shell "cat /proc/$PID/cgroup"
  echo "--- limits ---";        hdc shell "cat /proc/$PID/limits"
  echo "--- CPU ---";           hdc shell "hidumper --cpuusage $PID"
  echo "--- 逐线程 ---";        hdc shell "top -H -p $PID -n 1 -b" 2>/dev/null | head -40
  echo "--- 异常退出记录 ---";  hdc shell "hidumper -e --list java -n 20"
  echo "--- dmesg oom ---";     hdc shell "dmesg | grep -iE 'out of memory|killed process|oom' | tail -20"
  echo "--- MemMgr hilog ---";  hdc shell "hilog -x | grep -iE 'MemMgr|has been Killed|killing pid' | tail -20"
  echo "--- memcg ---";         hdc shell "ls /dev/memcg/; cat /dev/memcg/*/memory.max_usage_in_bytes 2>/dev/null"
} | tee "$OUT.txt"
echo "已保存 $OUT.txt；别忘了同时收集 backend.log / gc.log / hs_err_*.log"
```

---

## 附录 B zstd-jni 已知 issue 速查（判断"是不是已知坑"）

> 来源：上游 issue tracker 全量检索（详见配套报告）。**你自编译的是 v1.5.7-23，下列已修项应已包含。**

| issue | 现象 | 状态 |
|---|---|---|
| **#119** | **线程 dump 永久停在 `ZstdOutputStream.compressStream(Native Method)`**（close 顺序 bug） | 1.4.4-10 修 |
| **#298** | **workers=4 后"stuck"——实为极慢，不是死锁** | 已知行为 |
| **#346** | **JNI Critical Section 阻塞 GC** | ❌ **维护者 2026-08-27 明确拒绝修**；JEP 423 需 JDK22+ |
| **#156** | RSS 远超 `-Xmx`、崩溃无 heap dump；维护者确认 **native 内存随存活流数线性增长、close 即回收** | 设计如此，推荐 `RecyclingBufferPool` |
| **#175** | 只用 `flush()` 不 `close()` 会泄漏 | 用法问题 |
| **#363** | 维护者确认**不可跨线程共享** ctx（「unsupported mode」） | 设计如此 |
| **#327** | libzstd-jni 与系统 libzstd **符号串扰 SIGSEGV** | 1.5.6-7 修（编译需 `-Bsymbolic`） |
| **#331** | close `ZstdCompressCtx` 时 SIGSEGV | 1.5.6-8 修 |
| **#404** | `ZstdCompressCtx.loadDict` 跨对象 use-after-free | 1.5.7-15 修 |
| **#412** | 移除 finalize 后无 Cleaner，ThreadLocal 用法不安全 | **open** |
| #203 / #309 / #310 / #26 / #83 | worker handle 泄漏 / by-reference 泄漏 / 无 finalizer 泄漏 | 多数已修 |
| #116 / #356 / #389 | InputStream 特定 chunk 挂住 / `setDict(null)` segfault / 报错类名写错 | — |

**❓未找到**：zstd-jni README 里关于「不受 `-Xmx` 约束」或 thread-safety 的官方章节（README 里没有这两节，已与上游 master diff 确认）；MT/`nbWorkers>0` 的内存放大倍数官方公式。

---

## 附录 C 一页纸速查（贴在手边）

```
【上机前先改】
  main.js : child.on('exit',(code,signal)=>…) + 后端输出落文件
  JVM     : -XX:ErrorFile=/data/storage/el2/base/files/hs_err_%p.log
            -Xlog:gc*:file=/data/storage/el2/base/files/gc.log:time,uptime,level,tags

【卡住瞬间，按顺序】
  1. hdc shell "pidof java"                     → 空=死了 / 有值=活着
  2. 鼠标点一下 Electron 窗口                      → 恢复=能效模式
  3. hdc shell "top -H -p <pid>"                → 全0%=压制 / 单线程100%=自旋
  4. hdc shell "cat /proc/<pid>/cgroup"         → 与 Electron 对比
  5. hdc shell "hidumper -e --list java -n 20"  → 死了就看这（无 faultlog 的正解）
  6. hdc shell "dmesg | grep -i oom"            → 被杀的唯一证据处
  7. hdc shell "jcmd <pid> Thread.print | grep GCLocker"  → GC 锁死
  8. hdc shell "cat /proc/<pid>/task/*/wchan"   → pipe_write = 管道写满

【定位后】
  活着 + CPU≈0 + 聚焦恢复   → 能效模式     → setPowerSaveMode + TASK_KEEPING
  活着 + cgroup 在根组      → 调度降级     → §7.1
  活着 + GCLocker           → GC 被锁死    → 降并发（§7.3.2②）
  活着 + 单线程 100%        → 自旋         → 换实现/降版本
  死了 + dmesg 有 oom       → 内核 OOM     → §7.2 + §7.3
  死了 + hidumper -e 有记录 → 管控查杀     → 看 reason 列
  死了 + 都没有             → 快速泄漏类   → §7.2 + §7.3

【无条件先做（§7.5）】
  Zstd* 全 close() · 信号量钉死并发 · 降 level / 限 windowLog ·
  ZstdCompressCtx 放 ThreadLocal · 长时任务 + 能效豁免 · 线程池收敛
```

---

*本文结论建立在「三条现场事实（Electron 正常 / 无日志 / 必现于 zstd）」之上。若真机验证后事实有变（例如 java 进程其实已消失），请按 §0.5 决策树或 §6.4 判读表切换到对应分支。*
