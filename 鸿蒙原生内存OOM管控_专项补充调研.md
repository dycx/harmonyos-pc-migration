# 专项补充：zstd 处理期「Java 子进程被吃 / 卡住且无日志」的 cgroup 内存与原生内存排查

> 触发本次补充的现场事实：Electron 界面完全正常可操作、应用**始终前台**、现象约 10s 出现但不固定、**每次都在处理 zstd 压缩包时发生**。
> 结论方向：**堆外/原生内存（zstd 上下文）暴涨 → 触发内存管控**。
>
> 分级沿用主报告：`【官方明确】`/`【官方代码 文件:行号】`/`【官方文档·转载】`/`【社区实践】`/`【推测】`/`【未找到】`。
> 主报告：`鸿蒙应用资源限制与无日志被杀根因调研.md`

---

## 0. 先给结论：三条候选链路 + 一句话判别

| 链路 | 机制 | 与"界面正常 / 约10s / 无日志"的吻合度 |
|---|---|---|
| **M1. memcg OOM 直接 kill** | 进程所属 memory cgroup 用量触顶 → **cgroup 内 OOM killer 挑一个 task，杀其整个线程组**（只死 Java，Electron 存活） | ★★★★★ |
| **M2. memcg OOM wait（"停而不杀"）** | 若该 cgroup 的 `memory.oom_control` 里 `oom_kill_disable=1`，内核**不杀**，触发分配的 task 被 **stop 等待**（`under_oom=1`），内存释放后自动恢复 | ★★★★★（"不固定""约10s""任务像被掐掉又像卡住"高度吻合） |
| **M3. 整机/内核 OOM killer** | 全局内存紧张，按 `oom_score_adj` badness 挑**一个进程**（整个线程组）杀 | ★★★★☆ |
| ~~M4. memmgr userspace LowMemoryKiller~~ | 它**以 bundle 为单位选中，并杀掉该 bundle 的所有进程** | ★☆☆☆☆ **与现象矛盾**（Electron 也该死），除非 Java 子进程未被 AMS 登记进 `bundle.procs_` |
| **M5. 管控类 kill（线程数/RSS 超限）** | `ThreadKiller` / `RssThresholdKiller` / `ResourceLeak(ThreadLeak)` | ★★★★☆（zstd 多线程会同时推高线程数与 RSS） |

**一句话判别**：**"完全没有任何日志"这一条本身就排除了 `RLIMIT_AS` 触顶**（那会产生可捕获的分配失败/异常），指向 **SIGKILL** 或 **OOM-wait 停止**。再靠"进程还在不在"把 M2 与 M1/M3/M5 分开。

---

## 1. 鸿蒙的内存 cgroup 是 **v1**，不是 v2 —— 这直接决定你该读哪些文件

### 1.1 官方代码证据

```jsonc
"mkdir /dev/memcg",
"mount cgroup none /dev/memcg memory",
"chown system system /dev/memcg/tasks",
"chown system system /dev/memcg/memory.oom_control",
"chown system system /dev/memcg/cgroup.event_control",
"chown system system /dev/memcg/memory.pressure_level",
```
→ `resourceschedule_memmgr/services/memmgrservice/memmgrservice.cfg:12-23`【官方代码】

判定依据（三条互相印证）：
1. `mount` 的第 4 个参数是 **v1 控制器名** `memory`；
2. 里面出现 **`tasks`**（cgroup v1 专有文件，v2 没有）；
3. 出现 **`memory.oom_control` / `cgroup.event_control` / `memory.pressure_level`**，全是 v1 专有（kernel.org cgroup-v1 文档明确列出，且标注 `memory.oom_control` 已废弃）。

> **⚠️ 因此：`memory.max` / `memory.high` / `memory.events` / `memory.oom.group` 这些 v2 文件在 OpenHarmony 上按设计就不存在**。
> v1 的对应物是：`memory.limit_in_bytes`（≈max）、`memory.soft_limit_in_bytes`（已废弃无效）、`memory.oom_control`（含 `oom_kill` 计数）。
> 但**商用 HarmonyOS 可能同时/改用 unified(v2) 层级 → 必须实测判定（下一节给命令），不要假设。**

### 1.2 OpenHarmony **不设置任何内存硬上限**（重要）

对全部离线官方仓做 grep：**`limit_in_bytes` / `usage_in_bytes` / `soft_limit` 命中数为 0**。
memmgr 实际只使用这些 memcg 文件（均为 Huawei vendor 扩展 + 标准 `memory.stat`）：

