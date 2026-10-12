# zstd-jni 原生内存 / 并发安全 / 卡死崩溃模式 —— 调研报告

> 调研对象：`_research/zstd-jni-ohos/zstd-jni/`（`git describe` = **v1.5.7-23**，vendored zstd = **1.5.7**）
> 目标：为「鸿蒙 PC（OpenHarmony/musl）+ Electron spawn 的 毕昇 JDK17 Java 后端，处理 zstd 压缩包约 10 秒后无日志卡住」定位根因。
>
> **证据分级**：`【源码核实】` = 直接读本仓库源码；`【自测复现】` = 我用源码编译出的可执行程序实测；`【官方文档】` = Oracle / Node.js / OpenJDK 官方文档；`【社区/issue】` = GitHub issue 与维护者原话；`【推测】` = 我的推断，未验证；`【未找到】` = 确实查不到。

---

## 0. 结论速览（TL;DR）

| # | 结论 | 级别 |
|---|---|---|
| 1 | **`ZstdOutputStream` 走流式压缩时，`windowLog` 由 level 决定，且因为「源大小未知」永远选最大表**：level 1 → 1.3 MiB/流；level 3 → 3.5 MiB/流；level 19 → **89.5 MiB/流**；level 22 → **833.6 MiB/流**。全部是 `malloc`，**不吃 `-Xmx`**。 | 【自测复现】 |
| 2 | **`Zstd.compress(byte[], byte[], level)` 每次调用都 `new ZstdCompressCtx()` + `close()`**，即每次 `ZSTD_createCCtx`+`free`，还要 malloc 整个 workspace（1 MiB 输入实测 level 1 = 0.56 MiB，level 19 = 17.25 MiB）。 | 【源码核实】+【自测复现】 |
| 3 | **`ZstdOutputStreamNoFinalizer` 构造函数不检查 `createCStream()` 是否返回 0**。原生分配失败返回 NULL 后，紧接着的 `setLevel()` 会触发 **真·SIGSEGV**（我已编译复现，exit code 139）。 | 【源码核实】+【自测复现】 |
| 4 | **`ZstdCompressCtx` / `ZstdOutputStream` 的 `acquireSharedLock()` 是「共享计数锁」而不是互斥锁**，两个线程可以同时进入同一个 ctx 的原生调用 → 数据损坏 / SIGSEGV。官方 Javadoc 明写「每个线程一个，放 ThreadLocal」。 | 【源码核实】 |
| 5 | **byte[] 版 API 把整段压缩过程放在 JNI Critical Section（GCLocker）里**，`-Xmx` 受限时会导致 GC 完全停摆、全 JVM 停顿乃至 OOM（issue #346，维护者知情但明确不修）。 | 【源码核实】+【社区/issue】 |
| 6 | **原生 malloc 失败时 zstd 返回错误码（`ZSTD_error_memory_allocation = 64`），zstd-jni 抛 `ZstdIOException`** —— 但如果失败点在 `createCStream()` 上，就是 NULL 解引用 SIGSEGV，**没有 Java 异常**。 | 【源码核实】+【自测复现】 |
| 7 | **`-XX:MaxDirectMemorySize` 只管 `java.nio` direct buffer，完全不管 JNI `malloc`；NMT 也「cannot track native memory allocated outside of the JVM, for example by JNI code」。** | 【官方文档】 |
| 8 | 本仓库 **v1.5.7-23 的 `ZstdCompressCtx` 没有 finalizer / Cleaner**（`SharedDictBase` 有，`ZstdOutputStream` 有，`NoFinalizer` 系列和 `Ctx` 系列都没有）。不 `close()` 就是永久泄漏。 | 【源码核实】 |
| 9 | zstd-jni **README 里没有任何 thread-safety / memory 章节**（上游 master README 与本 fork 逐字节相同）。唯一的官方线程安全表述在 `ZstdCompressCtx` 的 Javadoc 和维护者 issue 回复里。 | 【源码核实】 |
| 10 | 「无任何日志」有三个完全自洽的解释：**(a)** 进程被内核 OOM killer `SIGKILL`（不产生 hs_err）；**(b)** Electron `spawn` 的 stdio 管道写满导致 Java 进程阻塞在 `write()`；**(c)** hs_err 写到了子进程 CWD 而不是用户在看的地方。 | 【官方文档】+【推测】 |
| 11 | **zstd-jni 完全没有把 `ZSTD_sizeof_CCtx` / `ZSTD_estimateCStreamSize` 导出给 Java** —— Java 侧无法运行时查询原生占用，只能自己按表算。 | 【源码核实】 |

---

## 1. 环境基线（先钉死版本与代码路径）

- `version` 文件：`1.5.7-23`；`git describe --tags` = `v1.5.7-23`；`ZSTD_versionString()` 实测 = `1.5.7`。【源码核实】
- **毕昇 JDK 17 走的是 JNI 实现，不是 FFM**：`README.md:60-72` 明确「native operations 已从 JNI 移植到 FFM（JEP 454）……编译为 JDK 22，放在同一个 Jar 的 `META-INF/versions/22`……**JDK 22+ 的运行时加载它们，更老的继续加载 Jar 根目录下的 JNI 实现**」。所以本故障里所有调用都经 `src/main/native/*.c`。【源码核实】
- 交叉编译脚本 `make_so_cross.sh` 的编译选项：
  ```
  -shared -static-libgcc -Wl,--version-script=./libzstd-jni.so.map -Wl,-Bsymbolic -fPIC -O3 -flto \
  -DZSTD_MULTITHREAD=1 -std=c99 -lpthread
  ```
  **注意：既没有 `-DNDEBUG` 也没有 `-O0`** —— 也就是说产出的 `.so` 里 **`assert()` 是活着的**（官方 `make_so.sh` 同样没有 `-DNDEBUG`）。zstd 里有 612 处 `assert(`，触发即 `abort()` → **SIGABRT**（会在 stderr 打印 `Assertion failed: ...`）。这一点在排障时可以直接排除/确认。【源码核实】
  `-Wl,-Bsymbolic` + version script 把 `ZSTD_*` 符号限成 local，这对 issue #327 那类「libzstd-jni 与系统 libzstd 符号串扰导致 SIGSEGV」是必要的；如果用户是**自己手写的编译命令、漏了这两个选项**，就会重新打开 #327 的坑。→ 需要核对用户实际的交叉编译命令。【源码核实】+【社区/issue #327】

---

## 2. 问题 1：原生内存占用

### 2.1 关键 API 的官方语义（vendored `zstd.h`，即上游 zstd 1.5.7 头文件）

| API | 位置 | 语义 |
|---|---|---|
| `ZSTD_sizeof_CCtx(const ZSTD_CCtx*)` | `src/main/native/zstd.h:1206` | 返回**当前实际**占用（含 workspace）|
| `ZSTD_sizeof_CStream` | `zstd.h:1208` | 与 CCtx 同一对象 |
| `ZSTD_estimateCCtxSize(int maxCompressionLevel)` | `zstd.h:1782` | **一次性压缩**预算；`zstd.h:1761-1776` 说明「estimate 假设输入任意大，是 worst case」「**该估算只对 one-shot 有效，对 streaming 无效**，streaming 用 `ZSTD_estimateCStreamSize*()`」 |
| `ZSTD_estimateCStreamSize(int maxCompressionLevel)` | `zstd.h:1807` | **流式压缩**预算；`zstd.h:1787-1796` 「同样假设 src size 任意大」「**size estimation 只对单线程压缩正确**」「`nbWorkers >= 1` 时 `*_usingCCtxParams` 会返回错误码」 |
| `ZSTD_compressBound(size_t)` | `zstd.h:250` | 宏 `zstd.h:249`：`srcSize + (srcSize>>8) + (srcSize < 128KB ? ((128KB - srcSize) >> 11) : 0)`；`srcSize >= ZSTD_MAX_INPUT_SIZE` 时返回错误码（`compress/zstd_compress.c:70-74`）|
| `ZSTD_CStreamOutSize()` | `compress/zstd_compress.c:5954-5957` | `= ZSTD_compressBound(ZSTD_BLOCKSIZE_MAX) + 3 + 4`，实测 **131591 字节** |

### 2.2 窗口缓冲区随 level 的增长关系（权威表）

真正的默认参数表在 **`src/main/native/compress/clevels.h:25-130`**，`ZSTD_defaultCParameters[4][23]`，列是 `W(indowLog), C(hainLog), H(ashLog), S(earchLog), L(minMatch), TL(argetLength), strategy`。

选哪一行由 `compress/zstd_compress.c:7759-7786` 的 `ZSTD_getCParams_internal()` 决定：

```c
U64 const rSize = ZSTD_getCParamRowSize(srcSizeHint, dictSize, mode);
U32 const tableID = (rSize <= 256 KB) + (rSize <= 128 KB) + (rSize <= 16 KB);
```
`tableID == 0` 即「srcSize > 256 KB 或未知」，取 `clevels.h:26-51` 的 **default 表**。

