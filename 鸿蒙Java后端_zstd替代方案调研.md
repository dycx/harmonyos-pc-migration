# HarmonyOS/OpenHarmony 上替代 zstd-jni 的压缩方案调研

> 目标：为跑在 HarmonyOS（OpenHarmony, aarch64, musl libc）上的 Java 后端，寻找 `com.github.luben:zstd-jni` 的替代方案，重点是不依赖 JNI 原生库的纯 Java 方案。
>
> 标注约定：`【已核实】` = 本次调研实际下载/反编译/运行了官方产物或看到官方文档、源码；`【推测】` = 由已核实事实推断；`未找到` = 未能证实。
> 本机验证环境：macOS aarch64、OpenJDK 25.0.4.1、zstd CLI 1.5.7。

---

## 0. 结论速览（先看这段）

1. **纯 Java 的 zstd 压缩 + 解压确实存在，而且是成熟库**：`io.airlift:aircompressor` 的 `io.airlift.compress.zstd.*` 就是纯 Java（0.27 版本，2019 年起就有）。**它不是"只能解压"**——`ZstdCompressor`、`ZstdFrameCompressor`、`ZstdOutputStream` 都在 jar 里，我实测过完整压缩。
2. **但它不能直接"换掉" Kafka 的 zstd-jni**：kafka-clients 的 `Compression.zstd().build()` 硬编码引用 `com.github.luben.zstd.ZstdOutputStreamNoFinalizer`，与具体实现强耦合。想换必须打补丁或写同名 shim。
3. **最稳的路线可能不是"纯 Java"**：OpenHarmony-SIG 有官方的 zstd 交叉编译方案，把 libzstd **静态链进你自己的 JNI/NAPI 库**（不是 `System.loadLibrary` 一个外部 .so），可以完全绕开沙箱加载限制。工作量约 150–300 行 C + 一次交叉编译。
4. **一个关键坏消息**：`aircompressor` 的纯 Java zstd 解码器**不支持字典压缩**，且有 8 MiB 窗口上限（实测只在真正触发 >8 MiB 回溯时才失败）。
5. **另一个关键坏消息**：OpenHarmony **没有系统级 libzstd**。我核对了 OpenHarmony master 的 manifest（496 个 project、180 个 third_party），压缩类只有 `brotli / bzip2 / lz4 / zlib`，**没有 zstd**。

---

## 1. 纯 Java 的 zstd 实现有哪些？

### 1.1 `io.airlift:aircompressor` —— 有纯 Java zstd，且**支持压缩** 【已核实】

**Maven 坐标与版本**（来自 Maven Central 元数据）：

| 坐标 | 最新版本 | 说明 |
|---|---|---|
| `io.airlift:aircompressor` | `2.0.3`（2026-02-24） | 2.x 系列 |
| `io.airlift:aircompressor-v3` | `3.10`（2026-09-22） | **3.x 换了 artifactId**，包名也从 `io.airlift.compress` 变成 `io.airlift.compress.v3` |

- https://repo1.maven.org/maven2/io/airlift/aircompressor/maven-metadata.xml
- https://repo1.maven.org/maven2/io/airlift/aircompressor-v3/maven-metadata.xml

> 注意：很多博客/旧资料只提 `io.airlift:aircompressor` 和 0.27，实际 2.x 与 3.x 是两个不同 artifact，坐标和包名都变了，迁移时容易踩坑。

**官方 README 原文依据**（zstd 章节标题就标注为 Recommended）：

> "**Zstandard is the recommended algorithm for most compression.** ... The **native** implementation of Zstandard is provided by the `ZstdNativeCompressor` and `ZstdNativeDecompressor` classes. The **Java** implementation is provided by the `ZstdJavaCompressor` and `ZstdJavaDecompressor` classes."
>
> "The Zstandard streaming format is supported by `ZstdInputStream` and `ZstdOutputStream`."

来源：https://github.com/airlift/aircompressor/blob/master/README.md （另：https://api.github.com/repos/airlift/aircompressor/readme ）

README 还明确区分了纯 Java 与原生两条实现路径：

> "This library provides a set of compression algorithms implemented in **pure Java** and where possible native implementations. The Java implementations use `sun.misc.Unsafe` to provide fast access to memory. The native implementations use `java.lang.foreign` to interact directly with native libraries **without the need for JNI**."

**关键澄清：0.27 与 2.x/3.x 是两套不同的东西**（这是我通过反编译 jar 亲自核实的，纠正了网上很多说法）：

| 版本 | 包名 | 是否在 jar 内打包 .so | 纯 Java 类名 | Zstd 压缩 | 字节码版本 |
|---|---|---|---|---|---|
| 0.27（2024-05-20） | `io.airlift.compress` | **否（0 个 .so/.dylib/.dll）** | `ZstdCompressor` / `ZstdDecompressor` | **支持** | major 52 = **Java 8** |
| 2.0.3（2026-02-24） | `io.airlift.compress` | 是 | `ZstdJavaCompressor` 等 | 支持 | Java 8 |
| 3.10（2026-09-22） | `io.airlift.compress.v3` | 是（linux-aarch64 等 glibc .so） | `ZstdJavaCompressor` / `ZstdJavaDecompressor` | 支持 | major 69 = **Java 25** |

- 0.27 的 `ZstdCompressor` 公开 API（`javap` 实测）：
  ```java
  public class io.airlift.compress.zstd.ZstdCompressor implements io.airlift.compress.Compressor {
    public int maxCompressedLength(int);
    public int compress(byte[], int, int, byte[], int, int);
    public void compress(java.nio.ByteBuffer, java.nio.ByteBuffer);
  }
  ```