| 文件 | 用途 | 出处 |
|---|---|---|
| `memory.app_score` | 回收优先级打分 | `memcg.cpp:207` |
| `memory.stat` | 读取 refault/swap 统计 | `memcg.cpp:146` |
| `memory.zswapd_single_memcg_param` / `memory.zswapd_memcgs_param` | 配置 mem→zram(60%)、zram→ufs(10%)、refault 阈值(50) | `memcg.cpp:210,263`；`memmgr_config_manager.cpp:162`；`reclaim_strategy_constants.h:26-30` |
| `memory.ub_ufs2zram_ratio` / `memory.force_swapin` / `memory.force_shrink_purgeable_bysize` | 换入/回收控制 | `memcg.cpp:236,238`；`purgeable_mem_utils.cpp:35` |
| `memory.avail_buffers`（写在 **root** memcg） | 系统可用内存水位，驱动 killer | `avail_buffer_manager.cpp:108` |
| `memory.zswapd_pressure_show` / `memory.eswap_info` | zswapd 压力 / eswap 健康度 | `kernel_interface.cpp:45`；`nandlife_controller.cpp:54` |

**→ 结论：OpenHarmony 上应用**没有** per-app `memory.limit_in_bytes` 硬上限**，所以 **M1/M2 两条 memcg-OOM 路径在开源版上不会因"应用自己的限额"触发**；它们要么来自（a）v2 层级上的 `memory.max`（商用版可能设），要么来自（b）**root/整机**层面的 OOM。（b）属于 M3。
**→ 商用 HarmonyOS 的 per-app 限额存在性与默认值：【未找到】。必须现场读文件确认（下面命令）。**

### 1.3 应用进程在哪个 memory cgroup？

【官方代码】memmgr 建的是 **按用户（userId）维度** 的 memcg：

```cpp
// user memcg dir: "/dev/memcg/${userId}"
```
→ `resourceschedule_memmgr/services/memmgrservice/src/reclaim_strategy_manager/memcg.cpp:323-325`；进程通过写 **`/dev/memcg/<userId>/cgroup.procs`** 加入（同文件 `:331`）

**关键推论【推测】**：加入动作由 AMS/memmgr 对**已登记的应用进程**执行；Electron 通过 `fork+exec` 拉起的 Java 子进程如果没被登记，就可能**仍留在 root memcg `/dev/memcg`**。root memcg 无自己的 limit，但它是**整机 OOM 与 zswapd 回收**的主战场，而且不会出现在任何 per-app 统计里。
→ **必查**：`cat /proc/<javaPid>/cgroup` 看它到底落在 `/dev/memcg/<uid>` 还是 `/dev/memcg`（根）。

---

## 2. 超限后的行为：到底杀谁？（官方/内核原文）

### 2.1 cgroup v1 memcg OOM（kernel.org 原文）

> `memory.oom_control` — set/show oom controls.
> **At reading, current status of OOM is shown:**
> - `oom_kill_disable` 0 or 1 (if 1, oom-killer is disabled)
> - `under_oom` 0 or 1 (if 1, the memory cgroup is under OOM, **tasks may be stopped**.)
> - **`oom_kill` integer counter — The number of processes belonging to this cgroup killed by any kind of OOM killer.**
>
> 同文档另有：`memory.failcnt`（show the number of memory usage hits limits）、`memory.max_usage_in_bytes`、`memory.limit_in_bytes`
> —— 出处：https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v1/memory.html 【标准 Linux（非鸿蒙特有）】

**→ `oom_kill` 计数就是你要的"铁证"**：它在故障前后从 N 变成 N+1，就证明是 **cgroup OOM killer** 干的。
**→ `under_oom=1` + 进程还活着 = "停而不杀"**，这正是 M2（最容易被误判为"线程被 kill"的机制）。文档说明"tasks may be stopped / 之后 stopped tasks will work again"。

**杀谁**：v1 memcg OOM 会在**该 cgroup 内**按 badness 选一个 task，然后杀其**整个线程组**（即整进程）；
若走 v2，另有 `memory.oom.group`（默认 `0`）：
> "Determines whether the cgroup should be treated as an indivisible workload by the OOM killer. If set, **all tasks belonging to the cgroup … are killed together or not at all**."
> —— https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html 【标准 Linux】
> 同文档：`memory.max` = 硬限，"**the OOM killer is invoked in the cgroup**"；`memory.high` = **只节流，永不触发 OOM killer**。