**实测 windowLog / 窗口大小（`ZSTD_getCParams(level, ZSTD_CONTENTSIZE_UNKNOWN, 0)`，我自己编译源码跑出来的）** 【自测复现】：

| level | windowLog | window buffer | chainLog | hashLog | strategy |
|---|---|---|---|---|---|
| 1 | 19 | 512 KiB | 13 | 14 | fast |
| 2 | 20 | 1 MiB | 15 | 16 | fast |
| 3 | 21 | 2 MiB | 16 | 17 | dfast |
| 5 | 21 | 2 MiB | 18 | 19 | greedy |
| 9 | 22 | 4 MiB | 20 | 21 | lazy2 |
| 12 | 22 | 4 MiB | 22 | 23 | lazy2 |
| 15 | 22 | 4 MiB | 23 | 23 | btlazy2 |
| 17 | 23 | 8 MiB | 23 | 22 | btopt |
| **19** | **23** | **8 MiB** | **24** | **22** | btultra2 |
| 20 | 25 | 32 MiB | 25 | 23 | btultra2 |
| 21 | 26 | 64 MiB | 26 | 24 | btultra2 |
| 22 | 27 | **128 MiB** | 27 | 25 | btultra2 |

主导项（`compress/zstd_compress.c:1654-1700` `ZSTD_sizeof_matchState`）：
```
tableSpace = chainSize*4 + hSize*4 + h3Size*4      // chainSize = 1<<chainLog, hSize = 1<<hashLog
optSpace   = strategy >= btopt 时的 (MaxML+MaxLL+MaxOff+Litbits) 表 + ZSTD_OPT_SIZE*(match_t+optimal_t)
```
例：level 19 → window 8 MiB + BT 表 `2^24*4 = 64 MiB` + hash 表 `2^22*4 = 16 MiB` ≈ 88 MiB，与下面实测 89.5 MiB 吻合。
`--long` 等价于 `setLong(windowLog)` → `jni_zstd.c` 的 `Java_..._setCompressionLong`（`ZSTD_c_enableLongDistanceMatching = enable` + `ZSTD_c_windowLog = windowLog`，`windowLog` 超出 10–27 就退回 `windowLog=0`）。也就是说 **`setLong(27)` 直接把窗口顶到 128 MiB，再加 LDM 表**。【源码核实】

### 2.3 ★ 实测原生内存：按 level 的完整表

我用本仓库 `src/main/native` 的源码（`common/*.c compress/*.c decompress/*.c dictBuilder/*.c`，`-O2 -DZSTD_MULTITHREAD=1`）编译了一个测量程序，调用 `ZSTD_sizeof_CCtx()` 取**真实分配量**。【自测复现】

**(A) 流式压缩（`ZstdOutputStream` 走的就是这条路径）= `ZSTD_estimateCStreamSize(level)`**

| level | MiB / 单个流 | level | MiB / 单个流 |
|---|---|---|---|
| 1 | **1.31** | 12 | 44.74 |
| 2 | 1.99 | 13 | 36.74 |
| **3**（zstd 默认档） | **3.49** | 14 | 52.74 |
| 4 | 4.74 | 15 | 68.74 |
| 5–6 | 5.24 | 16 | 36.89 |
| 7–8 | 7.74 | 17 | 56.89 |
| 9 | 14.74 | 18 | 57.50 |
| 10–11 | 24.74 | **19** | **89.50** |
| | | 20 | **193.50** |
| | | 21 | **385.50** |
| | | 22 | **833.58** |

> 复现方式：对新建 CCtx 设 level → `ZSTD_CCtx_reset(session_only)` → `ZSTD_compressStream2(..., ZSTD_e_continue)` 喂 1 MiB → 读 `ZSTD_sizeof_CCtx()`。
> **为什么流式一定是最大档**：`ZstdOutputStream` **没有 `setPledgedSrcSize`**，所以 `ZSTD_getCParamsFromCCtxParams()` 传的是 `ZSTD_CONTENTSIZE_UNKNOWN` → `tableID = 0`（default 表）→ 永远按 level 的完整 windowLog 分配。**`Zstd.compress(byte[])` 那种一次性 API 会按已知 srcSize 自动降档，流式不会** —— 这是本故障里最容易踩的内存放大器。

**(B) 一次性压缩的真实分配（已知 1 MiB 输入，`ZSTD_sizeof_CCtx` after）**

| level | MiB | level | MiB |
|---|---|---|---|
| 1 | 0.56 | 13–15 | 16.49 |
| 3 | 1.24 | 16–17 | 16.64 |
| 9–12 | 10.49 | 18–22 | 17.25 |

**(C) `ZSTD_estimateCCtxSize(level)`（= 未知 srcSize 的最坏估算，也是 `ZSTD_compress()` 可能达到的量级）**：level 1 = 0.56 MiB，3 = 1.24 MiB，9 = 12.49 MiB，19 = **81.25 MiB**，22 = **705.4 MiB**。

**新建但还没用的 CCtx = 5280 字节**（`ZSTD_sizeof_CCtx(fresh)`）。真正的几十上百 MiB 是第一次 `ZSTD_compressStream2` 时才分配的：`compress/zstd_compress.c:2130-2168` 的 `ZSTD_CCtx_init_workspace()` 会算出 `neededSpace`，**先 `ZSTD_cwksp_free(ws, ...)` 再 `ZSTD_cwksp_create(ws, neededSpace, ...)`**（即 free 旧的、malloc 更大的一块）。【源码核实】

### 2.4 ★ 这些内存不受 `-Xmx` 约束 —— 明确出处

- 【源码核实】`src/main/native/common/zstd_deps.h:66-68`：
  ```c
  #define ZSTD_malloc(s) malloc(s)
  #define ZSTD_calloc(n,s) calloc((n), (s))
  #define ZSTD_free(p) free((p))
  ```
  走的是 **libc `malloc`**，与 JVM 堆完全无关。