- 0.27 的 `ZstdOutputStream` / `ZstdInputStream` 同样存在，**支持流式压缩**。
- 压缩级别支持 1–22：`CompressionParameters` 里有完整的 `DEFAULT_COMPRESSION_PARAMETERS` 表（level 1 FAST … level 22 BTULTRA），`DEFAULT_COMPRESSION_LEVEL = 3`，`MAX_COMPRESSION_LEVEL = 22`。但**公开 API 不接受 level 参数**，`ZstdCompressor.compress()` 固定用默认 level 3；只有包内 `ZstdFrameCompressor.compress(..., int compressionLevel)` 可指定。

**我实测的互通性（关键证据）**——用 aircompressor 0.27 纯 Java 产物与官方 zstd 1.5.7 CLI 双向验证：

| 方向 | 结果 |
|---|---|
| aircompressor 压缩 → 官方 `zstd -d` 解压 200000 B | ✅ 成功，exit=0 |
| aircompressor 流式 `ZstdOutputStream` → 官方 `zstd -d` | ✅ 成功 |
| 官方 `zstd -3` 产物 → aircompressor 解压 | ✅ 成功，内容一致 |
| 官方 `zstd -19` 产物 → aircompressor 解压 | ✅ 成功 |
| 官方 `--long=27 -19`（大窗口）产物 → aircompressor | ✅ 成功 |
| 官方**字典压缩**产物 `-D dict.bin` → aircompressor | ❌ **失败：`Custom dictionaries not supported: offset=25`** |

**性能实测（同一台机器、同一份 200000 B 数据、同 level 3）**：

| 实现 | 压缩吞吐 | 解压吞吐 | 压缩率 |
|---|---|---|---|
| `zstd-jni` 1.5.6-6（原生 JNI） | **1471 MB/s** | **2504 MB/s** | 5.23% |
| aircompressor 0.27 纯 Java | **612 MB/s** | **730 MB/s** | 5.2% |

→ **纯 Java 约为原生的 1/2.4（压缩）、1/3.4（解压）**。这是本次调研最硬的量化结论。（单机、单线程、内存数据、aarch64 Mac，绝对值不可直接搬到鸿蒙，但倍数关系有参考价值。）

**已核实的限制清单**：
- **不支持字典**：`ZstdFrameDecompressor` 源码里写死 `verify(dictionaryId == -1, input, "Custom dictionaries not supported")`。
- **窗口上限 8 MiB**：`ZstdFrameDecompressor.MAX_WINDOW_SIZE = 1 << 23`，超出报 `Window size too large (not yet supported)`。**但实测** 30 MB 文件、`--long=27 -19` 也解压成功——说明该上限只在"帧内真正出现 >8 MiB 回溯引用"时才触发，Kafka 小消息场景无影响。
- **硬依赖 `sun.misc.Unsafe`**：`ZstdDecompressor.decompress(byte[])` 的字节码里直接 `getstatic sun/misc/Unsafe.ARRAY_BYTE_BASE_OFFSET`——**即使用 byte[] API 也绕不开 Unsafe**。本机 JDK 25 上只是打 WARNING；但若鸿蒙侧 JVM 移除/禁用了 Unsafe，则不可用。
- **必须小端**：`UnsafeUtil` 静态初始化里 `verify(littleEndian)`，否则抛 `IncompatibleJvmException("Zstandard requires a little endian platform")`。aarch64 是小端，没问题。
- **不支持 v0.7 旧格式**：`"Data encoded in unsupported ZSTD v0.7 format"`。
- **确定性**：同一输入重复压缩产出完全相同的字节（native 与 Java 两侧都验证过）。这对"shim 能否兼容 Kafka 去重"很关键（见第 3 节）。
- **3.x 会拖入 glibc `.so`**：`aircompressor-v3-3.10.jar` 内含 `aircompressor/linux-aarch64/{libzstd,liblz4,libsnappy,libbz2,libdeflate,libxxhash}.so`——**这些是 glibc 编译的，在 OHOS(musl) 上同样加载失败**。README 提供了开关：`-Dio.airlift.compress.v3.disable-native`（旧版为 `io.airlift.compress.v3.disable-native`）。
- **3.10 的纯 Java 类也需要 Java 25**（字节码 major 69），且 `ZstdJavaCompressor` 的方法签名里出现 `java.lang.foreign.MemorySegment`。**对鸿蒙上的 JVM 是很高的门槛**。

> **实践建议**：鸿蒙场景优先考虑 **`io.airlift:aircompressor:0.27`**（Java 8 字节码、jar 内零 .so、纯 Java）。注意 0.27 是 2024-05 的版本，之后 0.28+ 就没有了（直接跳到 2.0）。若担心安全修复，2.0.3 属于同一 `io.airlift.compress` 包名体系，是 0.27 的直接后继。

### 1.2 其他纯 Java zstd 实现？ 【已核实 + 未找到】