**→ 所以：若你只看到 Java 子进程死、Electron 活着，说明 `oom.group` 未开或两者不在同一 cgroup。**

### 2.2 整机/内核 OOM killer（M3）

标准 Linux：按 `oom_score_adj` 排序挑选**一个进程**杀掉（杀整线程组）。OH 的 memmgr 会主动改这个值（`resourceschedule_memmgr/services/memmgrservice/src/reclaim_priority_manager/oom_score_adj_utils.cpp:38,51`），所以**前台 Electron 主进程的 oom_score_adj 通常被压低（更不容易被杀），而后台/未登记的 Java 子进程分数更高 → 更可能被单独选中** —— 这与"只死子进程"现象**天然吻合**【推测】。

### 2.3 OpenHarmony 自带的 userspace LowMemoryKiller（为什么它不像本次元凶）

```cpp
for (auto bundle : bundles) { ...
  for (auto itrProcess = bundle.procs_.begin(); itrProcess != bundle.procs_.end(); itrProcess++) {
      HILOGI("killing pid<%{public}d> with uid<%{public}d> of bundle<%{public}s>", ...);
      freedBuf += KernelInterface::GetInstance().KillOneProcessByPid(itrProcess->first);
  }
```
→ `resourceschedule_memmgr/services/memmgrservice/src/kill_strategy_manager/low_memory_killer.cpp:78-113`【官方代码】
杀进程用 `kill(pid, SIGKILL)`（`common/src/kernel_interface.cpp:375-398`），hilog tag **`MemMgr`**、domain **`0xD001799`**（`common/include/memmgr_log.h:25-27`）。

- **选中单位 = bundle（uid）；杀伤范围 = 该 bundle 的所有进程** → 若它动手，Electron 应该也一起死 → **与现象不符**（除非 Java 子进程不在 `bundle.procs_` 里，即未被 AMS 登记）。
- 触发面（三选一，都在 memmgr 内）：
  1. **PSI**：`/proc/pressure/memory`（`services/memmgrservice/include/event/memory_pressure_observer.h:31`）
  2. **kswapd 压力**（`event/kswapd_observer.cpp:54`）
  3. **`memory.avail_buffers`** 水位（`avail_buffer_manager.cpp:108`）
- **OH 默认水位**（配置文件 `<XML_PATH>/memmgr_config.xml` 缺省时的兜底值，单位 MB）：`AVAIL_BUFFER=800`、`MIN_AVAIL_BUFFER=750`、`HIGH_AVAIL_BUFFER=850`、`SWAP_RESERVE=200`
  → `services/memmgrservice/include/reclaim_strategy_manager/reclaim_strategy_constants.h:24-29`；解析兜底见 `common/src/config/avail_buffer_config.cpp:80-86`【官方代码】
  （**注意**：这是 *OpenHarmony 默认*，商用机实际值来自 XML/vendor，**不要当成你设备上的真值**，读 `hidumper -s 1909` 确认。）
- 刚创建的 bundle 有 **3 秒保护期**（`low_memory_killer.cpp:28` `NOT_TO_KILL_DURING = 3`）。
- 优先级数值越大越先被杀（`reclaim_priority_constants.h:22-53`）：`FOREGROUND=0`、`VISIBLE=50`、`BACKGROUND=400`、`FROZEN=600`、`SUSPEND=800`、`EMPTY=900`。
  **→ 前台应用优先级最低分（0），是最后才被 memmgr 杀的** → 再次说明 memmgr 不太可能是本次元凶。

### 2.4 官方承认的「无维测信息」的内存类场景（含一条硬阈值）

> 「6. 系统对应用进行管控时，部分场景无法提供详细的维测信息，比如 LowMemoryKiller、**应用的 RSS 内存超过 4GB**、快速泄漏等。」
> → `docs/zh-cn/application-dev/dfx/appkilled-guidelines.md:28`【官方明确】
> 在线：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/appkilled-guidelines

**→ 「RSS > 4GB」是官方文档点名的、无详细维测的管控场景。zstd 多线程 + 高压缩级别时，原生内存把 RSS 推到 4GB 是现实可能。这是本次最值得优先验证的一条硬阈值。**
（另：同文档 reason 表里的 `RssThresholdKiller`「应用的 RSS 内存超一定阈值」→ `:105`；`SwapFull`「Swap 交换空间接近占满，可能存在个别进程内存泄漏，**或者是后台进程个数太多**」→ `:88`）

