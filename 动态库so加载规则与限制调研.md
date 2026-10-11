# HarmonyOS / OpenHarmony 动态库（.so）加载规则与限制调研

> 调研时间：本轮会话；调研范围：官方文档（OpenHarmony docs / Huawei developer）、官方源码（OpenHarmony 各仓）、本地离线资料（`_research/repo`、`research/`）、社区实践。
> 标注约定：`【官方明确】` = 官方文档正文或官方仓库源码；`【官方代码】` = 官方开源仓源码级证据（未必有文档描述）；`【社区实践】` = 第三方博客/论坛实测；`【推测】` = 本报告推断；`未找到` = 明确没查到。
> 证据文件已落盘：`_research/xpm-research/evidence/`（见文末清单）。

---

## 0. TL;DR（先看这 8 条）

1. **随 HAP 打包的 `.so` 走的是"文件级代码签名（fs-verity）"这条路**：签名 HAP 时，hapsigner 会自动为 HAP 内**所有 `libs/` 开头的条目**（以及 `*.an`）生成代码签名信息（`SoInfoSegment`），安装时由 `code_signature` 部件逐个文件使能 fs-verity，文件 ownerid = 应用自己的 ownerid，XPM 校验通过。**不是"因为文件在 HAP 签名范围内所以天然豁免"**。【官方代码】
2. 非随包签名（运行期写入沙箱、从网络下载）的 `.so`，在被 `dlopen` 时由 ld.so 以 `PROT_EXEC` 映射 → 命中 XPM 的 `mmap_region` 钩子 → `get signature info failed` → `mmap` 返回 `-EPERM` → **dlopen 失败**。这与"可执行文件 exec 被拦"是**同一个内核钩子、同一套规则**。【官方代码】
3. `code_type: ELF` 的含义**不是文件类型**，而是"本次映射被判定为**文件代码段映射**（file-backed + PROT_EXEC）"；反之非 exec 映射记为 `ABC`。`vm_prot: 5` = `PROT_READ|PROT_EXEC`。【官方代码】
4. `echo 0 > /proc/sys/kernel/xpm/xpm_mode` 会把 XPM 的整体判定结果"清零"（`xpm_ret()`），因此**同样放开 .so 的可执行映射**；仅调试可用。【官方代码】+【推测】（同一 hook 路径）
5. 官方**没有**一篇文档直接写"dlopen 的 .so 会被 XPM 拦"；结论来自内核源码 + 官方 userspace 代码签名部件。**HarmonyOS 侧文档对 XPM 完全沉默**（OpenHarmony docs 中 `grep -i xpm` 命中 0 条相关内容）。【官方明确】= "未找到直接文档"
6. `hap-bin` 这篇华为页面正文抓不到（JS 渲染）。OpenHarmony 侧等价机制是 module.json5 的 **`executableBinaryPaths`（API 24+）**：可执行文件**必须放 `libs/{abi}/`**，且必须配置解压模式。它与 HNP 是**同一主题的两条路**（轻量 bin 随 HAP 走 `libs/`；重型 Native 软件包走 HNP）。【官方明确】
7. `binary-sign-tool` **可以签 .so**（ET_DYN 且 entry==0）：会写入 `.codesign` 段并生成代码签名，但**不写 profile/permission 段**（所以"共享库不支持声明权限"）。要跨应用/跨分发加载"二进制证书签名的共享库"，需要受限权限 **`ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY`**（system_basic / system_grant / PC/2in1 / API 20+，API 22 起对普通应用开放）。【官方明确】
8. libc 是 **musl**（官方 manifest `third_party_musl`；官方文档"OpenHarmony采用musl作为C标准库"）。glibc 平台编译的 `.so` **即使签名通过也加载不了**（ABI/加载器不兼容）。另外，**普通应用不能 dlopen `/system/lib64` 下的系统库**（命名空间隔离，只能用 `/system/lib64/ndk`）。【官方明确】

---

## 1. 问题 1：随 HAP 打包的 .so 走哪条路

### 1.1 落盘路径（开发态 → 安装态）

| 阶段 | 路径 |
| --- | --- |
| 工程（开发态） | `entry/libs/arm64-v8a/*.so`（或 `src/main/cpp` + CMake 产物经 `build-profile.json5` 的 `nativeLib` 配置落到同一处） |
| HAP 内 | `libs/arm64-v8a/*.so` |
| 设备·应用沙箱内 | **`/data/storage/el1/bundle/libs/arm64/`**（注意：ABI 目录名从 `arm64-v8a` 变成 `arm64`） |
| 设备·物理路径 | `/data/app/el1/bundle/public/<PACKAGENAME>/libs/arm64/` |

- 沙箱路径证据：官方文档的崩溃栈里直接出现 `/data/storage/el1/bundle/libs/arm64/libsample.so`、`/data/storage/el1/bundle/libs/arm64/libentry.so` —— `zh-cn/application-dev/dfx/cppcrash-guidelines.md:766,991`；`zh-cn/application-dev/ui/arkts-stability-crash-issues.md:52`。【官方明确】
- 物理路径映射证据：官方《应用沙箱目录》表 "`/data/storage/el1/bundle` → `/data/app/el1/bundle/public/<PACKAGENAME>`"。【官方明确】
- **例外**：`module.json5` 的 `libIsolation` 为 `true` 时，.so 会放到 `libs/<ModuleName>/` 下；缺省 `false`（`zh-cn/application-dev/quick-start/module-configuration-file.md:143`）。【官方明确】
- 本仓库现成例子（Electron CPF）：`project-template/electron/libs/arm64-v8a/{libelectron.so, libadapter.so, libffmpeg.so, libc++_shared.so, libextractor.so}`。【工作区文件】

### 1.2 沙箱内怎么引用 / `nativeLibraryDir` 与 `System.loadLibrary` 的对应物