- 【社区/issue】luben 在 [issue #156](https://github.com/luben/zstd-jni/issues/156)（2021-01-21）原话：
  > "There are two distinct memory allocations:
  > - **native memory used by the library, allocated through the system allocator. It is cleaned on `close` and it will grow linearly with the number if instances of Zstd(Input|Output)Streams you have alive.** Memory is reclaimed immediately, though the system allocator may not return it straight away to the OS.
  > - Java heap memory - there is also a buffer allocated in the java part of the code. It is cleaned through the GC."
  
  同一 issue 的报障人原话（和本故障高度相似）：
  > "the process itself is consuming nearly all of the host's memory **going well beyond the jvm's -mx value. When it crashes there is no heap dump.** Non heap seems ok, so it looks like its pointing to jni stuff."
- 【官方文档】zstd-jni README（本仓库 `README.md`，与上游 `luben/zstd-jni` master README **逐字节相同**，我 diff 过）**完全没有** memory / thread-safety 章节 → 对「不受 -Xmx 约束」**未找到** README 级表述，只有上面的 issue 陈述。

### 2.5 `Zstd.compress(byte[])` 这类一次性 API 每次调用分配多少？

**不是「只分配 `ZSTD_compressBound(srcSize)`」，而是每次调用都完整 create/free 一个 CCtx。**
【源码核实】`src/main/java/com/github/luben/zstd/Zstd.java:77-86`：
```java
public static long compress(byte[] dst, byte[] src, int level, boolean checksumFlag) {
    ZstdCompressCtx ctx = new ZstdCompressCtx();   // -> ZSTD_createCCtx()  (malloc)
    try {
        ctx.setLevel(level);
        ctx.setChecksum(checksumFlag);
        return (long) ctx.compress(dst, src);
    } finally {
        ctx.close();                               // -> ZSTD_freeCCtx()
    }
}
```
- `Zstd.compressBound(long)` 本身不分配，只是算上界（`Zstd.java:914` → `jni_zstd.c:230-232` → `ZSTD_compressBound`）。
- 若走 `ZstdCompressCtx.compress(byte[] src)`（`ZstdCompressCtx.java:784-792`），它会 `new byte[(int) maxDstSize]`（**Java 堆**，吃 `-Xmx`）。
- 若走 `ZstdCompressCtx.compress(ByteBuffer)`（`ZstdCompressCtx.java:757-778`），会 `ByteBuffer.allocateDirect(maxDstSize)`（**native**，受 `-XX:MaxDirectMemorySize` 管）。

**另外**：`ZstdOutputStreamNoFinalizer.java:33` 的 `dstSize = recommendedCOutSize()` = **131591 字节**，`ZstdOutputStreamNoFinalizer.java:88-89` 每次建流都从 `BufferPool` 拿一个这么大的 **Java 堆数组**。默认用的是 `NoPool.INSTANCE`（`ZstdOutputStreamNoFinalizer.java:56,65`），即 **每条流一个新 128.5 KiB 堆数组**，N 条并发流 = N×128.5 KiB 堆压力（这会先撞 `-Xmx`，报 `OutOfMemoryError: Java heap space`，**是会有日志的**，所以与"无日志"不符）。

---

## 3. 问题 2：资源释放 / 泄漏

### 3.1 哪些 API 必须显式释放

| 对象 | 有无 finalizer/Cleaner（v1.5.7-23） | 必须 close() | 出处 |
|---|---|---|---|
| `ZstdOutputStreamNoFinalizer` | **无** | ✅ | `ZstdOutputStreamNoFinalizer.java:508-517`（`finally { ... freeCStream(stream); }`）；类文档见 `ZstdInputStreamNoFinalizer.java:17-19`：「It also does not have finalizer, so if you rely on finalizers to clean the native memory and release buffers use `ZstdInputStream` instead.」 |
| `ZstdInputStreamNoFinalizer` | **无** | ✅ | 同上 |
| `ZstdDirectBufferCompressingStreamNoFinalizer` / `...DecompressingStreamNoFinalizer` | **无** | ✅ | `ZstdDirectBufferCompressingStream.java:18,44-45` 有 `setFinalize()` 开关（已 deprecated） |
| `ZstdCompressCtx` / `ZstdDecompressCtx` | **无**（`AutoCloseBase` 里没有 finalize，也没有 Cleaner） | ✅ | `ZstdCompressCtx.java:43-56 doClose()`；`AutoCloseBase.java` 全文无 `finalize`/`Cleaner` |
| `ZstdOutputStream`（非 NoFinalizer 包装类） | **有** `protected void finalize() { close(); }` | 建议显式 | `ZstdOutputStream.java:91-94` |
| `ZstdDirectBufferDecompressingStream` | 有（`setFinalize` 可关） | 建议显式 | `ZstdDirectBufferDecompressingStream.java:82-84` |
| `ZstdDictCompress`/`ZstdDictDecompress` | 有：`SharedDictBase.java:6-8 finalize(){close();}` | 建议显式 | 【源码核实】 |

**不 `close()` 会怎样**：`ZSTD_CCtx` / `ZSTD_CStream` 永远不会被 `free`，那个 level 对应的一大块 `malloc`（1.3 MiB ~ 833 MiB）**永久泄漏**，且 JVM 完全不知情。而且 —— **线程结束不会释放它**；如果你把 `ZstdCompressCtx` 放 `ThreadLocal`、而线程池又不断新建/销毁线程，`ThreadLocal` 被回收后 ctx 对象变成垃圾但**没有 finalizer** → 直接泄漏。这正是 [issue #412](https://github.com/luben/zstd-jni/issues/412)（open）的核心指控：【社区/issue】
> "After [finalize() was removed](https://github.com/luben/zstd-jni/issues/83), **Cleaner was not added** and now it becomes unsafe to use ZstdCompressCtx in the ThreadLocal in case threads are dynamically allocating and deallocating."

### 3.2 已知原生泄漏 issue（含结论）

| issue | 标题 | 结论 |
|---|---|---|
| [#26](https://github.com/luben/zstd-jni/issues/26) | native memory leak（2016） | `ZstdInputStream` 无 finalizer → 加 finalizer 修复。**当前 NoFinalizer 系列仍然是「无 finalizer」的（设计如此）**。 |
| [#83](https://github.com/luben/zstd-jni/issues/83) | finalize() should not be overridden | 移除了 finalize，**未换成 Cleaner** → 见 #412。 |
| [#156](https://github.com/luben/zstd-jni/issues/156) | Detected Native memory leak or slow reclamation | **不是库的 bug**：native 内存随存活流数量线性增长、`close` 即回收；但分配器不立刻还给 OS。维护者提供 `RecyclingBufferPool` 作为「silver bullet」。**报障现象与本故障几乎一致：RSS 远超 -Xmx、崩溃时没有 heap dump。** |
| [#175](https://github.com/luben/zstd-jni/issues/175) | Freeing native memory buffer without closing parent OutputStream | `setCloseFrameOnFlush(true)+flush()` 不释放 CStream → 加了 `closeWithoutClosingParentStream()`（见 `ZstdOutputStreamNoFinalizer.java:474-476`）。**如果你只用 flush 不复用 close，仍会泄漏一条流的全部原生内存。** |
| [#203](https://github.com/luben/zstd-jni/issues/203) | ZstdOutputStream leaking thread handles | **上游 zstd 的 win32 threading 没 `CloseHandle`**，被 [facebook/zstd#3147](https://github.com/facebook/zstd/pull/3147) 修，1.5.5 起好了。**只在 `nbWorkers>0` 时才有 worker 线程**；维护者原话：「On the JVM side we don't create any threads.」 |
| [#310](https://github.com/luben/zstd-jni/issues/310) / [#309](https://github.com/luben/zstd-jni/pull/309) | Native memory leak from using "By-reference" variants | 已修（PR #309）。涉及 `ZstdDictCompress.byReference` / `byReferenceFast` 相关路径。 |
| [#196](https://github.com/luben/zstd-jni/issues/196) | Apparent Leak when using ZstdDictDecompress | 已处理（issue 关闭）。 |
| [#119](https://github.com/luben/zstd-jni/issues/119) | JVM Crash When Internal output Stream Closed / Not Writable | **close 顺序 bug**：旧代码 `freeCStream()` 成功 → `out.close()` 抛异常 → `isClosed=true` 没执行 → 第二次 close（finalize）用已释放指针 → `malloc: pointer being freed was not allocated` / JVM crash / **挂死在 `ZstdOutputStream.compressStream(Native Method)`**。**1.4.4-10 修复**；当前代码已改成 `finally`（`ZstdOutputStreamNoFinalizer.java:508-517`）。 |
| [#389](https://github.com/luben/zstd-jni/issues/389) | `FindClass` uses an invalid class name when reporting native allocation failure | `jni_zdict.c` 里用 `"Ljava/lang/OutOfMemoryError;"`（字段描述符）而不是二进制名 → **原生分配失败时那条「报 OOM」的路径本身就坏掉**，留下 pending exception。维护者确认「yes, this is an error」。**只影响 `Zstd.trainFromBuffer*`。** |
| [#392](https://github.com/luben/zstd-jni/issues/392) / [#404](https://github.com/luben/zstd-jni/issues/404) | Dictionary critical-array failure paths / Cross-Object Use-After-Free in `ZstdCompressCtx.loadDict` | #404 是 **native use-after-free**：`loadDict(ZstdDictCompress)` 只在 native 调用期间持有 dict 的共享锁（`ZstdCompressCtx.java:424-441`），dict 被 `close()` 后 ctx 仍指向已释放的 `ZSTD_CDict` → 下次 compress SIGSEGV。**1.5.7-15 修复**（本仓库是 -23，已含修复）。 |

### 3.3 `BufferPool` / `RecyclingBufferPool` 的机制与坑

【源码核实】`RecyclingBufferPool.java` 全文 62 行：

- **池化的是 Java 堆 `ByteBuffer`，不是原生内存**。`get()` 返回 `ByteBuffer.allocate(buffSize)`（`RecyclingBufferPool.java:47`）。
- 固定单一尺寸：`buffSize = max(ZstdOutputStreamNoFinalizer.recommendedCOutSize(), ZstdInputStreamNoFinalizer.recommendedDInSize(), recommendedDOutSize())`（`:19-22`）。**请求比它大的容量直接抛 `RuntimeException`**（`:34-39`）。
- **线程安全**：底层是 `ConcurrentLinkedQueue`（`:25,28`），`get`/`release` 本身无需外部加锁；注释明确承认有 race（`:41-43`）：「This if statement introduces a possible race condition of allocating a buffer while we're trying to release one.」
- **会不会无限增长**：**用 `SoftReference` 包着（`:60`）**，堆压力大时 JVM 会回收 SoftReference 的 referent，`get()` 会跳过已被回收的条目（`:49-52`）→ **不会无界增长**。但反过来，**SoftReference 的回收时机由 GC 决定，可能导致延迟/抖动**。维护者在 #156 里也提醒过：「Internally it uses soft references that can be collected under memory pressure. It may cause some issues with some garbage collectors.」
- **`release()` 只在 `buffer.capacity() >= buffSize` 时才放回池**（`:58-61`），否则静默丢弃。
- **和故障的关系**：如果用户的代码给每条流传了同一个 `RecyclingBufferPool`，所有流共享**同一批** 128.5 KiB 堆数组，这既是好事（省堆）也可能造成堆数组在多个 native 临界区里被同一批线程争抢（仍在同一时刻只被一条流持有，不是数据竞争）。

---

## 4. 问题 3：★ 并发安全性

### 4.1 官方说法（唯一的两个权威出处）

1. **Javadoc**：`src/main/java/com/github/luben/zstd/ZstdCompressCtx.java:31-34`
   ```java
   /**
    * Create a context for faster compress operations
    * One such context is required for each thread - put this in a ThreadLocal.
    */
   ```
   【源码核实】—— 这是**唯一**的官方「每线程一个上下文」表述。

2. **维护者 luben 在 [issue #363](https://github.com/luben/zstd-jni/issues/363)（2025-07-16）的原话**：【社区/issue】
   > "**No, single instance of `ZstdOutputStream` should not be used concurrently from multiple threads.** `ZstdOutputStream` delegates to `ZstdOutputStreamNoFinalizer` that is **synchronized on the JVM side (to prevent segfaults) but itself delegates to the native library that is not synchronized.** So in short - **it may work in certain situations but it's unsupported mode.**"

3. **README 里没有任何 thread-safety 章节** —— 【未找到】。（本仓库 README 与上游 master README 逐字节相同，我 `diff` 过。）

**并发压缩的官方推荐用法**：README **未找到**。可操作的只有 `ZstdCompressCtx` Javadoc 的 ThreadLocal 建议，以及 `setWorkers(n)`（见 §4.4）。

### 4.2 源码核实：哪些对象不是线程安全的，以及「共享会发生什么」

| 对象 | 线程安全？ | 共享后果 | 依据 |
|---|---|---|---|
| `ZstdCompressCtx` / `ZstdDecompressCtx` | **否** | **不是「卡死」，而是数据错乱 + SIGSEGV** | 见下 §4.3 —— **致命点**：`acquireSharedLock()` 是共享计数锁，不互斥 |
| `ZstdOutputStreamNoFinalizer` | **方法级 `synchronized`，但只保护 Java 侧状态** | 多线程同时写同一个流：`write()` 的 `srcPos`/`dstPos` 字段被 `synchronized` 串行化了，**但因为 `synchronized` 在实例上，实际上不会同时进 native** → 更多是逻辑错乱（跨线程混流）而不是崩溃 | `ZstdOutputStreamNoFinalizer.java:400`（`public synchronized void write`）、`:438 flush`、`:470 close` |
| 一个 `ZSTD_CCtx` 原生指针被两个 Java 对象同时持有 | **否** | 数据损坏 / SIGSEGV / `ZSTD_CCtx_reset` 互踩 | `jni_fast_zstd.c:611-639` 每次调用都 `ZSTD_CCtx_reset(cctx, ZSTD_reset_session_only)` |
| 同一个 Java `byte[]` 作为 **dst** 被两条流同时使用 | **否** | 输出互相覆盖（静默数据损坏） | `ZstdOutputStreamNoFinalizer.java:88-89` + `jni_outputstream_zstd.c:66` |
| `ZstdDictCompress`（fast dict） | 可跨线程共享（有共享锁） | 但 #404 证明**共享锁只覆盖调用期**，dict 被 close 后 ctx 仍会用 → UAF | `AutoCloseBase.java:27-55`；[#404](https://github.com/luben/zstd-jni/issues/404) |

### 4.3 ★★ 致命设计点：`acquireSharedLock()` 不是互斥锁

`src/main/java/com/github/luben/zstd/AutoCloseBase.java:27-40`：
```java
void acquireSharedLock() {
    while (true) {
        int sharedLock = this.sharedLock;
        if (sharedLock < 0) throw new IllegalStateException("Closed");
        if (sharedLock == Integer.MAX_VALUE) throw new IllegalStateException("Shared lock overflow");
        if (SHARED_LOCK_UPDATER.compareAndSet(this, sharedLock, sharedLock + 1)) break;   // <-- 只是 +1
    }
}
```
它是**共享（读）计数锁**：`sharedLock` 从 0 加到 1、2、3…**两个线程都能同时获取成功**。它唯一的语义是「有活跃使用者时 `close()` 会抛 `IllegalStateException("Attempt to close while in use")`」（`AutoCloseBase.java:68-70`）。

而 `ZstdCompressCtx.compressByteArray()`（`ZstdCompressCtx.java:691-710`）**只调用了 `acquireSharedLock()` / `releaseSharedLock()`**，没有任何实例级 `synchronized`：
```java
public int compressByteArray(byte[] dstBuff, int dstOffset, int dstSize, byte[] srcBuff, int srcOffset, int srcSize) {
    ...
    ensureOpen();
    acquireSharedLock();          // <-- 只是计数 +1，不互斥！
    try {
        long size = compressByteArray0(nativePtr, ...);   // <-- 多线程可同时进 native，共享同一个 ZSTD_CCtx
        ...
    } finally { releaseSharedLock(); }
}
```
**结论（【源码核实】）：如果在多线程里共享一个 `ZstdCompressCtx` 并调用 `compressByteArray` / `compressDirectByteBuffer` / `compressByteBufferStream`，库不会阻止你，两个线程会同时操作同一个原生 `ZSTD_CCtx`。**
后果（推断，均为 zstd 未定义行为）：`ZSTD_CCtx_reset` 互相打断 → 输出的帧头/窗口错乱、**静默数据损坏**；`ZSTD_cwksp` 的 workspace 指针被并发改写 → **SIGSEGV**。**不会**产生 Java 异常。【源码核实】+【推测】

> 这个「不是互斥锁」的语义容易误读 —— 变量名叫 `sharedLock`、有 `acquire/release`，看起来像锁；实际上它更接近「引用计数」。**#331（SIGSEGV when closing ZstdCompressCtx）的根因就在这一带**：维护者回复「After `compareAndSet(0, CLOSED)` the lock is closed and attempt to acquire it will throw exception」，随后在 [commit cec96538](https://github.com/luben/zstd-jni/commit/cec96538e692336eae11b033d9f09e7be30ff075) 里给更多方法补上了 guard 并发布 1.5.6-8。

### 4.4 MT（多 worker）压缩：另有内存放大

- zstd-jni **不自己建线程**；worker 线程全部来自 zstd 的 `ZSTDMT`（本仓库编译时带了 `-DZSTD_MULTITHREAD=1`，`make_so_cross.sh` / `make_so.sh` / `CMakeLists.txt:15` 都有）。
- 入口：`ZstdOutputStreamNoFinalizer.setWorkers(int n)`（`:154-166`）→ `jni_zstd.c` `ZSTD_c_nbWorkers`。
- **内存影响**：`zstd.h:1780,1793,1796` 明确「`ZSTD_estimateCCtxSize_usingCCtxParams()` / `ZSTD_estimateCStreamSize_usingCCtxParams()` 在 `nbWorkers >= 1` 时**返回错误码**」「CStream size estimation **只对单线程压缩正确**」→ **上表的 MiB 数字对 `nbWorkers>0` 不再成立**，实际用量按 worker 数成倍增长（每个 job 都要自己的 in/out buffer 与 job 表）。**具体倍数【未找到】官方公式。**
- **已知坑**：[issue #298 "Stuck when parallel compression is enabled"](https://github.com/luben/zstd-jni/issues/298) —— 开 `workers=4` + `level=5` 后 Spark task **看起来卡死**；报障人最终确认「**It's not a real hang, just the task time becomes extremely long**」，同样数据从 ~10min 变成 ~5h。**这是"看起来卡住"的一条真实历史**。【社区/issue】
- 另：#203 说明 `nbWorkers>0` 在 Windows 上会泄漏 thread handle（上游 1.5.5 已修）。

---

## 5. 问题 4：原生分配失败 / 崩溃的表现形态

### 5.1 原生 `malloc` 失败时 zstd-jni 会抛什么

| 失败点 | 行为 | 依据 |
|---|---|---|
| `ZSTD_createCCtx()` 内部 `calloc` 失败 | 返回 **NULL**；`ZstdCompressCtx` 构造函数检查并抛 `IllegalStateException("ZSTD_createCompressCtx failed")`（`:35-41`）。**`ZstdOutputStreamNoFinalizer` 不检查 → 见 5.2** | `ZstdCompressCtx.java:35-41` vs `ZstdOutputStreamNoFinalizer.java:86` |
| zstd workspace `malloc` 失败（`ZSTD_cwksp_create`） | 返回错误码 `ZSTD_error_memory_allocation`（`compress/zstd_cwksp.h:689-695` 的 `RETURN_ERROR_IF(workspace == NULL, memory_allocation, ...)`），经 `ZSTD_CCtx_init_compressStream2` 的 `FORWARD_IF_ERROR`（`compress/zstd_compress.c:6476`）返回；JNI 侧 `Zstd.isError(size)` 为真 → **抛 `ZstdIOException` / `ZstdException`，消息为 `"Allocation error : not enough memory"`** | 【源码核实】+【自测复现】（`ZSTD_getErrorName((size_t)-64)` 实测输出就是这个字符串） |
| JNI 层 `GetPrimitiveArrayCritical` 返回 NULL | 返回 `-ZSTD_error_memory_allocation`（= `(size_t)-64`），Java 侧同样抛 `ZstdIOException`（`jni_outputstream_zstd.c:62,68,71`） | 【源码核实】 |
| `Zstd.trainFromBuffer*` 的 `malloc` 失败 | **本应抛 `OutOfMemoryError`，但代码写错了类名 → 留下 pending exception**（[#389](https://github.com/luben/zstd-jni/issues/389)，维护者确认是 bug） | 【社区/issue】 |

**错误码对照**：`ZSTD_error_memory_allocation = 64`（`src/main/native/zstd_errors.h:83`）；`ZSTD_isError(code)` 实现为 `code > (size_t)(-ZSTD_error_maxCode)`，`maxCode = 120`（`zstd_errors.h:97`、`jni_zstd.c:240-242`）。所以 `-64` 确实是 error。

> ⚠️ **重要**：zstd 的错误返回是 **`size_t` 的负数**，JNI 里是 `return (jlong) size;`（`jni_outputstream_zstd.c:82`），Java 侧 `Zstd.isError(long)`。**这条链路是完整的，能抛 Java 异常 → 会有日志。** 所以如果用户「完全没有日志」，最可能的不是这条路径。

### 5.2 ★★ 已复现的崩溃路径：`createCStream()` 失败 → NULL 解引用 → SIGSEGV

**A. Java 侧缺失检查** —— `src/main/java/com/github/luben/zstd/ZstdOutputStreamNoFinalizer.java:83-90`：
```java
public ZstdOutputStreamNoFinalizer(OutputStream outStream, BufferPool bufferPool) throws IOException {
    super(outStream);
    this.stream = createCStream();          // <-- 没有 if (this.stream == 0) throw ... ！
    this.bufferPool = bufferPool;
    this.dstByteBuffer = Zstd.getArrayBackedBuffer(bufferPool, dstSize);
    this.dst = dstByteBuffer.array();
}
```
构造函数链（`:55-58` / `:64-66`）紧接着就会调 `Zstd.setCompressionLevel(this.stream, level)`。

**B. Native 侧没有 NULL 检查** —— `src/main/native/compress/zstd_compress.c:708-711`：
```c
size_t ZSTD_CCtx_setParameter(ZSTD_CCtx* cctx, ZSTD_cParameter param, int value)
{
    DEBUGLOG(4, "ZSTD_CCtx_setParameter (%i, %i)", (int)param, value);
    if (cctx->streamStage != zcss_init) {          // <-- 直接解引用，没有任何 NULL 检查
```
`ZSTD_CCtx_reset` 同样（`zstd_compress.c:1367-1373` 第一行就 `cctx->streamStage = zcss_init;`）。
只有 `ZSTD_freeCCtx` 是 NULL-safe 的（`zstd_compress.c:181-184`：`if (cctx==NULL) return 0;`）。

**C. 我实测的结果** 【自测复现】（编译本仓库源码，直接调用 `ZSTD_CCtx_setParameter(NULL, ZSTD_c_compressionLevel, 3)`）：
```
mode=0  calling ZSTD_CCtx_setParameter(NULL, ZSTD_c_compressionLevel, 3) ...
[exit code: 139]        # 128 + 11 = SIGSEGV
mode=1  calling ZSTD_CCtx_reset(NULL, ZSTD_reset_session_only) ...
[exit code: 139]        # SIGSEGV
mode=2  freeCStream(NULL) -> 0        # 安全
```
→ **原生 malloc 失败（例如 OHOS 上内存紧张）→ `createCStream()` 返回 0 → `setLevel()` 触发 SIGSEGV。整个过程中 Java 层不会抛任何异常。**

**这正是 Oracle 官方文档描述的场景** 【官方文档】[Troubleshoot Memory Leaks § Troubleshooting a Crash Instead of a java.lang.OutOfMemoryError error](https://docs.oracle.com/en/java/javase/17/troubleshoot/troubleshooting-memory-leaks.html)：
> "Sometimes an application crashes soon after an allocation from the native heap fails. **This occurs with native code that does not check for errors returned by the memory allocation functions.** For example, the `malloc` system call returns `null` if there is no memory available. **If the return from `malloc` is not checked, then the application might crash when it attempts to access an invalid memory location.**"

**同类但已修的问题**：[#356](https://github.com/luben/zstd-jni/pull/356) 「Fix segmentation fault when calling `ZstdOutputStream#setDict(ZstdDictCompress)` with null」—— 说明这条「Java 侧漏检 NULL 原生指针 → segfault」的模式在这个库里有前科。【社区/issue】

### 5.3 JNI 层发生 SIGSEGV 时 JVM 的表现（★ 本故障关键）

**正常情况下会写 `hs_err_pid<pid>.log`，并且 header 会同时打到 stdout。**
【官方文档】[Fatal Error Log](https://docs.oracle.com/en/java/javase/17/troubleshoot/location-fatal-error-log.html)：
> "The header is also printed to standard output and may show up in the application's output log."
> 头部样例：
> ```
> # A fatal error has been detected by the Java Runtime Environment:
> #  SIGSEGV (0xb) at pc=0x00007f0f159f857d, pid=18240, tid=18245
> # Problematic frame:
> # C  [libMyApp.so+0x57d]  Java_MyApp_readData+0x11
> # The crash happened outside the Java Virtual Machine in native code.
> ```
> 默认位置：「the system attempts to create the file in **the working directory of the process**. In the event that the file cannot be created in the working directory (insufficient space, permission problem, or other issue), the file is created in the temporary directory for the operating system. On the Linux operating system, the temporary directory is `/tmp`.」

**在什么情况下原生崩溃会「不留下可见日志」** —— 逐条列出：

| 场景 | 有 hs_err？ | 有 stderr？ | 说明 |
|---|---|---|---|
| **内核 OOM killer 发 `SIGKILL`** | **没有** | **没有** | `SIGKILL` 不可捕获，JVM 的 signal handler 不会被调用；即使装 `-XX:OnOutOfMemoryError` 也不会触发（那不是 Java OOM）。**这是「无日志卡住」最干净的解释。** |
| SIGSEGV 发生在原生代码 | 有 | 有 header | 但写到**子进程的 CWD**。Electron 用 `spawn` 拉起的 Java 进程 CWD 默认继承 Electron 的 CWD（OHOS 上可能是 `/` 或应用沙箱目录），**用户不会去那里找**。 |
| hs_err 写失败（CWD 只读/无空间） | 回落到 `/tmp` | — | OHOS 沙箱下 `/tmp` 可能也不可写。 |
| `-XX:ErrorFile=` 指向不可写路径 | 无 | 有 header（若 stderr 被吞则无） | 官方：路径写不了就只回落到系统临时目录。 |
| stderr 未被 Electron 捕获（`stdio:'ignore'` 或未监听） | 有（文件仍在） | **无** | header 只打到 stdout/stderr。 |
| **JVM 处于某种无法安全生成报告的严重状态** | 可能只有部分 | — | 官方明确：「In some cases only a subset of this information is output to the error log. This can happen when a fatal error is of such severity that the error handler is unable to recover and report all the details.」 |
| `-Xrs`（减少 signal 使用） | 影响 handler 安装 | — | 若用户加了 `-Xrs` 会削弱崩溃报告。 |
| **JVM 根本没崩，只是阻塞/自旋** | 没有（因为没崩） | 没有 | 见 §6 的三种卡住机制。 |

**已知「zstd-jni 调用 hang 住」的 issue**【社区/issue】：
- [#119](https://github.com/luben/zstd-jni/issues/119)：**线程 dump 永久停在 `com.github.luben.zstd.ZstdOutputStream.compressStream(Native Method)`** —— 1.4.4-10 已修（close 顺序）。
- [#116](https://github.com/luben/zstd-jni/issues/116)：`ZstdInputStream hangs for certain chunks`（1.4.4-7；`setContinuous(true)` + `setCloseFrameOnFlush(false)` 场景），当天关闭。
- [#298](https://github.com/luben/zstd-jni/issues/298)：`workers>0` 后「stuck」—— 实为极慢不是死锁（见 §4.4）。
- [#346](https://github.com/luben/zstd-jni/issues/346)：**byte[] API 长时间持有 JNI Critical Section**，维护者明说「liable to cause OOM crashes when using that with G1 GC without region pinning，i.e. in a runtime before java 22」，最终以「不修」关闭（2026-08-27）：「I am happy that Java land is getting better. **We don't want to add more overhead (by memcpy).** If people want the best performance, they should use the latest Java.」

**本仓库里 zstd-jni 自身的 Java 层「可能无限自旋」的循环**（值得作为独立机制排查）【源码核实】：
- `ZstdOutputStreamNoFinalizer.java:418-426`（`write`）：
  ```java
  while (srcPos < srcSize) {
      long size = compressStream(stream, dst, dstSize, src, srcSize);
      if (Zstd.isError(size)) throw new ZstdIOException(size);
      if (dstPos > 0) out.write(dst, 0, (int) dstPos);
  }
  ```
  `srcPos` 是**由 native 侧 `SetLongField` 回写的字段**（`jni_outputstream_zstd.c:79`）。如果 native 因任何原因不推进 `input.pos` 却又返回非 error，**这里就是纯 CPU 自旋死循环，无异常、无日志、无 I/O**。
- `ZstdOutputStreamNoFinalizer.java:457-463`（`flush`）：`do { size = flushStream(...); out.write(...); } while (size > 0);` —— 只要返回值一直 > 0 就无限循环（`dstPos` 可能是 0，即连输出都没有）。
- `ZstdInputStreamNoFinalizer.java:155-164`（`read`）：`while (result == 0) { result = readInternal(...); }` —— **无进度保护**；`readInternal` 在 0 输出时会返回 0，形成自旋。`read()`（`:229-240`）同样。
- 对比：`readInternal` 的内层循环 `:180` 是**有**进度保护的（`&& lastDstPos < dstPos`），说明作者知道这个问题，但外层没有。

---

## 6. 问题 5：JVM 侧把原生内存纳入管控的手段

### 6.1 `-XX:MaxDirectMemorySize` 管不管 JNI `malloc`？—— **完全不管**

【官方文档】[java Command (JDK 17)](https://docs.oracle.com/en/java/javase/17/docs/specs/man/java.html)：
> `-XX:MaxDirectMemorySize=size`
> "Sets the maximum total size (in bytes) of the **`java.nio` package, direct-buffer allocations**."

它只管 `ByteBuffer.allocateDirect`（以及走同一套 `Bits.reserveMemory` 记账的 FFM `MemorySegment.allocateNative`）。
- **JNI 里的 `malloc`（zstd 的 `ZSTD_malloc`）完全在它的管辖范围之外。**
- 连 `Unsafe.allocateMemory` 都不走这套记账。
- **zstd-jni 里唯一受它管的地方**是 `ZstdCompressCtx.compress(ByteBuffer)` 的 `ByteBuffer.allocateDirect(maxDstSize)`（`ZstdCompressCtx.java:763`）——**而流式 `ZstdOutputStream` 完全不用它**。

### 6.2 `-XX:NativeMemoryTracking=summary` + `jcmd VM.native_memory` —— **定位不到 zstd 的分配**

【官方文档】[Native Memory Tracking (JDK 17)](https://docs.oracle.com/en/java/javase/17/vm/native-memory-tracking.html)：
> "NMT tracks **only the memory that the JVM or HotSpot VM uses, not the user's native memory**."
> "**NMT does not track memory allocations for third-party native code** and Oracle Java Development Kit (JDK) class libraries."

[Troubleshoot Memory Leaks](https://docs.oracle.com/en/java/javase/17/troubleshoot/troubleshooting-memory-leaks.html) 再次强调：
> "The JVM has a powerful tool called Native Memory Tracking (NMT) that tracks native memory allocations performed internally by the JVM. **Note that this tool cannot track native memory allocated outside of the JVM, for example by JNI code.**"

用法（供排除 JVM 自身用）：
```
-XX:NativeMemoryTracking=summary            # 5%-10% 性能开销
jcmd <pid> VM.native_memory summary
jcmd <pid> VM.native_memory baseline
jcmd <pid> VM.native_memory summary.diff
```
→ 如果 NMT 的 Total 和进程 RSS 差出几百 MiB～几 GiB，**差值就是 JNI/第三方库的原生内存**。这是定位 zstd 占用最实用的间接手段。**但 NMT 里不会出现 `zstd` / `malloc` 的调用点。**

**真正能定位 zstd 分配的替代手段**：
- 外部按时间采 `/proc/<pid>/status` 的 `VmRSS`、`/proc/<pid>/smaps_rollup`；
- `pmap -x <pid>` 两次对比找增长的 anon 段（官方文档推荐的 JNI leak 手法）；
- `LD_PRELOAD` 包一层 `malloc/free` 计数，或交叉编译时加 `-fsanitize=address`（OHOS musl 下可用性需确认）；
- ⚠️ **zstd-jni 没有把 `ZSTD_sizeof_CCtx` / `ZSTD_estimateCStreamSize` 导出到 Java**【源码核实】：`grep -n "sizeof\|estimate" src/main/java/com/github/luben/zstd/Zstd.java` 无任何匹配，`src/main/native/*.c` 里也没有 `JNIEXPORT ... ZSTD_sizeof_*`。**所以 Java 侧无法运行时查询原生占用** —— 只能按 §2.3 的表自己算，或者自己加一个 JNI 方法/用 JNA 直接绑 `ZSTD_sizeof_CCtx`。

### 6.3 `-XX:+HeapDumpOnOutOfMemoryError` / `-XX:ErrorFile=` / `-XX:+ExitOnOutOfMemoryError` 在原生内存问题下的有效性

| 选项 | 原生 `malloc` 失败时有效吗 | 说明 |
|---|---|---|
| `-XX:+HeapDumpOnOutOfMemoryError` | **基本无效** | 「dump the **Java heap** of a process when it fails with a `java.lang.OutOfMemoryError` error」（[官方](https://docs.oracle.com/en/java/javase/17/troubleshoot/troubleshooting-memory-leaks.html)）。**原生 malloc 失败默认不抛 `OutOfMemoryError`**，所以不触发。即使 zstd-jni 抛了 Java OOM（#389 那条坏路径），dump 出的也只是一个**没问题的 Java 堆**，看不到原生内存。issue #156 的报障人正是：「**When it crashes there is no heap dump.**」 |
| `-XX:ErrorFile=<绝对路径>/hs_err_%p.log` | **有效（强烈建议加）** | 把 hs_err 从「子进程 CWD」挪到你一定会看的地方。默认行为见 §5.3。**这是把「无日志」变成「有日志」的最低成本动作。** |
| `-XX:+ExitOnOutOfMemoryError` | **无效** | 只在**首次 `java.lang.OutOfMemoryError`** 时立即退出 VM。原生 malloc 失败不产生 Java OOM。 |
| `-XX:+CrashOnOutOfMemoryError` | 无效（同上） | 但它能让 Java OOM 产生 core，配合 `jhsdb jmap` 有用。 |
| `-Xlog:gc*:file=<path>:time,uptime,level,tags` | **间接有效** | 能看到 GCLocker 引发的 GC、以及 GC 是否被 `GetPrimitiveArrayCritical` 阻塞（见 §7 机制 B）。 |
| `-XX:+PrintNMTStatistics`（配 `-XX:+UnlockDiagnosticVMOptions`） | 间接 | VM 退出时打印 NMT 快照，用于算「RSS − NMT」的差值。 |
| **OS 级**：cgroup memory limit / `ulimit -v` | **有效** | OHOS 上应用本身可能已有内存配额；也可以主动设一个上限让进程**有机会**返回错误而不是被 OOM killer 秒杀。 |
| `-XX:+HeapDumpOnOutOfMemoryError` 的替代：**`-XX:+HeapDumpOnOutOfMemoryError -XX:OnOutOfMemoryError=<script>`** | 无效（对原生） | 同上。**真正需要的是「父进程侧的看门狗」**：Electron 监听 `child.on('exit', (code, signal) => ...)`，把 `signal`（如 `SIGKILL`/`SIGSEGV`/`SIGABRT`）和 `code` 记下来。**这是本次排障最该先补的一行代码。** |

---

## 7. 问题 6：★ 推荐的安全用法

### 7.1 把原生内存钉在上界内：先算账

**流式压缩每流原生内存 ≈ `ZSTD_estimateCStreamSize(level)`（§2.3 表）**。所以：

```
原生内存上界 ≈ 并发流数 × CStreamSize(level)  (+ 若 nbWorkers>0，再乘上 worker 放大系数)
```

举例（**这些是硬数字，直接可用**）：
| 并发流数 | level 3（3.49 MiB） | level 9（14.74 MiB） | level 19（89.5 MiB） |
|---|---|---|---|
| 4 | 14 MiB | 59 MiB | 358 MiB |
| 16 | 56 MiB | 236 MiB | **1.4 GiB** |
| 64 | 223 MiB | 943 MiB | **5.6 GiB** |

→ **在手机/PC 端的 OHOS 上，`level >= 9` 且并发 > 16 几乎必然打爆原生内存。** 而 `ZstdOutputStream` 的默认 level 是 `Zstd.defaultCompressionLevel()`（= 3，见 `ZstdOutputStreamNoFinalizer.java:112-114` 的文档），3.49 MiB/流还算温和；**如果业务显式设了 level 或调了 `setLong()`，就要按上表重算。**

### 7.2 推荐模式 A：固定数量 worker + 每条 worker 长期持有一个 `ZstdCompressCtx`

```java
public final class ZstdWorkers implements AutoCloseable {
    // 唯一的并发闸门：原生内存 = permits × CtxSize(level)。按设备内存定这个数。
    private final Semaphore permits = new Semaphore(4);
    private final ExecutorService pool;              // 固定大小，线程不销毁 => ThreadLocal 不泄漏
    private final int level;

    /** 每线程一个 ctx；线程由固定池持有，故 ctx 生命周期 == 池生命周期。 */
    private final ThreadLocal<ZstdCompressCtx> tls = ThreadLocal.withInitial(() -> {
        ZstdCompressCtx ctx = new ZstdCompressCtx();
        ctx.setLevel(level);
        // ★ 显式钉死 windowLog，杜绝「源大小未知 => 用最大表」的放大
        //   2^21 = 2 MiB 窗口；配合 level<=9 时原生内存约 3~5 MiB/线程
        // ctx.setWindowLog(21);   // 需要时打开；不要再调 setLong()/setWorkers()
        return ctx;
    });

    public byte[] compress(byte[] src) throws Exception {
        permits.acquire();                            // ★ 限并发 —— 这是控制原生内存的唯一有效手段
        try {
            return pool.submit(() -> {
                ZstdCompressCtx ctx = tls.get();
                byte[] dst = new byte[(int) Zstd.compressBound(src.length)];
                int n = ctx.compressByteArray(dst, 0, dst.length, src, 0, src.length);
                return Arrays.copyOf(dst, n);
            }).get();
        } finally {
            permits.release();
        }
    }

    @Override public void close() {
        // 固定池：关闭前把每个线程的 ctx 都 close 掉
        pool.shutdown();
        // （实现上：用一个 CopyOnWriteArrayList 记录所有创建过的 ctx，逐个 close()）
    }
}
```

**要点**
1. **`Semaphore` 限并发是核心**；`ThreadLocal` 只解决「不共享」，不解决「总量」。
2. **不要用 `Zstd.compress(byte[],byte[],level)`**（`Zstd.java:77-86`）：它每次 create/free 一个 CCtx，一次调用就 malloc 几十 MiB（level 19 @1MiB 输入 = 17.25 MiB），在并发下形成「分配风暴」。**改用长期存活的 `ZstdCompressCtx` + `compressByteArray`。**
3. **绝对不要在多个线程间共享同一个 `ZstdCompressCtx`** —— 因为 `acquireSharedLock()` 不互斥（§4.3），库不会救你。
4. **`setWindowLog(w)` 是控制内存最直接的旋钮**（`ZstdCompressCtx.java:228-241` → `ZSTD_c_windowLog`）。把 `w` 从 23 降到 21，窗口从 8 MiB 降到 2 MiB，BT/hash 表也随之缩小。**代价是压缩率。**
5. **`setWorkers(n)` 要慎用**：官方文档说 `nbWorkers>=1` 时尺寸估算 API 直接失效（`zstd.h:1780,1793`），实际内存按 worker 数放大，且历史上有「看起来卡死」的 issue #298。
6. **`setLong(w)` 是内存核弹**：`w=27` 直接 128 MiB 窗口 + LDM 表（`jni_zstd.c` `setCompressionLong`）。除非明确知道在做什么，不要调。
7. **`ZstdOutputStream` 一定要 `try-with-resources` / 显式 `close()`**；只用 `flush()` 不 `close()` 会泄漏整条流的原生内存（#175）。
8. BufferPool：`NoPool`（默认）每流一个 128.5 KiB 堆数组；`RecyclingBufferPool` 复用（SoftReference，不会无限增长），但**只在缓冲尺寸 == `recommendedCOutSize()` 时才生效**。

### 7.3 推荐模式 B：如果必须用 `ZstdOutputStream`（流式落盘/网络）

```java
try (ZstdOutputStream zos = new ZstdOutputStream(out, RecyclingBufferPool.INSTANCE, 3)) {
    zos.setWindowLog(21);   // ★ 显式限窗，别依赖未知 srcSize 的默认档
    zos.setWorkers(0);      // ★ 保持单线程，内存可预测
    // ... write ...
}   // close() 里 finally { freeCStream(stream); bufferPool.release(dst); }
```
配合 §7.2 的 `Semaphore` 限定**同时打开的流数量**。

### 7.4 有没有官方推荐的「流式压缩 + 固定数量 worker」模式？

- **zstd-jni 官方**：**未找到**。README 无此章节；维护者只在 issue 里说过「一个 `ZstdOutputStream` 不能跨线程用」。
- **zstd 官方**：`zstd.h:1787-1796` 只说明「`ZSTD_estimateCStreamSize()` 是单线程预算，MT 时这些估算 API 返回错误码」；zstd CLI 的 `-T#` 就是 worker 数。**没有「应用侧应该开几个 worker」的官方建议。**
- 实践中被验证有效的是 issue #156 里维护者给出的 **`RecyclingBufferPool` + 固定池** 组合（报障人反馈「seems like the silver bullet」「My instances are stable now where it doesn't crash because of memory error」）。

---

## 8. ★ 对本故障的判定建议

**现象回顾**：鸿蒙 PC / Electron `spawn` Java 后端 / 多线程并发 zstd / **每次卡在「处理 zstd 压缩包」约 10 秒** / 进度卡住 / Electron 前台正常 / **后端日志无异常、无 OOM、无 stack trace**。

「**无异常、无 stack trace**」这条信息极其关键，它直接**排除**了下面这些路径（因为它们的异常链是完整的、必然留日志）：
- ❌ zstd workspace malloc 失败 → `ZstdIOException("Allocation error : not enough memory")`（§5.1）
- ❌ Java 堆 OOM（`ZstdOutputStream` 每流 128.5 KiB dst 数组）→ `OutOfMemoryError: Java heap space` + stack trace
- ❌ 参数错误 / 数据损坏 → `ZstdException` + stack trace

剩下 3 个**天然不产生 Java 日志**的机制，按我的判断排序：

### 机制 A（最可能）：原生内存耗尽 → 进程被内核 OOM killer `SIGKILL`，或 zstd 内 NULL 解引用 `SIGSEGV`

**为什么吻合**：
- 「每次都在处理 zstd 压缩包时」—— 只有这时才 malloc 几 MiB~几百 MiB 的原生内存。
- 「约 10 秒左右」—— 恰好是「若干条并发流已经把 `level` 对应的 workspace 全部 malloc 出来、RSS 越过设备/应用配额」的时间尺度。
- 「无任何日志」—— `SIGKILL` **不产生 hs_err、不产生 stderr、不产生 core**；如果 Electron 没有监听 `child.on('exit')`，UI 上就只是「进度不动」。
- 「Electron 界面完全正常」—— 杀的是子进程，父进程毫无感知。
- 与 issue #156 的报障现象一致：「going well beyond the jvm's -mx value. When it crashes there is no heap dump.」
- 与 §5.2 我已复现的 SIGSEGV 路径一致：**createCStream() 返回 NULL → setLevel → SIGSEGV**（此时 hs_err 会写到**子进程 CWD**，用户看不到 = 等效于「无日志」）。

**最小验证方法（三选一，都很快）**：
1. **零代码改动，先看三处**：
   - `ls /proc/<java_pid>` 在卡住时还在不在（不在 = 进程已死 = 被杀了）；
   - `dmesg | grep -iE "out of memory|killed process|oom"`（内核 OOM killer 会留痕，**这是唯一能找到 SIGKILL 证据的地方**）；
   - `find / -name "hs_err_pid*.log" -newermt "-1 day" 2>/dev/null`（去**子进程 CWD** 找）。
2. **加 `-XX:ErrorFile=<绝对可写路径>/hs_err_%p.log`** 并在 Electron 侧加 `child.on('exit', (code, signal) => log(code, signal))`。**下一次复现就能一句话定性**：`signal === 'SIGKILL'` → OOM killer；`'SIGSEGV'` → 原生空指针；`'SIGABRT'` → zstd `assert` 触发（本 .so 没 `-DNDEBUG`）。
3. **跑一次带内存曲线的复现**：`while :; do grep VmRSS /proc/<pid>/status; sleep 1; done`，同时把并发数/level 记下来。若 RSS 单调涨到某个数字后进程消失 → 机制 A 确诊。**再用 §2.3 的表对照：RSS 峰值 ≈ 并发流数 × CStreamSize(level)。**

### 机制 B：JNI Critical Section（GCLocker）阻塞 GC → 全 JVM 停顿

**为什么吻合**：
- zstd-jni 的 byte[] API 把**整段压缩**放在 `GetPrimitiveArrayCritical` 里（`jni_fast_zstd.c:611-639` 的 `compressByteArray0`：先 critical dst、再 critical src、然后才 `ZSTD_compress2`）；`ZstdOutputStream` 的 `compressStream` 也一样（`jni_outputstream_zstd.c:66-74`）。
- `GetPrimitiveArrayCritical` 会拿 **GCLocker**（[Shipilëv, JVM Anatomy Quark #9](https://shipilev.net/jvm/anatomy-quarks/9-jni-critical-gclocker/)：「**GCLocker is a lock that prevents GC from running when JNI critical is acquired**」）。多线程同时持有时，**GC 完全无法启动**。
- 用户 `-Xmx` 有上限 + 每流 128.5 KiB 堆数组 + 多线程 → 堆很快就需要 GC，但 GC 被 GCLocker 挡住 → 其他线程在 `GCLocker::stall_until_clear` 里等 → **表现为整体卡住，没有任何异常/日志**。
- 这正是 [issue #346](https://github.com/luben/zstd-jni/issues/346) 的指控，且维护者**明确拒绝修**（2026-08-27）。JEP 423（G1 region pinning）要 **JDK 22+**，[region pinning 让 Shenandoah 能做无 GCLocker 的 JNI Critical](https://openjdk.org/jeps/423)；**用户的毕昇 JDK 17 没有这个能力**。

**最小验证方法**：卡住时（进程还在）、另开一个终端跑
```
jcmd <pid> Thread.print     # 或 jstack <pid>
```
- 看是否有大量线程停在 `GCLocker::stall_until_clear` / `GCLocker Initiated GC`；
- 看是否有线程 `_thread_in_native` 且栈顶是 `compressStream`/`compressByteArray0`；
- 配合启动参数 `-Xlog:gc*:file=/path/gc.log:time,uptime,level,tags`，看是否出现密集的 `Pause Young (GCLocker Initiated GC)`。
- **反向验证**：把并发降到 1~2 再跑同一份数据，如果不再卡 → 强烈指向 B（或 A）。

### 机制 C：Electron `spawn` 的 stdio 管道写满 → Java 进程阻塞在 `write()`

**为什么吻合**：
- 【官方文档】[Node.js child_process](https://nodejs.org/download/release/v24.20.0/docs/api/child_process.html)：
  > "By default, pipes for `stdin`, `stdout`, and `stderr` are established between the parent Node.js process and the spawned subprocess. These pipes have limited (and platform-specific) capacity. **If the subprocess writes to stdout in excess of that limit without the output being captured, the subprocess blocks, waiting for the pipe buffer to accept more data.**"
- OHOS/Linux 管道缓冲默认 **64 KiB**。Java 后端在开始处理压缩包时打印进度日志 → **约 10 秒后累积到 64 KiB → Java 进程卡在 `write(2)` 上**。
- 「后端日志没有任何异常」：如果日志框架是**写文件**的，文件里的确没有异常（异常根本没发生）；而 stdout/stderr 那条 pipe 满了没人读。
- 「Electron 界面完全正常」：父进程事件循环完全没问题。
- 「进度卡住」：子进程确实还活着（`kill -0` 成功），只是不干活。

**最小验证方法**：
1. 卡住时：`ls -l /proc/<java_pid>/fd/1 /proc/<java_pid>/fd/2` → 若指向 `pipe:[NNN]`，再 `cat /proc/<java_pid>/task/*/wchan`（或 `stack`），看到 `pipe_write` / `wait_for_partner` 就**确诊**。
2. **零成本对照实验**：把 `spawn` 改成给 `child.stdout` 和 `child.stderr` 都挂 `on('data')`（或 `stdio: 'ignore'` / 重定向到文件）再跑一次。**如果不再卡 → 就是它。**
3. 顺带检查 `child.on('exit')` 是否注册 —— 这同时也是机制 A 的确诊手段。

### 补充机制 D（低概率但要顺手排除）：zstd-jni Java 层的无限自旋

`ZstdOutputStreamNoFinalizer.java:418-426`（`while (srcPos < srcSize)`）和 `:457-463`（`do/while(size>0)`）以及 `ZstdInputStreamNoFinalizer.java:155-164`（`while(result==0)`）**都没有「无进展即报错」的保护**（对比 `readInternal` 内层 `:180` 是有保护的）。一旦 native 不推进游标又返回非错误值，就是**纯 CPU 自旋**。

**最小验证方法**：卡住时看 **Java 进程的 CPU**。
- `top -H -p <java_pid>`：**某个线程 ~100% 单核 → 强烈指向 D**（或 zstd 内部在大窗口上做极慢的匹配搜索，参见 issue #298 的「不是真卡死，是慢了 30 倍」）。
- ~0% CPU 且进程存活 → A(kill 前的等待)/B(等 GC)/C(等 pipe) 三者之一。
- 拿到 thread dump 后连打两次，若同一线程停在同一行 Java 代码（`write`/`flush`/`read`）→ D 确诊。

### 一句话行动清单

1. **今天就加**：`-XX:ErrorFile=<abs>/hs_err_%p.log`、`-Xlog:gc*:file=<abs>/gc.log:time,uptime,level,tags`，Electron 侧 `child.on('exit')` + 给 stdout/stderr 挂消费（或 `stdio:'ignore'`）。
2. **明天复现时抓三样**：`dmesg | grep -i oom`、`jcmd <pid> Thread.print`、`top -H -p <pid>`。三者足以在 A/B/C/D 之间一次定性。
3. **无论结论如何都要改**：用 §7.2 的模式把**并发数上限**和**每条流的 level/windowLog** 钉死；把 `Zstd.compress(...)` 换成长期存活的 `ZstdCompressCtx`；所有 `Zstd*Stream` / `Zstd*Ctx` 都 `close()`。这是唯一能把原生内存变成「有上界、可预测」的手段。

---

## 9. 出处清单

**源码（本仓库，`_research/zstd-jni-ohos/zstd-jni/`）**
`src/main/java/com/github/luben/zstd/`：`ZstdOutputStreamNoFinalizer.java`（33, 42-47, 56, 65, 83-90, 112-114, 154-166, 400-427, 418-426, 438-467, 457-463, 470-518）、`ZstdOutputStream.java`（91-94）、`ZstdInputStreamNoFinalizer.java`（16-20, 155-164, 166-227, 180, 229-240）、`ZstdCompressCtx.java`（11, 31-41, 43-56, 228-241, 424-441, 647-712, 733-792）、`Zstd.java`（77-86, 914, 1803-1815）、`AutoCloseBase.java`（8-73）、`SharedDictBase.java`（5-8）、`RecyclingBufferPool.java`（15-62）、`BufferPool.java`、`NoPool.java`、`ZstdDirectBufferCompressingStream.java`（18,44-45）、`ZstdDirectBufferDecompressingStream.java`（82-84）
`src/main/native/`：`jni_outputstream_zstd.c`（7-9, 16-19, 26-29, 46-52, 59-83, 90-103, 110-123）、`jni_fast_zstd.c`（611-639 及 24/151/153/472/495/516-518 等 critical 点）、`jni_zstd.c`（230-242, 336-345, 650-672）、`compress/clevels.h`（19, 25-130）、`compress/zstd_compress.c`（70-74, 181-190, 206-219, 708-716, 1367-1373, 1654-1754, 1769-1785, 2130-2168, 5497-5514, 5927-5957, 6447-6520, 7759-7786）、`compress/zstd_cwksp.h`（689-707）、`common/zstd_deps.h`（66-68）、`common/allocations.h`（26-53）、`common/mem.h`、`common/error_private.c`（51-52）、`decompress/zstd_decompress.c`（2357-2364）、`zstd.h`（148, 232-250, 843, 1206-1210, 1761-1809）、`zstd_errors.h`（61-97）
构建：`version`、`make_so.sh`、`make_so_cross.sh`、`CMakeLists.txt:15`、`libzstd-jni.so.map`、`README.md`

**自测复现**（我在 `_research/zstdmeasure/` 用上表源码编译的两个 C 程序：`measure.c`、`crash.c`）
- `ZSTD_sizeof_CCtx` / `ZSTD_estimateCStreamSize` / `ZSTD_getCParams` 全 level 扫描
- `ZSTD_CCtx_setParameter(NULL, ...)` / `ZSTD_CCtx_reset(NULL, ...)` → **exit 139 (SIGSEGV)**；`ZSTD_freeCStream(NULL)` → 0
- `ZSTD_getErrorName((size_t)-64)` = `"Allocation error : not enough memory"`

**官方文档**
- [java Command, JDK 17](https://docs.oracle.com/en/java/javase/17/docs/specs/man/java.html)（`-XX:MaxDirectMemorySize` 定义、`-XX:ErrorFile` 默认位置、`-XX:ShowMessageBoxOnError`）
- [Native Memory Tracking, JDK 17](https://docs.oracle.com/en/java/javase/17/vm/native-memory-tracking.html)
- [Troubleshoot Memory Leaks, JDK 17](https://docs.oracle.com/en/java/javase/17/troubleshoot/troubleshooting-memory-leaks.html)（NMT 不跟踪 JNI、HeapDumpOnOutOfMemoryError 语义、native malloc 未检查 → crash、`request size bytes for reason. Out of swap space?`）
- [Fatal Error Log, JDK 17](https://docs.oracle.com/en/java/javase/17/troubleshoot/location-fatal-error-log.html)（hs_err 位置、header 同时打 stdout、`_thread_in_native`、只输出部分信息的情况）
- [Node.js child_process（v24.20.0）](https://nodejs.org/download/release/v24.20.0/docs/api/child_process.html)（pipe 写满 → 子进程阻塞）
- [zstd 官方手册 zstd_manual.html（release 分支）](https://github.com/facebook/zstd/blob/release/doc/zstd_manual.html)（`ZSTD_estimateCCtxSize` / `ZSTD_estimateCStreamSize` / `ZSTD_compressBound` 的完整说明）
- [JEP 423: Region Pinning for G1](https://openjdk.org/jeps/423)
- [Shipilëv, JVM Anatomy Quark #9: JNI Critical and GC Locker](https://shipilev.net/jvm/anatomy-quarks/9-jni-critical-gclocker/)

**社区 / issue（`luben/zstd-jni`）**
#26、#83、#116、#119、#156、#175、#196、#203、#298、#309、#310、#327、#331、#346、#356、#363、#389、#392、#404、#412

**未找到**
- zstd-jni README 中关于「原生内存不受 -Xmx 约束」或 thread-safety 的**官方章节**（README 里根本没有这两节）。
- zstd 官方给出的「MT/`nbWorkers>0` 时内存放大倍数」公式（`zstd.h:1780,1793` 只说那些估算 API 在 MT 下返回错误码）。
- zstd-jni 官方推荐的「流式压缩 + 固定 worker 数」代码模式。