### 2.5 内存泄漏维测的触发规则（用于判断"是否已被系统认定为泄漏"）

【官方文档·转载】（华为官方《Resource Leak 检测》文档的可抓取逐字转载，见主报告 §2.4 来源）：
- Native 内存（`PSS_MEMORY`）：以**应用平均动态峰值内存**为基线，60s 轮询，**动态内存峰值超过基线值 2 倍 → 判定泄漏，同时触发管控**
- 内核内存（ashmem/gpu/ion）：软门限（连续 8 个采样周期，30+ 分钟超软门限）/硬门限（单次超）
- 线程：**700**；fd：**5000**

**→ 含义**：一个"平时 300MB、zstd 时冲到 1.5GB"的进程，会**周期性地**被判为 native 泄漏并**触发管控** —— 这解释了"**不固定、约 10s、每次都在 zstd 时发生**"。这是与现象最自洽的机制之一。

---

## 3. 可直接在设备上跑的命令（标注：鸿蒙特有 / 标准 Linux）

> 前置：`hdc shell`。下面 `PID` 指 **Java 后端进程 pid**（`hdc shell "ps -ef | grep -i java"`）。
> 标注说明：**【OH】**=鸿蒙/OpenHarmony 特有路径或文件；**【L】**=标准 Linux 接口（内核通用）。**【权限】**=以 `hdc shell` 的 shell 用户可能读不到。

### 3.1 判定 cgroup 版本 + 定位本进程的 memory cgroup

```bash
# 【L】本进程属于哪些 cgroup：v1 会看到 "N:memory:/xxx" 多行；v2 只有一行 "0::/xxx"
hdc shell "cat /proc/$PID/cgroup"

# 【L】看挂载点与层级
hdc shell "mount | grep -i cgroup"

# 【OH】鸿蒙的 memcg 挂载点与其 v1 文件（存在 memory.limit_in_bytes/tasks 即 v1）
hdc shell "ls -l /dev/memcg | head -40"
hdc shell "ls /dev/memcg/memory.max /dev/memcg/memory.limit_in_bytes 2>&1"   # 哪个存在就是哪套
```

### 3.2 读内存限额与用量（★核心）

**v1 路径（OpenHarmony 官方代码确认的方式）**
```bash
CG=/dev/memcg/<userId>          # 【OH】per-user memcg 目录，见 memcg.cpp:325；userId 一般是 100 或你的应用 uid 前几位
hdc shell "cat $CG/memory.limit_in_bytes"      # 【L】末尾 9223372036854771712 ≈ PAGE_COUNTER_MAX，即“无限制”
hdc shell "cat $CG/memory.usage_in_bytes"      # 【L】当前用量
hdc shell "cat $CG/memory.max_usage_in_bytes"  # 【L】历史峰值  ← 与故障时刻对齐可证明暴涨
hdc shell "cat $CG/memory.failcnt"             # 【L】触限次数   ← 非 0 = 撞过上限
hdc shell "cat $CG/memory.oom_control"         # 【L】★ oom_kill_disable / under_oom / oom_kill
hdc shell "cat $CG/memory.stat"                # 【L】anon/file/slab/... 明细
hdc shell "cat $CG/cgroup.procs"               # 【L】该 memcg 内所有进程（看 Java pid 在不在）
hdc shell "cat /dev/memcg/cgroup.procs"        # 【OH】root memcg —— 若 Java pid 在这里，说明它是“没人管”的进程
```

**v2 路径（如果设备是 unified hierarchy）**
```bash
CG=/sys/fs/cgroup/$(sed -n 's/^0:://p' /proc/$PID/cgroup)
hdc shell "cat $CG/memory.max"      # 默认 max；非 max 就是硬上限
hdc shell "cat $CG/memory.high"     # 只节流不杀
hdc shell "cat $CG/memory.current"
hdc shell "cat $CG/memory.peak"
hdc shell "cat $CG/memory.events"   # 【L】★ oom / oom_kill / oom_group_kill / max / high
hdc shell "cat $CG/memory.oom.group" # 非 0 = 整组一起杀
```
> 字段语义出处（标准 Linux）：`memory.max` 触顶**在该 cgroup 内调用 OOM killer**；`memory.high` **只节流、永不触发 OOM**；`memory.oom.group` **非 0 时全组同生共死**；`memory.events` **默认含子树计数**，只要本 cgroup 的数就用 `memory.events.local`——https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html