| Android | HarmonyOS / OpenHarmony | 出处 |
| --- | --- | --- |
| `ApplicationInfo.nativeLibraryDir` | **`nativeLibraryPath`**（API 12+，`ApplicationInfo` / `HapModuleInfo` 字段） | `zh-cn/application-dev/reference/apis-ability-kit/js-apis-bundleManager-applicationInfo.md:52`、`js-apis-bundleManager-hapModuleInfo.md:47`【官方明确】 |
| `System.loadLibrary("foo")` | ArkTS：`import foo from 'libfoo.so'` 或 `loadNativeModule('libfoo.so')`（后者仅 UI 主线程、需在 `oh-package.json5` 声明依赖） | `zh-cn/application-dev/napi/use-napi-asynchronous-task.md:153`；`zh-cn/application-dev/reference/common/js-apis-common-load-native-module.md:11-41`【官方明确】 |
| —（NDK/C++） | 直接 `dlopen("libfoo.so")`，由 **app ns** 解析：官方原文"app ns: 应用启动时创建的ns，它的搜索路径一般是**应用的安装路径(可能为沙箱路径)**，即可加载应用的so" | `zh-cn/application-dev/napi/c-cpp-overview.md:41`【官方明确】 |

> 结论：**工程侧写 `libs/arm64-v8a/`，设备侧就是 `bundleCodeDir/libs/arm64/`；同名 `dlopen("libxxx.so")` 即可命中**（app ns 覆盖应用安装路径）。不需要（也不应该）拼绝对路径去 `resources/resfile` 里 `dlopen`。

### 1.3 「在 HAP 签名范围内所以不受 XPM 管控」——**这个说法不准确，官方依据链如下**

真正的机制是"**HAP 签名时自动给每个 `libs/` 条目生成文件级代码签名，安装时使能 fs-verity**"：

1. **HAP 签名阶段**：`developtools_hapsigner` 的 `CodeSigning.java` → `signNativeLibs()` → `getNativeEntriesFromHap()` → `isNativeFile()`：
   ```java
   if (entryName.endsWith(FileUtils.NATIVE_LIB_AN_SUFFIX)) return true; // *.an
   if (entryName.startsWith(FileUtils.LIBS_PATH_PREFIX)) return true;  // libs/
   ```
   命中的每个条目都会生成 `(文件名, SignInfo)` 并写入签名的 `SoInfoSegment`（fs-verity 描述符 + PKCS7 签名 + merkle tree）。
   出处：`developtools_hapsigner/hapsigntool/hap_sign_tool_lib/src/main/java/com/ohos/hapsigntool/codesigning/sign/CodeSigning.java:209-212, 260-270, 378-408`；常量 `LIBS_PATH_PREFIX = "libs/"`、`NATIVE_LIB_AN_SUFFIX = ".an"` 见同仓 `.../utils/FileUtils.java:78, 88`。【官方代码】
2. **安装阶段**：`base/security/code_signature`（代码签名部件）README 原文："**代码签名使能**：在用户态提供代码签名校验的相关接口和逻辑，**供应用安装的时候调用**，为应用和代码文件使能代码签名。"
   `EnforceCodeSignForApp(entryPath, signatureFile)` 从签名文件中取出 `<entry>.fsv-sig` 条目，对每个落地文件调用 `EnableCodeSignForFile()` → `ioctl(fd, FS_IOC_ENABLE_CODE_SIGN / FS_IOC_ENABLE_VERITY)`。
   出处：`security_code_signature/README_zh.md`；`interfaces/inner_api/code_sign_utils/src/code_sign_utils.cpp:62-113, 135-174`；常量 `ENABLE_APP_BASE_PATH = "/data/app/el1/bundle"`、`FSV_SIG_SUFFIX = ".fsv-sig"` 见 `.../include/constants.h:25-29`。【官方代码】
   单测路径直接就是 `.../libs/arm64-v8a/libentry.so`、`libc++_shared.so`（`test/unittest/code_sign_utils_test.cpp:55-107`），可佐证 `libs/**.so` 在使能范围内。
3. **运行阶段**：XPM 校验通过 —— 见下一节的 ownerid 策略表（`[应用进程][应用文件] = CHECK`，同 ownerid 即放行）。【官方代码】

> 因此**正确表述**是：随包 `.so` 不是"免疫 XPM"，而是"**它在签名/安装链路上被正确地做成了合法签名的代码文件，且 ownerid 与应用进程一致**"。
> 反例（同一机制的否定证明）：官方 HNP 文档给出的拦截日志，文件路径是 `/data/storage/el1/bundle/entry/resources/resfile/electron` —— 放在 `resources/resfile` 下的 ELF **不走 `libs/` 的 fsv-sig 链路**，直接被 `get signature info failed` 拦下。出处：`_research/repo/docs/hnp-packaging-guide/README.md:22-27`。【官方明确（华为官方文档引用的内核日志）】

---

## 2. 问题 2：XPM 内核管控的具体规则

### 2.1 官方 XPM 说明（OpenHarmony 内核仓 README）

`kernel_linux_common_modules/xpm/README_zh.md` 原文要点【官方明确】：

- 目的：为应用的**二进制和 abc 代码**提供运行时管控，"**强制仅包括合法签名的代码允许分配可执行权限（二进制）**"。
- 功能 1 执行权限检查："通过 hook 特定系统调用函数，XPM 在**代码内存映射操作前，强制验证文件的代码签名合法性，拒绝将未包含合法签名的文件映射到可执行内存**。此外，XPM 还会通过解析文件头，获取文件的代码段信息，**限制应用仅能将已通过签名验签的文件中的数据内容映射到可执行内存**。"
- 功能 2 验签地址区（HAP 拉起时在进程地址空间保留一段范围，映射到该范围的文件都会被校验；ABC 字节码也在其中校验）。
- 功能 3 代码完整性保护（readonly / writetainted 页标记，防运行时篡改）。
- **管控规则（靠 SELinux 标签 `exec_no_sign` / `execmem_anon` 分级）**：
  1. 普通应用类：强制检查二进制可执行文件和 abc 的合法签名，**限制匿名可执行内存**；
  2. webview 类：强制签名校验，**允许匿名可执行内存（JIT）**；
  3. 调测类：**不校验签名**，允许 JIT；
  4. 沙箱类：**不校验签名**，允许 JIT。
- 配置：`CONFIG_SECURITY_XPM=y/n`，调试 `CONFIG_SECURITY_XPM_DEBUG=y`。

### 2.2 只覆盖可执行 ELF，还是也包括 dlopen 的 .so？—— **包括 .so**

内核源码 `xpm/core/xpm_security_hooks.c`（官方仓 `openharmony/kernel_linux_common_modules`，master）【官方代码】：

