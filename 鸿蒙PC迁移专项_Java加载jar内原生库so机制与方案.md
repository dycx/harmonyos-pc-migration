# 鸿蒙 PC 专项：Java 后端加载 jar 内自包含 so 的机制与解决方案（以 zstd-jni 为例）

> **触发问题**：迁移后的 Electron 应用在鸿蒙 PC 上运行时，Java 后端加载 zstd 时提示 `libzstd-jni` 的 so 无法正常加载，zstd 压缩/解压全部失败。
> **本文回答两件事**：① jar 内自包含 so 的**加载机制**到底是什么；② 鸿蒙上**目前通用的做法**是什么。
> **证据等级**：✅ 实测/源码核实（本机可直接复现）｜✅ 官方/权威原文｜🟡 推断（置信高，附推理链）｜⚠️ 需真机实测
> **版本**：v1.0

---

## 0. 结论速览

### 0.1 根因（一句话）

**zstd-jni 随包分发的 `.so` 是 glibc 编译的，而鸿蒙（OpenHarmony）用的是 musl libc。两者 ABI 不兼容，`dlopen` 必然失败——这与签名/XPM 管控无关，是更底层的硬冲突。**

这一条**在本机就能证实、不需要真机**：

| 检查项 | zstd-jni 的 .so | 鸿蒙实际环境 | 结果 |
|---|---|---|---|
| 版本化符号 | `GLIBC_2.17` | musl 无 GLIBC_ 版本标签 | ❌ 不兼容 |
| `DT_NEEDED` | `libc.so.6`、`libpthread.so.0` | `libc.so`、`ld-musl-aarch64.so.1`（pthread 已并入 libc） | ❌ 名字对不上 |
| jar 内平台目录 | 只有 `linux/aarch64/`，**无 ohos/musl** | macOS/Windows/Linux 各架构 | ❌ 无可用分支 |

### 0.2 ★ 第二层问题（已由内核源码证实，不是猜测）

即使解决了 libc 问题，**"运行期从 jar 解压 so 到临时目录再加载"这个模式本身在鸿蒙上必然被拦**：

> **XPM 内核管控 hook 的是 `mmap_region` + `file_mprotect`，判定只看"file-backed + `PROT_EXEC`"，与 ELF 的 `e_type` 无关。**
> 也就是说 —— **`dlopen` 一个 .so 和 `exec` 一个可执行文件，走的是同一套校验**。
> 而 zstd-jni 默认就是把 so 解压到 `java.io.tmpdir` 再 `System.load()` —— **tmpdir 不在签名目录内，对应用类进程直接被拦**。

**结论：只有 `libs/` 前缀下的原生文件才会被 HAP 签名自动做代码签名（fs-verity），从而通过 XPM。**
放在 `resources/resfile/`、沙箱 filesDir、`/data/local/tmp` 的 ELF/.so，对"普通应用类"进程**一律默认被拦**。（官方 HNP 文档里那个被拦的例子，正是 `resources/resfile/` 下的 ELF。）

**但有个关键转机**：XPM 按**进程类别**分级 —— **调测类/沙箱类进程不校验签名**。而**终端启动的 `java`** 大概率属于这两类（与"终端进程才有 JIT"的实测结论同源）。
→ **形态 A（终端启动）几乎不受 XPM 约束；形态 B（应用内拉起）才是硬约束。**（详见 §4.2）

### 0.3 解法优先级

| 优先级 | 方案 | 一句话 |
|---|---|---|
| **① 首选** | **交叉编译 zstd-jni 的 .so → `-DZstdNativePath` 指过去** | Java 零改动；已有公开先例；**只需 1 行 CMake 补丁**（§5） |
| ② 备选 | 换**纯 Java** 的 `aircompressor`（压缩+解压都支持） | 彻底无 JNI；但慢 2.4×/3.4×、**不支持字典**、硬依赖 `sun.misc.Unsafe`（§6） |
| ③ 兜底 | 干掉 zstd（若是传递依赖）/ 换 gzip | Kafka 场景**源码级强耦合**，只能"不用 zstd"，不能简单换实现（§6.1） |
| ④ 形态 B 必需 | so **必须随 HAP 放 `libs/{abi}/`** | 沙箱内 JVM 走不了"任意路径"（§4.3/§4.4） |
| ⑤ 绕开 | 后端跑在 openEuler Linux 子系统 | glibc 环境，官方 .so 直接可用 |

> **决策分水岭**：**你的后端是形态 A（终端 `java -jar`）还是形态 B（应用内 HNP 拉起）？**
> - 形态 A → 方案① 基本零阻力（编出 musl .so，放任意可读路径）
> - 形态 B → 方案① 仍可用，但 .so **必须随 HAP 放 `libs/{abi}/`**

---

## 1. 机制：JVM 到底怎么加载 jar 里的 so

### 1.1 通用机制：两条路 + 一个关键事实

Java 加载原生库只有两个 API：

| API | 行为 | 在鸿蒙上意味着什么 |
|---|---|---|
| `System.loadLibrary("foo")` | 由 JVM 在 `java.library.path`、`LD_LIBRARY_PATH` 等搜索路径里找 `libfoo.so` | 需要 so **已经在某个系统搜索路径下**——jar 里的东西不满足这个前提 |
| `System.load("/abs/path/libfoo.so")` | 用**绝对路径**直接 `dlopen` | 只要能读到该文件就能加载，**不受搜索路径限制** |

**关键事实**：jar 里的 `.so` **不是**文件系统上的文件，JVM 无法直接 `dlopen` 一个 jar 条目。所以"jar 自包含 so"的库（zstd-jni、sqlite-jdbc、JNA 的部分用法、netty-tcnative 等）都必须自己实现一套 **"把 so 从 jar 解压到磁盘 → 再 `System.load()`"** 的逻辑。

**这一步就是全部问题的来源。**

### 1.2 标本：zstd-jni 的三级加载（✅ 源码核实）

源码：`com/github/luben/zstd/util/Native.java`（本机已下载 jar 并核对；亦可从 GitHub/源码包复现）。

```java
public static synchronized void load(final @Nullable File tempFolder) {
    if (loaded.get()) return;
    String resourceName = resourceName();          // 形如 /linux/aarch64/libzstd-jni-1.5.6-4.so

    // ── 第 1 级：显式路径覆盖（最高优先级，且不再回退）
    String overridePath = System.getProperty("ZstdNativePath");
    if (overridePath != null) {
        loadLibraryFile(overridePath);             // System.load(绝对路径)
        loaded.set(true);
        return;                                    // ★ 直接返回，不做任何 fallback
    }

    // ── 第 2 级：交给 JVM 按名字找（java.library.path / 系统库目录）
    try {
        loadLibrary(libnameShort);                 // System.loadLibrary("zstd-jni-<ver>")
        loaded.set(true);
        return;
    } catch (Throwable e) { /* 忽略，继续下一级 */ }

    // ── 第 3 级：从 jar 解压到临时文件，再 System.load()
    InputStream is = Native.class.getResourceAsStream(resourceName);
    if (is == null) {
        throw new UnsatisfiedLinkError("Failed to open resource " + resourceName + " as stream:\n" + errorMsg);
    }
    File tempLib = File.createTempFile(libname, "." + libExtension(), tempFolder);
    tempLib.deleteOnExit();
    // ...把 is 拷进 tempLib...
    loadLibraryFile(tempLib.getAbsolutePath());    // ★ 在这一步 dlopen 失败
    // finally 里：tempLib.delete()  ← 注意：加载后立即删除
}
```