**★ 判定逻辑**
- `memory.limit_in_bytes` / `memory.max` = **无限制** → M1/M2（cgroup 内 OOM）**被排除**，转向 M3（整机 OOM）/ M5（管控）。
- 有限制 + `oom_kill` 增加 → **M1 锤定**。
- 有限制 + `under_oom=1` 且进程活着 → **M2 锤定**（"停而不杀"）。
- `failcnt` 增长但 `oom_kill` 不变 → 撞过限但没杀（被回收/被节流救回来了）。

### 3.3 时间序列取证（★在 zstd 复现时开，能一图定性）

```bash
# 在 PC 上执行；1 秒一个采样点，故障前后各抓 60s
PID=$(hdc shell "ps -ef | grep -i java | awk '{print \$2}'" | tr -d '\r' | head -1)
for i in $(seq 1 120); do
  echo "----- $(date +%T) -----"
  hdc shell "grep -E 'VmRSS|VmSize|VmPeak|Threads' /proc/$PID/status" 2>/dev/null
  hdc shell "grep -E 'Rss:|Pss:|Anonymous:|Private_Dirty:|SwapPss:' /proc/$PID/smaps_rollup" 2>/dev/null
  hdc shell "cat /dev/memcg/*/memory.usage_in_bytes /dev/memcg/*/memory.oom_control 2>/dev/null"
  sleep 1
done
```
**看点**：`VmRSS` / `Anonymous` / `Threads` 在 zstd 开始后的**爬升斜率**；`Threads` 是否逼近 **700**；`memory.usage_in_bytes` 是否触及 `limit_in_bytes`；`oom_control` 的 `oom_kill` 是否 +1、`under_oom` 是否变 1。
> 若 `ps -ef` 在采样中途查不到 pid → **进程已被杀**；若 pid 一直都在但 `Threads` 停住、`VmRSS` 不动 → **被停/被冻结**。

### 3.4 区分 Java 堆 vs 原生内存（zstd 的账）

**线程数 / 线程名单（判断是不是把线程数打爆）**
```bash
hdc shell "grep Threads /proc/$PID/status"                        # 【L】
hdc shell "ls /proc/$PID/task | wc -l"                             # 【L】
hdc shell "hidumper -p $PID --thread"                              # 【OH】线程名聚类（API 26+），找 zstd worker
hdc shell "cat /proc/$PID/task/*/comm | sort | uniq -c | sort -rn | head -20"  # 【L】按线程名计数
```

**内存构成**
```bash
hdc shell "cat /proc/$PID/smaps_rollup"          # 【L】Rss/Pss/Anonymous/Private_Dirty/SwapPss —— Anonymous 主要就是 Java 堆+原生 malloc
hdc shell "cat /proc/$PID/statm"                 # 【L】
hdc shell "hidumper --mem $PID"                                        # 【OH】分类内存
hdc shell "hidumper --mem $PID --show-ashmem --show-dmabuf"            # 【OH】
hdc shell "hidumper --mem-smaps $PID -v"                               # 【OH】需 debug 版应用
hdc shell "cat /proc/meminfo | grep -iE 'memfree|memavailable|swap'"
```
官方 API 侧（应用内调用，ArkTS/NA）：`hidebug.getRssInfo()`（读 `/proc/<pid>/status`，轻量）、`hidebug.getAppNativeMemInfo()`（读 `smaps_rollup`+`statm`，返回 pss/vss/rss/sharedDirty/privateDirty…）
→ `docs/zh-cn/application-dev/reference/apis-performance-analysis-kit/js-apis-hidebug.md:1726-1738, 840-869`【官方明确】
（**注意**：它**不区分 Java 堆与 native**，只给总量。）

**JVM 侧（能拿到堆/原生的分账）**
```bash
# 启动参数（二选一或都开）：
#   -XX:NativeMemoryTracking=summary        # 开 NMT
#   -XX:+PrintNMTStatistics                 # ★ JVM 退出时把 NMT 汇总打到 stdout（不依赖 attach，沙箱内最可靠）
#   -Xlog:gc+heap=info:file=/data/storage/el2/base/files/gc.log:time,uptime,level,tags   # 堆曲线

# 若 attach 机制可用（沙箱内可能被禁）：
jcmd $PID VM.native_memory summary
jcmd $PID VM.native_memory baseline        # 打基线
jcmd $PID VM.native_memory summary.diff    # ★ 差分：直接看出哪一类原生内存在涨（Thread/Code/GC/Internal/Other）
jcmd $PID GC.heap_info
jcmd $PID Thread.print
```
> NMT 是 HotSpot 标准能力（毕昇 JDK17 同源）；`jcmd` 需要 attach（`/tmp/.java_pid<PID>` 或 `-XX:+StartAttachListener`），**鸿蒙沙箱内不一定可用 → 优先用 `-XX:+PrintNMTStatistics` + `-Xlog:gc*` 落盘**。
> 【未找到】官方（华为/OpenHarmony）关于 NMT/jcmd 在鸿蒙沙箱内可用性的说明。

