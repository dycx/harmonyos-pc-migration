# 在 HarmonyOS PC/NEXT 上运行 Java 后端（JDK 21 + Spring Boot）可行性调研报告

> 调研时间：2026 年 8 月（以网络公开资料为准）
> 调研方法：中英文多轮 web 检索 + 公开网页抓取（华为官方支持页、openEuler 官方页、Spring 官方文档源文件、GitHub 仓库、IT 之家、社区论坛/博客等）
> 结论级别标注：✅ 已证实（官方/一手来源）｜🟡 多方佐证但非官方｜⚠️ 推测/待实测

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 |
|---|---|
| 鸿蒙 PC 上能否**直接**跑 JDK + Spring Boot？ | ✅ **能跑 JDK 17**（毕昇 JDK 17 鸿蒙版，应用市场一键安装，`javac`/`java` 可编译运行标准 Java 程序、可 `-cp` 引三方 JAR）。**JDK 21/25 无官方支持路线图**。**未找到"直接在鸿蒙 PC 上用毕昇 JDK 跑通完整 Spring Boot（监听端口提供服务）"的公开实测案例**，属于高风险、需自行验证的路径（见 2.a）。 |
| 用虚拟机/Linux 子系统跑 JDK 21 + Spring Boot？ | ✅ **可行**，且是当前"在鸿蒙 PC 本机跑完整后端"的最优路径。官方提供**融合开发引擎**（Linux 子系统，HarmonyOS 6.0/6.1，当前仅支持 openEuler）；社区已验证用第三方虚拟机（OSEasy 等）装 **ARM64 Debian 12**。两者都能装 JDK 17/21 后 `java -jar` 跑 Spring Boot。坑很多（见 2.b）。 |
| 后端放远程服务器，鸿蒙 App 网络调用？ | ✅ **最主流、最省事**。鸿蒙 NEXT 用 `@kit.NetworkKit` 的 http 模块发请求；需 `ohos.permission.INTERNET` 权限；明文 HTTP 在 API 10+ 需开 `cleartextTraffic` 配置（且各版本配置位置不同）；生产建议 HTTPS。 |
| 用华为 PaaS/Serverless 跑 Spring Boot？ | 🟡 **AGC 云函数不行**（仅 Java 1.8，FaaS handler 模型，无法跑常驻 Web 服务）。**华为云 FunctionGraph 支持 Java 8/11/17/21**（21 仅限利雅得/伊斯坦布尔区域），但同样是函数模型。**跑完整 Spring Boot 应使用华为云 ECS/CCE**（普通 Linux 服务器/容器，任意 JDK 版本）。 |
| Spring Boot 3.x 对 JDK 的要求？ | ✅ 官方文档原文：**所有 3.x 最低 Java 17**。3.0–3.2 兼容至 Java 21；3.3 至 23；3.4 至 24；3.5 至 24+（官方源文件核实）。3.2 起官方支持虚拟线程（需 JDK 21）。Spring Boot 4.0（2025-11 发布）最低仍为 Java 17、兼容至 25、官方推荐 21。**因此"JDK 17 + Spring Boot 3.2+"完全可行，只是用不了 JDK 21 专属特性。** |
| 其他社区方案？ | Termony（Termux for HarmonyOS，proot/qemu-vroot 跑 Alpine/Ubuntu rootfs）、BiShengJDKInstaller（OH 版 JDK 安装器，JDK 8/17 分支）、自行编译鸿蒙版 JDK（蓝香蕉代码系列）、qemu-hmos 等，均处于实验/进行中状态（见第 4 节）。 |

**一句话建议**：如果后端**必须跑在鸿蒙 PC 本机**→ 用融合开发引擎或 Linux ARM64 虚拟机装 JDK 17/21 + Spring Boot；如果只是**给鸿蒙 App 做后端**→ 放云端（华为云 ECS/CCE 或任意服务器），App 用 NetworkKit 走 HTTPS 调用；不要在"毕昇 JDK 直接在鸿蒙上跑 Spring Boot"这条路上投入过多预期（官方自己都不推荐用 JDK 原生 API 做网络/IO，见 2.a）。

---

## 1. 毕昇 JDK 在鸿蒙上的支持现状（核实问题 1）

### 1.1 官方/官方渠道确认的事实