```c
static struct security_hook_list xpm_hooks[] __ro_after_init = {
    LSM_HOOK_INIT(mmap_region, xpm_mmap_check),      // :379
    LSM_HOOK_INIT(file_mprotect, xpm_mprotect_check), // :380
};
```
```c
is_exec = !xpm_is_anonymous_vma(vma) && (prot & PROT_EXEC);   // :259
if (!((vma->vm_flags & VM_XPM) || is_exec))  return 0;        // :260-261 非 exec 映射直接放行
...
ret = get_exec_file_signature_info(vma->vm_file, is_exec, &info);  // :268
if (ret) { report_mmap_event(GET_SIGN_FAIL, is_exec ? TYPE_ELF : TYPE_ABC, ...); return ret; }  // :269-273
```
- **判定维度是"这次映射是不是 file-backed 且带 PROT_EXEC"，与 ELF 的 `e_type` 无关。**
  `dlopen` 一个 .so 时 ld.so 会用 `mmap(PROT_READ|PROT_EXEC)` 映射其代码段 → `is_exec = true` → 走**完全相同的校验路径**。`mprotect(..., PROT_EXEC)` 也被 `file_mprotect` 钩子覆盖。
- XPM 解析 ELF 时按 **`PF_X` 程序头**收集代码段（`xpm/validator/elf_code_segment_info.c:81-157`），可执行文件与共享库一视同仁。
- 校验四连（`xpm_check_signature`，:275-296）：`xpm_validate_signature`（数据须在 fs-verity 已验证范围内）→ `xpm_check_code_segment`（被映射区间必须落在 ELF 的某个 `PF_X` 段内，**否则即使整文件有签名也拒绝**）→ `xpm_check_ownerid`。

**ownerid 策略表**（`xpm_security_hooks.c:30-48`，行=进程、列=文件）【官方代码】：

| 进程\文件 | SYSTEM | APP | DEBUG | SHARED | COMPAT |
| --- | --- | --- | --- | --- | --- |
| SYSTEM | ALLOW | – | – | – | – |
| **APP** | **ALLOW** | **CHECK（须同 ownerid）** | DENY(未初始化=0) | **ALLOW** | – |
| DEBUG | ALLOW | – | ALLOW | ALLOW | – |
| COMPAT | ALLOW | – | – | – | ALLOW |
| EXTEND | 全 ALLOW | | | | |

- `FILE_OWNERID_SYSTEM` 来自 **dm-verity**（系统分区）或 fs-verity 描述符；`FILE_OWNERID_APP` 来自证书链校验后的 `sinfo->ownerid`（`code_sign/verify_cert_chain.c:70-108`）。
- **推论**：a) 系统库（/system）对应用进程是 ALLOW；b) 应用自己的 `libs/*.so` 是 `[APP][APP]` → 只要 ownerid 一致就放行；c) **任何既非 dm-verity、又非 fs-verity、且自身没有可解析 `.codesign` 块的文件 → `FILE_SIGNATURE_INVALID` → 直接失败**（`xpm/validator/exec_signature_info.c:275-291, 559-569`）。
- 开发者模式下自签名的 ELF 有一条"就地使能 fs-verity"的通道：`check_exec_file_is_verity()` 在 `is_exec && elf_file_enable_fs_verity(file) == 0` 时返回 `FILE_SIGNATURE_FS_VERITY`；而 `elf_file_enable_fs_verity()` 要求 `get_developer_mode_state() == STATE_ON`，否则打日志 "developer mode off, elf not allowed to execute"（`code_sign/code_sign_elf.c:206-217`）。【官方代码】

### 2.3 报错特征的确切含义

`xpm/core/xpm_report.h:24-34` 定义事件字符串与 code_type 枚举【官方代码】：

```c
#define ANON_EXEC            "anon executed"
#define GET_SIGN_FAIL        "get signature info failed"   // 取签名信息失败 = 既非 dm-verity 也非 fs-verity（且无法动态使能）
#define SIGN_INVALID         "invalid signature"
#define DATA_MMAP_CODE       "data mmap code"              // 数据段被当代码映射
#define OWNERID_INCONSISTENT "ownerid inconsistent"
#define INTEGRITY_RO         "code tampered"
#define INTEGRITY_WT         "data executed"
enum xpm_code_type { TYPE_ABC = 0, TYPE_ELF, TYPE_ANON };   // 报告里打印为 "ABC"/"ELF"/"ANON"
```

| 日志片段 | 确切含义 |
| --- | --- |
| `"event_type": "get signature info failed"` | `get_exec_file_signature_info()` 失败：文件既不在 dm-verity 分区、又没有 fs-verity 信息、也没有可用的 `.codesign` 块 |
| `"code_type": "ELF"` | 本次是"文件 + PROT_EXEC"映射（`is_exec==true`）；为 `ABC` 时表示落在 XPM 验签地址区的非 exec 映射（abc 字节码） |
| `"code_type": "ANON"` | 匿名可执行内存申请（JIT），对应 `ANON_EXEC` |
| `"filename": "/data/storage/el1/bundle/entry/resources/resfile/electron"` | 被拦文件。注意它在 `resources/resfile/` 下 —— 不参与 `libs/` 的 fsv-sig 使能 |
| `"vm_prot": 5` | `PROT_READ(1)|PROT_EXEC(4)`，即代码映射（`xpm_report.c:23` `PROT_MASK`） |
| `"vm_pgoff"/"vm_size"` | VMA 的文件偏移/大小，用来判断是否落在 `PF_X` 段内（`DATA_MMAP_CODE` 证据） |
| `"p_id_type"/"p_ownerid"/"f_id_type"/"f_ownerid"` | 进程/文件 ownerid 四元组，`OWNERID_INCONSISTENT` 时用来定位不匹配 |

字段拼装见 `xpm/core/xpm_report.c:91-116`（`set_mmap_content`）、事件常量 `EVENT_MMAP = 1011009112`（`xpm_report.h:45`）。【官方代码】

### 2.4 `xpm_mode` 关掉 XPM 是否也影响 .so 加载？—— **是，全局放开**

- `xpm/core/xpm_debugfs.c`：
  ```c
  static uint8_t xpm_mode = XPM_PERMISSIVE_MODE;      // :13 默认宽松
  int xpm_ret(int ret) { return xpm_mode == XPM_ENFORCE_MODE ? ret : 0; }  // :16-18
  debugfs_create_u8("xpm_mode", 0600, xpm_dir, &xpm_mode);                 // :28
  ```
  而 `xpm_common_check()` 最终 `return xpm_ret(ret);`（`xpm_security_hooks.c:362`）→ **非 enforce 模式下所有 mmap/mprotect 校验失败都被清零**，`.so` 的 `dlopen` 与二进制的 `exec` 一起放开。【官方代码】