**判读方法（不需要 NMT 也能粗分）**：
```
原生近似 = smaps_rollup 的 Anonymous  −  Java 堆“已触碰”量
```
"已触碰"≈ `MemoryMXBean.getHeapMemoryUsage().getUsed()`（或 GC 日志里的 used）。把这两个数按秒打日志，**两者之差的增速就是原生内存的增速**。zstd 处理期差值陡增即证据。

**zstd 侧的可引用事实**（用于估量每个上下文的量级，**不给具体数字**）：
- `ZSTD_c_nbWorkers`：*"Select how many threads will be spawned to compress in parallel… **More workers improve speed, but also increase memory usage.** Default value is 0, aka single-threaded mode"*
- `ZSTD_c_windowLog`：*"This will set a **memory budget for streaming decompression**, with larger values requiring more memory"*
- `ZSTD_c_jobSize`：多线程专用，最小 `ZSTDMT_JOBSIZE_MIN = 512 KB`；`ZSTD_c_overlapLog` 控制每个 job 重载的 overlap
- 官方提供估算 API：`ZSTD_estimateCCtxSize(level)` / `ZSTD_estimateCStreamSize*()` / `ZSTD_estimateDCtxSize()`（*"estimate memory usage of a future {D,C}Ctx"*）
—— 出处：zstd 官方手册 https://facebook.github.io/zstd/zstd_manual.html 【上游官方】
**→ 落地建议：把"并发压缩任务数 × 每上下文估算"当作预算硬约束**；`ZstdCompressor/ZstdOutputStream` 必须 `close()`（否则原生上下文泄漏，`-Xmx` 管不到）；不要为每个任务 `new ZstdCompressor()` 且设 `setWorkers(n)`（那会 线程数×n 地开原生线程，**同时**推高线程数与内存）。

### 3.5 RLIMIT 检查（判断"分配失败"还是"被杀"）

```bash
hdc shell "cat /proc/$PID/limits"     # 【L】标准 Linux；OH 未设置这些（见主报告 §1.6）
```
看四行：`Max address space`（RLIMIT_AS）、`Max resident set`（RLIMIT_RSS）、`Max processes`（RLIMIT_NPROC）、`Max open files`（RLIMIT_NOFILE=32768）。

**两种失败模式的区别（关键判别）**

| | `RLIMIT_AS` 有限 | `RLIMIT_AS` 无限（unlimited） |
|---|---|---|
| 机制 | `mmap`/`brk` 失败 → `malloc` 返回 NULL | 内存真的涨上去，由 memcg/整机 OOM 或管控处理 |
| zstd 表现 | 返回 `ZSTD_error_memory_allocation`（"Allocation error"），Java 侧抛 `ZstdException` / `OutOfMemoryError` | **无任何指示**，直接消失或停住 |
| 日志 | **有**（错误码/异常栈） | **无** |
| 与本次现象 | ❌ 不符（用户说"没有任何异常记录"） | ✅ 相符 |

**→ 因此：只要确认 `/proc/<pid>/limits` 的 `Max address space` 是 `unlimited`，就可以把"malloc 失败"整条排除，把资源全部投到"被杀 / 被停"两条上。**

### 3.6 pids / cpu（次要方向，保留）

```bash
# 【OH】pids cgroup：每应用一个目录 /dev/pids/<userId>/<bundle>/app_<pid>/
hdc shell "ls -l /dev/pids/*/*/app_$PID/ 2>/dev/null"
hdc shell "cat /dev/pids/*/*/app_$PID/pids.current 2>/dev/null"      # 当前任务数
hdc shell "cat /dev/pids/*/*/app_$PID/pids.max 2>/dev/null"          # 文件不存在=未设限
hdc shell "cat /dev/pids/*/*/app_$PID/pids.fork_denied 2>/dev/null"  # =1 表示已被禁止再 fork/clone
hdc shell "cat /dev/pids/*/*/app_$PID/pids.events 2>/dev/null"

# 【OH】cpu cgroup：只有 shares，没有硬配额
hdc shell "cat /proc/$PID/cgroup | grep -E 'cpu|cpuset'"
hdc shell "ls /dev/cpuctl /dev/cpuset"
hdc shell "cat /dev/cpuctl/background/cpu.shares"      # OH 唯一设置的 CPU 参数=512
# 【L】v1 的 CPU 配额文件若存在会是 cpu.cfs_quota_us（OH 不写）；cpu.max 是 v2 名称
hdc shell "ls /dev/cpuctl/cpu.cfs_quota_us /dev/cpuctl/cpu.max 2>&1"
```