**资源路径的选择规则**（决定它去 jar 里翻哪个目录）：

```java
resourceName() = "/" + os + "/" + arch + "/" + "libzstd-jni-" + VERSION + "." + ext
    os   = System.getProperty("os.name").toLowerCase().replace(' ', '_')   // "Linux" → "linux"
    arch = System.getProperty("os.arch")                                   // "aarch64"
```

→ 在鸿蒙上（Linux 内核 + aarch64）它会去找 **`/linux/aarch64/libzstd-jni-<ver>.so`**。

### 1.3 三个"逃生口"（关键：方案就建立在这上面）

| 机制 | 用法 | 作用 |
|---|---|---|
| **`-DZstdNativePath=/abs/path/libzstd-jni-<ver>.so`** | 启动参数 | **跳过全部自动逻辑，直接 `System.load` 指定文件**，不做回退。★ 这是**首选方案的核心** |
| `-DZstdTempFolder=/some/dir` | 启动参数 | 指定解压目录（应对临时目录不可写） |
| `Native.assumeLoaded()` | 代码调用 | 官方逃生口：你自己加载好 so 后告诉它"别再加载了" |

> 源码注释原文（`assumeLoaded`）：*"Tell the library to assume the native library is already loaded. This is escape hatch for environments that have special requirements for how the native part is loaded."* —— 说明**上游已经预期到"有些平台需要自己管加载"**。

---

## 2. 实测证据：为什么在鸿蒙上必然失败

以下四条**全部在本机复现**，不需要真机。

### 2.1 jar 内根本没有鸿蒙分支

下载 `zstd-jni-1.5.6-4.jar`（6.4MB）后列出原生库资源：

```
aix/ppc64/…        darwin/aarch64/…   darwin/x86_64/…    freebsd/amd64/…
linux/aarch64/libzstd-jni-1.5.6-4.so   ← 鸿蒙会命中这一个
linux/amd64/…  linux/arm/…  linux/i386/…  linux/loongarch64/…  linux/mips64/…
linux/ppc64/…  linux/ppc64le/…  linux/riscv64/…  linux/s390x/…
win/aarch64/…  win/amd64/…  win/x86/…
```

**没有 `ohos/`、没有 musl 变体。** 而且**最新版 1.5.7-23 依然如此**（已核对 Maven Central 元数据与最新 jar），说明**上游不会为鸿蒙提供支持**。

### 2.2 命中那个 .so 的 ABI 是 glibc

```
$ file linux/aarch64/libzstd-jni-1.5.6-4.so
ELF 64-bit LSB shared object, ARM aarch64, dynamically linked, not stripped

$ strings … | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -u
GLIBC_2.17                       ← ★ glibc 版本化符号，musl 编译的库不会有

$ 解析动态段（DT_NEEDED）
DT_NEEDED → libpthread.so.0
DT_NEEDED → libc.so.6            ← ★ 纯 glibc 的 soname
```

### 2.3 对照：鸿蒙工具链产出的 .so 长什么样

同仓库里由 OHOS 工具链编译的 `libadapter.so`（Electron 壳运行时）：

```
$ strings libadapter.so | grep -oE 'GLIBC_[0-9]+\.[0-9]+'
（无输出）                        ← ★ musl 编译：没有 GLIBC_ 版本标签
```

**两边一个带 `GLIBC_2.17`、一个完全不带** —— 这就是 ABI 不同源的直接证据。

### 2.4 结论

鸿蒙的动态链接器在处理 `DT_NEEDED = libc.so.6` 时，**在 musl 环境里找不到这个 soname**（musl 提供的是 `libc.so` / `ld-musl-aarch64.so.1`，且 pthread 功能已并入 libc，没有 `libpthread.so.0`）。

🟡 **预期报错形态（置信高，待你的真机日志确认）**：

```
java.lang.UnsatisfiedLinkError: /tmp/libzstd-jni-1.5.6-4xxxx.so:
  Error loading shared library libc.so.6: No such file or directory
  (needed by /tmp/libzstd-jni-1.5.6-4xxxx.so)
```

（`Error loading shared library <name>: No such file or directory (needed by <requester>)` 是 musl 动态链接器的标准报错格式。）

**⚠️ 请对照 §3 的判读表确认你实际看到的是哪一种** —— 不同报错对应完全不同的根因和解法。

### 2.5 一个好消息：只需要换一个文件

那个 .so **把 zstd 静态内置了**：

```
$ strings … | grep -c '^ZSTD_'                    → 240 个 zstd C API 符号
$ strings … | grep -c 'Java_com_github_luben_zstd' → 288 个 JNI 导出
$ 是否依赖外部 libzstd？                            → 否（DT_NEEDED 里没有 libzstd.so）
```

→ **不存在"还要额外带一个 libzstd.so"的问题**，交叉编译产出**单个 .so** 替换即可。
→ 但 288 个 JNI 导出意味着**必须用与 Java 侧完全相同的 zstd-jni 版本源码**编译，否则方法签名对不上。

---

## 3. ★ 报错信息判读表（最实用的诊断工具）

zstd-jni 的四种失败路径各有**特征性文案**，直接对照即可定位根因：

| 你看到的报错特征 | 对应失败点 | 根因 | 解法 |
|---|---|---|---|
| 提到 **`libc.so.6`** / `libpthread.so.0` / `GLIBC_2.` 或 `cannot open shared object file` | 第 3 级 `System.load(临时文件)` 的 dlopen 阶段 | **★ libc 不匹配（本文诊断）** | §6 方案① 交叉编译 |
| **`Unsupported OS/arch, cannot find /<os>/<arch>/…`** / `Failed to open resource … as stream` | 第 3 级，**资源查找阶段**（还没到 dlopen） | jar 里没有匹配 `os.name`/`os.arch` 的目录 → 说明鸿蒙 JDK 报告的 `os.name`/`os.arch` 与 `linux`/`aarch64` 不同 | 先查清 JDK 报告的 os/arch；再用 `ZstdNativePath` 绕过 |
| **`Cannot unpack libzstd-jni-…`** | 第 3 级，**写临时文件阶段** | 临时目录不可写（沙箱限制） | `-DZstdTempFolder=<可写目录>`；或用 `ZstdNativePath` 彻底不解压 |
| **`get signature info failed`** / `code_type: ELF`（内核日志，非 Java 异常） | **XPM 内核拦截** | 未签名的二进制/库被内核拒绝 | §5：随包签名 / HNP / 二进制签名证书 |
| 报错里含 `… : cannot locate symbol "xxx"` | dlopen 阶段，符号解析失败 | 误用了宿主架构或错误配置的库 | 用 `llvm-readelf` 核对 `Machine`/`Class` 与 `NEEDED` |

---

## 4. 鸿蒙侧的第二层约束（XPM / 签名 / 沙箱）★ 已由内核源码证实

