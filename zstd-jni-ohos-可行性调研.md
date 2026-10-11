# zstd-jni 交叉编译到 HarmonyOS（aarch64-linux-ohos / musl）可行性调研

> 调研时间：2026-10
> 上游版本基准：zstd-jni **v1.5.7-23**（git HEAD `fbee544eb093b4c90e3935b873e13f16afa93669`，`version` 文件内容 `1.5.7-23`）
> 源码已克隆至 `_research/zstd-jni-ohos/zstd-jni/`（本文所有"仓库内路径"均相对该目录）
> 标注约定：**【已核实】** = 读到原文/源码/实测 ELF；**【推测】** = 由已核实事实推导，未直接验证

---

## 0. 结论速览（先看这个）

| 问题 | 结论 |
|---|---|
| 能否为 OHOS 编译？ | **能，且已有公开成功先例**【已核实】——某鸿蒙 PC 三方库移植框架把 zstd-jni 1.5.6-5 标记为 `published` |
| 工作量大不大？ | **很小**。只需 1 个 1 行 CMake 补丁（加 vendored `jni/` 头文件目录），无需改任何 C 代码 |
| 需要额外带 libzstd.so 吗？ | **不需要**，zstd 源码静态编入。已用 ELF NEEDED 实测证明 |
| Maven 中央仓有 ohos 版本吗？ | **没有**。已逐文件列出 1.5.7-23 全部 classifier，无 ohos |
| 直接拿 Maven 的 `linux_aarch64` jar 能在鸿蒙跑吗？ | **不能**。实测其 NEEDED 为 `libc.so.6` + `libpthread.so.0`，而 OHOS 实测 NEEDED 为 `libc.so` —— 必然 `UnsatisfiedLinkError` |
| 主要风险点 | 不是编译，而是**运行时 so 的加载位置**（沙盒/XPM 签名管控） |

---

## 1. zstd-jni 的构建方式

### 1.1 存在两套并行的构建路径 —— 别被 CMakeLists.txt 误导

**【已核实】** 仓库根目录同时有：

| 文件 | 作用 |
|---|---|
| `CMakeLists.txt` | 通用 CMake 构建入口（**OHOS 移植就是走这条路**） |
| `build.sbt`（36 KB） | 官方 Maven 制品发布主路径（sbt + artifact classifier） |
| `make_so.sh` | 官方 Linux/FreeBSD/AIX 原生发布编译（ssh 到各架构机器上跑 gcc） |
| `make_so_cross.sh` | 官方交叉编译脚本（riscv64，qemu 容器） |
| `make_so_cross_buster.sh` | 老 Debian（buster）交叉编译，用于压低 glibc 版本需求 |
| `jni/` | **vendored `jni.h` + `jni_md.h`**（各 1960 / 51 行）——OHOS 移植的关键 |
| `libzstd-jni.so.map` / `.exported` | 符号可见性版本脚本 |

`CMakeLists.txt` 全文只有 20 行，核心是：

```cmake
cmake_minimum_required(VERSION 3.5)
project(zstd-jni C ASM)
file(STRINGS "version" NATIVE_VERSION)          # ← 版本号来自 version 文件
find_package(JNI)
include_directories("src/main/native" "src/main/native/common" \
                    "src/main/native/compress" "src/main/native/decompress" \
                    "src/main/native/dictBuilder")
add_library(zstd-jni-${NATIVE_VERSION} SHARED ${SOURCES})
add_definitions("-DZSTD_MULTITHREAD=1")
```

来源：`CMakeLists.txt`（仓库内路径）

### 1.2 native 目录结构：zstd 源码是完整内置的

**【已核实】** `src/main/native/` 是 **zstd 1.5.7 的完整 vendored 源码树**：

```
src/main/native/
├── zstd.h / zdict.h / zstd_errors.h     # 公共头
├── jni_*.c  (8 个)                      # JNI 胶水层：jni_zstd.c / jni_zdict.c /
│                                        #   jni_inputstream_zstd.c / jni_outputstream_zstd.c /
│                                        #   jni_bufferdecompress_zstd.c /
│                                        #   jni_directbuffercompress_zstd.c /
│                                        #   jni_directbufferdecompress_zstd.c / jni_fast_zstd.c
├── ffm_zstd.c                           # Panama/FFM 绑定（java22）
├── common/   (24 文件)                  # entropy/fse/huf/xxhash/pool/threading/zstd_common
├── compress/ (26 文件)                  # zstd_compress*.c, zstdmt_compress.c, zstd_opt.c ...
├── decompress/ (8 文件)                 # 含 huf_decompress_amd64.S
└── dictBuilder/ (5 文件)                # cover.c, fastcover.c, zdict.c, divsufsort.c
```

- `src/main/native/README.md` + `LICENSE`/`COPYING` 存在 → 确认是同步自 facebook/zstd
- `zstd.h` 中 `ZSTD_VERSION_MAJOR/MINOR/RELEASE = 1/5/7` 【已核实】
- **共 39 个 `.c` + 1 个 `.S`**，全部在 `src/main/native/` 下（即 `GLOB_RECURSE "src/*.c"` 不会误抓测试代码）【已核实：`find src -name "*.c"` 只返回上述 5 个目录】