- 路径差异（重要）：
  - 官方 **userspace 代码签名部件**里写死的常量是 **`/proc/sys/kernel/xpm/xpm_mode`**（`security_code_signature/.../constants.h:28`，用于 `InPermissiveMode()` 判定 `"0"`），这也是华为官方 HNP 文档给的调试命令路径（`_research/repo/docs/hnp-packaging-guide/README.md:29`）。【官方明确】
  - 而 OpenHarmony **master 内核源码**里 `xpm_mode` 是 **debugfs** 节点（`/sys/kernel/debug/xpm/xpm_mode`）。两者路径不一致，说明不同版本/不同产品（HarmonyOS 闭源内核 vs OpenHarmony 主线）实现有差异 —— **以你手上设备实际存在的节点为准**。【官方代码】+【推测】
- **仅调试**：官方文档明确"仅供调试"；`CONFIG_SECURITY_XPM` 才是编译期开关。`/proc/sys/kernel/xpm/xpm_mode` 需要 root/主用户，重启失效。【官方明确 + 社区实践】

---

## 3. 问题 3：官方《应用程序包集成 bin 文件（PC/2in1）》（hap-bin）到底讲什么

### 3.1 抓取结论（先说实话）

- `https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hap-bin` 与英文版 `https://developer.huawei.com/consumer/en/doc/harmonyos-guides/hap-bin`：`curl` 均返回 HTTP 200 但**正文为空壳**（JS 渲染，仅 1772 字节 HTML，无任何 `hnp/executableBinaryPaths/bin文件` 字样）；`device.harmonyos.com` 镜像同样是空壳；`r.jina.ai` 直连失败。
- 在 `openharmony/docs` 仓（已做 sparse clone 到 `zh-cn/application-dev`，2.2 GB）全文检索 **没有 `hap-bin.md`**；该页是华为侧（HarmonyOS）专有文档。
- **因此：该页的原文摘录 = 未找到。** 下面是 OpenHarmony 仓内**同一机制**的官方正文（可视为该页的技术等价物），并附官方 Sample 佐证。

### 3.2 等价官方内容：`executableBinaryPaths`（应用内可执行二进制文件）

`zh-cn/application-dev/quick-start/module-configuration-file.md:1326-1353`【官方明确】：

> ## executableBinaryPaths标签
> 标识应用内可执行二进制文件的路径信息。**从 API version 24 开始**，支持该标签。
>
> | 属性名称 | 含义 |
> | --- | --- |
> | path | 标识可执行文件的路径。该路径是**相对路径，必须以 `libs/{abi}/` 为前缀**，其中 `{abi}` 为设备 CPU 架构类型（如 arm64-v8a、x86_64、armeabi-v7a），即**可执行二进制文件必须配置在 `libs/{abi}/` 目录下**。 |
>
> ```json5
> "executableBinaryPaths": [ { "path": "libs/arm64-v8a/test.bin" } ]
> ```

配套约束（都是官方文档）：
- **必须"解压模式"**：`packing-tool.md` 错误码 **10012055**："配置了 executableBinaryPaths 且存在二进制文件，但配置为以不解压 libs 库的方式进行安装"→ 需保证 `extractNativeLibs` **或** `compressNativeLibs` 至少一项为 `true`（`zh-cn/application-dev/tools/packing-tool.md:1620-1634`）。
- **设备/安装校验**：`bm-tool.md` 错误码 **9568449** `error: check bin file failed.`，原因即"配置了 executableBinaryPaths 但未配置解压模式"或"该设备不支持安装配置了该标签的应用"，处理步骤为"设置 `compressNativeLibs=true`"或"更换为 PC/2in1 设备"（`zh-cn/application-dev/tools/bm-tool.md:3431-3448`）。
- 官方 Sample（`HarmonyOS_Samples/guide-snippets` → `bmsSample/ModuleConfigurationFile05/entry/src/main/module.json5`）**在同一份 module.json5 里同时示范 `hnpPackages` 与 `executableBinaryPaths`**，并在注释里写："这里配置保证编译通过，实际开发过程请参考：`https://gitcode.com/openharmony/startup_appspawn/blob/master/service/hnp/README_zh.md`"。【官方 Sample 源码】

### 3.3 与 HNP 的关系