| 候选 | 结论 |
|---|---|
| `com.github.luben` 是否有纯 Java 版？ | **未找到**。luben/zstd-jni 本身就是 JNI 绑定（名字即 "zstd-jni"）。我核对过本地 `_research/zstd-jni-ohos/zstd-jni/.git/config`，其 origin 指向 `https://github.com/luben/zstd-jni.git`，且**该本地克隆是空的**（只有 .git，`HEAD` 为 `refs/heads/.invalid`，无任何文件），无法由此获得额外信息。 |
| Apache Commons Compress 的 zstd 支持依赖谁？ | **依赖 zstd-jni**。【已核实】`commons-compress-1.27.1.pom` 中 `zstd-jni` 是 `<optional>true</optional>`；反编译 `ZstdCompressorInputStream` 确认其字段类型就是 `com.github.luben.zstd.ZstdInputStream`；`ZstdUtils` 的 Javadoc 原文：*"The underlying implementation is provided through the Zstandard JNI library"*，可用性探测即 `Class.forName("com.github.luben.zstd.ZstdInputStream")`。**所以 Commons Compress 完全没有解决 JNI 问题。** |
| 其他 "zstd-java" / "pure java zstd" 项目？ | **基本未找到可作为生产替代的成熟项目**。检索到的 `luyuncheng/aircompressor`、`dlazerka/aircompressor` 都只是 aircompressor 的 fork/镜像（README 标题均为 "A port of Snappy, LZO, LZ4, and Zstandard to Java"）。**【推测】** aircompressor 事实上是 Java 生态里唯一被广泛使用的纯 Java zstd 实现。 |

---

## 2. zstd-jni 通常是被谁引入的？能否关掉？

### 2.1 kafka-clients：**非 optional 的 runtime 依赖，且硬编码** 【已核实】

我下载了官方 POM 逐个解析依赖：

| kafka-clients 版本 | zstd-jni | lz4-java | snappy-java |
|---|---|---|---|
| 3.9.0 | `com.github.luben:zstd-jni:1.5.6-4`, scope=**runtime**, optional=**false** | `org.lz4:lz4-java:1.8.0` runtime | `org.xerial.snappy:snappy-java:1.1.10.5` runtime |
| 3.9.1 | 同上 | 同上 | 同上 |
| 4.0.0 | `com.github.luben:zstd-jni:1.5.6-6`, scope=**runtime**, optional=**false** | 同 | 同 |

- https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/4.0.0/kafka-clients-4.0.0.pom

**kafka-clients 全部运行时依赖只有 4 个**：`zstd-jni`、`lz4-java`、`snappy-java`、`slf4j-api`。三者都是 **runtime + 非 optional**，即**无法用 `<exclusions>` 干净地摘掉而不产生后果**。

更严重的是**实现被写死**。反编译 `org.apache.kafka.common.compress.ZstdCompression` 的字节码：

```
4: new  #39  // class com/github/luben/zstd/ZstdOutputStreamNoFinalizer
16: invokespecial #48 // Method com/github/luben/zstd/ZstdOutputStreamNoFinalizer."<init>":(Ljava/io/OutputStream;Lcom/github/luben/zstd/BufferPool;I)V
```

即 `wrapForOutput()` 直接 `new ZstdOutputStreamNoFinalizer(...)`，`wrapForZstdInput()` 直接 `new ZstdInputStreamNoFinalizer(...)`，还实现了一个 `com.github.luben.zstd.BufferPool` 的匿名子类。Kafka 4.0 源码同样如此（`ZstdCompression.java` 第 27–30 行 import、第 60/72 行 `catch (Throwable e) { throw new KafkaException(e); }`）。**kafka-clients 与 zstd-jni 是源码级强耦合，不是可插拔 SPI。**

### 2.2 实测：不同 classpath 下 Kafka 各编解码器的可用性 【已核实】

我实际跑了三组 classpath（Kafka 4.0.0 + slf4j）：

**A) 只有 kafka-clients + aircompressor 0.27（零 JNI 原生库）**

| 编解码器 | 结果 |
|---|---|
| none | ✅ OK |
| gzip | ✅ OK（30820 → 231 B） |
| **snappy** | ❌ `ClassNotFoundException: org.xerial.snappy.SnappyOutputStream` |
| **lz4** | ❌ `ClassNotFoundException: net.jpountz.lz4.LZ4Factory` |
| **zstd** | ❌ `ClassNotFoundException: com.github.luben.zstd.ZstdOutputStreamNoFinalizer` |

**B) 加上 lz4-java + snappy-java（其 glibc JNI 原生库在场）**

| 编解码器 | 结果 |
|---|---|
| snappy | ✅ OK（30820 → 1569 B） |
| lz4 | ✅ OK（30820 → 247 B） |
| zstd | ❌ 仍然失败 |

**结论（很重要）**：**aircompressor 不能通过依赖替换来"顶掉" zstd-jni**。Kafka 的 builder 在 `build()` 阶段就 eager 地解析实现类，抛 `NoClassDefFoundError`（实测：连 `Compression.zstd().level(3).build()` 这一步就炸，**不是**等到真正压缩时才炸）。想接入纯 Java 实现只有两条路：
- **(a) 写同名 shim**：自己在 `com.github.luben.zstd` 包名下实现 `ZstdOutputStreamNoFinalizer` / `ZstdInputStreamNoFinalizer` / `BufferPool` / `RecyclingBufferPool`，内部委托 aircompressor。【已核实】viability：native zstd 与 aircompressor 各自都是**确定性**的（重复压缩字节完全一致），因此 Kafka 依赖的"按压缩后字节去重"对 shim 依然成立。见第 6 节方案 E。
- **(b) fork/patch kafka-clients** 的 `ZstdCompression.java` 改指向 aircompressor。

### 2.3 其他常见引入方 【已核实 / 部分未找到】