### 3.7 日志与事件取证

```bash
# 【L/OH】内核日志：OH 已把 dmesg_restrict 置 1（init.cfg:11），普通 shell 读不到
hdc shell "dmesg | grep -iE 'oom|killed process|out of memory'"      # 大概率 Permission denied
hdc shell "cat /proc/sys/kernel/dmesg_restrict"                      # 确认=1
hdc shell "ls -l /sys/fs/pstore"                                     # eng/root 版的另一条路

# 【OH】内存管控服务视图（含回收优先级、配置）
hdc shell "hidumper -s 1909"
hdc shell "hidumper -s 1909 -a '-h'"

# 【OH】hilog：内存管控、冻结、appspawn
hdc shell "hilog -T MemMgr"          # domain 0xD001799：含 "xxx has been Killed !"
hdc shell "hilog -T FreezeDetector"  # domain 0xD002D01
hdc shell "hilog -T appspawn"        # domain 0xD002C11
hdc shell "hilog | grep -iE 'kill|oom|overlimit|thread'"

# 【OH】故障日志 / 资源超限日志（★重点看这两个目录）
hdc shell "ls -lt /data/log/faultlog/faultlogger/ | head -20"
hdc shell "ls -lt /data/storage/el2/log/resourcelimit/ | head -20"   # RESOURCE_OVERLIMIT_<ts>_<pid>.log
hdc shell "hidumper -s 1201 -a '-p Faultlogger -l'"                  # 需要 dump 权限
hdc shell "hidumper -e --list"                                       # API 22+，异常退出记录列表

# 【L/OH】PSI 与 swap：OH 把 /proc/pressure/memory 设成 system:system 0664（init.cfg:64-65）
hdc shell "cat /proc/pressure/memory"        # 应用/shell 用户很可能 Permission denied
hdc shell "cat /proc/meminfo | grep -iE 'swap|zram'"
hdc shell "cat /sys/block/zram0/mm_stat 2>/dev/null"                 # zram 压缩/占用
hdc shell "cat /dev/memcg/memory.eswap_info 2>/dev/null"             # 【OH】eswap 健康度（NAND 寿命相关）
```

**应用侧唯一可靠的"事后告知"**（必须在故障前埋好）：`hiAppEvent.addWatcher` 订阅 `APP_KILLED` / `RESOURCE_OVERLIMIT` / `APP_FREEZE`；或下次启动读 `LaunchParam.lastExitReason` / `lastExitMessage`（`appkilled-guidelines.md:60-90`）。**事件是异步的，订阅之前发生的故障拿不到。**

---

## 4. "只杀线程不杀进程"在内核层面存在吗？

**不存在。** 三条理由：
1. `SIGKILL` 作用于**线程组**：`kill(pid,...)` 与 `tgkill(tgid,tid,...)` 的最终效果都是终结整个进程；Linux 没有"外部只杀一个线程而保留进程"的接口（进程内自我 `pthread_cancel`/`pthread_exit` 是另一回事，那不是"被系统杀"）。
2. OpenHarmony 里所有管控路径都写的是 `kill(pid, SIGKILL)`：memmgr（`kernel_interface.cpp:392`）、appspawn（`appspawn_cgroup.c:164,241`）、AMS（`KillProcessByPid`）。【官方代码】
3. 官方 kill reason 表的语义单位全部是"**应用/进程**终止"。【官方明确】

**但有两种机制"看起来像只杀了线程"**，务必区分：

| 机制 | 真相 | 现象 |
|---|---|---|
| **memcg OOM wait**（`oom_kill_disable=1`） | 内核**不杀**；触发分配的 task 进入 OOM 等待被 **stop**（`under_oom=1`）。v1 文档："tasks may be stopped"、"stopped tasks will work again" | 进程在、线程全停、无日志、**内存释放后自动恢复** ← 与"约10s、不固定"高度吻合 |
| **cgroup freezer 冻结**（`/dev/frz`） | 整进程被 group-stop | 进程在、CPU=0、无日志；**不会自己恢复**，直到被 thaw |
| 线程池自身静默失败 | `ScheduledExecutorService` 任务抛异常后"subsequent executions are suppressed" | 任务不再跑、无日志，但**进程与其它线程都正常** |