> 这一层**独立于 libc 问题**。即使交叉编译出正确的 musl .so，**放在哪里**仍直接决定能否加载。
> 本节结论来自官方内核源码与签名部件源码 —— 完整报告见仓库根 **《动态库so加载规则与限制调研.md》**（397 行，含 20 份官方源码证据的引用与索引）。

### 4.1 ★ 结论先行：`dlopen` 一个 .so **同样受 XPM 管控**（此前"未知"，现已证实）

**内核级证据**（`kernel_linux_common_modules/xpm`，OpenHarmony master）：

```c
// xpm/core/xpm_security_hooks.c:378-381  —— 挂的是 LSM 钩子
static struct security_hook_list xpm_hooks[] __ro_after_init = {
    LSM_HOOK_INIT(mmap_region,   xpm_mmap_check),      // ★ 内存映射
    LSM_HOOK_INIT(file_mprotect, xpm_mprotect_check),  // ★ mprotect(PROT_EXEC)
};
```
```c
// 同文件 :259-261  —— 判定维度：只看这次映射是不是"文件映射 + 可执行"
is_exec = !xpm_is_anonymous_vma(vma) && (prot & PROT_EXEC);
if (!((vma->vm_flags & VM_XPM) || is_exec))  return 0;   // 非 exec 映射直接放行
```

**关键推论**：
- 判定维度是"**file-backed 且带 `PROT_EXEC`**"，**与 ELF 的 `e_type` 无关**。
- `dlopen` 一个 .so 时，ld.so 必然用 `mmap(PROT_READ|PROT_EXEC)` 映射其代码段 → `is_exec = true` → **走完全相同的校验路径**。
- 所以**"XPM 只管可执行文件、不管 .so"是错的**。

**几个易误读的字段（澄清）**：

| 字段 | 真实含义 |
|---|---|
| `code_type: "ELF"` | **不是"文件类型是 ELF"**，而是"本次映射是**文件代码段映射**（file-backed + PROT_EXEC）"；非 exec 映射记为 `ABC` |
| `vm_prot: 5` | `PROT_READ \| PROT_EXEC` |
| `get signature info failed` | `GET_SIGN_FAIL`：既非 dm-verity、又非 fs-verity、也没有可用的 `.codesign` 块 → `mmap` 返回 `-EPERM` → **dlopen 失败** |
| `echo 0 > .../xpm_mode` | 把所有校验失败**清零**（`xpm_ret()`），因此 **exec 与 dlopen 一起放开**；仅调试、重启失效。⚠️ 路径有版本差异：userspace 常量写 `/proc/sys/kernel/xpm/xpm_mode`，而 master 内核是 debugfs `/sys/kernel/debug/xpm/xpm_mode` —— 以真机为准 |

### 4.2 ★ 但"进程类别"决定 XPM 是否真的拦你（这条最实用）

XPM 官方 README 把进程分成 4 类，**校验强度完全不同**：

| 进程类别 | 是否校验签名 | 允许 JIT |
|---|---|---|
| **普通应用类** | ✅ **强制校验** | ❌ 限制匿名可执行内存 |
| webview 类 | ✅ 强制校验 | ✅ 允许 |
| **调测类** | ❌ **不校验签名** | ✅ 允许 |
| **沙箱类** | ❌ **不校验签名** | ✅ 允许 |

**与你项目的对应关系**（🟡 置信高，需真机确认）：

| 后端形态 | 进程类别 | XPM 是否校验 .so | 含义 |
|---|---|---|---|
| **形态 A：终端 `java -jar`** | 调测类/沙箱类 | **大概率不校验** | ★ 交叉编译好的 .so **放任意可读路径**（含 `/data/local/tmp`）即可加载 |
| **形态 B：应用内 HNP 拉起 JVM** | 普通应用类 | **强制校验** | ★ .so **必须走 `libs/{abi}/` 随 HAP 签名**，否则被拦 |

> 这与《鸿蒙PC沙盒JIT与so加载限制解决方案.md》里"**只有命令执行器直接启动的那一个进程有 JIT 权限**"的实测结论**完全吻合**——同一个"进程类别"划分同时解释了 JIT 与 XPM 校验两件事。

### 4.3 随包 .so 的真实机制（不是"免疫"，是"被正确签成了合法代码"）

| 阶段 | 发生了什么 | 证据 |
|---|---|---|
| **HAP 签名时** | hapsigner 的 `CodeSigning.isNativeFile()` 命中**所有以 `libs/` 开头的条目**（以及 `*.an`）→ 为每个条目生成 `SoInfoSegment`（fs-verity 描述符 + PKCS7 + merkle tree） | `hapsigner/.../codesigning/sign/CodeSigning.java:209-212,260-270,378-408`；常量 `LIBS_PATH_PREFIX="libs/"` 见 `FileUtils.java:78,88` |
| **安装时** | `code_signature` 部件的 `EnforceCodeSignForApp(entryPath, sigFile)` 取 `<entry>.fsv-sig`，逐文件 `EnableCodeSignForFile()` → `ioctl(FS_IOC_ENABLE_CODE_SIGN)`。生效根 `/data/app/el1/bundle` | `security_code_signature/.../code_sign_utils.cpp:62-113,135-174`；`constants.h:25-29` |
| **运行时** | XPM ownerid 策略 `[APP 进程][APP 文件] = CHECK(须同 ownerid)` → 一致即放行 | `xpm_security_hooks.c:30-48` |

**反证（官方文档里的真实拦截案例）**：HNP 指南里被拦的文件是
`/data/storage/el1/bundle/entry/resources/resfile/electron` —— 放在 **`resources/resfile/`** 下，
**不以 `libs/` 开头 → 不进 fsv-sig 链路 → 直接被拦**。

> 🔑 **一句话规则**：**只有 `libs/` 前缀下的原生文件才会被自动做代码签名。**
> 放在 `resources/resfile/`、沙箱 filesDir、`/data/local/tmp` 的 ELF/.so —— **对"普通应用类"进程一律默认被拦**。

### 4.4 合规路径对照表（★ 决定 so 该放哪）

| 位置 | 能否被加载 | 前提 |
|---|---|---|
| HAP `libs/{abi}/*.so` | ✅ **推荐** | HAP 签名自动进 `SoInfoSegment` + 安装期 fs-verity 使能 |
| HAP `libs/{abi}/*.bin`（可执行） | ✅ | `module.json5.executableBinaryPaths`（**API 24+**，PC/2in1）+ 解压模式 |
| HNP 包（`hnp/{abi}/*.hnp`） | ✅ | `hnpPackages` + `--hnp-path`；public/private；`independentSign`(API23+) |
| 沙箱内运行期写入的 .so | ❌ 默认被拦 | 需**二进制证书签名** + 受限权限 `ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY` |
| **HAP `resources/resfile/` 内的 ELF/.so** | ❌ | 不在 `libs/` 前缀，不进 fsv-sig 链路（官方 HNP 文档的拦截案例即此路径） |
| `/system/lib64/*.so` | ❌ | **命名空间隔离**：应用 app ns 只能访问 `/system/lib64/ndk`，不能访问 default ns（含 `/system/lib{,64}`、`/vendor/lib*`） |
| `/data/local/tmp/` | ❌（对应用类进程） | 社区在 API26/2in1 实测 `Permission denied`（SELinux label）；**但终端启动的调测类进程不受此限**（§4.2） |
| 关闭 XPM 后 | ⚠️ 仅调试 | `echo 0 > .../xpm_mode`，重启失效 |