| 依赖方 | 是否引入 zstd-jni | 能否关掉 |
|---|---|---|
| kafka-clients | **是**，runtime、非 optional | 不能"配置关掉"；关掉就是运行时 `NoClassDefFoundError` |
| Apache Commons Compress | **是**，`<optional>true</optional>` | **可以**：不引 zstd-jni 就只是没有 zstd 能力，`ZstdUtils.isZstdCompressionAvailable()` 返回 false，其余格式正常 |
| Spring Kafka / Flink | 通过 kafka-clients 传递引入 | **未找到**官方"关闭 zstd"的配置项；本质同 kafka-clients |
| aircompressor 自身 | 仅 **test scope**（3.10 pom：`zstd-jni:1.5.7-17` scope=test） | 不传递到用户 |
| Netty / RocksDB / Pulsar | **未找到**确凿的 POM 证据，未逐一核实 | — |

---

## 3. 放弃 zstd，改用其他纯 Java 算法

### 3.1 公开 benchmark

**官方 zstd 项目 benchmark（Silesia 语料，Core i7-9700K @4.9GHz，Ubuntu 24.04，lzbench + gcc 14.2.0）** 【已核实，取自 OpenHarmony 镜像的 zstd README，内容与上游一致】

| 算法 | 压缩率 | 压缩速度 | 解压速度 |
|---|---|---|---|
| **zstd 1.5.7 -1** | **2.896** | **510 MB/s** | **1550 MB/s** |
| brotli 1.1.0 -1 | 2.883 | 290 MB/s | 425 MB/s |
| zlib 1.3.1 -1（=JDK Deflate 同族） | 2.743 | 105 MB/s | 390 MB/s |
| zstd --fast=1 | 2.439 | 545 MB/s | 1850 MB/s |
| zstd --fast=4 | 2.146 | 665 MB/s | 2050 MB/s |
| **lz4 1.10.0** | **2.101** | **675 MB/s** | **3850 MB/s** |
| **snappy 1.2.1** | **2.089** | **520 MB/s** | **1500 MB/s** |

来源：https://gitcode.com/openharmony-tpc/chromium_zstd/blob/144_trunk/lib/README.md （上游同源：https://github.com/facebook/zstd#benchmarks ）

**读法**：zstd 1 级比 zlib 高约 +5.6% 压缩率且压缩快 4.9 倍、解压快 4 倍；lz4/snappy 压缩率只比 zlib 低约 23–24%，但速度快得多。**从 zstd 换到 lz4/snappy 会损失约 28% 压缩率换取 1.3–2.5 倍速度**——对网络传输型后端通常是亏的。

**CPU 无关的横向对比**（本机 aarch64，20000 B 高冗余数据，纯 Java 实现）：

| 实现 | 库 | 结果 |
|---|---|---|
| LZ4 纯 Java | `lz4-java` `LZ4Factory.fastestJavaInstance()` | ✅ roundtrip 正确，压缩率 0.42% |

### 3.2 哪些库是纯 Java、无 JNI？ 【已核实】

| 库 | 纯 Java？ | 证据 |
|---|---|---|
| **`io.airlift:aircompressor` 0.27** | ✅ **纯 Java，jar 内 0 个 .so/.dylib/.dll** | 反编译 jar 确认；LZ4/Snappy/Zstd 的 `Lz4Compressor`/`SnappyCompressor`/`ZstdCompressor` 都是纯 Java 路径 |
| **`aircompressor-v3` 3.10** | ⚠️ **部分**：`*Java*` 类纯 Java，同时 jar 内打包 glibc `.so`（`aircompressor/linux-aarch64/*.so`），且需 Java 25 | 反编译 jar 确认 |
| **`org.lz4:lz4-java`** | ⚠️ **混合，但有纯 Java 回退** | jar 内**确实打包** 8 个原生库（`net/jpountz/util/linux/aarch64/liblz4-java.so` 等，均为 glibc）；但 `LZ4Factory.fastestJavaInstance()` 走 `safeInstance()`/`unsafeInstance()`，**完全不碰 JNI**。我实测纯 Java LZ4 roundtrip 成功。维护版：`at.yawk.lz4:lz4-java`（最新 **1.12.0**），同样打包原生库且结构一致。 |
| **`org.xerial.snappy:snappy-java`** | ❌ **JNI** | jar 内打包 **22 个原生库**（`org/xerial/snappy/native/Linux/aarch64/libsnappyjava.so` 等），`SnappyLoader` 调 `System.load`（实测输出 `java.lang.System::load has been called by org.xerial.snappy.SnappyLoader`）。**鸿蒙上必挂。** |
| **JDK 自带 Deflate/GZIP/Zip** | ❌ 非纯 Java（`java.util.zip` 内部走 native zlib） | aircompressor README 原文：*"This is implemented in the built-in Java libraries **which internally use the native code**."* 但 **JDK 自带的 native 是 JDK 自身的组成部分**，不涉及额外 `.so` 加载，因此在鸿蒙上**通常仍可用**（取决于鸿蒙 JVM 是否完整实现 java.util.zip）。 |

### 3.3 Kafka 生态关掉 zstd 会不会影响与 broker 的兼容？ 【已核实 / 部分推测】