**结论：不依赖任何外部 libzstd，也不需要 `-lzstd`。**

### 1.3 官方发布编译命令（真实使用的，非 CMake）

**【已核实】** `make_so.sh:23`（aarch64 那一行走的是这个模板）：

```bash
gcc -Wl,--version-script=./libzstd-jni.so.map -Wl,-Bsymbolic -Wl,-z,relro,-z,now \
    -shared -flto -fPIC -O3 -DZSTD_MULTITHREAD=1 \
    -I/usr/include -I./jni -I./native -I./native/common -std=c99 \
    -lpthread -o libzstd-jni-<version>.so \
    native/*.c native/common/*.c native/compress/*.c \
    native/decompress/*.[cS] native/dictBuilder/*.c
```

注意其中 **`-static-libgcc`**（在 `CC` 变量默认值 `"gcc -static-libgcc"` 里）—— 这个参数是 musl 兼容性的历史关键，见 §2.3。

---

## 2. 交叉编译到 aarch64-linux-ohos 的可行性

### 2.1 有公开先例：`build_in_harmonyos` 框架【已核实，最重要的证据】

存在一个专门做「开源软件 → OpenHarmony 编译兼容性」的框架项目 `build_in_harmonyos`，其归档中**明确收录了 zstd-jni 且状态为 published**。

**归档 manifest**（`archives/z/zstd-jni/manifest.yaml`，来源 <https://gitcode.com/asp1r1n1/build_in_harmonyos/blob/feat%2Fqjackctl-1.0.4-asp1/archives/z/zstd-jni/manifest.yaml>）：

```yaml
software: zstd-jni
category: compress
homepage: "https://github.com/luben/zstd-jni"
license: BSD-2-Clause
build_system: cmake
ohos_adaptation:
  key_points:
    - "JNI 项目可使用本地 jni.h 头文件编译"
    - "自包含，不需要外部 zstd 库"
    - "需修补 CMakeLists.txt 添加 JNI include 路径"
  common_dependencies:
    - jni
versions:
  "1.5.6-5":
    status: published
    build_date: "2026-04-24"
```

**版本级 manifest**（`archives/z/zstd-jni/1.5.6-5/manifest.yaml`）：

```yaml
version: "1.5.6-5"
status: published
build_date: "2026-04-24"
source:
  url: "https://github.com/luben/zstd-jni/archive/refs/tags/v1.5.6-5.tar.gz"
  tar_format: tar.gz
build:
  system: cmake
  configure_options:
    - "cmake -DCMAKE_C_COMPILER=clang"
  dependencies: []
patches_applied:
  - "0001-cmake-add-jni-include.patch"
knowledge_gained:
  - "JNI 项目可使用本地 jni.h 头文件编译"
  - "zstd-jni 是自包含的，不需要外部 zstd 库"
```

**唯一需要的补丁**（`archives/z/zstd-jni/1.5.6-5/patches/0001-cmake-add-jni-include.patch`，全文 555 字节，就 1 行改动）：

```diff
--- a/CMakeLists.txt
+++ b/CMakeLists.txt
@@ -5,7 +5,7 @@
 file(STRINGS "version" NATIVE_VERSION)
 find_package(JNI)
-include_directories("src/main/native" "src/main/native/common" "src/main/native/compress" "src/main/native/decompress" "src/main/native/dictBuilder" "src/main/native/legacy")
+include_directories("jni" "src/main/native" "src/main/native/common" "src/main/native/compress" "src/main/native/decompress" "src/main/native/dictBuilder" "src/main/native/legacy")
 if (JNI_FOUND)
     include_directories(${JNI_INCLUDE_DIRS})
 endif (JNI_FOUND)
```

即：**把仓库自带的 `jni/`（vendored `jni.h`）加进 include 路径**，就不再依赖构建机上的 JDK。

**构建结果**（`archives/z/zstd-jni/1.5.6-5/notes.md`）：
- 状态：`success`，构建系统 `cmake`，源码来自 GitHub tag tarball
- 流程走完：`init-build` → `configure` → `make` → `make install` → `make check` → 打包
- 产出主包名：**`zstd-jni-1.5.6-5-ohos-aarch64.tar.gz`**
- 遗留问题：无

> **重要辨析【已核实】**：该框架的 OHOS 构建 profile（`ci/conan/profiles/ohos-aarch64`）指向
> `tools.build:compiler_executables={"c": "/data/service/hnp/bin/clang", ...}`，
> 且 `[buildenv] PATH=+(path)/data/service/hnp/bin`。
> 也就是说 —— **这个先例是在鸿蒙 PC 本机上用 hnp（HarmonyOS Native Package）工具链「本机编译」的，不是在 macOS/Linux 上交叉编译的**。
> 这证明「zstd-jni 在 OHOS/musl/aarch64 上能编译且能跑通验证」，但**不等于**「从外部主机交叉编译已验证」。

### 2.2 官方 issue tracker：**没有任何 OHOS/HarmonyOS 讨论**