**路径映射（开发态 → 设备态）**：工程 `entry/libs/arm64-v8a/*.so` → HAP 内 `libs/arm64-v8a/*.so` → 沙箱 **`/data/storage/el1/bundle/libs/arm64/`**（注意 ABI 目录名变成 `arm64`）→ 物理 `/data/app/el1/bundle/public/<pkg>/libs/arm64/`。
（`libIsolation=true` 时会多一层 `libs/<ModuleName>/`。）

### 4.5 另外两条硬约束

1. **`binary-sign-tool` 可以签 .so**：对 `ET_DYN` 且 `entry==0` 的普通 .so 也会写入 `.codesign` 段并生成代码签名，但**跳过 profile/permission 段**（对应社区说的"共享库不支持声明权限"）。要跨应用/跨分发加载"二进制证书签名的共享库"，需要受限权限 **`ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY`**（system_basic / system_grant / PC/2in1 / API 20+，**API 22 起普通应用可申请**）。
2. **系统里没有 zstd，而且有也用不了**：OpenHarmony 官方 manifest（496 个 project、180 个 third_party）里 **zstd 零命中**，压缩类只有 `brotli/bzip2/lz4/zlib`；即使存在 `/system/lib64/libzstd.so`，应用的命名空间也 **dlopen 不到**（§4.4）。

> 📌 **顺带勘误**：本地 `_research/repo/docs/hnp-packaging-guide/README.md:29-31` 把 `HNP_PRIVATE_HOME` / `HNP_PUBLIC_HOME` **两个环境变量名写反了**，公有/私有路径描述也与官方 appspawn README 不一致——以官方 `startup_appspawn` 仓的 README 为准。

---

## 5. 解决方案（按推荐度）

### 方案①（首选）：交叉编译 zstd-jni 的 .so + `-DZstdNativePath`

**思路**：绕开"jar 解压 + 自动查找"整条链，直接告诉 zstd-jni "so 在这里"。
**可行性**：✅ 已有公开成功先例 + 完整编译参数（见下）。

#### ✅ 先例：已有人为 OHOS 编译成功

| 项 | 内容 |
|---|---|
| 框架 | `build_in_harmonyos` |
| 状态 | **zstd-jni 1.5.6-5 标记为 `published`**（build_date 2026-04-24），产物 `zstd-jni-1.5.6-5-ohos-aarch64.tar.gz` |
| 地址 | `https://gitcode.com/asp1r1n1/build_in_harmonyos/tree/feat%2Fqjackctl-1.0.4-asp1/archives/z/zstd-jni` |
| **只需 1 行 CMake 补丁** | `include_directories("jni" "src/main/native" ...)` —— 用仓库**自带的 vendored `jni/jni.h`** 进 include 路径，就不再依赖构建机的 JDK（仓库内 `jni/jni.h` + `jni/jni_md.h` 确实存在） |
| ⚠️ 注意 | 该框架的 OHOS profile 指向 `/data/service/hnp/bin/clang`，即**在鸿蒙 PC 本机"本机编译"**，不是从 macOS/Linux 交叉编译。它证明"OHOS/musl 上能编能跑"，**不等于"外部主机交叉编译已验证"**（后者未找到公开先例） |

> 📄 **完整可行性调研见仓库根《zstd-jni-ohos-可行性调研.md》**（590 行）：含 Maven classifier 全量清单（20 个，**无 ohos/harmony**）、官方 issue tracker 检索结果（`ohos`/`harmony` **命中 0**）、musl 相关历史坑（Issue #157 实为缺 `libgcc_s.so.1`，v1.4.8-2 用 `-static-libgcc` 修复）、以及 §4.3 可直接抄的 CMake / 裸 clang 两版命令。

#### ✅ 好消息：这个库"很好编"（已核实）

| 事实 | 说明 |
|---|---|
| **zstd 已 vendored** | `src/main/native/` 内含完整 zstd 源码（**39 个 .c + 1 个 .S**）→ 产出**单个自包含** `libzstd-jni-<ver>.so`（约 690 KB），**无需额外带 libzstd.so** |
| **无 glibc 专属依赖** | `src/main/native/` 全量 grep `musl\|__GLIBC__\|backtrace\|execinfo` → **零命中** |
| **不需要 `-D__MUSL__`** | 仓库内 `__MUSL__` 零命中（那只是 OHOS SDK clang wrapper 的惯例，不是本库要求） |
| **不依赖 libgcc_s** | 官方用 `-static-libgcc`，产物 NEEDED 里**没有 `libgcc_s.so.1`**（历史上 Alpine/musl 的坑 Issue #157 正是缺它，v1.4.8-2 已修） |
| 官方从未讨论鸿蒙 | issue tracker 全量检索 `ohos`/`harmony` **命中 0**；源码树 grep 也是零命中 |

#### 编译要点（可直接抄）

```bash
# 唯一必需的 CMake 覆盖
-DCMAKE_SYSTEM_NAME=Linux          # ★ 必须！CMake 不认识 HarmonyOS/ohos，不设直接 configure 失败
                                   #   ⛔ 禁止设成 ohos / HarmonyOS
-DCMAKE_TOOLCHAIN_FILE=$NDK/build-tools/cmake/ohos.toolchain.cmake
-DOHOS_ARCH=arm64-v8a
-DOHOS_PLATFORM=OHOS

# 编译器（toolchain 内部会用到）
$NDK/llvm/bin/aarch64-linux-ohos-clang  --target=aarch64-linux-ohos  --sysroot=$NDK/sysroot

# ★ 版本必须与你的 jar 严格一致（288 个 JNI 方法签名由 Java 侧决定）
#   源码：_research/zstd-jni-ohos/zstd-jni/（已克隆，v1.5.7-23，HEAD fbee544）
```

#### ★★ so 放哪：这才是真正的风险（两个形态答案不同）

> **重要**：网上有建议把 .so 放 `/data/storage/el2/base/files/`（应用沙箱目录）。**对形态 B 这是错的** —— 依 §4.1/§4.3 的内核证据，**沙箱内运行期写入的 .so 不在 `libs/` 前缀下 → 不进 fsv-sig 链路 → 对"普通应用类"进程被 XPM 直接拦**。

| 后端形态 | .so 放哪 | 启动参数 |
|---|---|---|
| **形态 A：终端 `java -jar`** | 任意可读路径（`/data/local/tmp/libs/`、用户目录） | `java -DZstdNativePath=/data/local/tmp/libs/libzstd-jni-1.5.7-23.so -jar app.jar` |
| **形态 B：应用内 HNP 拉起 JVM** | **必须随 HAP 放在 `libs/{abi}/`**，安装后沙箱内为 `/data/storage/el1/bundle/libs/arm64/` | `-DZstdNativePath=/data/storage/el1/bundle/libs/arm64/libzstd-jni-1.5.7-23.so` |

**优点**：
- Java 代码**零改动**（一行启动参数）
- 不依赖临时目录可写
- 走 `ZstdNativePath` 分支时**不做任何回退**（源码 L105-111），行为确定

**另一条零改码的路**：`System.load(<abs>)` + `Native.assumeLoaded()`（官方逃生口，源码 L64-66）。