已核实的事实：
1. 压缩**不是**客户端与 broker 之间协商的能力，而是**每批消息（RecordBatch）上的一个 attribute 位**。`CompressionType` 的枚举是 `NONE(0)/GZIP(1)/SNAPPY(2)/LZ4(3)/ZSTD(4)`，`CompressionType.forId(4)` 直接返回 `ZSTD`，**不需要 zstd-jni 在场**（实测：classpath 无 zstd-jni 时枚举加载与 `forId(4)` 均正常）。
2. Kafka 复用的是**生产者自己设置的压缩类型**；broker 只在 `compression.type` 显式配置且 `log.message.format.version`/验证开启的情况下才会重新压缩。
3. 因此：**只要 producer 不选 zstd，producer 侧永远不需要 zstd 能力**。broker 端 topic 配 `compression.type=zstd` 不会强迫客户端发 zstd。
4. **消费侧是真风险**：如果 topic 上存在 zstd 压缩的 batch（别的 producer 发的，或 broker 按 `compression.type=zstd` 重压过），那么缺 zstd 实现的 consumer **解码该 batch 会失败**，表现为 `NoClassDefFoundError`/`ClassNotFoundException`（被 Kafka 包成 `KafkaException` 或 `UnsupportedCompressionTypeException`；具体异常类名 **未找到** 确定性官方文档表述，但实测缺失 zstd-jni 时的根因就是 `NoClassDefFoundError: com/github/luben/zstd/ZstdOutputStreamNoFinalizer`）。
5. **实测（本次调研的关键证据）**：在**没有 zstd-jni** 的 classpath 上，kafka-clients 4.0.0 可以正常加载 `CompressionType` 枚举、正常构建并使用 **gzip** 压缩；只有当你显式请求 zstd 时才抛 `NoClassDefFoundError`。**说明"不用 zstd 就能在没有 zstd-jni 的环境跑 Kafka 客户端"是成立的。**