**【已核实】** 对 `luben/zstd-jni` 做 issue 全量检索（关键词 `ohos OR harmony OR musl OR alpine`），`total_count = 7`，逐条如下：

| # | 标题 | 状态 | 日期 |
|---|---|---|---|
| [#260](https://github.com/luben/zstd-jni/issues/260) | Support for system-provided libzstd | closed | 2023-05-07 |
| [#157](https://github.com/luben/zstd-jni/issues/157) | Alpine link error | closed | 2021-01-24 |
| [#114](https://github.com/luben/zstd-jni/issues/114) | Version 1.4.4-5 not able to locate native library in Docker container | closed | 2020-01-22 |
| [#88](https://github.com/luben/zstd-jni/issues/88) | SSE2 support in binaries | closed | 2019-02-11 |
| [#43](https://github.com/luben/zstd-jni/issues/43) | UnsatisfiedLinkError on Alpine linux | closed | 2017-09-13 |
| [#47](https://github.com/luben/zstd-jni/issues/47) | Support Older version of Linux distribution | closed | 2017-10-19 |
| [#38](https://github.com/luben/zstd-jni/issues/38) | Error running on alpine docker image | closed | 2017-06-14 |

→ **`ohos` / `harmony` 命中数为 0。** 官方从未讨论过鸿蒙，也没有 PR。
**【已核实】** 另外在克隆的源码树里 grep `ohos|harmony`（排除 `.git`），**零命中**（仅 3 个二进制测试资源误匹配）。

### 2.3 已知 musl 移植障碍：**没有障碍，且历史上已解决**

#### (a) 真正的历史坑是 `libgcc_s.so.1`，不是 glibc

**[已核实]** [Issue #157](https://github.com/luben/zstd-jni/issues/157) 原文报错：

```
java.lang.UnsatisfiedLinkError: /tmp/libzstd-jni5866050574215524596.so:
Error loading shared library libgcc_s.so.1: No such file or directory
(needed by /tmp/libzstd-jni5866050574215524596.so)
```

维护者 luben 的定位与修复：
> "mystery solved... it looks we can statically compile the libgcc so that it will not be needed on the host."
> "I just pushed v1.4.8-2 to maven-central... It compiles the libgcc_s statically that's the only difference with the netty libs."

修复后 `ldd` 只剩 `libpthread` + `libc`。报告者回复：**"Amazing, it just works"**。
→ 该修复已固化进 `make_so.sh` / `make_so_cross.sh`（`-static-libgcc`）与 `build.sbt` 的 `jniGccFlags`。
→ **本次调研已实测确认**：Maven 上 `linux/aarch64` 的 `.so` 的 NEEDED 中**不含 `libgcc_s.so.1`**（见 §3）。

#### (b) glibc 专属函数：**一个都没有**

**【已核实】** 对 `src/main/native/` 全量 grep `MUSL|musl|__GLIBC__|gnu_get_libc|execinfo|backtrace|malloc_usable_size` → **零命中**。

实际用到的 libc 面（均在 musl 中齐备）：

| 用法 | 位置 | musl 支持 |
|---|---|---|
| `pthread_*`（create/join/mutex/cond） | `compress/zstdmt_compress.c`、`dictBuilder/cover.c`、`common/pool.c`、`common/threading.c` | ✅ musl 内置（无独立 libpthread） |
| `posix_memalign` | `common/xxhash.h:6082` | ✅ |
| `sysconf` | `compress/zstdmt_compress.c:54` | ✅ |
| `_GNU_SOURCE` | `common/zstd_deps.h`、`dictBuilder/cover.c` | ✅ musl 接受，仅影响符号可见性 |

#### (c) `-D__MUSL__` 是否需要？—— **对 zstd-jni 不需要**

**【已核实】** 仓库内 grep `__MUSL__` → 零命中。zstd 源码完全不感知 musl。

`-D__MUSL__` 是 **OpenHarmony SDK 自身的约定**：Rust 官方文档给出的 OHOS clang wrapper 写法是
（来源 <https://github.com/rust-lang/rust/blob/master/src/doc/rustc/src/platform-support/openharmony.md>）：

```sh
#!/bin/sh
exec /path/to/ohos-sdk/linux/native/llvm/bin/clang \
  -target aarch64-linux-ohos \
  --sysroot=/path/to/ohos-sdk/linux/native/sysroot \
  -D__MUSL__ \
  "$@"
```

→ 加上它无害（跟随 SDK 惯例），但 zstd-jni 不依赖它。

#### (d) `.S` 汇编文件对 aarch64 是安全的

**【已核实】** `src/main/native/decompress/huf_decompress_amd64.S` 整体被
`#if defined(__ELF__) && defined(__GNUC__)` 包住，内部对 `__aarch64__` 只发射一个
`.note.gnu.property`（BTI/PAC 标记），**没有任何 x86 指令**。aarch64 下等价于空文件，可安全编译。
（CMake 的 `project(zstd-jni C ASM)` 与 `GLOB_RECURSE "src/*.S"` 会带上它。）

---

## 3. 产出物：.so 名字 / 格式 / 是否要带 libzstd.so

### 3.1 名字

- **CMake 路径**：`add_library(zstd-jni-${NATIVE_VERSION} SHARED ...)`，`NATIVE_VERSION` = `version` 文件内容
  → 产出 **`libzstd-jni-1.5.7-23.so`**（注意名字里带连字符）
- **make_so.sh 路径**：`-o libzstd-jni-$VERSION.so` → 同上
- **jar 内资源路径**：`/<os>/<arch>/libzstd-jni-<version>.so`

### 3.2 是否需要额外 libzstd.so —— **不需要**

**【已核实，实测】** 下载 Maven 中央仓的 `zstd-jni-1.5.7-23-linux_aarch64.jar`，解包后解析 ELF `.dynamic` 段：

```
===== linux/aarch64/libzstd-jni-1.5.7-23.so
  machine: AARCH64
  NEEDED : ['libpthread.so.0', 'libc.so.6']
```

- **NEEDED 中没有 `libzstd.so*`** → zstd 已被静态编入同一个 `.so`
- 也没有 `libgcc_s.so.1` → `-static-libgcc` 生效
- `strings` 里可见 317 个 `ZSTD_*` 本地符号 + `GLIBC_2.17`（发布基线为 Debian 7 时代 glibc 2.13~2.17）
- 该 `.so` 内部同时导出 JNI 入口（`Java_com_github_luben_zstd*`）与 zstd C API（受 `libzstd-jni.so.map` 控制，其余 `local: *`）

→ **最终交付就是一个自包含的 `libzstd-jni-<ver>.so`，约 690 KB（aarch64），无需任何伴随库。**

### 3.3 ⚠️ 关键：Maven 上的 linux_aarch64 版本在鸿蒙上**必然加载失败**

**【已核实，实测对比】** 用同一套 ELF 解析器对比工作区里真实的 OHOS 二进制：

```
===== project-template/electron/libs/arm64-v8a/libelectron.so   (OHOS 真机产物)
  machine: AARCH64
  NEEDED : [..., 'libc++_shared.so', 'libc.so']           ← 注意：libc.so
===== project-template/electron/libs/arm64-v8a/libadapter.so
  NEEDED : [..., 'libc.so']
===== project-template/electron/libs/arm64-v8a/libffmpeg.so
  NEEDED : ['libc.so']
===== project-template/electron/libs/arm64-v8a/libc++_shared.so
  NEEDED : ['libc.so']
```

对比：

| | NEEDED |
|---|---|
| Maven `linux_aarch64` zstd-jni（glibc 构建） | `libpthread.so.0`, **`libc.so.6`** |
| OHOS 真实二进制（musl 构建） | **`libc.so`**（无 libpthread，musl 已合入 libc） |

→ OHOS 的 musl **不提供 `libc.so.6` 这个名字**，也**不提供 `libpthread.so.0`**。
→ 直接放 Maven 的 `linux_aarch64` 那个 `.so` 进鸿蒙，dlopen 会失败。
→ **必须自己为 OHOS 重新编译。**（这也反过来证明 §2.1 那个 OHOS 构建产物的价值。）

### 3.4 资源路径：鸿蒙上 `os.name`/`os.arch` 会解析成什么

**【已核实】** `Native.java`（`src/main/java/com/github/luben/zstd/util/Native.java`）逻辑与任务描述完全一致：

| 行 | 行为 |
|---|---|
| L17-20 | `ZstdNativePath` / `ZstdTempFolder` / `libnameShort="zstd-jni-"+ZstdVersion.VERSION` |
| L25-35 | `osName()`：`os.name` 小写 + 空格→下划线；**只特判 `win*`→`win`、`mac*`→`darwin`，其余原样返回** |
| L47-54 | `resourceName()` = `"/"+os+"/"+arch+"/"+libname+"."+ext`；仅对 `darwin`+`amd64` 把 arch 改 `x86_64` |
| L105-111 | `ZstdNativePath` 非空 → 直接 `System.load(path)` 并 **return，不回退** |
| L114-120 | 否则 `System.loadLibrary("zstd-jni-<ver>")` |
| L122-126 | 再否则 `getResourceAsStream("/<os>/<arch>/libzstd-jni-<ver>.so")`，取不到就抛 `UnsatisfiedLinkError` |
| L130 | `File.createTempFile(libname, "."+ext, tempFolder)` → 写临时文件再 `System.load(abs)` |
| L167-179 | `finally` 中 `tempLib.delete()`（Linux 下 dlopen 后删文件是安全的，inode 仍在） |
| L64-66 | `Native.assumeLoaded()` 逃生口 |

**【推测，但有强依据】** 鸿蒙 PC 上跑的是 **BiShengJDK17-OH**（毕昇 JDK17 鸿蒙版，musl；见工作区 `鸿蒙PC沙盒JIT与so加载限制解决方案.md:101` 与 `鸿蒙PC迁移专项_后端部署与网络证书方案.md:388`）。
OpenJDK 在 Linux 上 `os.name` 硬编码为 `Linux`、`os.arch` 为 `aarch64`，而 `Native.java` 只特判 win/mac。
→ **resourceName 应为 `/linux/aarch64/libzstd-jni-1.5.7-23.so`**。
→ 这意味着**可以复用现成的 `linux/aarch64` 资源槽位**：把 OHOS 编译出的 `.so` 覆盖进 jar 的 `linux/aarch64/` 即可自动加载，**无需改 Java 代码**。
⚠️ 但此点**未在真机验证**（本机无鸿蒙设备/无 JDK），属于必须实测的第一项。

---

## 4. 替代编译路径：用 OpenHarmony NDK 直接编译

### 4.1 官方 OHOS CMake 工具链参数【已核实】

来源：OpenHarmony 官方文档
<https://gitee.com/openharmony/docs/raw/master/en/application-dev/napi/build-with-ndk-overview.md>
（中文版 `.../zh-cn/application-dev/napi/build-with-ndk-overview.md`，同内容）

> `ohos.toolchain.cmake` 是 OpenHarmony NDK 提供给 CMake 的 toolchain 脚本……此文件中的常用参数见下表。

| 参数 | 类型 | 说明 |
|---|---|---|
| `OHOS_STL` | `c++_shared` / `c++_static` | libc++ 链接方式，默认 `c++_shared` |
| `OHOS_ARCH` | `armeabi-v7a` / `arm64-v8a` / `x86_64` | 交叉编译目标架构 |
| `OHOS_PLATFORM` | `OHOS` | 目标平台，当前仅支持 OpenHarmony |

文档同时明确最终产生的 clang 参数：

- `--target={arch}-linux-ohos` → 生成对应架构、符合 OpenHarmony ABI 的二进制
- `--sysroot={ndk_root}/sysroot` → 指定系统头文件位置

SDK 内路径（同文档 + Rust 文档）：
- 编译器：`{sdk}/native/llvm/bin/aarch64-linux-ohos-clang`（也存在 `aarch64-unknown-linux-ohos-clang` 命名的包装）
- CMake：`{sdk}/native/build-tools/cmake/bin/cmake`
- sysroot：`{sdk}/native/sysroot`，头文件在 `sysroot/usr/include` 与 `sysroot/usr/include/aarch64-linux-ohos`，库在 `sysroot/usr/lib/aarch64-linux-ohos`

### 4.2 ⚠️ 坑：CMake **不认识** `HarmonyOS` 平台【已核实】

来自 `build_in_harmonyos` 的知识库错误条目 **E092**（`knowledge/doc/E092.md`）：

> **E092: CMake 不识别 HarmonyOS 平台**
> 错误特征：`CMake Error: System is unknown to cmake` / `CMAKE_SYSTEM_NAME = harmonyos`
> 根因：CMake 没有 harmonyos 的 platform module。HarmonyOS 基于 Linux 内核，**CMake 的 Linux 平台模块通常可以直接使用**。
> 影响范围：已知受影响 **blosc、zstd、zopfli、physfs**
> 方案 1（推荐）：设置 `CMAKE_SYSTEM_NAME=Linux`
> ⛔ **禁止**将 `CMAKE_SYSTEM_NAME` 设为 `ohos` 或 `HarmonyOS`，会导致无法加载任何平台模块，构建系统完全失效。

E092 还给出配套 toolchain 文件模板：

```cmake
# toolchain-ohos.cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_C_COMPILER clang)
set(CMAKE_CXX_COMPILER clang++)
```

**次要坑（E092 补充章节）**：即使 `CMAKE_SYSTEM_NAME=Linux` 设对，CMake 的
`check_c_source_compiles()` / `check_function_exists()` / `check_include_files()` 在 HarmonyOS 上仍可能失败，
导致 `config.h` 缺 `HAVE_*` 宏。
→ 对 zstd-jni **影响很小**：其 `CMakeLists.txt` 只用了一次
`CHECK_C_COMPILER_FLAG(-Oz COMPILER_SUPPORTS_OZ)`，失败也只是不优化，不会中断构建。

### 4.3 推荐的实际编译命令

**【已核实部分】** 下面命令中的每一段都有出处（toolchain 变量来自 §4.1，`CMAKE_SYSTEM_NAME` 覆盖来自 §4.2，补丁来自 §2.1）；
**【推测部分】** 整条命令未经端到端实跑，标记为待验证。

```bash
export OHOS_SDK=/path/to/ohos-sdk/linux          # macOS 则为 .../macos
export NDK=$OHOS_SDK/native
export VER=$(cat version)                        # 例如 1.5.7-23

# 1) 取源码
curl -L -o zstd-jni.tar.gz \
  https://github.com/luben/zstd-jni/archive/refs/tags/v${VER}.tar.gz
tar xzf zstd-jni.tar.gz && cd zstd-jni-${VER}

# 2) 应用唯一必需的补丁：把 vendored jni/ 加进 include 路径
sed -i.bak 's#include_directories("src/main/native"#include_directories("jni" "src/main/native"#' CMakeLists.txt

# 3) 配置
$NDK/build-tools/cmake/bin/cmake -B build-ohos \
  -DCMAKE_TOOLCHAIN_FILE=$NDK/build-tools/cmake/ohos.toolchain.cmake \
  -DOHOS_ARCH=arm64-v8a \
  -DOHOS_PLATFORM=OHOS \
  -DCMAKE_SYSTEM_NAME=Linux \
  -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
  -DCMAKE_C_COMPILER=$NDK/llvm/bin/aarch64-linux-ohos-clang \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SHARED_LINKER_FLAGS="-static-libgcc -Wl,-Bsymbolic -Wl,-z,relro,-z,now"

# 4) 编译
$NDK/build-tools/cmake/bin/cmake --build build-ohos -j$(nproc)
# → build-ohos/libzstd-jni-${VER}.so
```

> 说明：
> - 若 `find_package(JNI)` 报 `JNI_FOUND=FALSE` **不算失败** —— vendored `jni/` 已提供头文件（这正是补丁的意义）。
> - 项目是 `C ASM`，**不需要 C++ STL**，`OHOS_STL` 无关紧要。
> - 原 `CMakeLists.txt` 里硬写了 `-fuse-ld=lld`（OHOS NDK 自带 lld，可用），但用上面显式 `CMAKE_SHARED_LINKER_FLAGS` 覆盖掉更稳。
> - 也可以用最裸的方式绕开 CMake（等价于官方 `make_so.sh`），只需把 `-I./jni` 指对：
>   ```bash
>   $NDK/llvm/bin/aarch64-linux-ohos-clang -shared -fPIC -O3 -flto -DZSTD_MULTITHREAD=1 \
>     -static-libgcc -Wl,--version-script=./libzstd-jni.so.map -Wl,-Bsymbolic -Wl,-z,relro,-z,now \
>     -I./jni -I./src/main/native -I./src/main/native/common -std=c99 \
>     -o libzstd-jni-${VER}.so \
>     src/main/native/*.c src/main/native/common/*.c src/main/native/compress/*.c \
>     src/main/native/decompress/*.c src/main/native/decompress/*.S \
>     src/main/native/dictBuilder/*.c
>   ```

### 4.4 现成的 OHOS toolchain 参考文件

| 来源 | 内容 |
|---|---|
| `$NDK/build-tools/cmake/ohos.toolchain.cmake` | **官方随 SDK 分发**，文档见 §4.1 |
| `build_in_harmonyos` / `knowledge/doc/E092.md` | 手写 `toolchain-ohos.cmake` 模板（§4.2） |
| OpenHarmony `lycium` 框架 | `tpc_c_cplusplus` 仓库的 HPKBUILD / envset.sh，用 `$OHOS_SDK/native/llvm/bin/{aarch64-linux-ohos-clang,...}`，参考 <https://shiply.tds.qq.com/document/en-US/blog/2025/08/12/OpenHarmony-Third-Party-Libraries-Cross-Compilation-Guide/> |
| Rust 官方 OHOS target 文档 | clang wrapper 写法（§2.3c），含 `-D__MUSL__` |

> **未找到**：`ohos.toolchain.cmake` 的逐行完整原文。`developer.huawei.com` 为 JS 渲染页抓不到正文；
> `raw.githubusercontent.com`、`grep.app`、`xrefandroid.com` 在本环境被网络/Cloudflare 拦截；
> 本机也未安装 DevEco Studio / OHOS SDK（已确认 `/Applications/DevEco-Studio.app` 不存在，`$OHOS_SDK` 为空）。
> 上文 §4.1 的变量表来自 OpenHarmony 官方文档，足以使用。

---

## 5. Maven 中央仓 zstd-jni 各 classifier —— 确认**没有** ohos

**【已核实】** 最新版 `1.5.7-23`（`maven-metadata.xml` `lastUpdated=20261010231247`）
逐文件列举 <https://repo1.maven.org/maven2/com/github/luben/zstd-jni/1.5.7-23/>：

| classifier | 说明 |
|---|---|
| *(无 classifier)* `zstd-jni-1.5.7-23.jar` | **主 jar，内置全部 18 个平台的 .so/.dylib/.dll** |
| `linux_amd64` | Linux x86-64 |
| `linux_aarch64` | Linux ARM64 |
| `linux_arm` | Linux ARM32 |
| `linux_i386` | Linux x86 |
| `linux_ppc64` | Linux POWER64 大端 |
| `linux_ppc64le` | Linux POWER64 小端 |
| `linux_mips64` | Linux MIPS64 |
| `linux_riscv64` | Linux RISC-V 64 |
| `linux_s390x` | Linux s390x |
| `linux_loongarch64` | Linux LoongArch64 |
| `darwin_x86_64` | macOS Intel |
| `darwin_aarch64` | macOS Apple Silicon |
| `win_x86` / `win_amd64` / `win_aarch64` | Windows 32/64/ARM64 |
| `freebsd_amd64` / `freebsd_i386` | FreeBSD |
| `aix_ppc64` | AIX |
| `cloud` | Spring Cloud 用的「无 native」变体 |
| `sources` / `javadoc` | 源码/文档 |
| `zstd-jni-1.5.7-23.aar` | Android AAR |

### 主 jar 内实际打包的资源（`unzip -l` 结果）【已核实】

```
aix/ppc64/libzstd-jni-1.5.7-23.so           1517380
darwin/aarch64/libzstd-jni-1.5.7-23.dylib    601336
darwin/x86_64/libzstd-jni-1.5.7-23.dylib     712672
freebsd/amd64/libzstd-jni-1.5.7-23.so        901432
freebsd/i386/libzstd-jni-1.5.7-23.so         784152
linux/aarch64/libzstd-jni-1.5.7-23.so        701896   ← 鸿蒙要替换的就是这个槽位
linux/amd64/libzstd-jni-1.5.7-23.so          900661
linux/arm/libzstd-jni-1.5.7-23.so            736260
linux/i386/libzstd-jni-1.5.7-23.so           888604
linux/loongarch64/libzstd-jni-1.5.7-23.so    895376
linux/mips64/libzstd-jni-1.5.7-23.so         814468
linux/ppc64/libzstd-jni-1.5.7-23.so         1027552
linux/ppc64le/libzstd-jni-1.5.7-23.so        833024
linux/riscv64/libzstd-jni-1.5.7-23.so        884088
linux/s390x/libzstd-jni-1.5.7-23.so          826464
win/aarch64/libzstd-jni-1.5.7-23.dll         656896
win/amd64/libzstd-jni-1.5.7-23.dll          1051617
win/x86/libzstd-jni-1.5.7-23.dll            1051927
```

分类器 jar 是主 jar 的单平台子集，例如 `zstd-jni-1.5.7-23-linux_aarch64.jar` 内**只有**
`linux/aarch64/libzstd-jni-1.5.7-23.so`（701896 字节）。

✅ **结论：全部 20 个 classifier + 主 jar + aar 中，没有 `ohos` / `harmony` / `linux_ohos` 任何形式的存在。**
（`build.sbt` 中 `addArtifact(...)` 的枚举也印证：只有 `Linux_amd64/i386/aarch64/arm/ppc64le/ppc64/mips64/loongarch64/s390x/riscv64`、`Aix_ppc64`、`Darwin_x86_64/aarch64`、`FreeBSD_amd64/i386`、`Win_x86/...`。）

---

## 6. 可行性判断

### 6.1 工作量估计：**小（编译本身）**，关键成本在运行时装库

| 阶段 | 工作量 | 风险 | 说明 |
|---|---|---|---|
| 编译出 OHOS 版 `.so` | **0.5~1 人日** | 🟢 低 | 唯一必需改动是 1 行 CMake include 补丁；无 C 代码改动；无外部依赖；无 glibc 专属函数；`.S` 对 aarch64 为空 |
| 集成进鸿蒙 Java 后端 | **0.5~1 人日** | 🟡 中 | 见 6.2 的四个方案 |
| 真机验证 + 回填 | **0.5 人日** | 🟡 中 | 必须实测 `os.name`/`os.arch` 与加载路径 |

**总计约 1.5~2.5 人日**，且已有 published 先例背书，不是"从零探索"。

### 6.2 主要风险点（按严重度排序）

**R1 🟡 最大风险：`.so` 放在哪 —— 沙盒 / XPM 签名管控（不是编译问题）**

工作区既有结论（`鸿蒙PC沙盒JIT与so加载限制解决方案.md:14,131-152`）指出：
> 沙箱管控：**非应用市场来源的 so/二进制需要二进制签名**；随 HAP 打包的 so（应用签名内）不受额外限制。
> Java `System.loadLibrary` 加载的 so 属于"进程内加载"——其 so 文件若在应用签名目录内应可行；在外部目录则受管控。

这直接冲击 `Native.java` 的**默认加载路径**：L130 会把 `.so` 解压到 `java.io.tmpdir` 再 `System.load()`。
**tmpdir 不在应用签名目录内** → 大概率被拦。

→ 应对（按推荐度）：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | 用 `-DZstdNativePath=/data/storage/el2/base/files/.../libzstd-jni-1.5.7-23.so` 指向**应用签名目录内**的 so。L105-111 保证走这条就不再回退 | 零改代码；配合"形态 A 终端 `java -jar`"最自然 |
| **B** | `System.load(绝对路径)` 后调 `Native.assumeLoaded()`（L64-66 逃生口） | 零改代码，控制权最大 |
| **C** | 随 HAP 打包进 `libs/arm64-v8a/`，走 `System.loadLibrary("zstd-jni-1.5.7-23")` | 与既有 sqlite 方案同机制；但需确认 `java.library.path` 覆盖到 HAP libs 目录 |
| **D** | 替换主 jar 内 `linux/aarch64/libzstd-jni-1.5.7-23.so`（§5 槽位），依赖自动解压 | ❌ **不推荐**，会踩 R1 的 tmpdir 问题 |

**R2 🟡 鸿蒙 JVM 的 `os.name` / `os.arch` 实际取值未实测**

若 BiShengJDK17-OH 把 `os.name` 报成别的东西（如 `HarmonyOS`/`OHOS`），`resourceName()` 会变成 `/<那个值>/aarch64/...`。
→ 方案 A/B 用 `ZstdNativePath` 绝对路径可**完全绕开**这个不确定性（这也是它们被列为推荐的原因）。
→ 一条命令即可验证：
```bash
java -XshowSettings:properties -version 2>&1 | grep -E "os.name|os.arch"
```

**R3 🟢 编译期：CMake 平台识别（已有确定解法）**

必须设 `CMAKE_SYSTEM_NAME=Linux`（E092 明确禁止设为 `ohos`/`HarmonyOS`）。不设会直接 configure 失败。

**R4 🟢 已消解：musl / libgcc**

`-static-libgcc` 是官方脚本既有做法，Maven 产物实测 NEEDED 里已无 `libgcc_s.so.1`。自己编时务必保留该参数。

**R5 🟢 已消解：libzstd 依赖**

zstd 静态内置，实测无 `libzstd.so` 依赖。

**R6 🟢 低：`ZSTD_MULTITHREAD=1` 需要 pthread**

OHOS musl 把 pthread 合在 `libc.so` 内（实测 OHOS 二进制 NEEDED 只有 `libc.so`），无独立 `libpthread` 需链接；CMake 下不需要额外 `-lpthread`。

### 6.3 一句话结论

> **zstd-jni 为 OHOS 交叉编译是可行的，且难度很低**——唯一必要的源码改动是 1 行 CMake `include_directories("jni" ...)` 补丁，其余全是标准 OHOS NDK 交叉编译操作，并已有 `build_in_harmonyos` 框架把 1.5.6-5 标记为 `published` 的成功先例。
> **真正的风险不在编译，而在运行时**：Maven 上的 `linux_aarch64` 产物（NEEDED `libc.so.6` + `libpthread.so.0`）在 OHOS musl 上**必然加载失败**，必须用自编译版本，并通过 `ZstdNativePath` / `assumeLoaded()` 把加载位置控制在应用签名目录内，以规避鸿蒙沙盒对非签名目录 so 的管控。

---

## 附录：证据索引

| 结论 | 出处 |
|---|---|
| CMake 构建入口 / 版本号来源 | 仓库内 `CMakeLists.txt` |
| 官方发布编译命令、`-static-libgcc` | 仓库内 `make_so.sh`、`make_so_cross.sh` |
| vendored jni.h | 仓库内 `jni/jni.h`、`jni/jni_md.h` |
| zstd 1.5.7 完整内置、39 个 .c + 1 个 .S | 仓库内 `src/main/native/**`、`zstd.h` |
| 加载逻辑 / assumeLoaded / ZstdNativePath | 仓库内 `src/main/java/com/github/luben/zstd/util/Native.java` |
| 符号可见性 | 仓库内 `libzstd-jni.so.map` |
| OHOS 移植先例（manifest / patch / notes） | <https://gitcode.com/asp1r1n1/build_in_harmonyos/tree/feat%2Fqjackctl-1.0.4-asp1/archives/z/zstd-jni> |
| OHOS 本机构建 profile（hnp clang） | 该仓库 `ci/conan/profiles/ohos-aarch64` |
| CMake 不识别 HarmonyOS（E092） | 该仓库 `knowledge/doc/E092.md` |
| musl 历史问题与修复 | <https://github.com/luben/zstd-jni/issues/157>、<https://github.com/luben/zstd-jni/issues/43>、<https://github.com/luben/zstd-jni/issues/38> |
| 官方 issue 无 ohos 讨论（7 条检索结果） | GitHub Search API `repo:luben/zstd-jni ohos OR harmony OR musl OR alpine` |
| OHOS 目标三元组 + `-D__MUSL__` + sysroot 布局 | <https://github.com/rust-lang/rust/blob/master/src/doc/rustc/src/platform-support/openharmony.md> |
| `ohos.toolchain.cmake` 参数表 | <https://gitee.com/openharmony/docs/raw/master/en/application-dev/napi/build-with-ndk-overview.md> |
| OHOS SDK 目录 / cmake 路径 | <https://gitee.com/openharmony/docs/raw/master/en/application-dev/napi/build-with-ndk-cmake.md> |
| lycium 交叉编译框架实践 | <https://shiply.tds.qq.com/document/en-US/blog/2025/08/12/OpenHarmony-Third-Party-Libraries-Cross-Compilation-Guide/> |
| Maven classifier 全量 | <https://repo1.maven.org/maven2/com/github/luben/zstd-jni/1.5.7-23/>、`maven-metadata.xml` |
| ELF NEEDED 实测（zstd-jni vs OHOS） | 本地解析 `zstd-jni-1.5.7-23-linux_aarch64.jar` 与 `project-template/electron/libs/arm64-v8a/*.so` |
| 鸿蒙沙盒 so 加载管控 | 工作区 `鸿蒙PC沙盒JIT与so加载限制解决方案.md` |
| 鸿蒙侧 JDK 为 BiShengJDK17-OH（musl） | 工作区 `鸿蒙PC迁移专项_后端部署与网络证书方案.md`、`鸿蒙PC迁移专项_SSH_SQLite_线程方案.md` |