| 维度 | `executableBinaryPaths`（bin 文件集成） | HNP（`hnpPackages`） |
| --- | --- | --- |
| 载体 | 可执行文件直接放 HAP 的 `libs/{abi}/` 下 | `hnp/{abi}/*.hnp` 独立包（`hnpcli pack` 生成），HAP 内声明 |
| 声明 | `module.json5.executableBinaryPaths`（API 24+） | `module.json5.hnpPackages`（`package`/`type` public\|private/`independentSign`，API 23+ 支持独立签名） |
| 安装位置 | 随 HAP 解压到 `bundleCodeDir/libs/arm64/` | public → `/data/service/hnp/<name>.org/<name>_<ver>`（物理 `/data/app/el1/bundle/<userid>/hnppublic`）；private → `/data/app/<bundleName>/...`（物理 `/data/app/el1/bundle/<userid>/hnp`）；环境变量 `HNP_PUBLIC_HOME` / `HNP_PRIVATE_HOME` |
| 典型用途 | 零散的小工具 bin | Python/Node/**Java** 等**整套 Native 软件包**（官方 README 原句："例如Python、node、**java**等Native软件包"） |
| 签名覆盖 | HAP 签名时 `isNativeFile()` 命中 `libs/` 前缀 → 同样进 `SoInfoSegment` | HAP 签名时 `signNativeHnps()` 另行处理 `hnp/**.hnp`；public 类型使用 `getPublicHnpOwnerId(profileContent)` 的 ownerid |

出处：`openharmony/startup_appspawn/service/hnp/README_zh.md`（官方）；`CodeSigning.java:273-302`；`module-configuration-file.md:1092-1123`。【官方明确】

> 一句话：**两者都是"PC/2in1 上让应用分发并运行原生程序"的官方路径**；hap-bin 走轻量的 `libs/`，HNP 走独立的包管理器式分发。HNP 是当前 Electron/Java 这类"整包 Native 运行时"的官方方案。（本地已有完整流程文档：`_research/repo/docs/hnp-packaging-guide/README.md`；注意其中 `HNP_PRIVATE_HOME`/`HNP_PUBLIC_HOME` 两个环境变量名与官方 README **写反了**，以官方 README 为准。）

---

## 4. 问题 4：二进制签名工具 & 二进制证书

### 4.1 工具与流程（官方文档）

`zh-cn/application-dev/tools/binary-sign-tool.md`（OpenHarmony 官方，等价于华为《二进制签名工具》）【官方明确】：

- 定位："用于对二进制文件进行代码签名，支持通过命令行的方式对**标准 ELF 文件**进行代码签名或打印已签名 ELF 的权限、证书信息。"
- 三种获取形态：Linux（SDK `toolchains/lib/binary-sign-tool`）、**OpenHarmony PC/2in1（从应用市场装 DevBox，终端里直接 `binary-sign-tool`）**、Java（API 24+ 的 `binary-sign-tool.jar`，需 JDK 8+）。
- 命令：`help` / `sign` / `display-sign`。
- `sign` 关键参数：`-keyAlias -keyPwd -appCertFile(证书链) -profileFile(p7b) -profileSigned -signAlg(SHA256withECDSA/SHA384withECDSA) -keystoreFile -keystorePwd -inFile -outFile -moduleFile(权限 module.json) -selfSign`。
- 自签名：`binary-sign-tool sign -inFile unsigned-elf -outFile signed-elf -selfSign 1` → 输出 `write code sign data success.`
- `display-sign` 输出：`permission is not found` / `code signature is not found` / `code signature is self-sign` / 证书链。

### 4.2 签名的对象：**可执行二进制 + 动态库 .so 都支持，但 .so 不带权限段**

源码证据（`developtools_hapsigner/binary_sign_tool/hap/sign/src/sign_elf.cpp`）【官方代码】：

```cpp
bool SignElf::isExecElf(ELFIO::elfio& reader) {                 // :119
    if (eType == ELFIO::ET_EXEC) return true;                   // :122 可执行
    if (eType == ELFIO::ET_DYN && reader.get_entry() > 0) return true; // :125 PIE 可执行
    return false;                                               // ET_DYN 且 entry==0 ⇒ 普通 .so
}
// :185-188  “check elf bin or so”，非 exec ELF 直接 return true（跳过 profile/permission 段）
```
而 `SignElf::Sign()`（:34-67）**无条件**执行 `WriteCodeSignBlock()`（加 4K `.codesign` 段）与 `GenerateCodeSignByte()`（生成 merkle tree + fs-verity 描述符 + PKCS7 代码签名）。
⇒ **`binary-sign-tool` 能签 .so，签完也有代码签名；只是 .so 不会被写入 profile/权限段** —— 这与社区实测结论"调试证书签名的二进制可执行程序可以声明权限，但**共享库不支持声明权限**"完全吻合。【官方代码 + 社区实践】

另外，**应用包签名工具（hap-sign-tool.jar / hapsigntool）本身也能签 ELF/bin**：`sign-app -inForm elf|bin`，且 `-signCode` 说明为"默认对 **hap、hsp、hqf、elf** 开启代码签名"（`zh-cn/application-dev/security/hapsigntool-guidelines.md:201-218`；`hapsigntool-overview.md:14`："签名工具当前仅支持对 hap、hsp、hqf 格式的应用包和二进制工具执行代码签名"）。【官方明确】

### 4.3 申请二进制证书

- **官方入口**：AppGallery Connect 文档《申请二进制证书》— `https://developer.huawei.com/consumer/cn/doc/App/agc-help-binary-cert-0000002408063605`（"管理证书、指纹"章节）。（页面正文未抓取到，仅确认存在与标题）【官方明确（URL/标题层面）】
- **证书等级与差异**（社区实测整理，与官方工单答复一致）【社区实践】：
  | 类型 | 证书 | 分发范围 | 能否声明权限 |
  | --- | --- | --- | --- |
  | 二进制证书签名 | 华为颁发（面向认证开发者） | 无限制 | ✅ |
  | 调试证书签名 | 华为颁发调试证书 | 仅 `.permission` 中 `device-ids` 指定的设备，且需开发者模式 | ✅（**共享库不支持**） |
  | 自签名 adhoc | 无需证书 | 本机加载运行 | ❌（写了也不生效） |
  另注：**DevEco clang 交叉编译产物默认是 `adhoc` 类型**（不是 debug bin）。
- **应用侧加载"非随包签名"库的官方许可**：受限权限
  **`ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY`** —— 官方描述："**允许应用加载二进制证书签名的共享库**"；权限级别 `system_basic`，授权方式 `system_grant`，支持设备 **PC/2in1**，起始版本 **API 20**，"在 API 20-21，该权限面向系统应用开放；**从 API 22 开始，面向普通应用开放**"。
  出处：`zh-cn/application-dev/security/AccessToken/restricted-permissions.md:983-993`。【官方明确】
  受限权限申请方式（官方）：通过 ACL 跨级别申请（把 `HarmonyAppProvision` 的 `bundle-info.apl` 声明为 `system_basic` 及以上并重新签名，**仅调试可用**；商用需在应用市场申请发布证书与 Profile）。【官方明确】
- 二进制签名的 `.permission` 段（`-moduleFile`）内可写：`ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY`、`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`、`ohos.permission.kernel.IGNORE_LIBRARY_VALIDATION`、`ohos.permission.kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`、`ohos.permission.INHERIT_PARENT_PERMISSION`；调试证书还需要 `debug-info.device-ids`（UDID，`hdc shell bm get --udid`）。【社区实践】

### 4.4 签名后的文件**放在哪里**才能被加载

三条**可加载**通路（这也是本报告第 8 节对照表的核心）：

1. **放进 HAP 的 `libs/{abi}/`**（推荐）：HAP 签名 → `SoInfoSegment` → 安装时 fs-verity 使能 → XPM 放行。文件类型不限（.so、可执行 bin 都可以，bin 需配 `executableBinaryPaths` + 解压模式）。
2. **打进 HNP 包**（`hnp/{abi}/*.hnp`）：HAP 签名时 `signNativeHnps()` 单独签名；安装后位于 `/data/service/hnp/...`（public）或 `/data/app/<bundleName>/...`（private），可被 `execv` 拉起或被 dlopen。
3. **放在沙箱任意路径 + 二进制证书签名 + `ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY`**（PC/2in1，API 22+ 普通应用）：由 `EnforceCodeSignForFile(path)` 读取 ELF 自带的 `.codesign` 块并就地使能 fs-verity（`code_sign_utils.cpp:298-320`；`ElfCodeSignBlock(V1)` 解析）。
   注意：该接口的路径校验常量是 `ENABLE_APP_BASE_PATH = "/data/app/el1/bundle"`，因此**能自动使能的位置仍在应用安装目录体系内**；沙箱 `/data/storage/el1/bundle/...` 即映射到该物理路径。【官方代码】+【推测（对"任意路径"需以真机实测为准）】

**不能加载**的位置见第 8 节。

---

## 5. 问题 5：HarmonyOS 的 libc —— **musl**

### 5.1 官方依据

1. 官方 manifest 里 libc 仓就是 musl：`openharmony/manifest/ohos/ohos.xml:101`
   `<project ... name="third_party_musl" path="third_party/musl" .../>`；同一份 manifest 中 **`glibc` 命中 0 次**。【官方明确】
2. 官方文档 `zh-cn/application-dev/reference/native-lib/musl.md:11`：
   > "**OpenHarmony采用musl作为C标准库**，musl库是一个轻量，快速，简单，免费的开源libc库…… musl与glibc的差异点请参考 musl与glibc功能对比。"
   版本："1.2.0；从 OpenHarmony 4.0 起 1.2.3；从 OpenHarmony 5.0 起 1.2.5"。`libc/libm/libdl` 组合实现 C11；**libdl 是链接，dlopen 等实际定义在 libc 中**。【官方明确】
3. 官方文档中出现真实加载器路径：`/system/lib/ld-musl-aarch64.so.1`、`/system/bin/ld-musl-aarch64.so.l`（`zh-cn/application-dev/dfx/cppcrash-guidelines.md:279,635`；`arkts-stability-freeze-issues.md:18`）。【官方明确】
4. `third_party/musl/README_zh.md` 列出 OpenHarmony 对 musl 的增强（加载器命名空间、dlclose 真卸载、symbol-versioning、**dlopen 可直接加载 zip 包内未压缩文件** 等）。【官方明确】

### 5.2 glibc（Ubuntu aarch64）编译的 .so 拿到鸿蒙会发生什么

**先说结论（分两层，别混淆）：**

- **第一层：签名/XPM** —— 如果这个 .so 不在 HAP 的 `libs/` 里，它**先**会被 XPM 拦（`get signature info failed`）。
- **第二层：ABI** —— **即使**你把它放进 `libs/` 走通了签名链，**glibc 产物在 musl 系统上也加载不了**。二者 ABI 不兼容：glibc 的 `.so` 依赖 `ld-linux-aarch64.so.1` 与 `GLIBC_2.x` 版本化符号、`libstdc++.so.6`、glibc 专有 TLS/stdio/locale 行为；OpenHarmony 既没有 glibc，也没有这些 soname/版本符号。

**具体报错特征**（musl `ldso/dynlink.c` 的原文格式串，`dlopen` 时经 `error_impl → __dl_vseterr` 进入 `dlerror()`；非 runtime 时直接打到 stderr）【官方代码】：

| 场景 | musl 报错串（源码行） |
| --- | --- |
| 直接 `dlopen` 打不开/映射失败 | `Error loading shared library %s: %m`（dynlink.c:2235-2237）→ 例如 `...: No such file or directory` / `...: Operation not permitted`（**后者就是被 XPM 拦的形态**） |
| 依赖的 soname 找不到（DT_NEEDED） | `Error loading shared library %s: %m (needed by %s)`（dynlink.c:1329-1330）→ 例如 `needed by libfoo.so`，缺 `libstdc++.so.6` / `ld-linux-aarch64.so.1` |
| 重定位时符号找不到（版本化符号 `GLIBC_2.17` 之类） | `Error relocating %s: %s: symbol not found`（dynlink.c:446-447） |
| ELF 头不合法 | `invalid ELF header` |

**注意**：`-EPERM`（`Operation not permitted`）是 XPM 拦截的典型 errno，**与 ABI 无关**；而 `No such file or directory`（找不到依赖）才是 ABI/加载器缺失的典型。两者要分清。

> 【推测】部分：OpenHarmony **官方没有**一篇文档专门描述"glibc 产物拿到鸿蒙上的报错"，以上报错串来自官方 musl 源码 + 通用 musl/glibc 差异。**未找到**官方对 glibc 产物的报错说明。
> 正确做法：用 **OHOS NDK（`--target=aarch64-linux-ohos`，musl）** 重编。本地 HNP 文档给出的工具链配置里显式带 `CLANG --target=aarch64-linux-ohos`、`CFLAGS="-fPIC -D__MUSL__=1"`（`_research/repo/docs/hnp-packaging-guide/README.md` 第 150 行附近；同仓 `docs/api/index.md` 里的产物目录名也是 `musl_64`）。【官方（Electron CPF 官方仓）+ 本地】

---

## 6. 问题 6：系统自带哪些 .so；java 进程能否直接用系统库

### 6.1 `/system/lib64` 确实有系统库，但**有命名空间墙**

官方 `c-cpp-overview.md:28-48`（"musl libc动态链接器 → 动态库加载命名空间隔离"）【官方明确】：

> - **default ns**：动态链接器启动时默认创建，可以搜索 `/system/lib{abi}; /vendor/lib{abi}` 等系统目录路径下的 so。
> - **ndk ns**：默认创建，搜索 **`/system/lib{abi}/ndk`** 目录下的 so，主要是暴露 NDK 接口的 so。
> - **app ns**：应用启动时创建，搜索路径一般是应用的安装路径（可能为沙箱路径），即可加载应用的 so。
> - 规则：1. default ns 和 ndk ns 可以互相访问全部 so，**不能访问 app ns 的 so**；2. **app ns 能访问 ndk ns 的全部 so，不能访问 default ns 的 so**。

官方 `musl.md:39` 更直白："动态加载器支持命名空间隔离能力，**应用可以 dlopen 加载的动态库受系统命名空间限制（比如，无法打开系统侧动态库）**"。【官方明确】

⇒ **普通应用（以及应用拉起的 java 进程）不能用 `dlopen` 直接加载 `/system/lib64/*.so`；只能用 `/system/lib64/ndk/*.so`（NDK 库），或自带/走 HNP。**
（反过来说：官方文档中的系统库示例 `/system/lib/ld-musl-aarch64.so.1`、`/system/lib/ark_jsruntime.so`、`/system/lib/platformsdk/libace_napi.z.so` 都是 default ns 侧，应用只能通过框架接口间接使用。）
【推测】对于通过 HNP 分发的独立进程（例如 HNP 里的 JDK），其加载器命名空间归属需要真机实测；**未找到**官方说明。

### 6.2 `/system/lib64/libzstd.so` 到底有没有？

- **未找到**任何官方清单或文档能证明存在 `/system/lib64/libzstd.so`。
- 反向证据：OpenHarmony manifest（`ohos/ohos.xml`）中 `grep zstd` = **0**；gitee/gitcode 上也不存在 `openharmony/third_party_zstd` 仓；`openharmony/docs` 全量 `zh-cn/application-dev` 中 `zstd` 只出现在 hilog 落盘压缩算法选项里（`zh-cn/application-dev/dfx/hilog.md:418`："压缩方式可以为 zlib、zstd、none"）。【官方明确（"没有证据"本身是明确的）】
- 结论：**不要假设系统里有 `libzstd.so`**；需要就把 zstd 静态/动态编进自己的 `libs/`（或打进 HNP）。
- 即便设备上确实存在，**普通应用也 dlopen 不到**（见 6.1 命名空间规则）。

### 6.3 顺带：官方文档确认存在的系统侧 so 例子

| 路径 | 出处 |
| --- | --- |
| `/system/lib/ld-musl-aarch64.so.1`（及 `/system/lib/ld-musl-arm.so.1`） | `dfx/cppcrash-guidelines.md:279,330,366` |
| `/system/lib/platformsdk/libace_napi.z.so` | `dfx/cppcrash-guidelines.md:888` |
| `/system/lib/ark_jsruntime.so` | `dfx/cppcrash-guidelines.md:888` |
| `/system/lib/module/arkcompiler/stub.an` | 同上 |
| `/system/lib64/ndk/…`（NDK ns，应用可用） | `napi/c-cpp-overview.md:39` |

---

## 7. 未找到 / 无法确证的部分（如实列出）

1. **`hap-bin` 页面正文原文**：中英文页面均为 JS 空壳，OpenHarmony docs 无同名文件 → **未找到**（已用等价官方机制 `executableBinaryPaths` 补全）。
2. **官方文档对 XPM 的任何正式描述**：OpenHarmony `zh-cn/application-dev` 全量检索 `xpm` 无相关内容；XPM 只有内核仓 README + 源码 → "**dlopen .so 会被 XPM 拦**"这一条**没有官方文档明文**，是**源码级结论**。
3. **`xpm_mode` 的确切 sysctl 路径**：userspace 写 `/proc/sys/kernel/xpm/xpm_mode`，OpenHarmony master 内核用 debugfs `/sys/kernel/debug/xpm/xpm_mode` → 两者不一致，**以真机为准**。
4. **二进制证书的具体申请条件/审核标准**：AGC 页面正文未抓取到（`agc-help-binary-cert-0000002408063605`），只有标题与社区转述（"面向华为认证的已知开发者，个人开发者基本拿不到"）。
5. **glibc 产物在鸿蒙上的官方报错说明**：**未找到**。
6. **`/system/lib64` 的完整文件清单**：**未找到**官方发布的清单（官方文档只在崩溃栈示例里零散出现若干路径）。
7. **HNP 独立进程（如 HNP 内 JDK）的加载器命名空间归属**：**未找到**说明。

---

## 8. 加载 .so 的合规路径对照表（核心交付）

| # | .so / bin 放置位置 | 能否被 dlopen/exec | 前提与机制 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | **HAP `libs/{abi}/*.so`**（工程 `libs/arm64-v8a/`） | ✅ **推荐** | HAP 签名时 `isNativeFile()` 命中 `libs/` → 进 `SoInfoSegment`；安装时 `EnforceCodeSignForApp` 用 `.fsv-sig` 使能 fs-verity；文件 ownerid=APP 且与进程一致 → XPM `[APP][APP]=CHECK` 通过。设备路径 `/data/storage/el1/bundle/libs/arm64/` | 官方代码：`CodeSigning.java:378-408`、`code_sign_utils.cpp:62-113`、`xpm_security_hooks.c:30-48`；官方文档：`cppcrash-guidelines.md:766` |
| 2 | **HAP `libs/{abi}/*.bin`（可执行文件）** | ✅ | 额外需 `module.json5.executableBinaryPaths`（**API 24+**，路径必须以 `libs/{abi}/` 为前缀）且**必须解压模式**（`extractNativeLibs`/`compressNativeLibs` 至少一个 true）；设备须 PC/2in1 | 官方文档：`module-configuration-file.md:1326-1353`、`packing-tool.md:1620-1634`、`bm-tool.md:3431-3448` |
| 3 | **HNP 包 `hnp/{abi}/*.hnp`** | ✅ | HAP 签名时 `signNativeHnps()` 单独签名（public 用 `getPublicHnpOwnerId`）；安装释放到 `/data/service/hnp/<name>.org/<ver>`（public）或 `/data/app/<bundleName>/...`（private）；`hnpPackages` 声明 `public/private`，`independentSign` 支持独立签名（API 23+）；HNP 内 lib 需 `-Wl,-rpath=$ORIGIN/../lib -Wl,--disable-new-dtags`；文件权限须含 others 执行位 | 官方：`appspawn/service/hnp/README_zh.md`、`module-configuration-file.md:1092-1123`、`CodeSigning.java:273-302`；社区：CSDN/HarmonyOS 社区 |
| 4 | **应用沙箱数据目录**（`filesDir`/`cacheDir`/`tempDir`，运行期写入或下载的 .so） | ❌ **默认被拦** | 该文件既无 dm-verity 也无 fs-verity（`ENABLE_APP_BASE_PATH` 只覆盖 `/data/app/el1/bundle`）→ `FILE_SIGNATURE_INVALID` → 内核 `get signature info failed` → `mmap(PROT_EXEC)` 返回 EPERM → dlopen 失败 | 官方代码：`exec_signature_info.c:275-291`、`xpm_security_hooks.c:259-273`；官方日志样例：`_research/repo/docs/hnp-packaging-guide/README.md:22-27` |
| 5 | **HAP `resources/resfile/` 内的 ELF/.so** | ❌ | 不在 `libs/` 前缀内，不参与 fsv-sig 使能。官方 HNP 文档记录的实际拦截案例就是 `.../resources/resfile/electron` | 官方文档：`_research/repo/docs/hnp-packaging-guide/README.md:22-27`（Electron CPF 官方仓） |
| 6 | **沙箱内任意路径 + 二进制证书签名的 .so** | ⚠️ 有条件 ✅ | 需受限权限 **`ohos.permission.kernel.LOAD_INDEPENDENT_LIBRARY`**（system_basic/system_grant/**PC/2in1**/API 20+，API 22 起普通应用可申请，需 ACL 或应用市场申请）；.so 须用 `binary-sign-tool` + 二进制证书签名（自带 `.codesign` 块），运行时由 `EnforceCodeSignForFile` 就地使能 fs-verity | 官方文档：`restricted-permissions.md:983-993`；官方代码：`code_sign_utils.cpp:298-320` |
| 7 | **`/system/lib64/*.so`（default ns 系统库）** | ❌ | 命名空间隔离：app ns 不能访问 default ns 的 so | 官方文档：`c-cpp-overview.md:28-48`、`musl.md:39` |
| 8 | **`/system/lib64/ndk/*.so`（NDK ns）** | ✅ | app ns 可访问 ndk ns 全部 so | 官方文档：`c-cpp-overview.md:39,46` |
| 9 | **`/data/local/tmp/`** | ❌ | 社区在 OpenHarmony-7.0.0.105/API 26 实测：`Permission denied`（`code_protect` 读不了该 SELinux label）；**与 Android 直觉相反** | 社区实践（ystyle.top 实测） |
| 10 | **本机调试：自签名（adhoc）bin 直接执行** | ⚠️ | 需 `binary-sign-tool sign -selfSign 1` + `chmod 755`（工具沿用 outFile 旧权限位）；**adhoc 不能声明权限**；强沙箱应用（无 `ohos.permission.CUSTOM_SANDBOX`）拉起独立二进制需要 `ALLOW_EXTERNAL_NATIVE_CODE`，且仍不支持 adhoc | 社区实践 + 官方 `binary-sign-tool.md` |
| 11 | **本机调试：调试证书签名 bin** | ⚠️ | 需 `.permission` 段且 `debug-info.device-ids` 填运行设备 UDID，设备须开发者模式；**共享库(.so)不支持声明权限**；实测建议用自己申请的证书（DevEco 自动签名下发的那张在部分设备被内核 PKCS7 校验拒绝） | 社区实践 |
| 12 | **关闭 XPM 后加载未签名 .so** | ⚠️ 仅调试 | `echo 0 > /proc/sys/kernel/xpm/xpm_mode`（或 debugfs 版本 `/sys/kernel/debug/xpm/xpm_mode`）；`xpm_ret()` 清零所有校验失败，`exec` 与 `dlopen` 一起放开；重启失效、需 root | 官方文档 + 官方代码：`xpm_debugfs.c:16-18`、`constants.h:28` |