**历史先例（很有说服力）**：Kafka 3.8.0 曾因把 zstd-jni 变成硬依赖而导致 z/OS 与 `noexec /tmp` 环境完全无法启动：
- [KAFKA-17891](https://issues.apache.org/jira/browse/KAFKA-17891)：*"Kafka 3.8.0 has introduced a hard dependency on zstd-jni... it fails on z/OS because zstd-jni does not include a library for this platform... Since the pre-req is only for optional compression it should be a soft dependency and fail only when the functionality is actually used."*
- [KAFKA-17227](https://issues.apache.org/jira/browse/KAFKA-17227)：`/tmp` 为 `noexec` 时 Kafka 3.8.0 连 `kafka-storage.sh` 都无法运行，报 `UnsatisfiedLinkError: /tmp/lib/libzstd-jni-...so: failed to map segment from shared object`，即便 `compression.type=none`。修复版本：3.7.2 / 3.8.1 / 3.9.0。

→ **这与你遇到的鸿蒙问题是同一类故障**（zstd-jni 在目标平台无匹配原生库 / 无法加载）。Kafka 社区把它当 bug 修，并明确认为"应该是软依赖、只在真正用到时才失败"。

---

## 4. HarmonyOS/OpenHarmony 上用纯 Java 替代 JNI 压缩库的先例

**直接"在鸿蒙上用纯 Java 压缩库替代 JNI 压缩库"的成功先例：未找到。** 但找到了大量**更相关**的旁证，其中一条尤其重要：

### 4.1 【已核实，强证据】OpenHarmony-TPC 官方移植版 `commons-compress` 的做法

`@ohos/commons-compress`（OpenHarmony-TPC，ohpm 官方三方库中心仓，最新 2.0.8，下载量 10639，仓库 https://gitcode.com/openharmony-tpc/CommonsCompress ，是一个用 TypeScript 重写的 Apache Commons Compress 移植版）的依赖清单：

```
"dependencies": {
  "js-sha256", "lz4js", "pako", "snappyjs", "text-encoding"
},
"devDependencies": {
  "@types/libzstdnapi.so": "file:./src/main/cpp/types/libzstdnapi"
}
```

来源：https://ohpm.openharmony.cn/ohpmweb/registry/oh-package/openapi/v1/detail/@ohos%2Fcommons-compress 与 https://gitee.com/zhang-huan-633/CommonsCompress/blob/master/CommonsCompress/oh-package.json5

**这条证据的信息量极大：**
- LZ4 → `lz4js`（纯 JS）
- Deflate/GZIP → `pako`（纯 JS）
- Snappy → `snappyjs`（纯 JS）
- **zstd → 没有任何纯 JS/纯 ArkTS 实现，只能自己写 NAPI 层去调 `libzstdnapi.so`**（注意：`libzstdnapi.so` 是他们**自己编译**的 NAPI 库，不是系统库）

→ **【推测，但推断链很短】** 鸿蒙生态里 **zstd 至今没有纯 Java/纯 TS 的可替代实现，社区的标准答案就是"自己编一个 zstd 的 NAPI/JNI 库"**。这也解释了为什么 pure-Java zstd 在鸿蒙上没有先例。

### 4.2 【已核实】有人在鸿蒙上成功用 Node-API + zstd 做了批量压缩

博客《HarmonyOS 7 TaskPool + Node-API + zstd：Native 批量压缩任务的主线程隔离、进度回传与资源收口》（李游Leo，2026-10-01）：
https://ai6s.net/6abd3f2dad85947e68cd52a3.html

关键原文：
- *"我用 **OHOS NDK 编译出适配目标架构的库**，再通过 C++ Node-API 层暴露一个同步 `compress()` 方法给 ArkTS。"*
- 代码片段用了真实的 zstd C API：`ZSTD_compressBound` / `ZSTD_compress` / `ZSTD_isError` / `ZSTD_getErrorName`，以及 `ZSTD_createCCtx` / `ZSTD_compressCCtx` / `ZSTD_freeCCtx`。
- Demo 数据：12 files / 输入 64.0 MB / 输出 18.7 MB / ratio 29.2% / level 6 / 1260 ms。

→ **证明：用 OHOS NDK 交叉编译 zstd 并在鸿蒙应用内调用，是已经跑通的路径。**

### 4.3 【已核实】社区确实在为鸿蒙找 zstd 方案

- 论坛帖《HarmonyOS 鸿蒙Next 求助，求zstd解压字节数组的第三方库》：http://bbs.itying.com/topic/66dd26c2bb648a00d0981196
  - 提问者明确说要**解压字节数组**；1 楼推荐 `@ohos/commons-compress`；2 楼回复 *"这个我也看过。但这个解压的是文件。我的需求是解压一个字节数组"* —— 说明**现有鸿蒙方案连字节数组级别的 zstd 都不好用**。
- npm/ohpm 包 `@ohos-ports/zstd-napi`（"Zstandard (zstd) compression library bindings with Node-API"，最新 `0.0.13-beta.0`，仓库 https://github.com/ohos-ports/ohos-ports ）：又是一条"**为鸿蒙单独打包一个 zstd native binding**"的证据。
- `zstd4cj`（基于 Zstd 的仓颉 FFI 绑定，https://gitcode.com/dove-tec/zstd4cj ）：鸿蒙主推的仓颉语言也要为 zstd 单独做 FFI 绑定。

### 4.4 其他相关项目

- `openharmony-tpc/chromium_zstd`：OpenHarmony 生态的 zstd 实现项目（https://gitcode.com/openharmony-tpc/chromium_zstd ，注意含 `openharmony-sig/chromium_zstd` 别名）。
- `build_in_harmonyos`（OpenHarmony 平台开源软件编译兼容性框架，https://gitcode.com/OpenHarmonyPCDeveloper/build_in_harmonyos ）的 `archives/z/zstd-jni` 目录，其 **manifest.yaml 引用了 zstd-jni**，说明该框架把 zstd-jni 作为一个"待适配 OpenHarmony 的归档包"跟踪；另有一个 issue 明确讨论 OHOS 交叉构建下 zstd 的 `CHECK_LIBRARY_EXISTS` 探测静默失败问题（https://gitcode.com/OpenHarmonyPCDeveloper/build_in_harmonyos/issues/3370 ）。**但我未能读取到 manifest.yaml 的正文**（页面是 JS 渲染，返回的是导航壳），所以**不能确认该归档是否已成功产出 OHOS 版 zstd-jni 的 .so**。标记为 **未找到**。

---

## 5. OpenHarmony 有系统级 libzstd 吗？能否自己写极小的 JNI 包装？

### 5.1 结论：**没有系统级 libzstd** 【已核实】

我核对了 **OpenHarmony master 的官方 manifest**（`https://gitee.com/openharmony/manifest/raw/master/ohos/ohos.xml`，84,218 字节，**496 个 project**，内含 **180 个 third_party 组件**）：

- 全文检索 `zstd` / `zstandard`：**0 命中**
- 压缩相关组件**只有 4 个**：`third_party/brotli`、`third_party/bzip2`、`third_party/lz4`、`third_party/zlib`

（对比：`third_party/musl` 在列表里，与"OHOS 用 musl libc"一致。）

→ **标准 OpenHarmony 系统镜像里不包含 libzstd**。**【推测】** 因此 `System.loadLibrary("zstd")` 或 JNI 直接链接系统 libzstd 这条路**在标准镜像上不可行**——即使华为闭源 HarmonyOS 的商业版镜像里可能因 Chromium/ArkWeb 而带上 zstd，那也属于**私有库**，第三方应用不能依赖（也不在 NDK 公开库列表里；公开 NDK 库列表 **未找到**明确提及 zstd）。

### 5.2 但官方提供了两条把 zstd 弄上去的路径 【已核实】

OpenHarmony-SIG 的 `tpc_c_cplusplus`（C/C++ 三方库适配项目，即 **lycium** 交叉编译框架）里，zstd 是一等公民，有完整目录结构：
```
thirdparty/zstd/
├── docs/{hap_integrate.md, rom_integrate.md}
├── BUILD.gn
├── bundle.json
├── HPKBUILD      # 构建脚本
├── HPKCHECK      # 测试脚本
├── SHA512SUM
├── README.OpenSource
├── README_zh.md
├── OAT.xml
```

**路径 A：集成到系统 ROM（需要刷机权限，应用开发者不适用）**
`rom_integrate.md` 原文要点：
- 把 `thirdparty/zstd` 拷到 `~/openharmony/third_party/`
- 在 `vendor/hihope/rk3568/config.json` 里，`subsystem: "thirdparty"` 下新增 `{"component": "zstd", "features": []}`
- `hb build --target-cpu arm64`
- 产物在 `out/rk3568/thirdparty/zstd`，**手动 `mv libzstd_shared.z.so /system/lib64/`**

来源：https://raw.gitcode.com/CPF-ApplicationTPC/tpc_c_cplusplus/raw/master/thirdparty/zstd/docs/rom_integrate.md （同文：https://gitee.com/openharmony-sig/tpc_c_cplusplus/blob/master/thirdparty/zstd/docs/rom_integrate.md ）
注意产物名是 `libzstd_shared.z.so`（OHOS 的带版本号命名），且需要 `mount -o remount,rw /`，**明确是 ROM 级改动**。

**路径 B：集成到应用 HAP（应用开发者可用）——推荐**
`hap_integrate.md` 原文要点：
```bash
cd lycium && ./build.sh zstd      # 产出 usr/zstd/{arm64-v8a,armeabi-v7a}
```
然后在 IDE 的 cpp 目录下建 thirdparty 目录，CMake 里：
```cmake
target_link_libraries(entry PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/zstd/${OHOS_ARCH}/lib/libzstd.a)
target_include_directories(entry PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/zstd/${OHOS_ARCH}/include)
```
来源：https://raw.gitcode.com/openharmony-sig/tpc_c_cplusplus/raw/master/thirdparty/zstd/docs/hap_integrate.md

> **关键洞察**：官方示例用的是 **`libzstd.a`（静态库）**，直接链进 `entry` 这个 native 目标。**这恰好绕开了鸿蒙"应用不能从私有目录 dlopen .so"的沙箱限制**——因为 zstd 的代码变成了你 HAP 内 `libentry.so` 的一部分，走的是官方支持的 native 库加载机制。**这是本问题最优的工程解法。**

### 5.3 工作量评估（自写极小 JNI 包装）

| 项目 | 评估 |
|---|---|
| **zstd 侧代码量** | **0 行**——`libzstd.a` 由 lycium 一键构建，无需改上游 |
| **JNI 包装代码量** | 约 **150–300 行 C**。最小 API 面：`ZSTD_compressBound` / `ZSTD_compress` / `ZSTD_decompress` / `ZSTD_getFrameContentSize` / `ZSTD_isError` / `ZSTD_getErrorName`；流式再加 `ZSTD_createCCtx`/`ZSTD_compressStream2`/`ZSTD_createDCtx`/`ZSTD_decompressStream`（可后置） |
| **构建配置** | CMakeLists.txt 加 1 个 `target_link_libraries` + 1 个 `target_include_directories`，约 10 行 |
| **Java 侧** | 一个 `native` 方法声明 + `System.loadLibrary("entry")`（复用 HAP 已有的 native 库名，**不新增 .so**），约 50 行 |
| **总工期** | **【推测】** 熟悉 NDK 的人 1–3 天可跑通压缩/解压；加流式 API 与错误处理约 1 周 |
| **主要风险** | ① 需要能跑 `lycium` 构建环境（Docker/Linux）；② JNI 层的 `GetByteArrayElements`/`GetPrimitiveArrayCritical` 与 DirectByteBuffer 选型要正确，否则会退化性能；③ 与 zstd-jni 的 API 不兼容，业务代码要改 |

**对比**：如果目标是保留 Kafka 兼容性，路径 B + shim（第 6 节方案 E）比纯 Java 方案更稳，因为底层是**官方 zstd 实现**，格式、字典、窗口、性能全部一致。

---

## 6. 替代方案对照表

| # | 方案 | 是否纯 Java | 支持压缩/仅解压 | 迁移成本 | 主要风险 |
|---|---|---|---|---|---|
| **A** | `io.airlift:aircompressor:0.27`（纯 Java zstd） | ✅ 纯 Java（jar 内 0 个 .so），Java 8 字节码 | **压缩 + 解压 + 流式**（实测与官方 zstd 1.5.7 双向互通） | **中**：替换业务代码里的 zstd-jni 调用；**但 Kafka 场景必须额外写 shim 或 fork**（Kafka 硬编码 zstd-jni 类名） | ① **硬依赖 `sun.misc.Unsafe`**，JBolt/鸿蒙 JVM 若禁用则不可用；② **不支持字典**；③ 8 MiB 窗口上限（实测仅真实 >8 MiB 回溯时触发）；④ 版本停在 0.27（2024-05），后续无同坐标更新 |
| **B** | `io.airlift:aircompressor-v3:3.10` | ⚠️ 部分（`*Java*` 类纯 Java，但 jar 内打包 glibc `.so`） | 压缩 + 解压 + 流式 | 高 | ① **需要 Java 25**（字节码 major 69，且 API 出现 `java.lang.foreign.MemorySegment`）——鸿蒙上极难满足；② 内置 .so 是 glibc，需 `-Dio.airlift.compress.v3.disable-native` 关闭 |
| **C** | 自写 JNI/NAPI 包装 + lycium 交叉编译的 **`libzstd.a` 静态链入**（官方路径） | ❌ 有 native，但**无 .so 加载** | 压缩 + 解压 + 流式 + 字典（官方实现全功能） | **中低**：zstd 侧零改动，约 150–300 行 C + ~10 行 CMake | ① 需 `lycium` 构建环境；② 与 zstd-jni API 不兼容，调用点要改；③ 需自己保证 JNI 内存/性能正确 |
| **D** | 换算法：**纯 Java LZ4**（`lz4-java` 的 `fastestJavaInstance()`，或 aircompressor 的 `Lz4Compressor`） | ✅ 纯 Java（`lz4-java` 走 safe/unsafe 路径，**不碰 JNI**，已实测） | 压缩 + 解压 | 中 | ① **压缩率比 zstd 低约 27%**（2.101 vs 2.896）；② `lz4-java` 1.8.0 已停更（维护版为 `at.yawk.lz4:lz4-java` 1.12.0）；③ **Kafka 场景同样要 shim/fork**；④ 与已有 zstd 数据不兼容，需重刷数据 |
| **E** | **纯 Java zstd + 同名 shim**：在 `com.github.luben.zstd` 包名下实现 `ZstdOutputStreamNoFinalizer` / `ZstdInputStreamNoFinalizer` / `BufferPool` / `RecyclingBufferPool`，委托 aircompressor 0.27 | ✅ 纯 Java | 压缩 + 解压（Kafka 需要的子集） | **低–中**：**kafka-clients 与业务代码零改动** | ① shim 的 API 面要覆盖 Kafka 实际用到的部分（含 `BufferPool`，Kafka 有匿名子类实现该接口）；② 仍需 `sun.misc.Unsafe`；③ 与 zstd-jni 的**异常语义**不同（`KafkaException` 包装后的类型可能变化）；④ 属"自造依赖"，长期需自维护。**已核实可行性**：native 与 Java 实现各自均确定性压缩，Kafka 的去重逻辑不受影响 |
| **F** | 关掉 zstd，改用 **JDK 自带 gzip/deflate** | ❌ `java.util.zip` 内部走 native zlib，**但不涉及额外 .so 加载** | 压缩 + 解压 | **低**（Kafka 侧实测可用） | ① 压缩率最低（2.743 vs zstd 2.896），压缩速度仅 105 MB/s（zstd -1 的 1/4.9）；② 取决于鸿蒙 JVM 是否完整实现 `java.util.zip`；③ **消费侧若遇 zstd batch 仍会失败** |
| **G** | 用 `org.xerial.snappy:snappy-java` | ❌ **JNI**（jar 内 22 个原生库） | 压缩 + 解压 | — | **鸿蒙上必挂**，与 zstd-jni 同类问题。除非另编 OHOS native —— 那不如直接用方案 C |
| **H** | Apache Commons Compress 的 zstd | ❌ 依赖 **zstd-jni**（optional） | 压缩 + 解压 | — | **完全不解决问题**：`ZstdCompressorInputStream` 的字段就是 `com.github.luben.zstd.ZstdInputStream` |

### 推荐排序（针对"鸿蒙 musl + Kafka 后端"这一具体场景）

1. **方案 E（aircompressor 0.27 + `com.github.luben.zstd` shim）**——若必须"纯 Java + 零 Kafka 改动"，这是唯一路径；成本最低，且我已实测其底层压缩产物与官方 zstd 完全互通。
2. **方案 C（libzstd.a 静态链入 + 自写 JNI）**——工程上最稳、性能与格式完全对齐官方，且用官方支持的机制绕开沙箱；代价是引入 native 编译环节。
3. **方案 F（退化到 gzip）**——如果这套后端里 zstd 只是"顺手用用"、且能确认 topic 上没有别人写的 zstd batch，成本最低、最省事。
4. **方案 D（换 LZ4）**——只有在确认"延迟比带宽重要"时才选，且要接受 27% 压缩率损失与数据重刷。
5. **方案 B（aircompressor-v3）**——除非鸿蒙侧能上 Java 25，否则直接排除。

---

## 7. 明确"未找到"的项

- 在鸿蒙上**用纯 Java 压缩库替代 JNI 压缩库**的成功先例 —— **未找到**（找到的都是"自己编 native 库"的路径）。
- `com.github.luben` 提供纯 Java zstd 实现 —— **未找到**。
- `build_in_harmonyos` 的 `zstd-jni` archive 是否已产出可用的 OHOS 版 `.so` —— **未找到**（页面 JS 渲染，拿不到 manifest.yaml 正文）。
- Apache Commons Compress **不依赖** zstd-jni 的版本 —— **未找到**（1.27.1 确认依赖）。
- 华为官方 NDK 公开库列表中对 zstd 的明确记载（含/不含）—— **未找到**。
- 缺失 zstd 实现时 Kafka 抛出的**确切异常类名**（`UnsupportedCompressionTypeException`？）—— **未找到**官方文档表述；实测根因是 `NoClassDefFoundError`，被 `ZstdCompression` 用 `catch (Throwable e) { throw new KafkaException(e); }` 包装。
- Netty / RocksDB / Pulsar 是否传递引入 zstd-jni —— **未找到**确凿 POM 证据（未逐一核实）。
- aircompressor 纯 Java 与原生实现的**官方 JMH 对比数据** —— **未找到**（本报告中的 2.4×/3.4× 为本机自测结果，非官方数据）。

---

## 附：本报告的核心实测命令与产出（可复现）

```bash
# 1. 拉取 aircompressor 0.27（纯 Java，jar 内零 .so）
curl -O https://repo1.maven.org/maven2/io/airlift/aircompressor/0.27/aircompressor-0.27.jar
unzip -l aircompressor-0.27.jar | grep -cE '\.so$|\.dylib$|\.dll$'   # => 0
# 2. 双向互通验证
java -cp aircompressor-0.27.jar:. ZTest     # aircompressor -> official zstd
zstd -d -c ac.zst > out                     # exit=0
zstd -q -f -19 refsrc.bin -o ref19.zst && java ... # official -> aircompressor
# 3. 字典（预期失败）
zstd -q -f -D dict.bin refsrc.bin -o ref_dict.zst
#    => Custom dictionaries not supported: offset=25
# 4. 性能对比（同机同数据同 level 3）
#    zstd-jni 1.5.6-6 native : compress 1471 MB/s | decompress 2504 MB/s | ratio 5.23%
#    aircompressor 0.27 Java : compress  612 MB/s | decompress  730 MB/s | ratio 5.20%
# 5. Kafka 在无 zstd-jni 的 classpath 上
java -cp kafka-clients-4.0.0.jar:slf4j-api-1.7.36.jar:aircompressor-0.27.jar:. KFull2
#    none -> OK | gzip -> OK | snappy -> FAIL | lz4 -> FAIL | zstd -> FAIL
```