---

## 5. 一页执行清单（照抄即可）

```bash
# 0) 找到 Java pid
PID=$(hdc shell "ps -ef | grep -i java | awk '{print \$2}'" | tr -d '\r' | head -1)
echo "PID=$PID"

# 1) 它在哪套 cgroup 里、内存限额是多少
hdc shell "cat /proc/$PID/cgroup"
hdc shell "cat /proc/$PID/limits"
hdc shell "cat /dev/memcg/*/memory.limit_in_bytes 2>/dev/null || true"
hdc shell "cat /dev/memcg/*/memory.oom_control 2>/dev/null || true"
hdc shell "ls /dev/memcg/memory.max 2>/dev/null && cat /sys/fs/cgroup\$(sed -n 's/^0:://p' /proc/$PID/cgroup)/memory.events"

# 2) 当前规模（线程数 / RSS / 匿名页）
hdc shell "grep -E 'Threads|VmRSS|VmSize' /proc/$PID/status"
hdc shell "grep -E 'Rss:|Anonymous:|Private_Dirty:|SwapPss:' /proc/$PID/smaps_rollup"

# 3) 开启 1s 时间序列（在 zstd 任务开始前就启动）
for i in $(seq 1 180); do
  printf '%s ' "$(date +%T)"
  hdc shell "grep -E 'Threads|VmRSS' /proc/$PID/status 2>/dev/null | tr '\n' ' '"
  hdc shell "grep -E 'oom_kill |under_oom ' /dev/memcg/*/memory.oom_control 2>/dev/null | tr '\n' ' '"
  echo
  sleep 1
done

# 4) 事后取证
hdc shell "ls -lt /data/storage/el2/log/resourcelimit/ | head"
hdc shell "ls -lt /data/log/faultlog/faultlogger/ | head"
hdc shell "hidumper -s 1909"
hdc shell "hilog -T MemMgr | tail -100"
hdc shell "dmesg | tail -50"        # 需要 root/eng
```

**判读表**

| 观测 | 结论 |
|---|---|
| pid 消失 + `oom_kill` +1 | **M1 / M3**：被 OOM killer 杀（cgroup 内 or 整机） |
| pid 消失 + `oom_kill` 不变 | **M5**：管控类 kill（RSS>4GB / RssThresholdKiller / ThreadKiller）→ 必须靠 HiAppEvent/APP_KILLED 或下次启动的 `lastExitReason` |
| pid 在 + `under_oom=1` + CPU 0 + 之后恢复 | **M2**：memcg OOM wait（"停而不杀"） |
| pid 在 + CPU 0 + 不恢复 | 冻结（`/dev/frz`） |
| pid 在 + 正常 + 任务不跑 | 线程池静默吞异常 / `pids.fork_denied=1` 导致 `clone` 失败 |
| 有 zstd 错误码/异常栈 | `RLIMIT_AS` 或 malloc 失败（与本次"无日志"矛盾） |

---

## 6. 本次新增的「未找到」项

1. 商用 HarmonyOS 是否对应用设置 per-app `memory.limit_in_bytes` / `memory.max` 及其默认值 —— **【未找到】**，必须现场读文件。
2. `memory.avail_buffers`（800/750/850/200 MB）在**商用机**上的实际取值 —— OH 默认值有源码，但会被 `<XML_PATH>/memmgr_config.xml`/vendor 覆盖；`hidumper -s 1909` 可查实际值。
3. `memory.avail_buffers` / `memory.app_score` / `memory.zswapd_*` / `memory.eswap_info` 的**内核实现**（Huawei vendor 补丁，不在 OpenHarmony 开源仓）。
4. 官方文档中「RSS > 4GB 管控」的**精确阈值定义与适用版本**（只查到一句定性描述 `appkilled-guidelines.md:28`）。
5. 是否有官方服务会把应用 memcg 的 `oom_kill_disable` 置 1（若置 1，"停而不杀"就是常规行为）—— 全仓 grep 无 `oom_kill_disable` 写入点 → **【未找到】**。
6. NMT / `jcmd` attach 在鸿蒙应用沙箱内的可用性 —— **【未找到】**。