**⚠️ 备选巧法（省事但有前提）**：若实测确认鸿蒙 JVM 的 `os.name=Linux`、`os.arch=aarch64`，则 zstd-jni 会去找 jar 内 `/linux/aarch64/libzstd-jni-<ver>.so`。
→ 可以**直接把 OHOS 编译产物替换进主 jar 的那个槽位**，连启动参数都不用加。
→ 但**默认加载路径是"解压到 `java.io.tmpdir` 再 `System.load`"** —— **tmpdir 不在签名目录内，形态 B 下大概率被 XPM 拦**；形态 A 可用。且这样做会让该 jar 无法在真 Linux 上跑（槽位被占用），**只在"整个应用只跑鸿蒙"时才推荐**。

**风险/前提**：
- 必须**版本严格一致**（288 个 JNI 导出必须与 Java 侧匹配）
- 需能跑通交叉编译（§7 的通用流程）
- ⚠️ 若 JVM 在应用沙箱内（形态 B），.so 位置与 XPM 校验是硬约束（上表）

#### ★★ 形态 B 实战配方（Electron `spawn` 启动后端 Java）

> 适用：**Electron 主进程用 `child_process.spawn` 拉起 `java -jar`**。
> 此时 JVM 继承**应用沙箱**与**应用类进程**身份 → **XPM 强制校验签名** → .so 的存放位置是硬约束。

**第 0 步（最容易搞错）：先确认你编出来的是哪一个**

| 产物 | 是什么 | 能否替代 zstd-jni 的 so |
|---|---|---|
| **`libzstd-jni-<ver>.so`** | zstd-jni 的 **JNI 包装层**，**内部静态内置了 zstd** | ✅ **能** |
| **`libzstd.so`** | 纯 zstd C 库，**没有任何 JNI 符号** | ❌ **不能** —— 缺 288 个 `Java_com_github_luben_zstd_*` 符号 |

**怎么区分**（一条命令）：
```bash
nm -D --defined-only libzstd.so | grep -c Java_com_github_luben_zstd
#   ≈288 → 是 zstd-jni 的包装库 ✅
#   0    → 只是纯 zstd C 库，需要按 §5 的流程重编 zstd-jni 的 native 部分 ❌
```
> zstd-jni 的源码已克隆在 `_research/zstd-jni-ohos/zstd-jni/`，其 native 部分在 `src/main/native/`（含 vendored zstd，39 个 .c）。

**第 1 步：把 .so 放进 `electron/libs/arm64-v8a/`**

| 项 | 值 |
|---|---|
| 工程内路径 | `project-template/electron/libs/arm64-v8a/libzstd-jni-<ver>.so` |
| 为什么是 `electron` 模块 | 它是 **entry**（`module.json5` 里 `"type": "entry"`）；`web_engine` 是 **har**。entry 的 `libs/` 会进 HAP 并在安装时被 hapsigner 的 `isNativeFile()` 命中 → 生成 `SoInfoSegment` → 安装期使能 fs-verity |
| 为什么不能放别处 | `electron/libs/arm64-v8a/` 里已有的 `libelectron.so`/`libadapter.so` 就是**已验证可加载**的同款路径 |
| 安装后沙箱路径 | **`/data/storage/el1/bundle/libs/arm64/`**（注意 ABI 目录名从 `arm64-v8a` 变成 **`arm64`**） |

> 🚫 **千万不要**把 .so 放到 `web_engine/src/main/resources/resfile/` 下（哪怕和 `app.jar` 并排很"自然"）。
> **官方 HNP 文档里被 XPM 拦下的那个例子，路径正是 `.../resources/resfile/electron`** —— `resfile/` 不以 `libs/` 开头，**不进 fsv-sig 链路**，对应用类进程必被拦。

**第 2 步：给 spawn 的 java 加启动参数**（`main.js`）

```js
// project-template/web_engine/src/main/resources/resfile/resources/app/main.js
//   第 56 行附近：JVM_ARGS
//   第 149 行：const args = [...CONFIG.JVM_ARGS, '-jar', jarPath];

JVM_ARGS: [
  '-Xmx256m',
  // ★ 关键：把应用 libs 目录加进 JNI 搜索路径
  '-Djava.library.path=/data/storage/el1/bundle/libs/arm64',
  // ★ 双保险：zstd-jni 的显式路径分支（走到这条就不再回退）
  '-DZstdNativePath=/data/storage/el1/bundle/libs/arm64/libzstd-jni-<ver>.so',
],
```

**为什么优先用 `-Djava.library.path` 而不是只加 `ZstdNativePath`**：
- 它能让 zstd-jni 走**第 2 级** `System.loadLibrary("zstd-jni-<ver>")` 直接命中，**完全不做"解压到 tmpdir"** —— 从根上避开 XPM 对 tmpdir 的拦截；
- **同时覆盖其它 JNI 库**：Kafka 场景下 `lz4-java`、`snappy-java` 也是 JNI 库，同样需要进 `libs/` 并靠这个路径被找到（只配 `ZstdNativePath` 救不了它们）。
- ⚠️ **文件名必须严格等于 `libzstd-jni-<你的 jar 版本>.so`**（`libnameShort = "zstd-jni-" + ZstdVersion.VERSION`），否则第 2 级找不到、会退回第 3 级解压。
- ⚠️ 若设了 `java.library.path` 后 JDK 自身的库反而找不到，把它追加进同一串：`-Djava.library.path=/data/storage/el1/bundle/libs/arm64:/data/app/<bundle>/jdk17_1.0/lib`

**第 3 步：验证（按顺序）**

| # | 验证 | 命令 / 判据 |
|---|---|---|
| 1 | .so 确实打进了 HAP | `unzip -l electron-default-unsigned.hap \| grep libs/arm64-v8a` |
| 2 | 安装后确实落地了 | `hdc shell ls /data/app/el1/bundle/public/<bundleName>/libs/arm64/` |
| 3 | 沙箱内视角可见 | `nsenter -t <electron 进程号> -m sh` 后 `ls /data/storage/el1/bundle/libs/arm64/` |
| 4 | 未被 XPM 拦 | `hdc shell hilog \| grep -i "get signature info failed"`（**应无输出**） |
| 5 | 真的从 libs 加载了（没走 tmpdir） | 启动日志里**不应**出现解压临时文件；或临时观察 `java.io.tmpdir` 下无 `libzstd-jni-*` |
| 6 | 功能通了 | 跑一次 zstd 压缩+解压 |

**兜底（若第 2 步仍失败）**
- 若 JVM 读不到 `/data/storage/el1/bundle/libs/arm64/` → 用第 3 步的 `nsenter` 确认真实沙箱路径，改参数；
- 若该路径下文件存在但仍被 XPM 拦 → 说明没进 fsv-sig 链路，检查 .so 是否真的在 HAP 的 `libs/` 前缀下（而不是被放进了 `resources/`）；
- 终极逃生口：`System.load(<可读绝对路径>)` + `Native.assumeLoaded()`（零改 zstd-jni，但要求该路径本身合法）。

### 方案②：换纯 Java 实现（无 JNI）

若 zstd 的使用是**应用内部**的（不涉及与外部系统的格式约定），最干净的做法是**不用 JNI**。候选见 §6。