**一句话决策树**：
`.so` 要能加载 → 优先**打进 HAP 的 `libs/{abi}/`**（自动进入代码签名链）；整包 Native 运行时（Python/Node/**Java**）→ **打 HNP**；实在要运行期加载非随包库 → **二进制证书签名 + `LOAD_INDEPENDENT_LIBRARY`**（PC/2in1，门槛高）；仅本机调试 → **自签名 + （必要时）临时关 XPM**。

---

## 9. 证据文件清单（已落盘，可离线核查）

`_research/xpm-research/evidence/`：

| 文件 | 说明 |
| --- | --- |
| `openharmony_xpm_README_zh.md` | `kernel_linux_common_modules/xpm/README_zh.md` 官方原文（XPM 三大功能 + 四类管控策略） |
| `xpm_security_hooks.c` / `xpm_report.h` / `xpm_debugfs.c` / `elf_code_segment_info.c` / `exec_signature_info.c` | XPM 内核 hook、事件字符串、xpm_mode、ELF `PF_X` 段解析、verity 判定 |
| `verify_cert_chain.c` | ownerid 如何由证书链得出 |
| `codesign_README_zh.md` / `codesign_code_sign_utils.cpp` / `codesign_constants.h` / `codesign_code_sign_utils_in_c.h` | 官方代码签名部件（安装期使能 fs-verity；`/proc/sys/kernel/xpm/xpm_mode`；`.fsv-sig`；`FILE_ALL/FILE_SELF/FILE_ENTRY_ONLY`） |
| `hapsigner_CodeSigning.java` | HAP 签名自动为 `libs/**`、`*.an`、`hnp/**` 生成代码签名 |
| `binary_sign_tool_sign_elf.cpp` | 二进制签名工具的 `isExecElf()`（.so 可签但无权限段） |
| `openharmony_binary-sign-tool.md` | 官方《二进制签名工具》全文 |
| `openharmony_appspawn_hnp_README_zh.md` | 官方 HNP 指南（含 `independentSign`、安装路径、环境变量、规格限制） |
| `ohdocs_module-configuration-file.md` | 官方 module.json5（`hnpPackages`、`executableBinaryPaths`、`libIsolation`） |
| `ohdocs_c-cpp-overview.md` | 官方 musl 动态链接器命名空间隔离规则 |
| `ohdocs_musl.md` | 官方 libc = musl 说明 |
| `ohdocs_packing-tool.md` / `ohdocs_hapsigntool-overview.md` | 打包/签名约束与错误码 |

**工作区内的其他直接相关材料**：
- `_research/repo/docs/hnp-packaging-guide/README.md`（Electron CPF 官方 HNP 指南；XPM 日志与 `xpm_mode` 命令出自 `:22-33`）
- `_research/repo/docs/electron-loading-addon-guide/README.md`（`node_sqlite3.node` 放 `libs/arm64-v8a/` 的完整实操）
- `research/hnp打包与fork指导文档.md`、`鸿蒙PC迁移实施手册.md:1978,2257,2665,2798,3190`
- `project-template/electron/libs/arm64-v8a/`（本工程实际 .so 布局）