- **鸿蒙 PC 的 Java 运行环境以毕昇 JDK 17 为核心**。华为开发者论坛（鸿蒙 PC 对 JDK 21 及以上版本支持路线图问答）中，开发者与官方人士的回复确认：当前主推毕昇 JDK 17；编译构建环节若 JDK 版本不匹配（非 17）可能导致构建失败；**截至 2026 年 5 月，华为未公布将 JDK 21 或更新版本纳入官方支持计划的具体时间**；AWT/Swing 图形库**预计 2026 年 6 月提供**（论坛回复说法，未见独立官方公告原文）。来源：
  - [华为开发者问答：鸿蒙PC对JDK 21及以上版本的支持路线图是什么](https://developer.huawei.com/consumer/cn/forum/topic/0208214238763794004?fid=0109140870620153026)（JS 渲染，正文镜像见下）
  - [itying 镜像：同一问答全文（含 6 楼官方口径回复）](https://bbs.itying.com/topic/6a21c77ac4b04d0047fcb6bd)

- **BiShengJDK17-OH（毕昇 JDK 17 鸿蒙版）可一键安装**：鸿蒙应用市场搜索"BiShengJDK17-OH"安装后，在鸿蒙 PC 自带「终端」里 `java -version` 输出 `OpenJDK Runtime Environment BiSheng (build 17.0.13+6)`，`javac 17.0.13` 可用，能编译运行标准 Java 程序、`wget` 下载 Maven Central 的 JAR 并用 `-cp` 引用。来源：[鸿蒙PC Java开发环境搭建：BiShengJDK17-OH安装、验证与进阶使用（CSDN Harmony PC 社区）](https://harmonypc.csdn.net/697076877c1d88441d8e79a3.html)

- **DevEco Studio 构建基于 JDK 17**：华为官方 FAQ《JDK版本不匹配导致编译失败》确认非 JDK 17 会导致编译失败、需改用 JDK 17 修正。来源：[华为官方 FAQ：JDK版本不匹配导致编译失败](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-compiling-and-building-14)

- **鸿蒙 NEXT 应用开发已永久移除 Java**（API 8 起），Java 仅作为鸿蒙 PC 上的**独立进程/工具**形态存在，不是鸿蒙应用形态。来源：[itying：鸿蒙Next Api8不支持java，是暂时还是永久？](https://bbs.itying.com/topic/67a7f84936bb8501316cda80)（回帖："API8 以后不会再支持 Java 开发，不是暂时，是永久"）；OpenHarmony 官方文档甚至为 Java 程序员写了"转 ArkTS"入门指南：[OpenHarmony/docs: getting-started-with-arkts-for-java-programmers](https://gitee.com/openharmony/docs/blob/bd58f4560afbb3f70fa3607f2b1f1b7aed3f80a4/zh-cn/application-dev/quick-start/getting-started-with-arkts-for-java-programmers.md)

### 1.2 毕昇 JDK 本身的版本支持（注意区分"Linux 版"与"鸿蒙版"）

- openEuler 官方 BiSheng JDK 项目页：**支持 Java 8/11/17/21（均为 LTS）**，支持 Linux/AArch64 与 Linux/x86_64，要求 glibc ≥ 2.18 —— 这是**面向 Linux 发行版**的毕昇 JDK（AArch64 上有 JDK 21 可用，对"在鸿蒙 PC 的 Linux 虚拟机/子系统里装 JDK 21"非常关键）。来源：[openEuler: BiSheng JDK](https://www.openeuler.org/en/other/projects/bishengjdk/)
- 鸿蒙版（BiShengJDK17-OH / OH 版）目前见到的公开版本为 **JDK 8 与 JDK 17**（见 BiShengJDKInstaller 项目分支 harmonyos-8u432 等），未见到鸿蒙版 JDK 21。

### 1.3 已知限制（鸿蒙上跑 Java 的坑，多个来源交叉印证）

1. **Native 接口兼容性**：高版本 JDK 的 FFM（Project Panama，JDK 22+）、虚拟线程等新 Native API 需要鸿蒙系统库配合适配，"调用路径未完全开放，需等待系统侧支持"（论坛官方口径）。
2. **JNI/本地绑定三方库**：依赖 JNI 或本地绑定的 Java 库在鸿蒙 ARM 架构上基本需要逐个移植，暂无通用适配方案。
3. **JDK 内部类访问受限**：鸿蒙 PC 上反射调用 `sun.management.OperatingSystemImpl` 等内部类会抛 `IllegalAccessException`，须改用公开标准 API（如 `ManagementFactory`）。来源：[腾讯云开发者社区·徐建国《鸿蒙 PC 端 Java 应用开发实战》](https://cloud.tencent.com.cn/developer/article/2610881?policyId=1003)
4. **字符集/编码**：鸿蒙终端/IDE 与 Java 输出编码常不匹配，中文输出极易乱码（该文建议纯英文输出或多重编码兜底）。
5. **JDK 版本选择**：该实战文实测"鸿蒙 PC 对 JDK 8 兼容性最佳"，需避免 JDK 10+ 新增 API —— 与论坛"官方主推 17"并存，说明 8/17 是当前实际可用的两个主力版本。
6. **官方姿态**：论坛回复建议"优先采用 HarmonyOS Kits 提供的能力替代 JDK 原生调用（如 @kit.ArkUI、@kit.NetworkKit 做文件 IO、网络）"，必须用 Native 时按鸿蒙 NDK 文档桥接 —— 即**官方并不鼓励用 JDK 原生网络/文件 API 在鸿蒙上跑服务**，这是判断 2.a 路径风险的重要信号。

### 1.4 Spring Boot 3.x 能否跑在 JDK 17 上（问题 1 后半）

✅ **可以**。Spring Boot 3.x 全系最低要求 Java 17（官方 system-requirements 源文件原文，见第 3 节）。所以"Spring Boot 3.2/3.4/3.5 + JDK 17"是官方支持的组合；用不了的是 JDK 21 专属能力（虚拟线程、Record Patterns 等）。

---

## 2. 在鸿蒙 PC 上运行 Spring Boot 后端的四条路径（核实问题 2）

### 2.a 路径 A：毕昇 JDK 17 直接在鸿蒙上运行（命令行/进程方式）

**现状**：✅ JDK 17 本身可用（编译/运行/引 JAR 均验证过，见 1.1）；⚠️ **"完整 Spring Boot 服务在毕昇 JDK17-OH 上跑通"无公开实测案例**。

**可行性的关键拆解**（Spring Boot 依赖什么）：
- JAR/ZIP、类加载、反射、线程、文件 IO、`ManagementFactory`：预期可用（基础案例已验证）。
- **网络（`java.net.ServerSocket` / NIO Selector / 嵌入式 Tomcat）**：依赖 JDK 本地 socket 实现（libnet）在鸿蒙上的适配；鸿蒙/OpenHarmony 自研内核 + musl libc，非 glibc/Linux 生态，端口监听是否受系统沙箱/权限限制**未见官方说明**。⚠️ 需实测。
- **TLS/HTTPS（javax.net.ssl）**：JSSE 以纯 Java 为主，但部分场景走 native（随机数、加速）；未知。⚠️ 需实测。
- **JNI 三方库**（部分 JDBC 驱动、JNA、加密库等）：高风险，需逐个移植（论坛官方口径）。
- **虚拟线程（JDK 21）**：鸿蒙版 JDK 无 21，**不可用**——这是本路径对"JDK 21 需求"的直接否决项。

**结论**：作为**开发/演示/轻量工具**可行（例如本机跑个小服务自测）；作为**生产后端**不推荐、且与官方指引相悖。若必须尝试，建议先用最小 `java -jar` 的 Spring Boot 应用（内嵌 Tomcat 单端口）做冒烟测试，验证 NIO/TLS/端口监听三项。

### 2.b 路径 B：虚拟机 / Linux 子系统（推荐给"必须本机跑"的场景）

有三个子方案，**按官方程度排序**：

#### B1. 华为融合开发引擎（Linux 子系统，官方）✅
- 华为官方推出，定位"轻量级虚拟化开发环境（Linux 子系统）"，HarmonyOS 6.0/6.1 鸿蒙电脑可用，一键启动直接运行 Linux 环境。2026 年 4 月 1 日上线应用市场尝鲜专区（1.0.0.17），随后转正。来源：
  - [华为官方支持页：华为鸿蒙电脑融合开发引擎（Linux子系统）相关问题](https://consumer.huawei.com/cn/support/content/zh-cn16091898/)（内容为官方 FAQ，以下限制全部出自该页）
  - [IT之家：华为「融合开发引擎」上线鸿蒙PC端，允许开发人员直接运行Linux环境](https://www.ithome.com/0/934/994.htm)
  - [IT之家：融合开发引擎结束尝鲜转正](https://m.ithome.com/html/940942.htm)
- 功能：共享文件夹（挂载为 `/mnt/linux_share`）、快照备份（最多 5 个）、磁盘扩容、系统重置。
- **限制（对跑 Spring Boot 很关键）**：
  - **仅支持 openEuler 发行版**（后续版本才支持其他发行版）；
  - **不支持 `systemctl` 等服务管理工具**——服务需手动拉起（例：`sudo /usr/sbin/sshd`）或 nohup/自管脚本；
  - **暂不支持 Docker**；
  - **不支持内核操作**（modprobe/insmod 等均不可用）；
  - 网络分 NAT / host-only 两模式，**host-only 无法连外网**，要外网须 NAT；暂不支持 IPv6；
  - 仅"主用户"（首次开机创建的用户）可用；不支持 USB 直通；共享文件夹内文件属主为 root，git clone 等需 sudo。
- **对"JDK 21 + Spring Boot"的含义**：openEuler（AArch64）可装 OpenJDK 17/21 或毕昇 JDK 21（Linux 版官方支持），`java -jar app.jar` 直接跑；没有 systemd/Docker 只是少糖，不影响 Java 进程。**这是"官方支持的、在鸿蒙 PC 本机跑 Spring Boot（含 JDK 21）"的最可行路径。**

#### B2. 第三方虚拟机装 Linux（社区验证）✅ 实测成功
- 社区已验证：鸿蒙电脑应用市场的虚拟机（**OSEasy** 推荐；铠大师也可但键盘按键有 bug）里装 **ARM64 Debian 12**：U 盘写 Ventoy+Debian arm64 安装盘 → 直通 USB → 进 OVMF（开机按 Esc，或 Windows 设置→恢复→UEFI 固件设置）从 U 盘启动 → 正常安装；网络静态 IP `172.16.100.2`、网关 `172.16.100.1`；grub 命令行加 `modprobe.blacklist=vmwgfx` 才能启动图形。来源：[jiegec 博客：在鸿蒙电脑上的虚拟机内启动 Linux（2025-06）](https://github.com/jiegec/blog-source/blob/99d7ec4c6144ea9e74dfc9105e89129b18a13898/docs/blog/posts/software/linux-vm-on-harmonyos-computer.md)
- **内核兼容性有坑**：Debian 5.10/6.1 内核正常；6.2–6.4 需 `simpledrm`；**6.5/6.12 起不来需强制关机**——建议选发行版默认 LTS 内核。
- 在 Debian arm64 里装 OpenJDK 17/21（apt）或毕昇 JDK 21，`java -jar` 跑 Spring Boot 无架构障碍（该虚拟机是 ARM64 原生 Linux）。

#### B3. Windows ARM 虚拟机 + IDEA（社区帖子，问题 2b 直接对应）🟡
- 帖主在鸿蒙 PC 上装了应用商店的虚拟机（Windows ARM），用 **ARM 版 IDEA + Maven 3.6.1 + x86 版 JDK 1.8** 启动 Spring Boot 项目，报错 `进程已结束,退出代码 -1073741819 (0xC0000005)`（内存访问冲突）——**根因是架构混用**（x86 JDK 跑在 ARM Windows/虚拟机里）。社区给出的解法：换 **ARM64 JDK**（Adoptium/微软 OpenJDK 的 windows-aarch64 构建，建议 JDK 11+），统一 Maven/IDEA/JDK 均为 ARM64；命令行先 `java -jar` 验证。来源：[itying：HarmonyOS鸿蒙Next中PC安装虚拟机，用IDEA启动springboot微服务项目](https://bbs.itying.com/topic/697bd89bc504c50058fd2420)
- 也有人提到"鸿蒙 PC 装不了 Linux 虚拟机"的说法，但 B2 的实测博客已证伪（Oseasy 虚拟机可以启动 Linux）。另有 QEMU 方向社区项目：[qemu-hmos（面向鸿蒙平板/笔记本的 QEMU 发行版，WIP）](https://github.com/caidingding233/qemu-hmos)。

### 2.c 路径 C：后端在远程服务器，鸿蒙 App 网络调用（最主流）✅

- 这是社区教程的标准架构：Spring Boot 后端（RESTful + JPA + Security/Sentinel 等）部署在服务器/云上，鸿蒙端用 ArkTS 调接口。例：[博客园《鸿蒙开发与SpringBoot深度融合：从接口设计到服务部署全解析》](https://www.cnblogs.com/jzssuanfa/p/19490562)（注意：该文 Spring Boot 跑在服务器，鸿蒙只做前端）。
- **鸿蒙 NEXT 网络权限与明文限制**（App 侧）：
  - 必须申请 `ohos.permission.INTERNET`（`entry/module.json5` 的 `requestPermissions`），并引入 `@kit.NetworkKit` 依赖（`oh-package.json5`），用 `http.createHttp()` 发请求。来源：[CSDN：在鸿蒙NEXT中发起HTTP网络请求：从入门到精通](https://harmonyosdev.csdn.net/69491b41836da3214486cc73.html)
  - **明文 HTTP**：API 10+ 访问非 HTTPS 明文链接，需在 `AppScope/app.json5` 声明 `"network": { "cleartextTraffic": true }`（同文）；也有说法是在 `module.json5` 的 metadata 里配 `customize_data`。**HarmonyOS 6.1.0（API 23）起**官方引入 `network_config.json`（`src/main/resources/base/profile/network_config.json`，`cleartextTrafficPermitted`）可全局/按域名控制明文策略；API 15 时代则没有全局开关，只能代码层强制 HTTPS。来源：
    - [itying：Stage模型下明文http请求在哪里设置？](http://bbs.itying.com/topic/6722ebbabb648a00d098a18e)
    - [itying：全局禁止HTTP明文传输（network_config.json 从 API 23 开始）](https://bbs.itying.com/topic/6a268374f483360041a317da)
    - [itying：鸿蒙Next开发中非https请求是否被禁止？](https://bbs.itying.com/topic/68fcb81adf492800426438db)（回帖：默认未完全禁止，但系统会提醒升级 HTTPS；应用市场对非 HTTPS 审核更严）
  - **结论**：开发期 http 可用（配好权限+明文开关），**生产强烈建议 HTTPS**，避免明文策略/上架审核的不确定性。

### 2.d 路径 D：PaaS / Serverless（AGC 云函数、华为云）🟡

- **AppGallery Connect 云函数（Cloud Functions）**：支持运行环境为 **Node.js 14/18、Python3、Java 1.8**（Java 必须 ZIP 上传，入口格式 `包名.类名::方法名`；内存 500MB–4GB，超时默认 55s）。**Java 1.8 → Spring Boot 3.x 直接不可能**；且 FaaS 是 handler 模型、非常驻进程，**无法承载嵌入式 Web 服务器**，Spring Boot 生态在此不适用。来源：
  - [华为云开发者：AGC 云函数从这里开始](https://developer.huawei.com/consumer/cn/doc/appgallery-connect-Guides/agc-cloud-function-start-from-here-0000001512489692)
  - [AGC 云函数 Server (Java) 开发文档](https://developer.huawei.com/consumer/en/doc/AppGallery-connect-Guides/server-java-create-func-preparations-0000001664126178)
  - [helloworld.net：云函数创建配置指南（运行环境：Node.js 14/18、Python3、Java 1.8）](https://helloworld.net/p/2344191035)
- **华为云 FunctionGraph（函数工作流）**：支持 **Java 8、11、17、21**（其中 Java 21 目前仅"中东-利雅得""土耳其-伊斯坦布尔"区域），另有 Node.js/Python/Go/C#/PHP/仓颉/自定义运行时；但同样是**函数模型**（事件/HTTP 触发器调用），不是常驻进程。来源：[华为云官方：函数运行时支持列表](https://support.huaweicloud.com/devg-functiongraph/functiongraph_02_0101.html)
- **真正能跑 Spring Boot 的华为云形态**：弹性云服务器 ECS（任意 Linux + JDK 17/21）、云容器引擎 CCE（Docker/K8s 跑镜像）——普通服务器/容器，Spring Boot 无任何限制。这部分是常识性结论，无需特殊适配。

---

## 3. Spring Boot 3.x 对 JDK 的要求与版本选择（核实问题 3）

### 3.1 官方文档原文（GitHub 源码核实）

`spring-boot-docs/.../system-requirements.adoc` 原文：

- **v3.5.0**：`Spring Boot 3.5.0 requires at least Java 17 and is compatible with versions up to and including Java 24.` 内嵌容器：Tomcat 10.1、Jetty 12、Undertow 2.3（Servlet 6.0）。来源：[system-requirements.adoc @ v3.5.0](https://github.com/spring-projects/spring-boot/blob/v3.5.0/spring-boot-project/spring-boot-docs/src/docs/antora/modules/ROOT/pages/system-requirements.adoc)
- **v3.4.0**：`requires at least Java 17 ... up to and including Java 23.` 来源：[system-requirements.adoc @ v3.4.0](https://github.com/spring-projects/spring-boot/blob/v3.4.0/spring-boot-project/spring-boot-docs/src/docs/antora/modules/ROOT/pages/system-requirements.adoc)

### 3.2 各版本 Java 兼容范围与关键里程碑

| Spring Boot | 最低 Java | 最高兼容 | 备注 |
|---|---|---|---|
| 3.0 / 3.1 | 17 | 21 | 3.0 起抛弃 Java 8/11 之外的旧版 |
| 3.2 | 17 | 21 | **首个官方支持 Java 21 + 虚拟线程**的版本（2023-11 发布） |
| 3.3 | 17 | 23 | |
| 3.4 | 17 | 24 | |
| 3.5 | 17 | 24（+） | 2025-05 发布 |
| 4.0 | 17 | 25 | 2025-11 发布，基于 Spring Framework 7，**官方推荐 Java 21** |

（Java 兼容范围另见 [endoflife.date/spring-boot](https://endoflife.date/spring-boot) 的 Java 兼容列；3.2 的 Java 21/虚拟线程支持见 [InfoQ：Spring Boot 3.2 and Spring Framework 6.1 Add Java 21, Virtual Threads, and CRaC](https://www.infoq.com/articles/spring-boot-3-2-spring-6-1/)；4.0 见 [springframework.org.cn：Spring Boot 4.0.0 现已发布](https://springframework.org.cn/blog/2025/11/20/spring-boot-4-0-0-available-now/) 与 [腾讯云：Spring Boot 4.0 最低 Java 17、兼容至 25、推荐 21](https://cloud.tencent.com.cn/developer/article/2527650?policyId=1004#1)）

### 3.3 支持窗口（endoflife.date，OSS 支持期）

| 版本 | 发布 | OSS 支持结束 | 商业支持结束 |
|---|---|---|---|
| 3.2 | 2023-11 | 2025-06-30 | 2025-12-31 |
| 3.3 | 2024-05 | 2025-06-30 | 2025-12-31 |
| 3.4 | 2024-11 | 2025-12-31 | 2026-06-30 |
| 3.5 | 2025-05 | 2026-06-30 | 2026-12-31 |
| 4.0 | 2025-11 | ~2026-11 | ~2027-05 |

来源：[endoflife.date/spring-boot](https://endoflife.date/spring-boot)（截至本次调研：3.2/3.3 OSS 已结束；3.4 OSS 已结束、3.5 OSS 刚结束；仍处 OSS 支持期的主要是 4.0）

### 3.4 若只能 JDK 17：版本选择建议

- **结论：Spring Boot 3.x 全系（3.2–3.5）都支持 JDK 17**，不存在"必须 21"的问题；JDK 21 只是可选加速（虚拟线程）。
- 维护窗口角度（截至 2026-08）：若追求官方 OSS 支持 → **Spring Boot 4.0.x（仍兼容 Java 17）**；若有商业支持订阅或内部标准限制 → **3.5.x**（商业支持到 2026-12）；老项目 → 3.2.x 仍可运行但已 EOL，不建议新项目选用。
- 若能用 JDK 21：直接选 4.0.x 或 3.5.x + JDK 21，虚拟线程配置 `spring.threads.virtual.enabled=true`（3.2+）。

---

## 4. 其他社区方案盘点（核实问题 4）

| 项目/方案 | 形态 | 状态与说明 | 来源 |
|---|---|---|---|
| **Termony**（Termux for HarmonyOS） | OpenHarmony 终端模拟器 App | "Working in Progress"。内置 bash/gcc/python/curl/proot/qemu 等，**可用 qemu-vroot（用户态 QEMU + proot 式 rootfs 切换）跑 Alpine/Ubuntu arm64 rootfs，`apk`/`apt` 可装包**——理论上可装 OpenJDK，但未见跑通 Spring Boot 的公开记录；属实验性 | [GitHub: TermonyHQ/Termony](https://github.com/TermonyHQ/Termony)；[issue #48：鸿蒙PC里装 ARM64 Debian 12 虚拟机并编译安装 Termony](https://github.com/TermonyHQ/Termony/issues/48) |
| **BiShengJDKInstaller** | OpenHarmony 版 JDK 安装器 | AtomGit 项目，支持 JDK8、JDK17 分支（如 harmonyos-8u432），未来计划更多版本/图形化 | [AtomGit: BiShengJDKInstaller](https://gitcode.com/OpenHarmonyPCDeveloper/BiShengJDKInstaller/tree/harmonyos-8u432) |
| **自行编译鸿蒙版 JDK** | 源码编译 | CSDN"蓝香蕉代码"《鸿蒙&&Java》系列第一篇《编译获取鸿蒙版本JDK》，证明可从源码构建鸿蒙 JDK（以 BiSheng JDK 8 为例讲解） | [CSDN：编译获取鸿蒙版本JDK](https://blog.csdn.net/weixin_39954655/article/details/155470111) |
| **qemu-hmos** | QEMU 发行版（面向鸿蒙平板/笔记本） | WIP，星标少，前景未明 | [GitHub: caidingding233/qemu-hmos](https://github.com/caidingding233/qemu-hmos) |
| **鸿蒙 PC Java 桌面/工具开发**（非 JVM 移植，属应用实践） | 直接使用 | 鸿蒙 PC 能稳定运行企业级/工具类 Java 程序（毕昇 JDK 8 兼容性最佳），已有系统信息采集等实战 | [腾讯云：鸿蒙 PC 端 Java 应用开发实战](https://cloud.tencent.com.cn/developer/article/2610881?policyId=1003) |

**小结**：不存在"开箱即用的 OpenHarmony 官方 JVM 移植项目"；所有 JVM 相关社区项目（安装器、终端、QEMU、源码编译教程）都处于早期/实验阶段，且集中在 **JDK 8/17**，没有 JDK 21 的鸿蒙原生移植。

---

## 5. 决策建议（按需求场景）

1. **目标 = 鸿蒙 App 的后端**（最常见）→ 后端放远程/云端（华为云 ECS、CCE，或任意 Linux 服务器），JDK 17 或 21 + Spring Boot 3.5/4.0 均可；鸿蒙端用 `@kit.NetworkKit` http 模块 + `ohos.permission.INTERNET`，生产 HTTPS。**零鸿蒙适配成本。**
2. **目标 = 后端必须跑在鸿蒙 PC 本机，且可用 JDK 21** → 首选**融合开发引擎**（官方 Linux 子系统，openEuler，装 OpenJDK 21/毕昇 JDK 21，`java -jar`；接受无 systemctl/Docker、NAT 网络的限制）；或 OSEasy 虚拟机装 ARM64 Debian 12 + JDK 21（社区实测可行，注意内核版本）。
3. **目标 = 鸿蒙 PC 本机、仅 JDK 17** → 融合开发引擎/Linux VM 装 JDK 17，或直接毕昇 JDK17-OH 跑（先做 NIO/TLS/端口冒烟测试再决定）。
4. **目标 = 直接在毕昇 JDK17-OH 上跑完整 Spring Boot** → 低期望：官方不推荐用 JDK 原生网络/IO；未发现成功案例；建议只做自测/演示，别押注生产。
5. **Serverless** → 简单逻辑用 AGC 云函数（Java 1.8，无 Spring Boot）；要求 Java 17/21 且接受函数模型可用华为云 FunctionGraph（注意区域限制）；完整 Spring Boot 用 ECS/CCE。

---

## 6. 不确定点 / 待核实清单

1. **毕昇JDK17-OH 跑完整 Spring Boot（Tomcat 监听端口 + NIO + TLS）**：无公开成功/失败案例，最需要真机实测；建议冒烟测试项：`java -jar` 启动、`curl` 本机端口、HTTPS 端点、JDBC 连数据库。
2. **鸿蒙 PC 上 Java 进程入站端口监听是否受沙箱/权限限制**：未见官方说明；终端里启动的进程与鸿蒙应用沙箱的关系不明。
3. **AWT/Swing "2026年6月提供"**：仅论坛回复说法，未见独立官方公告原文（可关注 HarmonyOS 6 后续发布）。
4. **明文 HTTP 策略的版本差异**：社区对"默认是否允许 + 配置位置（app.json5 / module.json5 metadata / network_config.json）"说法不一，且随 API 版本（10 / 15 / 23）变化；需在目标机型实测。
5. **融合开发引擎可用性**：依赖 HarmonyOS 6.0/6.1、仅主用户、仅 openEuler；实际体验与后续发行版支持时间未知。
6. **鸿蒙版 JDK 21**：无论官方（毕昇）还是社区，均未见到；"JDK 21 直接跑在鸿蒙上"目前只能靠 Linux 子系统/虚拟机实现。
7. **Spring Boot 4.0 与 JDK 17 组合**：官方称最低 17，但部分新特性（模块化、Observability 等）在 17 上可能有功能取舍，建议以官方 system-requirements 与 release notes 为准。
8. **Termony 跑 OpenJDK**：理论上可（rootfs + apt），但 qemu-vroot 用户态仿真性能与 syscall 兼容性未经验证，无公开案例。

---

## 附：主要参考链接（按主题）

**毕昇 JDK / 鸿蒙 Java 现状**
- [华为开发者问答：鸿蒙PC对JDK 21及以上版本的支持路线图](https://developer.huawei.com/consumer/cn/forum/topic/0208214238763794004?fid=0109140870620153026)｜[itying 全文镜像](https://bbs.itying.com/topic/6a21c77ac4b04d0047fcb6bd)
- [CSDN：BiShengJDK17-OH 安装、验证与进阶使用](https://harmonypc.csdn.net/697076877c1d88441d8e79a3.html)｜[同文另一入口](https://alextechvision.blog.csdn.net/article/details/156581717)
- [华为官方 FAQ：JDK版本不匹配导致编译失败（DevEco Studio）](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-compiling-and-building-14)
- [openEuler：BiSheng JDK（8/11/17/21，Linux/AArch64）](https://www.openeuler.org/en/other/projects/bishengjdk/)
- [腾讯云：鸿蒙 PC 端 Java 应用开发实战（JDK 8 兼容性最佳、内部类限制、编码坑）](https://cloud.tencent.com.cn/developer/article/2610881?policyId=1003)
- [itying：鸿蒙Next Api8不支持java（永久移除 Java 应用开发）](https://bbs.itying.com/topic/67a7f84936bb8501316cda80)
- [OpenHarmony docs：给 Java 程序员的 ArkTS 入门](https://gitee.com/openharmony/docs/blob/bd58f4560afbb3f70fa3607f2b1f1b7aed3f80a4/zh-cn/application-dev/quick-start/getting-started-with-arkts-for-java-programmers.md)

**虚拟机 / Linux 子系统**
- [华为官方：融合开发引擎（Linux子系统）FAQ](https://consumer.huawei.com/cn/support/content/zh-cn16091898/)
- [IT之家：融合开发引擎上线（1.0.0.17）](https://www.ithome.com/0/934/994.htm)｜[转正报道](https://m.ithome.com/html/940942.htm)
- [jiegec 博客：在鸿蒙电脑上的虚拟机内启动 Linux（OSEasy + Debian 12 arm64 实测）](https://github.com/jiegec/blog-source/blob/99d7ec4c6144ea9e74dfc9105e89129b18a13898/docs/blog/posts/software/linux-vm-on-harmonyos-computer.md)
- [itying：PC安装虚拟机用IDEA启动springboot微服务项目（0xC0000005 架构混用案例）](https://bbs.itying.com/topic/697bd89bc504c50058fd2420)
- [qemu-hmos](https://github.com/caidingding233/qemu-hmos)

**鸿蒙网络**
- [CSDN：在鸿蒙NEXT中发起HTTP网络请求（INTERNET 权限 + cleartextTraffic）](https://harmonyosdev.csdn.net/69491b41836da3214486cc73.html)
- [itying：Stage模型明文http设置](http://bbs.itying.com/topic/6722ebbabb648a00d098a18e)｜[全局禁止HTTP明文（network_config.json）](https://bbs.itying.com/topic/6a268374f483360041a317da)｜[非https请求是否被禁止](https://bbs.itying.com/topic/68fcb81adf492800426438db)

**PaaS / Serverless**
- [AGC 云函数：从这里开始](https://developer.huawei.com/consumer/cn/doc/appgallery-connect-Guides/agc-cloud-function-start-from-here-0000001512489692)｜[AGC 云函数 Server (Java)](https://developer.huawei.com/consumer/en/doc/AppGallery-connect-Guides/server-java-create-func-preparations-0000001664126178)
- [helloworld.net：云函数创建配置指南（Java 1.8）](https://helloworld.net/p/2344191035)
- [华为云：FunctionGraph 函数运行时支持列表（Java 8/11/17/21）](https://support.huaweicloud.com/devg-functiongraph/functiongraph_02_0101.html)

**Spring Boot × JDK**
- [Spring Boot 3.5.0 system-requirements.adoc（Java 17 起、至 24）](https://github.com/spring-projects/spring-boot/blob/v3.5.0/spring-boot-project/spring-boot-docs/src/docs/antora/modules/ROOT/pages/system-requirements.adoc)
- [Spring Boot 3.4.0 system-requirements.adoc（Java 17 起、至 23）](https://github.com/spring-projects/spring-boot/blob/v3.4.0/spring-boot-project/spring-boot-docs/src/docs/antora/modules/ROOT/pages/system-requirements.adoc)
- [InfoQ：Spring Boot 3.2 支持 Java 21 / 虚拟线程 / CRaC](https://www.infoq.com/articles/spring-boot-3-2-spring-6-1/)｜[中文解读（腾讯云）](https://cloud.tencent.cn/developer/article/2401217?policyId=1003#1)
- [springframework.org.cn：Spring Boot 4.0.0 发布](https://springframework.org.cn/blog/2025/11/20/spring-boot-4-0-0-available-now/)｜[Boot 4.0 最低 Java 17、兼容至 25、推荐 21](https://cloud.tencent.com.cn/developer/article/2527650?policyId=1004#1)
- [endoflife.date/spring-boot（版本 EOL 与 Java 兼容范围）](https://endoflife.date/spring-boot)

**社区项目**
- [Termony（Termux for HarmonyOS）](https://github.com/TermonyHQ/Termony)｜[issue #48（鸿蒙PC+Debian12 VM 实测）](https://github.com/TermonyHQ/Termony/issues/48)
- [BiShengJDKInstaller（OH 版 JDK 安装器）](https://gitcode.com/OpenHarmonyPCDeveloper/BiShengJDKInstaller/tree/harmonyos-8u432)
- [蓝香蕉代码：编译获取鸿蒙版本JDK](https://blog.csdn.net/weixin_39954655/article/details/155470111)