**优点**：一劳永逸，无 ABI/签名/沙箱问题，跨平台一致。
**代价**：功能覆盖与性能需评估；若有协议绑定（见方案③）则不可行。

### 方案③：干掉 zstd（若是传递依赖）

`zstd-jni` 在后端里**经常不是直接依赖**，而是被这些库带进来的：
- **Kafka clients**（`kafka-clients` → `zstd-jni`）
- RocksDB / 某些消息队列、缓存、列存组件

排查与处置：
```bash
mvn dependency:tree -Dincludes=com.github.luben:zstd-jni     # 看是谁带进来的
```
- 若是 **Kafka**：zstd 是**生产端压缩算法选项**，可以改用 `compression.type=lz4/gzip/snappy`（需 broker 侧兼容；消费端通常能解多种格式）。**注意**：Kafka 客户端在 zstd-jni 缺失时通常会**在启动时报错或禁用 zstd**，需实测。
- 若是其它组件：查它是否提供"关闭 zstd / 换算法"的开关。

### 方案④：so 随 HAP 打包（仅形态 B 需要）

若 JVM 由应用在**沙箱内**拉起（形态 B），把交叉编译好的 so 放进 HAP 的 `libs/arm64-v8a/`，落在应用签名范围内，再用 `-DZstdNativePath` 指向它在沙箱内的实际路径。

- ⚠️ 沙箱内路径需要进沙箱确认：`nsenter -t <pid> -m sh` 然后 `ls`
- ⚠️ 终端启动的 JVM（形态 A）是否读得到应用安装目录，**待实测**

### 方案⑤：后端跑在 openEuler Linux 子系统

子系统内是 glibc 环境，**官方 zstd-jni 的 .so 可直接用**，零改造。代价是架构变化（见《可行性报告》的形态 C）。

---

## 6. 替代方案候选（纯 Java）★ 已实测

> 本节数据来自实测（下载 jar 反编译 + 双向互通 + 同机 benchmark），完整报告 `鸿蒙Java后端_zstd替代方案调研.md`。

| 方案 | 纯 Java？ | zstd 压缩 | zstd 解压 | 实测性能（压缩/解压） | 迁移成本 |
|---|---|---|---|---|---|
| **`io.airlift:aircompressor` 0.27** | ✅ **是**（jar 内 **0 个** .so，字节码 major 52 = Java 8） | ✅ | ✅ | **612 / 730 MB/s** | 低（直接业务调用）/ 中（Kafka 需 shim） |
| zstd-jni 1.5.6（原生，对照） | ❌ | ✅ | ✅ | 1471 / 2504 MB/s | — |
| JDK 自带 Deflate/GZIP/Zip | ✅ | ❌ 格式不同 | ❌ | — | 最低，但**不兼容 zstd 格式** |
| `org.lz4:lz4-java` 的 `fastestJavaInstance()` | ✅ 实测不碰 JNI | ❌ | ❌ | — | 中；**压缩率从 2.896 掉到 2.101（损失 ~27%）** |
| `org.xerial.snappy:snappy-java` | ❌ 含 JNI | ❌ | ❌ | — | **同样会踩本文的坑，不要替换成它** |
| `aircompressor-v3` 3.10 | ❌ | — | — | — | **排除**：字节码 major 69（**需 Java 25**），且 jar 内打包了 glibc `.so` |

**aircompressor 的关键事实（全部已核实）**：
- **压缩率几乎无损**：5.20% vs zstd-jni 的 5.23%（同数据同 level）。
- **双向格式互通**：aircompressor 产物能被官方 zstd 1.5.7 解压；官方 `-3`/`-19`/`--long=27` 产物也都能被 aircompressor 解压。
- **代价：慢 2.4×（压缩）/ 3.4×（解压）**。
- **两个硬限制**：
  1. **不支持字典** —— 源码 `verify(dictionaryId == -1, "Custom dictionaries not supported")`，实测构造字典样本失败；
  2. **硬依赖 `sun.misc.Unsafe`** —— `decompress(byte[])` 字节码直接 `getstatic sun/misc/Unsafe.ARRAY_BYTE_BASE_OFFSET`，**即使用 `byte[]` API 也绕不开**（注意：鸿蒙 JDK 是否有 `sun.misc.Unsafe` 需实测）；
  3. 另有 **8 MiB 窗口上限**（只在真正触发 >8 MiB 回溯时才报错）。
- **Commons Compress 不算替代**：`commons-compress-1.27.1.pom` 依赖 zstd-jni（optional），`ZstdCompressorInputStream` 的字段类型就是 `com.github.luben.zstd.ZstdInputStream`。**luben 无纯 Java 版**，也未找到其他成熟纯 Java zstd 项目。

### 6.1 ★ 关键坑：aircompressor **不能**靠依赖替换顶掉 zstd-jni（在 Kafka 场景）

| 事实 | 说明 |
|---|---|
| **源码级强耦合** | kafka-clients 的 `ZstdCompression` 字节码**硬编码** `new com/github/luben/zstd/ZstdOutputStreamNoFinalizer(...)` 与 `ZstdInputStreamNoFinalizer`，还实现了匿名 `com.github.luben.zstd.BufferPool` —— **不是可插拔 SPI** |
| **实测三组 classpath** | 只有 kafka-clients + aircompressor 时，`snappy`/`lz4`/`zstd` 全部 `ClassNotFoundException`；且**在 `Compression.zstd().level(3).build()` 这一步就炸**（eager），不是等真正压缩 |
| **好消息** | **没有 zstd-jni 时，`CompressionType` 枚举与 `gzip`/`none` 完全正常** → "不用 zstd 就能在无 zstd-jni 环境跑 Kafka 客户端"成立 |
| **强先例（同类故障）** | [KAFKA-17891](https://issues.apache.org/jira/browse/KAFKA-17891) / [KAFKA-17227](https://issues.apache.org/jira/browse/KAFKA-17227)：Kafka 3.8.0 把 zstd-jni 变成硬依赖，导致 z/OS 与 `noexec /tmp` 环境**完全无法启动**（`UnsatisfiedLinkError: /tmp/lib/libzstd-jni-*.so: failed to map segment`），**即使 `compression.type=none`**。社区认定这是 bug，修复于 3.7.2/3.8.1/3.9.0 —— **与你的鸿蒙问题是同一类故障** |

### 6.2 若走纯 Java：两条可行路线

| 路线 | 做法 | 改动面 |
|---|---|---|
| **A. 直接替换**（zstd 只用于业务内部压缩） | 换成 `io.airlift:aircompressor:0.27` | 只改业务代码 |
| **B. 包名 shim**（zstd 用在 Kafka 上） | 在 **`com.github.luben.zstd` 包名下**写同名 shim，实现 `ZstdOutputStreamNoFinalizer`/`ZstdInputStreamNoFinalizer`/`BufferPool`/`RecyclingBufferPool`，内部委托 aircompressor 0.27 | **kafka-clients 与业务代码零改动**；但这是"fork 式"兼容层，需自行维护 |
| B 的前提（已核实） | native 与 Java 实现**各自都是确定性的**（相同输入重复压缩字节完全一致）→ Kafka 的去重/校验逻辑不受影响 | — |

> ⚠️ **换库前必须确认的三件事**：① 新库**真的没有 JNI**（很多"纯 Java"实现检测到 native 可用时会优先走 JNI）；② **鸿蒙 JDK 是否提供 `sun.misc.Unsafe`**（aircompressor 硬依赖）；③ zstd 是否被**外部协议**要求（Kafka topic 上的既有 zstd 数据、与其它服务的交换格式）—— 若是，换算法会导致读不了历史数据。

---

## 7. ★ 通用做法：鸿蒙 C/C++ 三方库交叉编译标准流程

这是回答"**目前通用的做法是什么**"的核心。鸿蒙 PC 生态已有一套**官方/社区标准框架**：

### 7.1 标准工具链与框架

| 组件 | 地址 | 作用 |
|---|---|---|
| **OHOS SDK** | DevEco Studio 自带（6.0 Release+） | 提供 `native/llvm/bin/aarch64-linux-ohos-clang`（**自带 musl sysroot**，不需手配 `--sysroot`）与 `native/build/cmake/ohos.toolchain.cmake` |
| **lycium++** | `https://atomgit.com/OpenHarmonyPCDeveloper/lycium_plusplus` | ★ **三方库交叉编译框架**：写 `HPKBUILD` → `./build.sh <pkg>` 一键多架构构建 |
| **hnpcli** | `$OHOS_SDK/toolchains/hnpcli` | 把产物打成 `.hnp` 包 |
| **鸿蒙 PC 开发者社区** | `https://atomgit.com/OpenHarmonyPCDeveloper` | 已适配库的 HPKBUILD 集合（OpenSSL/libhv/11Zip/Protobuf…） |

### 7.2 标准流程（六步）

```
1. 环境：Ubuntu 22.04 + OHOS SDK 6.0+ + lycium++
   export OHOS_SDK=/path/to/sdk/linux          # 指向含 native 的那一层
   export HNP_TOOL=$OHOS_SDK/toolchains/hnpcli

2. 在 thirdparty/<pkgname>/ 下编写 HPKBUILD（类 Arch PKGBUILD）
   pkgname/pkgver/archs/source/builddir/buildtools + prepare()/build()/package()/archive()

3. ./build.sh <pkgname>     → 产物在 lycium/usr/<pkgname>/arm64-v8a/lib/

4. ★ ABI 校验（别跳过）
   $OHOS_SDK/native/llvm/bin/llvm-readelf -h  libxxx.so | grep -E "Machine|Class"
       期望：Class: ELF64 / Machine: AArch64
   $OHOS_SDK/native/llvm/bin/llvm-readelf -d  libxxx.so | grep NEEDED
       期望：libc.so    ← musl
       错误：libc.so.6  ← glibc，真机必定 dlopen 失败
   （原文：这一步能提前挡掉 90% 的"真机跑不起来"）

5. （可选）archive() 里 hnpcli pack 产出 .hnp

6. 集成：ArkTS/NAPI 工程放 entry/libs/arm64-v8a/；
   CMake 用 ohos.toolchain.cmake：
   -DCMAKE_TOOLCHAIN_FILE=$OHOS_SDK/native/build/cmake/ohos.toolchain.cmake -DOHOS_ARCH=arm64-v8a
```

### 7.3 musl 适配的常见坑（已知清单）

| 类别 | 具体 | 处置 |
|---|---|---|
| **glibc 专有函数缺失** | `getcontext`/`setcontext`（OpenSSL 异步引擎用）、`gettid()`、`setproctitle()` | 关掉相关特性（如 `no-async`）或用 `syscall(SYS_gettid)` 等替代 |
| **soname 不匹配** | glibc 产物要求 `libc.so.6`/`libpthread.so.0` | 必须重新编译；musl 的 pthread 已并入 libc |
| **误链宿主库** | 产物里混入 x86_64 或宿主 glibc 库 | 用 `llvm-readelf -h/-d` 核对 `Machine`/`Class`/`NEEDED` |
| 预处理器被错配 | lycium 的 `setarm64ENV()` 把 `CPP` 设成 `CXX` | 改成正确的 C 预处理器 |
| 自测依赖宿主工具链 | 如 OpenSSL 的 `tests` | 关掉（`no-tests`） |

> **一句话总结通用做法**：**任何要在鸿蒙上跑的原生库，都必须用 OHOS SDK 的 clang（`aarch64-linux-ohos`，musl）重新交叉编译；用 `llvm-readelf` 校验 ABI 是交付前的强制步骤。** 直接拿 Linux/glibc 的预编译 .so 到鸿蒙上用，必定失败。

---

## 8. 落地步骤与验证清单

### 8.1 立刻可做的三步（不需要真机）

| # | 动作 | 命令/判据 |
|---|---|---|
| 1 | **确认你的报错属于 §3 哪一类** | 把完整异常栈贴出来对照判读表 |
| 2 | **确认 .so 的 ABI** | 从你的 jar 里取出 `linux/aarch64/*.so`，`strings \| grep GLIBC_` + 解析 DT_NEEDED（本机即可做） |
| 3 | **确认 zstd 是谁带进来的** | `mvn dependency:tree -Dincludes=com.github.luben:zstd-jni` |

### 8.2 真机验证清单

| # | 验证项 | 方法 | 判据 |
|---|---|---|---|
| Z-1 | 鸿蒙 JDK 报告的 `os.name` / `os.arch` | `java -XshowSettings:properties -version 2>&1 \| grep -E "os.name\|os.arch"` | 若为 `Linux`/`aarch64` → 命中 `/linux/aarch64/` 分支（符合本文推断） |
| Z-2 | 真实报错文案 | 直接跑，抓完整 `UnsatisfiedLinkError` | 对照 §3 判读表 |
| Z-3 | **dlopen 未签名的 musl .so 是否被 XPM 拦截**（★ 关键未知项） | 交叉编译一个 musl 版 zstd-jni .so，放 `/data/local/tmp/`，用 `-DZstdNativePath` 加载 | 能加载 → XPM 不管 .so（方案① 无阻力）；被拦 → 需走签名/随包 |
| Z-4 | 终端启动的 JVM 能否读应用安装目录 | `ls /data/app/el1/bundle/*/<bundle>/**/libs/` | 决定方案④是否可行 |
| Z-5 | 临时目录可写性（形态 B） | 打印 `java.io.tmpdir` 并尝试写文件 | 决定第 3 级加载是否还有额外障碍 |
| Z-6 | 纯 Java 替代的功能/性能 | 用 §6 的库跑压缩解压回归 | 决定方案②可行性 |

### 8.3 交叉编译 zstd-jni 的最小工作项

1. 取 **与当前 jar 完全同版本** 的 zstd-jni 源码（`src/main/native/`，内含 zstd C 源码）
2. 按 §7.2 写 `HPKBUILD`（`buildtools` 视其构建系统而定；若无 CMake 则自己拼 clang 命令行）
3. 编译出 `libzstd-jni-<ver>.so`，用 `llvm-readelf -d | grep NEEDED` 确认是 **`libc.so`** 而非 `libc.so.6`
4. 用 `nm -D`/`llvm-nm` 抽查 `Java_com_github_luben_zstd_*` 导出符号存在（应有 ~288 个）
5. 真机用 `-DZstdNativePath` 验证（Z-3）

---

## 9. 待确认 / 未核实项（诚实清单）

> 本轮三路并行调研后，**原 7 项中 4 项已从"未核实"变为"已证实或已有先例"**，逐条更新如下。

### 9.1 已解决（本轮证实）

| # | 原问题 | 结论 | 证据 |
|---|---|---|---|
| 2 | ~~`dlopen` 一个未签名 .so 是否会被 XPM 拦截~~ | ✅ **会拦**（对"普通应用类"进程）。XPM hook 的是 `mmap_region`+`file_mprotect`，判定只看 "file-backed + PROT_EXEC"，与 `e_type` 无关 | 内核源码 `xpm_security_hooks.c:378-381,259-261`（§4.1） |
| 4 | ~~aircompressor 是仅解压还是也支持压缩~~ | ✅ **压缩+解压都支持**，纯 Java（0 个 .so，字节码 Java 8）；但慢 2.4×/3.4×、不支持字典、硬依赖 `sun.misc.Unsafe` | 实测（§6） |
| 7 | ~~是否已有他人为 OHOS 编译过 zstd-jni~~ | ✅ **有公开先例**：`build_in_harmonyos` 把 1.5.6-5 标记为 published，只差 1 行 CMake 补丁；但那是"鸿蒙本机编译" | §5 方案① |
| — | ~~OpenHarmony 有没有系统 libzstd~~ | ✅ **没有**（官方 manifest 496 project / 180 third_party 零命中），且即便有，应用命名空间也 dlopen 不到 `/system/lib64` | §4.5 |
| — | ~~libc 是 musl 还是 glibc~~ | ✅ **musl**（官方 manifest `third_party_musl` + 官方文档 + 加载器 `/system/lib/ld-musl-aarch64.so.1`），glibc 命中 0 | §2、§4 |

### 9.2 仍需真机确认（按优先级）

| # | 项 | 为什么重要 | 怎么测 |
|---|---|---|---|
| **1** | **用户实际看到的完整异常栈** | 决定是 libc 问题（§3 第一行）还是别的分支 | 直接跑，抓完整 `UnsatisfiedLinkError` |
| **2** | **鸿蒙 JDK 的 `os.name`/`os.arch`** | 决定它去 jar 里翻哪个槽位（🟡 推测 `Linux`/`aarch64` → 命中 `/linux/aarch64/`） | `java -XshowSettings:properties -version 2>&1 \| grep -E "os.name\|os.arch"` |
| **3** | **终端启动的 java 进程属于哪个 XPM 进程类别** | 决定形态 A 能否用"任意可读路径放 .so"（§4.2 推测属调测类/沙箱类 → 不校验签名） | 交叉编译出的 .so 放 `/data/local/tmp/`，`-DZstdNativePath` 加载；被拦会在内核日志留 `get signature info failed` |
| **4** | **从 macOS/Linux 交叉编译 zstd-jni 到 OHOS** 是否真的可行 | 现有先例是"鸿蒙本机编译"，交叉编译路径**未找到公开先例** | 按 §5 方案① 的参数实际跑一遍 |
| **5** | 鸿蒙 JDK 是否提供 **`sun.misc.Unsafe`** | aircompressor 硬依赖它（即使用 `byte[]` API） | 一行 Java 反射探测 |
| **6** | zstd 是**用在 Kafka 上**还是**直接业务调用** | 决定选纯 Java shim（Kafka）还是直接替换（业务） | `mvn dependency:tree -Dincludes=com.github.luben:zstd-jni` + 看代码调用点 |
| **7** | 终端 JVM 能否读应用安装目录 | 决定方案④是否可行 | `nsenter -t <pid> -m sh` 后 `ls` |

### 9.3 明确"未找到"（不要在这上面耗时间）

| 项 | 说明 |
|---|---|
| `ohos.toolchain.cmake` 逐行原文 | 华为文档 JS 渲染抓不到；多个源码站在本环境被 Cloudflare/网络拦；本机无 SDK。但**官方变量表已足够用**（§5） |
| 华为 `hap-bin` 页面正文 | 中英文页面均为 JS 空壳；OpenHarmony docs 也无对应 md。等价机制是 `module.json5.executableBinaryPaths`（§4.4） |
| 官方对"glibc 产物在鸿蒙报什么错"的说明 | 无官方文档；本文给出的是 musl 源码级推断（§3） |
| XPM 的官方文档描述 | 只有内核仓 README + 源码，HarmonyOS 侧文档对 XPM 完全沉默 |
| 上述 OHOS zstd-jni 产物的实测验证报告 | 归档里无 `reports/` 目录（404） |
| luben 的纯 Java 版 / 其他成熟纯 Java zstd 项目 | 未找到（Commons Compress 也是转发 zstd-jni） |

---

## 10. 出处与参考资料

**本文一手核实（本机复现）**
- zstd-jni 源码 `com/github/luben/zstd/util/Native.java`：`https://cdn.jsdelivr.net/gh/luben/zstd-jni@master/src/main/java/com/github/luben/zstd/util/Native.java`
- jar 与 ABI：Maven Central `com/github/luben/zstd-jni`（1.5.6-4 与最新 1.5.7-23 均已下载核对）

**官方文档**
- 官方 HNP 打包与 fork 指南（本地副本：`_research/repo/docs/hnp-packaging-guide/README.md`；原文亦在 `research/hnp打包与fork指导文档.md`）
- OpenHarmony HNP 打包工具：`https://gitee.com/openharmony/startup_appspawn/blob/master/service/hnp/pack/README_zh.md`
- 官方 FAQ《IDE应用调用插件包二进制及so文件的权限与签名要求》：`https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-access-control-23`
- 应用程序包集成 bin 文件（PC/2in1）：`https://developer.huawei.com/consumer/cn/doc/doccenter-getting-started/hap-bin`（页面为 JS 渲染，本次未能取到正文 → §9 未核实项）
- 二进制签名工具：`https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/binary-sign-tool`

**通用交叉编译做法（社区/官方框架）**
- 鸿蒙 PC C/C++ 三方库交叉编译实战（lycium++ / HPKBUILD，以 OpenSSL 为例）：`https://ai6s.net/6a951e9d3bda720d4b383e0f.html`
- libhv 鸿蒙化适配（musl 兼容性清单与 ABI 校验实践）：`https://harmonypc.csdn.net/6a3a2db7662f9a54cb82ff22.html`
- lycium++ 交叉编译框架：`https://atomgit.com/OpenHarmonyPCDeveloper/lycium_plusplus`
- 鸿蒙 PC 开发者社区（已适配库集合）：`https://atomgit.com/OpenHarmonyPCDeveloper`

**本仓库相关**
- 《鸿蒙PC沙盒JIT与so加载限制解决方案.md》（§5 讲 so 加载限制与 sqlite 场景）
- 《鸿蒙PC迁移专项_后端部署与网络证书方案.md》（形态 A/B/C 与 JDK 的 HNP 化）
- 《鸿蒙PC迁移实施手册.md》第六部分（HNP 完整流程）

---

*本文的 ABI 与加载机制结论均已在本机复现；涉及鸿蒙运行时行为的项（XPM 对 .so 的管控、JDK 的 os.name、沙箱可读性）标注为待实测，见 §9。*
