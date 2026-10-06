# 鸿蒙 PC 专项：启动等待动画（闪屏）不显示 —— 原因清单、调查方向与真机验证方案

> **适用**：Electron 34 鸿蒙壳工程（`templates/ohos_electron_hap-main` / `project-template`）
> **现象**：Windows 上启动时"屏幕居中的圆形图标 + 圆周进度"等待动画，在鸿蒙 PC 上不显示
> **本文定位**：姊妹篇《鸿蒙PC迁移专项_启动闪屏定位与解决方案.md》（下称**原专项**）已完成"三步定位法 + 6 类问题"的**假设性分析**；
> 本文是它的**升级版**：把原专项的假设逐条落到**源码级证据**上，补齐它没有覆盖的原因，并给出**可在没有真机时先做完的准备工作**与**上真机后的完整验证方案**。
> **来源标注**：✅源码核实（文件:行号）｜✅官方明文｜✅API 支持表｜🟡推断（置信度高，附推理链）｜⚠️需真机实测（对应手册附录 A）
> **版本**：v1.0 ｜ 编写时**未接触真机**，所有 ⚠️ 项均未验证

---

## 0. 一句话结论

**这不是一个"动画写错了"的问题，而是"动画画在了错误的时间窗口里"。**

鸿蒙冷启动时，屏幕在不同阶段由**三个不同的绘制者**接管，而你的等待动画在 Windows 上依赖的"窗口出现即开始渲染"这一前提，在鸿蒙上**只在第 4 阶段之后才成立**：

```
① 系统启动窗口（系统画，静态图，不能动画）
   ↓ ② ArkTS 页面（ArkTS 画，纯色底，不是你的页面）
      ↓ ③ XComponent 表面就绪 → 启动 Electron 进程
         ↓ ④ Electron 首帧 → ⑤ 你的页面终于出现 ← 动画最早只能从这里开始
```

**因此"动画不显示"有三种本质不同的成因**，必须先用 §5 的决策树分流，否则会在错误的方向上耗时间：

| 画像 | 现象 | 本质 | 对应原因 |
|---|---|---|---|
| **甲** | 全程没有任何等待画面，直接出现主界面 | 动画压根没被加载/渲染 | C 类（页面/时序） |
| **乙** | 有一段**白屏/纯色**，动画始终不出现 | 动画画在了 ②–③ 这段"别人在画"的时间里 | **A 类（架构错位）← 最常见** |
| **丙** | 窗口一闪即没 / 应用直接退出 | 踩中首窗口 `close()` = `terminateSelf()` | B 类（生命周期） |

> **本文的四个新发现**（原专项均未覆盖，全部为源码级或官方文档级证据）：
>
> 1. **`NewWindowParam` 建窗参数里根本没有 `transparent` 字段**（`CommonInterface.ts:300-317`）→ `transparent:true` 不会被传导到原生建窗，Windows 那套"透明圆角闪屏"在鸿蒙上**从建窗参数层面就无法表达**。
> 2. **★ Electron 每建一个窗口，其 UIAbility 的"系统启动窗口"被刻意设成"空白 + 全透明"**：
>    `AppWindowAdapter.ets:107-116` 用**空 `ArrayBuffer(0)`** 造了个 `image.PixelMap` 当 `startWindowIcon`，并在 `:131` 传 `startWindowBackgroundColor = this.defaultBackgroundColor`，而 `:60` 定义 `defaultBackgroundColor = '#00000000'`（**全透明**）。
>    → 含义：对 Electron 创建的窗口，**系统压根不画启动窗口**。想在 ①–③ 阶段"看到点什么"，只能靠自己（§6 方案 0/2）。
> 3. **Electron → ArkTS 方向不存在"首帧已渲染"信号**（全量回调清点见 §3.6）。
>    ⚠️ 注意区分：**`systemPreferences.callArkTSFunction` 是官方存在的 API**（有独立指南文档），只是**壳工程-E34 版本里未使用/未注册**。因此 §6 方案 2 的退场信号**有官方通道可用，但需要自行注册 AKI 函数**——这比"完全不可行"乐观，但比"开箱即用"麻烦。
> 4. **`win.setOpacity()` 在鸿蒙上有最低阈值，不支持设为 0**（官方 API 文档「差异说明」原文）→ 任何用 `opacity:0` 实现"先隐藏后淡入"的闪屏方案会失效。

---

## 1. 问题定义与现象边界

### 1.1 先把"不显示"拆成可判定的问题

上真机前先明确你看到的到底是哪一种。**这三问决定后面所有分支**（与原专项 §1 一致，此处补充判定证据）：

| 问 | 若答"是" | 若答"否" |
|---|---|---|
| ① 有无**任何**等待画面？（哪怕是纯色/白屏） | 有画面 → 动画内容/时机问题 → §5 画像乙 | 完全无画面 → 窗口未显示 → §4 的 B 类 |
| ② 等待期间**最终能进主界面**吗？ | 只是闪屏问题 | 应用被终结 → §4 的 B2（首窗口 close） |
| ③ 你的原工程用的是**独立 BrowserWindow 闪屏**还是**主窗口内覆盖层**？ | 独立窗口 → 大概率 A 类，直接看 §6 方案 1 | 已是覆盖层 → 问题在窗口本身/时序 → B 类 + C 类 |

### 1.2 ★ 术语澄清（避免查错方向）

**"启动窗口"在本仓库里有两个完全不同的含义**，混用会直接导致查错地方：

| 说法 | 实际指 | 配置位置 | 与本文的关系 |
|---|---|---|---|
| **系统启动窗口**（本文 §2 阶段①） | 系统绘制的**闪屏**：一张静态图标 + 纯色底 | `module.json5` 的 `startWindowIcon` / `startWindowBackground` | ★ 就是"等待动画"缺失的那段 |
| **首窗口**（官方模板 README 里的"启动窗口大小"） | 第一个 UIAbility 窗口的**几何尺寸** | `module.json5` 的 `ohos.ability.window.width/height/left/top` | 管尺寸，**与闪屏无关** |

> 证据：`templates/ohos_electron_hap-main/README-CN.md:92`「配置启动窗口大小」一节给的是 `ohos.ability.window.*`；而 `DevEcoStudio工程配置文件详解.md:281` 把 `startWindowIcon`/`startWindowBackground` 标为"启动窗口图标/背景色"。同名不同物。

---

## 2. 机制基础：冷启动 5 阶段与"谁在画屏幕"

这是全文的地基。**理解这张表，90% 的原因可以不测自明。**

| 阶段 | 屏幕上是什么 | 谁在画 | 能否动画 | 证据 |
|---|---|---|---|---|
| ① 系统启动窗口 | ⚠️ **分两种情况，见 §2.2**：**启动器冷启动** = 静态图标 + 纯色底（当前工程 `#FFFFFF` + 1024×1024 图标）；**Electron 自己创建的窗口** = **空白图标 + 全透明底（等于没有）** | **系统**（ArkUI 框架） | ❌ **不能**（静态资源配置项） | `electron/src/main/module.json5:28-29`；`color.json`（`start_window_background = #FFFFFF`）；**★ `AppWindowAdapter.ets:60,107-116,130-131`** |
| ② ArkTS 页面加载 | **ArkTS 页面的纯色底**（当前工程 = **白色** `#ffffffff`） | **ArkTS**（你的 `Index.ets`） | 🟡 可以，但需要自己实现 | `WebAbility.ets:163` `windowStage.loadContent('pages/Index', ...)`；`WebBaseAbility.ets:107-109` `getContentPath() → 'pages/Index'`；`electron/src/main/ets/pages/Index.ets` `initStyle.backgroundColor = 'ffffffff'` |
| ③ XComponent 表面就绪 → **启动 Electron 进程** | 仍是 ② 的画面（XComponent 尚无内容） | ArkTS | 🟡 同上 | `components/WebWindow.ets:92-95` `.onLoad(() => { ... this.config.nativeContext.runBrowser(vec_args); })` |
| ④ **Electron 首帧渲染进 SURFACE** | 你的 HTML 页面第一帧 | **Electron** | ✅ 从这里起"正常动画"才可用 | 🟡 由 ③ 的 `runBrowser()` 之后渲染管线决定；**壳工程未提供该时刻的回调**（§3.6 证据） |
| ⑤ 业务就绪（后端可用等） | 你的页面持续渲染 | Electron | ✅ | `main.js:328-331` `ensureBackend()` → 发 `EVT_BACKEND_READY` |

### 2.1 由这张表直接推出的三条硬结论

1. **阶段 ① 不可能有动画** —— 它是静态资源配置，不是代码。所以"Windows 那种启动就有动画"在鸿蒙上**必然存在一段无动画期**，只能靠"视觉对齐"让它不被察觉（§6 方案 0）。
2. **阶段 ②–③ 是唯一能放"早期动画"的窗口** —— 但绘制者是 **ArkTS**，不是 Electron。所以任何"用 Electron 实现启动闪屏"的方案，**最早也只能从阶段 ④ 开始**。
3. **阶段 ④ 的开始时刻，壳工程没有对外通知**（§3.6）—— 这决定了"ArkTS 层闪屏"必须额外解决退场信号，而"页面覆盖层"天然不需要（它本来就在 ④ 之后）。

> 🔑 **一句话判断法**：如果你在阶段 ②–③ 看到的是**纯色**（白/黑），说明"等待动画"缺的就是这一段；如果你在 ②–③ 看到**你的页面但没动画**，那才是 C 类（内容/时序）问题。

### 2.2 ★ 系统启动窗口有两种，别只盯着 `module.json5`

这一点原专项完全没提，但它直接决定"① 阶段能不能被利用"。

`module.json5` 的 `startWindowIcon` / `startWindowBackground` **只对"启动器冷启动那一次"生效**。此后 **Electron 每创建一个窗口，都走 `AppWindowAdapter.createWindow()` 另起一个 UIAbility 实例**，而那条路径把启动窗口**主动设成了"空白 + 全透明"**：

```ts
// web_engine/src/main/ets/adapter/AppWindowAdapter.ets（原文）
 60:  private defaultBackgroundColor: string = '#00000000';        // ★ 全透明

107:    let imagePixelMap: image.PixelMap;
108:    let color = new ArrayBuffer(0);                              // ★ 空 buffer
109:
110:    image.createPixelMap(color, {                                // ★ 用空 buffer 造图
111:      size: {
112:        height: param.bounds.height + leftBorder + topBorder,
113:        width: param.bounds.width + leftBorder + leftBorder,
114:      }
115:    }).then((data) => {
116:      imagePixelMap = data;
117:      let options: StartOptions = {
118:        processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
119:        startupVisibility: param.show ? ...STARTUP_SHOW : ...STARTUP_HIDE,
...
130:        startWindowIcon: imagePixelMap,                          // ★ 空白图
131:        startWindowBackgroundColor: this.defaultBackgroundColor   // ★ 全透明
132:      }
...
139:      LaunchHelper.LaunchWithOptions(this.ctxAdapter.getActiveContext(), want, options);
```

同时 `:87` 把 `abilityName` 定为 `"EntryAbility"`、`:93` 用 `instanceKey: param.window_id` 区分实例（配合 `module.json5` 的 `launchType: "specified"`）。

**这推出三条重要结论**：

| # | 结论 | 对排查的意义 |
|---|---|---|
| 1 | Electron 创建的窗口**没有系统绘制的启动画面**（图标空白 + 底色透明） | 阶段 ① 对这些窗口**不存在**。所以"启动时什么都没有"在**多窗口/二次建窗**场景下是**预期行为**，不是 bug |
| 2 | 因此 ①→② 之间不会有"系统闪屏残留" | 视觉连续性只需处理 ②→④（§6 方案 0 的对象要相应调整） |
| 3 | 启动器冷启动那一次的 `#FFFFFF` **仍然生效** | 首次启动会看到 **白色 + `startIcon.png`**；这与后续窗口的"透明"形成不一致 |

> ✅ **冷启动看到的是白色启动窗口（已由源码链确定，置信高）**
>
> 推理链（全部为源码事实）：
> 1. 首窗口由**启动器**经 `module.json5` 的 home skill 拉起 EntryAbility（`module.json5:63-70`），**不经过 `createWindow`** → 用的是 `module.json5:28-29` 的 `startWindowIcon=$media:startIcon` + `startWindowBackground=#FFFFFF`。
> 2. 窗口↔Ability 的绑定由**显式 `instanceKey`** 决定，而不是创建顺序：`AppWindowAdapter.ets:94-96` 写入 `instanceKey: param.window_id`，`WebAbilityStage.ets:52-67` 的 `onAcceptWant` 优先用它，否则回退 `kGetLastActiveWidget`，最后兜底 `ConfigData.DEFAULT_WINDOW_ID`（`Constants.ets:34` = **`'browser1'`**）。
> 3. `WebWindow.ets:103-129` 的 `setDefaultBounds()` **只在 `xComponentId === ConfigData.DEFAULT_WINDOW_ID`（即 `'browser1'`）时**才执行 `OnWindowInitSize/OnWindowInitState` —— 这证明 Electron 的主窗口对应的就是 `browser1`，也就是启动器创建的那个 Ability 实例。
>
> → **结论：冷启动 = 系统启动窗口是白色 + `startIcon`；只有 Electron 之后新起的窗口才是"空白 + 透明"**（§2.2 上半部分）。
> → 对 §6 方案 0 的意义：**要对齐的是"白色"**（把页面底色往白靠，或把 `start_window_background` 改成页面底色，二者取其一，但**必须一致**）。
>
> ⚠️ 保留 V10 作为低成本确认（若真机观察与上述结论不符，说明我对 `param.window_id` 的推断有误，需回查）。

---

## 3. 窗口可见性模型（原生侧事实，带源码行号）

### 3.1 ★ 建窗参数全集：`NewWindowParam`

Electron 创建一个窗口时，能传给原生的**全部参数**如下（这是 `AppWindow.CreateWindow` 的入参类型）：

```ts
// web_engine/src/main/ets/interface/CommonInterface.ts:300-317（原文）
export interface NewWindowParam {
  parent_id: string,
  window_id: string,
  bounds: WindowBound,
  init_color_argb: string,
  hide_title_bar: boolean,
  use_dark_mode: boolean,
  show: boolean,
  minimizable: boolean,
  maximizable: boolean,
  closable: boolean,
  always_on_top: boolean,
  resizable: boolean,
  is_modal: boolean,
  is_panel: boolean,
  is_stateless: boolean,
  display_id: number,
}
```

**★ 关键结论：这个结构体里没有 `transparent`。**

- 推论：Electron 的 `new BrowserWindow({ transparent: true })` **不会**通过建窗参数传导到原生窗口（原生侧也没有对应字段可接收）。
- 能表达"底色/透明"的**唯一**建窗参数是 `init_color_argb`（ARGB 字符串，含 alpha 通道）。
- 证据链：`jsbindings/AppWindowAdapterBind.ets:40-41` `createWindow(param: NewWindowParam)`；`:203` `JsBindingUtils.bindFunction("AppWindow.CreateWindow", createWindow)`。
- 意义：**Windows 上"透明底 + 圆形图标"的闪屏形态，在鸿蒙上从参数层面就无法表达**。原专项 P4 的处置（"改为实底窗口 + 圆角由页面 CSS 负责"）**方向正确，且现在有了源码级依据**。
- 🟡 待实测（⚠️ A-43）：`init_color_argb` 的 alpha 到底有没有实际透明效果；`win.setOpacity()`（API 表标注"支持"）是否可用于等效表达。二者都需真机确认。

### 3.2 窗口可见性在"创建那一刻"定死

```ts
// web_engine/src/main/ets/adapter/AppWindowAdapter.ets:123-126（原文）
let options: StartOptions = {
  processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
  startupVisibility: param.show ? contextConstant.StartupVisibility.STARTUP_SHOW : contextConstant.StartupVisibility.STARTUP_HIDE,
  windowLeft: param.bounds.left - leftBorder,
  ...
```

- `param.show` ← 就是 §3.1 结构体里的 `show` ← 来自 Electron 的 `BrowserWindow` 构造选项 `show`。
- **`show: false` ⇒ 窗口以 `STARTUP_HIDE` 被创建**。这不是"创建后再隐藏"，而是**创建时就作为启动参数下发**。
- 后果：之后想让它出现，只能走 §3.5 的 `showAbility()` —— 而那条路依赖托盘且时序敏感（原专项 P3）。

### 3.3 窗口显隐与托盘强绑定

同一处 `options` 里，`processMode: ATTACH_TO_STATUS_BAR_ITEM`（`:124`）。

**官方明文**（本次已核对原始出处）：
> 出于OH系统限制原因，窗口的显示隐藏与应用托盘强绑定，因此在启动应用前，为了保证窗口创建正常，需要先创建托盘。

- 出处：`research/rawgitcode_electron_readme.md:465-467`（章节「窗口显示隐藏」），原文照抄；同段 `:478-489` 给出"不要托盘"的改法（注释 `processMode` + `startupVisibility`）。
- 官方 Electron_CPF 仓库 `main` 分支 `README.md:469-495` 为同一段（已核对）。
- ⚠️ **该段在 v40.1.0 的 README 里改题为「窗口显示隐藏与托盘」，但"不要托盘"的改法在 v40.1.0 源码中已无对应代码**（`startupVisibility`/`ATTACH_TO_STATUS_BAR_ITEM` 在 v40.1.0 源码中零命中，仅存于 README）。**本工程是 E34 版本，`:124-125` 仍存在，所以该改法对本工程依然有效**；但若将来升级到 v40+，此路失效——详见 §9-B。

**★ 官方 API 文档对"显隐类接口"的逐条差异说明（本次新查，最权威的旁证）**

| API | 鸿蒙支持 | 「差异说明」原文 |
|---|---|---|
| `new BrowserWindow([options])` | 支持 | **"1.创建多窗口时需要创建托盘 2.可通过displayId指定创建在哪个屏幕上"** |
| `win.show()` | 支持 | **"使用此接口需要先创建托盘"** |
| `win.hide()` | 支持 | **"使用此接口需要先创建托盘"** |
| `win.isVisible()` | 支持 | 无差异 |
| `win.focus()` | 支持 | 无差异 |
| `win.showInactive()` | **不支持** | —（无差异章节） |
| `win.setSkipTaskbar()` | **不支持** | — |
| `win.setOpacity()` | 支持 | **"在鸿蒙下透明度存在最低阈值，不支持设置到0"** ← ★ 见 B6 |
| `win.setAlwaysOnTop()` | 支持 | 无差异；但支持矩阵：**主窗✅ / 子窗❌ / 悬浮窗❌** |
| `win.setBackgroundColor()` | 支持 | 无差异 |
| `win.setIgnoreMouseEvents()` | 支持 | "触屏为主的鸿蒙环境下…不支持部分穿透参数" |
| `ready-to-show` 事件 | 支持 | 无差异 |
| `show` 事件 | 支持 | 无差异 |

> 出处：官方 Electron_CPF 文档集 `main` 分支 `docs/api/BrowserWindow/` 下各 `method-win-*.md` / `event-*.md` / `method-BrowserWindow.md` 的「差异说明」章节。
> 本地离线副本：`_research/repo/docs/api/BrowserWindow/`（可直接 `grep`，见 §9-D）。
> **注意**：`win.show/hide` 的差异说明是"**使用此接口需要先创建托盘**"——这是官方对 §3.3 那条文字约束的**接口级确认**，比 README 的散文更硬。

**托盘的真实创建路径**（本次新查，原专项未给）：

| 环节 | 位置 |
|---|---|
| Electron 侧 | `new Tray(icon)`（`main.js:271`） |
| 绑定入口 | `jsbindings/StatusBarManagerAdapterBind.ets:46/50/54`（`SetImage` / `SetToolTips` / `SetContextMenu`） |
| ArkTS 实现 | `adapter/StatusBarManager.ets` |
| 系统能力 | `new-Tray` ✅支持、`tray.setContextMenu` ✅支持、`tray.setToolTip` ✅支持、`tray.setImage` ✅支持；**事件类几乎全不支持**（click 之外）→ `research/api_index.md:883-917` |

**★ 本次新发现的风险点：模板的 `createTray()` 会静默吞掉失败。**

```js
// project-template/.../app/main.js:269-285（原文节选）
function createTray() {
  try {
    const { icon } = ...;
    tray = new Tray(icon);
    ...
  } catch (e) {
    console.warn('[tray] create failed:', e.message);   // ★ 只 warn，不中断、不上报渲染层
  }
}
```

- `console.warn` 在主进程日志里，**真机上极难看到**（需 `hdc shell hilog` 主动抓）。
- 若托盘创建失败，按 §3.3 的官方约束，**后续窗口创建/显隐变得不可靠**——而应用会继续跑下去，表现为"窗口不显示"但没有任何报错。
- **这构成一个"静默失败"通道**，是调查时必须优先排除的项（验证方法见 §7 用例 V2）。
- 缓解事实：`new-Tray` 在 API 表里标注"支持"，托盘图标文件 `app/electron_white.png` **确实存在**（10,081 B，本次已核实）→ 因此**这条路的失败概率不高，但必须用日志确认，不能假设**。

### 3.4 "首窗口"如何确定，以及 `close()` 为何会终结应用

| 事实 | 证据 |
|---|---|
| 窗口 ID 前缀是 `browser` | `common/Constants.ets:33` `WINDOW_PREFIX = 'browser'` |
| 窗口 ID 生成 | `common/AbilityManager.ets:60` `return ConfigData.WINDOW_PREFIX + proxyId` |
| xcomponentId 生成 | `ability/WebBaseAbility.ets:117` `ConfigData.WINDOW_PREFIX + widgetId` |
| **首个窗口 = `browser1` = 绑定入口 EntryAbility** | 🟡 由上述 ID 生成规则 + 入口 Ability 唯一性推出（**⚠️ 待实测确认"第一个 BrowserWindow 是否必然复用入口 Ability"**，对应 A-44） |
| **`close()` 的真相是 `terminateSelf()`** | `adapter/AppWindowAdapter.ets:143-150`：`closeWindow(id)` → `context?.terminateSelf()` |

**`close()` vs `hide()` 的本质区别**（原专项未展开）：

| 调用 | 原生实现 | 语义 |
|---|---|---|
| `win.close()` | `context.terminateSelf()` | **销毁 UIAbility** ≈ 终结该 Ability（首窗口即入口 → 应用退出） |
| `win.hide()` | `context.hideAbility()`（`:238-246`） | 隐藏 Ability，**保留上下文**，可再 `showAbility()` 唤回 |
| `win.minimize()` | `windowClass.minimize()`（`:429-440`） | 最小化，非隐藏 |

> ⚠️ **A-44**：首窗口 `close()` 是否**必然**导致整个应用退出，还是只是"窗口消失但进程仍在"——需真机确认严重度。但无论如何，**用 `close()` 结束闪屏都是错的**。

### 3.5 运行期显隐：为什么"稍后 show()"不可靠

```ts
// AppWindowAdapter.ets:228-246（原文节选）
showWindow(id) {
  let context = this.abilityManager.getProxy(id)?.getWindowContext() as common.UIAbilityContext;
  context?.showAbility()...
}
hideWindow(id) {
  let context = this.abilityManager.getProxy(id)?.getWindowContext() as common.UIAbilityContext;
  context?.hideAbility()...
}
```

- 实现是**`UIAbilityContext.showAbility()`**，即"把 Ability 拉到前台"，**不是**"让窗口可见"。
- 🟡 **失败路径**：`getWindowContext()` 返回 undefined 时，可选链 `?.` 让**整个调用静默无操作**（不抛错、无日志）。这就是"时序敏感"的源码级原因——**调用早于窗口上下文就绪时，它什么都不做，且不报错**。
- 另有**第二条原生 show 路径**（本次新发现）：`AppWindowAdapter.ets:712` 在 `showHuaweiQuickLogin()`（`:644-730`）里用 `windowClass.showWindow(cb)` —— 这是 **ArkTS 原生 `window.Window.showWindow()`**，与 `showAbility()` 是两套不同机制。**原生 ArkTS 窗口的显隐比"Ability 级"显隐更直接可控**，这对 §6 方案 2 很关键。

### 3.6 ★ 跨边界信号通道现状（决定方案可行性的关键）

**方向 A：ArkTS → Electron**（`nativeContext.On*` 回调）—— 全量清点：

```
OnCaptionButtonRectChange   OnDisplayChangeCallback   OnDragEndCB        OnDragEnterCB
OnDragLeaveCB               OnDragMoveCB              OnDropCB           OnFontSizeChangeCallback
OnNotificationButtonClickCallback                     OnNotificationClickCallback
OnNotificationCloseCallback OnPanEventCB              OnPinchEventCB     OnWindowEvent
OnWindowInitSize            OnWindowInitState         OnWindowRectChange OnWindowSizeChange
OnWindowStatusChange        OnWindowVisibilityChange
```

**方向 B：Electron → ArkTS**（`JsBindingUtils.bindFunction`）—— 例如 `AppWindow.CreateWindow`（`AppWindowAdapterBind.ets:203`）、`SubWindow.Create/Show/Hide/Cancel/SetBounds`（`SubWindowAdapterBind.ets:63-67`）。

**两条硬结论**：

1. ❌ **不存在"Electron 已渲染首帧"的通知**。全量搜索 `firstFrame` / `onFirstFrame` / `firstPaint` / `didFinishLoad` / `OnFrame` 等关键词，**本工程壳源码中零命中**。
   → 含义：**ArkTS 层闪屏无法直接知道"何时该退场"**。
2. ⚠️ **`callArkTSFunction` 在"本工程壳源码"中零命中，但它是官方存在的 API**（此前结论需修正）。
   - 本工程（E34）壳源码全量搜索 `callArkTSFunction` / `CallArkTS` / `ArkTSFunction`：**零命中** → 开箱不可直接用。
   - 但官方**有独立的指南文档**：`docs/call-arkts-function-guide/README.md`，JS 端签名：
     ```ts
     systemPreferences.callArkTSFunction(
       functionName: string,      // AKI 注册的函数名，格式 "模块名.方法名"，如 "EtsBridge.TestReturnString"
       returnType?: string,       // 默认 "void"；可选 void/number/boolean/string/string[]/number[]
       paramArray?: any[]
     ): Promise<{ type: string, value: any }>
     ```
   - **已知限制（官方原文，直接影响可用性评估）**：① 暂不支持异步调用（ArkTS 函数不能是 `async`/返回 Promise，否则 AKI 类型校验失败）；② 暂不支持结构化 Object 参数（会 `JSON.stringify` 降级为字符串透传）；③ 4+ 参数时退化为字符串传递；④ 多参数场景不支持数组参数。
   - 结论：**退场信号有官方通道，但需要自行在 AKI 层注册一个模块函数**（属于改壳工程），不是"改一行 JS"就能用。

> 🔑 这两条直接决定了 **§6 方案 1（页面覆盖层）是首选、方案 2（ArkTS 层闪屏）需要额外成本**，而不是"两种随便选"。
> 同时修正原专项 §5 ② 的措辞：它说"隐藏时机可用官方 `callArkTSFunction`"——**API 确实存在**，但**需要先注册**，原专项未提这个前提。

---

## 4. 可能原因清单（核心）

> **分级说明**
> **A 级 = 架构性原因**：与代码写得好坏无关，是"方案选型"导致的必然结果。**最可能命中**。
> **B 级 = 生命周期/时序原因**：代码写了，但踩中鸿蒙与 Windows 的语义差异。
> **C 级 = 内容/渲染原因**：动画本身或页面本身的问题。
> **每条给出：现象特征 / 机制 / 证据 / 判定方法 / 修复方案 / 验证用例编号**

### 【A 级】架构性原因

#### A1. 等待动画画在了"别人在画"的时间窗口里（★ 最可能）

| 项 | 内容 |
|---|---|
| **现象特征** | 启动时有一段**纯色**（白/黑）停留数秒，之后直接进主界面；动画从头到尾没出现过 |
| **机制** | 阶段 ①–③ 由系统与 ArkTS 绘制（§2）。Windows 上"窗口出现即开始渲染你的页面"，鸿蒙上"窗口出现"（②）与"你的页面出现"（④）之间隔着**整个 Electron 进程的启动** |
| **证据** | §2 表格全行；`WebWindow.ets:92-95`（`onLoad` 才 `runBrowser()`） |
| **判定** | 看阶段 ②–③ 是不是纯色。用 §7 用例 **V1**（录屏逐帧看首 0–5 秒） |
| **修复** | §6 方案 0（视觉对齐）+ 方案 1（页面覆盖层）。**注意：修复后动画从阶段 ④ 开始，①–③ 仍是静态色** |
| **验证** | V1、V3 |

#### A2. `transparent` 在原生建窗参数里不存在 → 透明闪屏形态无法表达

| 项 | 内容 |
|---|---|
| **现象特征** | 闪屏窗口**完全看不见**，或看到一块**不透明方块**；`transparent:true` 改了没任何变化 |
| **机制** | `NewWindowParam` 无 `transparent` 字段（§3.1）。Windows 上"整窗透明 + 圆形图标 + 圆角"的经典闪屏，在鸿蒙上**从参数层面无法表达** |
| **证据** | `CommonInterface.ts:300-317`（★ 原文已列）；`AppWindowAdapterBind.ets:40-41, 203` |
| **判定** | 代码里搜 `transparent`。**当前模板经核实完全未使用**（仅注释提及）；若你的原工程用了 → 高度可疑 |
| **修复** | 改**实底窗口** + 圆角/圆形交由**页面内 CSS** 表达；或试 `init_color_argb` 的 alpha / `win.setOpacity()`（⚠️ 待实测） |
| **验证** | V5（专测 `transparent` 表现，对应 A-43） |

#### A3. 独立闪屏窗口方案本身与鸿蒙模型冲突（方案选型错误）

| 项 | 内容 |
|---|---|
| **现象特征** | 各种"差一点"的表现：窗口不出现 / 出现即消失 / 应用退出 / 主窗口异常 |
| **机制** | 独立闪屏窗口会同时触发 §3.2（可见性定死）、§3.3（托盘顺序）、§3.4（首窗口 close）三条约束，**三者叠加** |
| **证据** | §3.2 / §3.3 / §3.4 |
| **判定** | 数一下启动过程中出现了几个窗口/Ability：`hdc shell aa dump -a \| grep -i <bundleName>`（见 V6） |
| **修复** | **不要用独立闪屏窗口**，转 §6 方案 1 或 2 |
| **验证** | V6 |

#### A4. Electron 创建的窗口，其"系统启动窗口"本身就是空白 + 全透明的（★ 新发现）

| 项 | 内容 |
|---|---|
| **现象特征** | 首次启动能看到白底 + 图标一闪；**之后每次新建窗口（或多窗口场景）完全没有启动画面**，直接从"什么都没有"跳到页面 |
| **机制** | `AppWindowAdapter.createWindow()` 给每个新建 UIAbility 下发的 `StartOptions` 里，`startWindowIcon` 是**用空 `ArrayBuffer(0)` 造出来的空白 PixelMap**，`startWindowBackgroundColor` 是 `defaultBackgroundColor = '#00000000'`（**全透明**）→ 系统等于不画启动窗口 |
| **证据** | `AppWindowAdapter.ets:60`（全透明常量）、`:107-116`（空 buffer 造图）、`:130-131`（传入 StartOptions）、`:87`（`abilityName="EntryAbility"`）、`:93`（`instanceKey: param.window_id`）；§2.2 有完整原文 |
| **判定** | 对比"启动器冷启动"与"应用内新建窗口"两种场景的观感差异；或直接读源码确认（无需真机即可判定机制成立） |
| **修复** | 这是**平台/壳工程的既定行为，不要试图改它**（改壳工程 = 升级冲突）。正确对策是 §6 方案 0（把 `module.json5` 的 `startWindowBackground` 与页面底色对齐）+ 方案 1（页面内覆盖层），**不要去调 `startWindowIcon` 指望它当闪屏** |
| **验证** | V1（区分冷启动 vs 二次建窗） |

> ⚠️ 这一条**推翻了一个常见假设**："把 `startWindowIcon` 换成我的 logo 就能当启动闪屏"。对 Electron 创建的窗口不成立——那个字段被壳工程写死成空白图了。**只有启动器冷启动那一次用的是 `module.json5` 的值。**

### 【B 级】生命周期/时序原因

#### B1. 闪屏窗口建在 Tray 之前（或托盘创建静默失败）

| 项 | 内容 |
|---|---|
| **现象特征** | 窗口不显示或闪一下就没；日志里可能有 `[tray] create failed` |
| **机制** | 窗口显隐与托盘强绑定（§3.3 官方明文） |
| **证据** | `AppWindowAdapter.ets:124`（`ATTACH_TO_STATUS_BAR_ITEM`）；`main.js:269-285`（★ try/catch 静默吞错） |
| **判定** | ① 代码顺序：`createTray()` 是否在任何窗口之前；② **必须抓日志**看有无 `[tray] create failed`（`console.warn` 在渲染层看不到）；③ 托盘图标文件是否存在（模板 ✓ 已核实存在） |
| **修复** | 保证 `createTray()` 是 `app.whenReady()` 后**第一件事**；把 catch 里的 `console.warn` 升级为**显式上报**（写文件或发给渲染层） |
| **验证** | V2 |

#### B2. 把闪屏当首窗口，最后 `close()` 掉

| 项 | 内容 |
|---|---|
| **现象特征** | 应用**直接退出**，或主界面不出现；hilog 里出现 `terminateSelf` |
| **机制** | 首窗口（`browser1`）绑定入口 EntryAbility；`close()` 的实现是 `terminateSelf()`（§3.4） |
| **证据** | `AppWindowAdapter.ets:143-150`；`CommonInterface.ts` 的 ID 规则 |
| **判定** | hilog 里搜 `terminateSelf`（V4）；确认闪屏是否是第一个 `new BrowserWindow` |
| **修复** | ① 用 `hide()` 而非 `close()`；② 或让闪屏**不是**首窗口；③ 或改用页面覆盖层（最稳） |
| **验证** | V4（对应 A-44） |

#### B3. `show: false` 创建 + 稍后 `show()`

| 项 | 内容 |
|---|---|
| **现象特征** | 窗口**一直不出现**（不是"晚出现"） |
| **机制** | 可见性作为 `StartOptions.startupVisibility` 在创建时定死（§3.2）；事后 `showAbility()` 依赖托盘且 `getWindowContext()` 为 undefined 时**静默无操作**（§3.5） |
| **证据** | `AppWindowAdapter.ets:125`、`:228-236` |
| **判定** | 搜 `show: false`。**模板主窗口未使用该选项**（默认 `show:true`，✓ 已核实） |
| **修复** | 闪屏窗口**直接以 `show:true` 创建**；确需"先隐藏再出现"的，改成创建后 `hide()` |
| **验证** | V1、V3 |

#### B4. 等后端就绪后才建第一个窗口（空窗期）

| 项 | 内容 |
|---|---|
| **现象特征** | 启动后有一段**完全无窗口**的空白期（最长 = 等待超时，模板为 60s） |
| **机制** | 系统启动窗口已消失，而 Python/Java 后端探测还没结束，此间没有任何窗口 |
| **证据** | **模板已修复**：`main.js:326` `createWindow()` 已前移到 `:328` `await ensureBackend()` 之前（提交 `25063b3`） |
| **判定** | 查你自己的 `main.js`：`ensureBackend()` 是否在 `createWindow()` **之前** `await` |
| **修复** | 代码顺序对调：**先建窗显示**，等待过程交给页面/闪屏表达 |
| **验证** | V3 |
| ⚠️ **注意** | **原专项 §5 末"模板自身的坑（本次仅记录，未改代码）"已过期** —— 模板已修，见 §9 勘误 |

#### B5. 后端未就绪时弹出的模态对话框顶掉了等待动画

| 项 | 内容 |
|---|---|
| **现象特征** | 启动时弹出"后端服务未启动"模态框，而不是等待动画 |
| **机制** | 模板在 `USE_EMBEDDED_BACKEND=false`（默认，形态 A）且探测不到后端时，会 `await dialog.showMessageBox(...)`（`main.js:175-183`）。**这是一个模态框，且发生在窗口已显示之后** |
| **证据** | `main.js:174-186`；`dialog.showMessageBox` 在 API 表标注"支持"（`api_index.md:400`） |
| **判定** | 启动时是否看到"后端服务未启动"提示框 |
| **修复** | 期望"启动即看到等待动画"的场景（如正式演示/上架形态）：改用 `USE_EMBEDDED_BACKEND=true`，或把模态框换成页面内的非阻塞提示 |
| **验证** | V3 |

#### B6. 用 `opacity: 0` / `setOpacity(0)` 做"先隐藏后淡入" → 鸿蒙不支持设到 0（★ 新发现）

| 项 | 内容 |
|---|---|
| **现象特征** | 窗口**该隐藏时提前可见**（露出一块底色/白块），或淡入动画表现异常；`opacity` 设 0 完全无效 |
| **机制** | 官方 API 文档「差异说明」原文：**"在鸿蒙下透明度存在最低阈值，不支持设置到0"** |
| **证据** | 官方文档集 `docs/api/BrowserWindow/method-win-setOpacity.md` 的「差异说明」章节；本地副本 `_research/repo/docs/api/BrowserWindow/method-win-setOpacity.md` |
| **判定** | 代码里搜 `opacity` / `setOpacity`。注意：`transparent` / `opacity` / `backgroundColor` 的 alpha **三者有优先级**（官方口径：`transparent` > `opacity` > `backgroundColor` 的 alpha） |
| **修复** | 不要用"透明度 0"表达"不可见"。要隐藏就用 `win.hide()`（**前提：已建托盘**，见 B1）；要淡出用页面内 CSS `transition`（覆盖层方案天然规避此坑） |
| **验证** | **V8**（专测 `setOpacity(0)` 是否真的无效） |
| ⚠️ 附带矛盾 | 上游 Electron 文档说 `opacity` **仅 Windows/macOS 实现**，鸿蒙文档却说 `setOpacity` 支持（有阈值差异）。**以鸿蒙文档为准，但仍需实测**（§8-11） |

#### B7. ★★ 非首窗口创建**静默失败**：`createWindow` 全链无 `.catch()`（★ 本次最重要的新发现之一）

| 项 | 内容 |
|---|---|
| **现象特征** | **窗口压根没出现**，而且**日志里什么都没有**——没有报错、没有 warn、没有任何痕迹。应用照常运行，只是那个窗口不存在。若失败的是主窗口，就是"启动后什么都没有" |
| **机制** | `AppWindowAdapter.createWindow()` 整条链**只有 `.then()`，没有 `.catch()`**；而它依赖一个**用空 `ArrayBuffer(0)` 造 pixelMap** 的异步操作。一旦该 promise 被 reject 或抛错，`createWindow` **直接什么都不做**——不会调用 `LaunchHelper.LaunchWithOptions`，因此**不会创建 UIAbility、不会建窗** |
| **证据（源码）** | `AppWindowAdapter.ets:113-141`：<br>`image.createPixelMap(color, {...}).then((data) => { ... LaunchHelper.LaunchWithOptions(...) })`<br>—— **`.then()` 之后没有任何 `.catch()`**；`color` 是 `new ArrayBuffer(0)`（`:108`） |
| **判定** | ① 看 hilog 里有没有目标窗口的建窗痕迹（`AppWindowAdapter` 每个方法都有 `@LogMethod`）：**如果连 `createWindow` 的日志都没有，就命中这条**；② 用 V3 最小 case 试建第二个窗口；③ 直接读源码确认无 `.catch()`（无需真机） |
| **修复** | ① **短期绕过**：不要让关键窗口依赖这条路径的成败——把等待动画放在**页面内**（方案 1），它不依赖新建窗口；② **根治**：给 `AppWindowAdapter.createWindow` 补 `.catch()`（**改的是官方壳工程**，需接受升级冲突），并把 `new ArrayBuffer(0)` 换成真实图标数据；③ 至少在应用侧加"建窗超时告警"（例如 3 秒后 `BrowserWindow.getAllWindows().length === 0` 就打日志/提示） |
| **验证** | V3、V11（新增） |
| **为什么容易漏掉** | 它**不产生任何可观测信号**。常规排查（看日志、看报错）在这条路上**完全失效**，只能靠"数窗口数量"或代码审查发现 |

> ⚠️ **风险等级说明**：空 `ArrayBuffer` 造 pixelMap 在真机上的实际行为，**源码里无法判定**（可能成功返回空图，也可能 reject）。但**"没有 `.catch()`"是确定的代码缺陷**——即使它今天恰好不触发，也是一个随时会爆的静默失败点。**建议无论如何都补上 `.catch()`。**

#### B8. 托盘创建与"活动窗口上下文"的循环依赖

| 项 | 内容 |
|---|---|
| **现象特征** | 托盘没建起来（`[tray] create failed`），进而窗口显隐异常；启动阶段日志里可能出现 `no active window context` |
| **机制** | ArkTS 侧创建托盘走 `statusBarManager.addToStatusBar(this.ctxAdapter.getActiveContext(), ...)`（`StatusBarManager.ets:104-128`），而 `getActiveContext()` 在**没有任何活动窗口时返回 `undefined`**（`ContextAdapter.ets:59-71`，并打印 `no active window context`）→ 抛错 → 被 catch → `onCompleted(false)`（`StatusBarManager.ets:129-132`）→ Electron 侧 `new Tray()` 失败 |
| **证据** | `StatusBarManager.ets:104-132`；`ContextAdapter.ets:59-71`；`project-template/.../app/main.js:269-285`（catch 只 warn） |
| **推论** | 官方要求"**启动应用前先创建托盘**"，但托盘创建**又需要一个已存在的活动窗口上下文**。在 Electron 体系下，冷启动那一刻活动窗口是**启动器拉起的 EntryAbility**，所以模板的 `createTray()`（在 `app.whenReady()` 里、此时该 Ability 已存在）**通常能成功**。但这是**隐式依赖**——若应用改成"无窗口纯托盘启动"，或首个窗口尚未就绪，就会失败 |
| **判定** | 抓日志看 `[tray] create failed` 与 `no active window context`（V2） |
| **修复** | 保持"托盘在 `app.whenReady()` 内、所有 `new BrowserWindow()` 之前"的顺序**不动**（模板已正确）；**不要**把 `createTray()` 挪到窗口创建之后，也不要改成无窗口启动 |
| **验证** | V2 |

#### B9. 托盘"快捷操作"的 `abilityName` 是空串（潜在缺陷）

| 项 | 内容 |
|---|---|
| **机制** | `StatusBarManager.ets:112-113` 里 `quickOperation` 的 `abilityName: ""`，而右键菜单项才写了 `abilityName: 'StatusBarEntryAbility'`（`:216-217`） |
| **影响** | 可能影响托盘左键/快捷操作的响应。**与"闪屏不显示"关系较远**，但排查托盘问题时值得一并知道（列此以免误判） |
| **验证** | V2（顺带观察托盘左键是否正常） |

### 【C 级】内容/渲染原因

#### C1. 动画依赖 JS 定时器/框架挂载 → 首帧前不跑

| 项 | 内容 |
|---|---|
| **现象特征** | 画面出来了，但**动画不动**（静态圆环） |
| **机制** | 阶段 ④ 之前 JS 未就绪；`setInterval` 类动画起不来。**CSS/SVG 动画由渲染引擎在首帧即可绘制** |
| **证据** | 🟡 机制推断；模板 renderer 页当前**无任何动画**，无法据此判断 |
| **判定** | DevTools 里看 Elements 面板该元素有无 `animation` 生效 |
| **修复** | 改用**纯 CSS/SVG 动画**（原专项 §5 给的 `@keyframes ring-turn` 即是） |
| **验证** | V3 |

#### C2. 透明窗口内绘制不出内容（alpha 合成问题）

| 项 | 内容 |
|---|---|
| **现象特征** | 窗口存在、能点，但**看不见内容** |
| **机制** | 🟡 `transparent` 为整窗语义；SURFACE 的 alpha 合成表现未知 |
| **证据** | ⚠️ **A-43**，无源码级结论 |
| **判定** | V5：设 `transparent:true` + 纯色 HTML 内容，看内容是否绘制 |
| **修复** | 不用 `transparent`；走 `init_color_argb` / `setOpacity`（⚠️ 待实测） |
| **验证** | V5 |

#### C3. 页面加载失败 / 自检页挡住了闪屏

| 项 | 内容 |
|---|---|
| **现象特征** | 看到的是**自检页/主界面**，从没看到闪屏 → 说明"闪屏"逻辑压根没接上 |
| **机制** | **当前模板的 renderer 里根本没有闪屏覆盖层**（本次核实：`renderer/index.html` 中 `splash` / `ring` / `onBackendReady` **零命中**）；虽然 `preload.js:44` 已暴露 `onBackendReady`、`main.js:330` 已发送 `EVT_BACKEND_READY`、`channels.js:31` 已定义通道 —— **管道通了，UI 没接** |
| **证据** | `renderer/index.html`（无 `#splash`）；`preload.js:44`；`ipc/channels.js:31`；`main.js:330` |
| **判定** | 直接搜你工程 renderer 里的 `splash` / 是否调用 `onBackendReady` |
| **修复** | 见 §6 方案 1 的完整代码（原专项 §5 已给，本文补"为什么必须这么做"与落地注意点） |
| **验证** | V3 |

#### C4. 系统启动窗口与页面视觉不连续 → 被误认为"闪屏没显示"

| 项 | 内容 |
|---|---|
| **现象特征** | 看到"白闪一下"或"白→深色突变"，主观判断为"闪屏坏了" |
| **机制** | 阶段 ① 底色 = `#FFFFFF`（`color.json`）；阶段 ② 底 = `#ffffffff`（`Index.ets` initStyle）；阶段 ④ 页面底 = `#f5f7fa`（亮）/ `#111827`（暗，`prefers-color-scheme`）。**暗色模式下必然出现"白屏 → 深色"的突变** |
| **证据** | `color.json`（`start_window_background = #FFFFFF`）；`Index.ets`（`backgroundColor: 'ffffffff'`）；`renderer/index.html:14,35-37` |
| **判定** | 逐帧看启动首秒的颜色序列（V1）；分别在亮/暗色系统主题下各测一次 |
| **修复** | §6 方案 0：把 `start_window_background` 与 `Index.ets` 初始底色、页面底色**统一成同一个值**；图标用应用自己的 logo |
| **验证** | V1（亮/暗各一次） |
| ⚠️ 附带疑问 | `prefers-color-scheme` 在鸿蒙上是否生效未知（已知 `nativeTheme` 暗色模式失效，需轮询 `getprop persist.sys.dark_mode`）→ 记为待确认项 §8-6 |

#### C5. ★ 容易误判的一类：GPU/渲染链路故障导致的"白屏"（与闪屏无关）

| 项 | 内容 |
|---|---|
| **为什么单列** | 社区里称为"白屏"的案例，**多数根本不是你这个问题**——它们指的是"窗口起来了、标题栏都在，但**内容区**画不出来"，属于 Chromium GPU 子进程反复重启。若不先排除，很容易把"渲染坏了"当成"闪屏没显示"来查，方向完全错 |
| **典型日志特征** | `StartChildProcess command --use-gl=egl`、`GPU state invalid after WaitForGetOffsetInRange`、`GPU process start times: 131`（反复重启计数暴涨） |
| **证据（社区）** | `research/csdn_markdownify.txt:450-486`（现象与日志）、`:511-569`（修复：改 `common/CommandLineAdapter.ets` 里的 `--use-gl=egl` → `--use-gl=disabled`）、`research/csdn_keng.txt:514-559`（模拟器白屏，`app.disableHardwareAcceleration()` 解决） |
| **与本文问题的区分判据** | **内容区白屏 = 窗口/标题栏已可见但页面空白**；**本文的"闪屏不显示" = 等待阶段没有任何等待画面**。前者是渲染故障，后者是时序/架构问题 |
| **修复** | 只针对确认是 GPU 故障的场景：改 GL 后端或 `app.disableHardwareAcceleration()`。⚠️ **不要用它来"修闪屏"**——禁用硬件加速有性能代价，且与本问题无关 |
| **验证** | **V9**（先看 hilog 有无 GPU 进程重启刷屏） |
| ⚠️ 注意 | 上述两条证据均来自 CSDN 二手文章（模拟器场景），**真机是否复现未知**；记为待确认项 §8-12 |

---

## 5. 调查方向：30 秒分流 + 完整决策树

### 5.1 30 秒分流（先做这个，别急着读代码）

| 你看到的 | 直接跳到 |
|---|---|
| 应用**退出/闪退**了 | **B2** → 用例 V4 |
| 有一段**纯色**（白/黑）但没有动画 | **A1** → 用例 V1 → 方案 0+1 |
| **完全没有任何窗口** | **B1 / B3 / B4** → 用例 V2、V3 |
| 看到了**主界面/自检页**但没有闪屏 | **C3** → 方案 1 |
| 闪屏**出现了但是个不透明方块** | **A2 / C2** → 用例 V5 |
| 动画**出现了但不动** | **C1** |

### 5.2 完整决策树

```
启动应用
│
├─ 应用是否退出？ ──是──→ 【B2】首窗口 close→terminateSelf
│                        证据: AppWindowAdapter.ets:143-150
│                        用例: V4（hilog 抓 terminateSelf）
│
└─ 否
   │
   ├─ 有没有出现任何窗口？ ──否──→ 检查托盘与建窗顺序
   │                              ├─ createTray 在第一个窗口之前？ → 否 →【B1】
   │                              ├─ 有 show:false？              → 是 →【B3】
   │                              └─ ensureBackend 在 createWindow 之前？ →【B4】
   │                              用例: V2、V3
   │
   └─ 是
      │
      ├─ 出现的是纯色？ ──是──→【A1】架构错位（最可能）
      │                        检查是否另有独立闪屏窗口 →【A3】
      │                        用例: V1、V6
      │
      └─ 出现的是页面内容？
         │
         ├─ 动画元素存在但不动 →【C1】改 CSS/SVG 动画
         ├─ 完全看不到动画元素 →【C3】覆盖层压根没实现
         └─ 颜色突变/白闪     →【C4】视觉对齐（方案 0）
```

### 5.3 三种典型画像 → 最可能原因（按先验概率排序）

| 画像 | 排序 |
|---|---|
| **原 Windows 工程用独立透明闪屏窗口** | A3 → A2 → B2 → B3 |
| **已改用主窗口内覆盖层，但仍是纯色一段** | A1 → C4 → B4 |
| **完全没有任何画面** | B1 → B3 → B4 |

---

## 6. 修改方案（4 套，按成本/风险排序）

### 方案 0：视觉对齐（零代码风险，必做）

> ✅ **已实装到 `project-template`**（本次）。实现形式：`renderer/index.html` 的 `:root` 里定义 CSS 变量
> `--startup-bg: #ffffff`，并在 ①②③ 三处都加了互相指引的注释。三处当前均为纯白，已核验一致。

**目标**：让 ①→②→④ 三段的底色**完全一致**，使"无动画期"不被察觉。

**⚠️ 按 §2.2 的结论，对齐目标是"白色"**（冷启动走 `module.json5` 的 `start_window_background = #FFFFFF`）。
因此**只需保证下面三处一致**（页面自身的 `#f5f7fa` 属于"淡出之后"的观感，与启动瞬间无关）：

| # | 改动 | 位置 | 动作 |
|---|---|---|---|
| ① | 系统启动窗口底色 | `electron/src/main/resources/base/element/color.json` | `start_window_background`（当前 `#FFFFFF`） |
| ② | ArkTS 页初始底色 | `electron/src/main/ets/pages/Index.ets` | `initStyle.backgroundColor`（当前 `'ffffffff'` = 白，ARGB 无 `#` 前缀） |
| ③ | **覆盖层底色** | `app/renderer/index.html` 的 `--startup-bg` | 与 ①② 一致（当前 `#ffffff`） |
| ④ | 启动窗口图标（可选） | `AppScope/resources/base/media/startIcon.png` | 换成应用自己的 logo（当前是壳工程的 1024×1024 图标） |

> ⚠️ **只对冷启动有效**：`module.json5` 的这两个字段**只作用于启动器冷启动那一次**；
> Electron 之后新建的窗口走 §2.2 那条"空白图 + 全透明"路径，改这里对它们无效。

**副产品**：即使不修动画，观感也会从"白闪 + 突变"变成"平滑接力"。

### 方案 1：页面覆盖层（★ 推荐，Windows/鸿蒙行为一致）

> ✅ **已实装到 `project-template`**（本次）。落点：`app/renderer/index.html` 的 `#splash`
> （内联 SVG 圆环 + CSS `@keyframes` 动画），控制逻辑在同一文件的"启动等待覆盖层的显隐控制"脚本块。
> §7 用例 V3/V7 可直接用来验证它。

**覆盖范围**：阶段 ④ → ⑤（Electron 首帧 → 业务就绪）。
**不需要任何跨边界信号**（这是它相对方案 2 的决定性优势，理由见 §3.6）。

**分工**：

| 环节 | 改动 |
|---|---|
| main.js | 已就绪 ✅ —— `createWindow()` 先于 `ensureBackend()`（`:326` vs `:328`），就绪后发 `EVT_BACKEND_READY`（`:330`） |
| preload.js | 已就绪 ✅ —— `onBackendReady` 已暴露（`:44`） |
| channels.js | 已就绪 ✅ —— `EVT_BACKEND_READY: 'backend:ready'`（`:31`） |
| **renderer 页面** | ❌ **待补** —— 需要加覆盖层 DOM + CSS 动画 + 订阅 `onBackendReady` 后淡出 |

**落地注意点（本次实装后修订，与原专项的建议有一处不同）**：

1. **★ 覆盖层不要盖住自绘标题栏 → 用 `top: 36px`，而不是 `inset: 0`**（**此处修正本文 v1.0 的建议**）。
   原建议是"连标题栏一起盖住，启动期间不该允许拖窗/关窗"。但实装后发现问题：**后端一直不就绪时要等到 90s 硬超时才解除遮挡，用户在这段时间内连窗口都关不掉**——这是不可接受的。
   正确做法：覆盖层从标题栏下方开始（`position: fixed; left:0; right:0; top:36px; bottom:0; z-index:9999`），
   与 `body` 的 `padding-top: 36px` 对齐。等待期间标题栏仍可拖动/最小化/关闭。
2. **淡出后必须 `pointer-events: none`**，否则会挡住下面的自检按钮（原专项代码已含，务必保留）。
3. **后端失败时不要留白**：`onBackendReady({ok:false})` 时要给出提示（否则用户面对一个永远不消失的转圈）。
4. **动画用纯 CSS/SVG**（`@keyframes`），不要用 `setInterval` 驱动动画（原因见 C1）。
   注意区分：**轮询后端状态**可以用 `setInterval`（那不是动画，晚一点无妨）；**动画本身**必须交给 CSS。
5. **首帧一致性**：覆盖层底色应与方案 0 统一后的颜色相同，否则阶段 ②→④ 仍有一次突变。
6. **★ 必须有"事件丢失"兜底**（实装时新增，本文 v1.0 未提）：
   主进程是 `createWindow()` → `await ensureBackend()` → `webContents.send(EVT_BACKEND_READY)`。
   若后端**本来就在跑**，`probeBackend()` 几乎立刻返回，**事件可能在页面脚本注册监听之前就发出而丢失**。
   → 因此不能只依赖事件：需再加"页面自己轮询 `/api/ping`"作为兜底（实装里 1.2s 一次，最多 75 次）。
7. **★ 必须有硬超时兜底**：主进程异常、后端永不来、事件又丢了 —— 任何一种都不该让用户永久停在转圈。
   实装为 90s 后强制淡出并显示"启动超时"提示。
8. **★ 不要引入外部图片资源**：覆盖层的 logo/图标用**内联 SVG** 画。
   原专项示例里的 `<img src="logo.png">` 有真实风险——`check-app-manifest.js` 的 REQUIRED 清单与 electron-builder 的
   `files` 白名单都只覆盖 `.js`，新增图片很容易"没打进包"，从而变成又一个静默失效（见《主进程模块化专项》§构建期防复发）。

### 方案 2：ArkTS 层闪屏（能覆盖最早的 ②–③，但有前置缺口）

**覆盖范围**：阶段 ② → ④（比方案 1 **早一整个 Electron 启动期**）。
**这是"最接近 Windows 观感"的方案**，因为 Windows 上那段动画本来就出现在应用页面渲染之前。

**已有可抄的现成范式**（本次新发现）：壳工程里已有"**原生 ArkTS 窗口**"的完整实现，在 `adapter/AppWindowAdapter.ets:644-730`（`showHuaweiQuickLogin`）：

```ts
// AppWindowAdapter.ets:679-690（原文节选）
let config: window.Configuration = {
  name: 'login',
  windowType: window.WindowType.TYPE_DIALOG,   // ★ 原生窗口类型
  ctx: activeContext
};
window.createWindow(config, (err, data) => { ... });
// 随后： windowClass.showWindow(cb)          ← 原生 showWindow（:712）
//        windowClass.loadContent("pages/Login", storage, cb)  ← 载入 ArkTS 页面（:722）
```

**插入点**：`electron/src/main/ets/pages/Index.ets` 的 `build()` 当前是

```ts
build() {
  Row() { WebWindow() }           // ← WebWindow 即 Electron 画面容器
  .backgroundColor(this.backgroundColor_)
  .opacity(this.opacity_)
  ...
}
```

用 `Stack()` 包一层，把 ArkTS 闪屏组件叠在 `WebWindow()` 之上即可：

```ts
build() {
  Stack() {
    Row() { WebWindow() }.width('100%').height('100%')
    if (this.showSplash) { MyArkTSSplash() }     // ★ ArkTS 层闪屏，能盖住 Electron 启动期
  }
  .backgroundColor(this.backgroundColor_)
  .width('100%').height('100%')
}
```

**⚠️ 但必须先解决两个前置问题（原专项都没交代）**：

#### 前置问题 1：ArkTS 动画层能不能盖在 Electron 画面之上？——**未证实**

`WebWindow.ets:81-85` 用的是 `XComponentType.SURFACE` + `NodeContainer`。**`SURFACE` 类型 XComponent 走独立图层是已知特性，但本仓源码里找不到任何"ArkUI 组件能叠加在 SURFACE 之上"的证据或验证代码**（全仓无 z-order/合成相关说明）。

→ **不要想当然认为 `Stack(){ WebWindow(); Splash() }` 就能盖住 Electron 画面。** 需先做一次最小验证（V12）。若叠不上，备选：改用 `XComponentType.TEXTURE`（性能换可控性），或放弃 ArkTS 闪屏转方案 0+1。

#### 前置问题 2：退场信号走哪条路？——**有一条现成通道，不必改壳工程**

§3.6 已证明**不存在"Electron 首帧"通知**。但本次新发现一条**现成可用**的替代通道：

> **`win.setBackgroundColor()` / `win.setOpacity()` → `WindowStyle` → `Index.ets` 的 `updateStyle` 回调 → `@State` 变更 → ArkUI 重绘**

证据链（全部为源码事实）：

| 环节 | 位置 |
|---|---|
| Electron 调用 | `win.setBackgroundColor(...)`（官方文档标注**"无差异"**） |
| AKI 绑定名 | `AppWindow.SetBackgroundColor` / `AppWindow.SetOpacity`（`AppWindowAdapterBind.ets:115-121,220-221`） |
| ArkTS 实现 | `AppWindowAdapter.setBackgroundColor/setOpacity`（`:474-497`） |
| 转成回调 | `WindowStyle.getUpdateStyleFunc(id)?.(data)`（`WindowStyle.ets:19-24`） |
| 到达页面 | `Index.ets:63-69` 的闭包 → `this.backgroundColor_ / this.opacity_` |
| 触发重绘 | `Index.ets:86-87` 的 `.backgroundColor()/.opacity()` 绑定在 `@State` 上 |

**用法**：在 `ready-to-show`（或 `did-finish-load`）里调一次 `win.setBackgroundColor(同一个颜色)`，ArkTS 侧就会收到回调——把它当作"Electron 已就绪"的信号，用来撤掉 ArkTS 闪屏。
**注意**：
- 当前 `main.js` **没有调用**这两个 API（已核实），需要自己加。
- 优先用 `setBackgroundColor`（官方"无差异"），**别用 `setOpacity(0)`**（有最低阈值，见 B6）。
- 这条通路的语义是"样式变更"而非"首帧通知"，属于**借用**；稳妥起见仍建议配一个定时兜底。

**四条出路对比（更新版）**：

| 出路 | 做法 | 评价 |
|---|---|---|
| **① 借用 `setBackgroundColor` 回调（★ 新增，推荐）** | Electron 在 `ready-to-show` 调 `win.setBackgroundColor(...)`；ArkTS 在 `updateStyle` 回调里撤闪屏 | **不需改壳工程**；精确度取决于 `ready-to-show` 的时机（官方标注"页面渲染完成且可无闪烁显示时触发"，语义上接近首帧） |
| **② 定时兜底** | XComponent `onLoad`（`WebWindow.ets:92`）后延迟 N ms 淡出 | 实现最简单；N 需实测，慢机器上会闪一下主界面 |
| **③ 注册 `callArkTSFunction`** | 需在 AKI 层注册 `EtsBridge.*` 函数（本模板未注册任何；且随包 `libelectron.so`/`libadapter.so` 中搜不到 `EtsBridge`/`callArkTSFunction` 字符串） | **最精确但成本最高**，且该接口在**本模板所用 Electron 构建中能否可用尚未确认**（§3.6、§8-13） |
| **④ 不做 ArkTS 闪屏** | 只做方案 0 + 方案 1 | 最稳；代价是 ②–③ 那段（Electron 启动期）没有动画 |
| ~~⑤ 复用 `OnWindowEvent`/`OnWindowVisibilityChange`~~ | 这些是 **ArkTS→Electron** 方向 | ❌ 方向反了，不可行 |

> **建议**：先做方案 0 + 方案 1（零风险、可立即验证）；方案 2 作为"阶段二增强"，**先跑 V12 确认 SURFACE 叠加可行**，再按 ①+② 组合实现。

### 方案 3：独立闪屏窗口（❌ 不推荐）

**为什么明确不推荐** —— 它会同时触发三条约束，且每条都有独立失败模式：

| 约束 | 触发点 | 后果 |
|---|---|---|
| 可见性创建时定死 | §3.2 `startupVisibility` | `show:false` 后 `show()` 可能永远不生效 |
| 托盘强绑定 | §3.3 `ATTACH_TO_STATUS_BAR_ITEM` | 顺序错则窗口不显示；托盘静默失败则无任何报错 |
| 首窗口 `close()` = 终结 | §3.4 `terminateSelf()` | 闪屏若是首窗口并 `close()` → 应用退出 |

**若因历史原因必须保留独立闪屏窗口**，最低要求：

1. `createTray()` 必须在它之前；
2. 它以 `show:true` 创建（不要 `show:false`）；
3. 结束时 `hide()`，**绝不 `close()`**；
4. 它**不能**是第一个 `new BrowserWindow`；
5. 去掉 `transparent` / `skipTaskbar`（后者 API 表明确**不支持**：`api_index.md:285`）；
6. `createTray()` 的 catch 必须上报，不能只 `console.warn`。

---

## 7. 真机验证方案（可执行）

### 7.1 前置准备

```bash
# 1) 确认设备在线
hdc list targets

# 2) 抓「窗口生命周期」关键字日志（★ 全程保持这个窗口，后面所有用例都靠它）
hdc shell hilog | grep -iE "AppWindowAdapter|AbilityManager|showAbility|hideAbility|terminateSelf|WindowEvent|Visibility"

# 3) 抓「主进程 console」日志（模板的 console.log/warn 都在这里，托盘失败只有这里能看到）
hdc shell hilog | grep -iE "\[window\]|\[tray\]|\[backend\]|\[redirect\]|\[scheme\]|\[app\]"

# 4) 抓当前 Ability/窗口数量
hdc shell aa dump -a | grep -i <你的bundleName>
```

> 💡 **模板自带的判读锚点**（`main.js` 里已埋好日志）：
> - 启动顺序证据：`[window] workArea=... mode=... applied=... fill=...`
> - 托盘失败：`[tray] create failed: ...` ← **最容易被忽略、也最关键的一条**
> - 后端：`[backend] already up` / `[backend] not running (dev mode...)` / `[backend] ready`
> - 模块漏打包：`boot: module MISSING ...`（`main.js:35-38`）

### 7.2 验证用例 V0–V12

> **V0 是前提**：先确认"你的工程里到底有没有闪屏代码"，否则后面全在白测。

| # | 用例 | 怎么做 | 预期/判读 | 对应原因 |
|---|---|---|---|---|
| **V0** | **静态自查**（无需真机） | 在你的 `main.js` 搜：`transparent`、`skipTaskbar`、`show: false`、`new Tray(` 的行号、`splash.close()`、`parent:`/`modal:`、`setInterval`；在 renderer 搜 `splash` | 命中越少越好。`new Tray(` 必须早于任何窗口；`splash.close()` 命中即 B2 高危 | 全部 |
| **V1** | **录屏逐帧看首 5 秒** | 手机/系统录屏 → 逐帧看颜色序列 | 记录：① 有无静态图标段 ② 有无纯色段（多长）③ 有无动画 ④ 有无白闪/突变 | A1、C4 |
| **V2** | **托盘是否真的建起来了** | 看 `[tray] create failed` 是否出现；同时看任务栏有无托盘图标 | 出现该行 ⇒ 命中 B1，且后续窗口行为不可信 | B1 |
| **V3** | **最小 case：Tray 先建 + 非透明窗口 + 纯 CSS 动画** | 新建最小 `main.js`：`app.whenReady()` → `createTray()` → `new BrowserWindow({width:400,height:400,frame:false,show:true})` → 载入一个**纯 CSS 圆环动画**的 HTML | ① 窗口能否稳定显示（验证 P1/P3）② 动画能否跑（验证 C1）| B1/B3/C1（=A-42） |
| **V4** | **首窗口 close 是否终结应用** | 故意让第一个窗口在 3 秒后 `close()` | 应用退出/主界面异常 ⇒ 命中 B2（=A-44） | B2 |
| **V5** | **`transparent` 的真实表现** | `new BrowserWindow({transparent:true, frame:false})` + **不透明纯色** HTML 内容 | 内容是否绘制？整窗是否透明到看不见？（=A-43） | A2、C2 |
| **V6** | **数窗口/Ability 数量** | 启动过程中 `hdc shell aa dump -a \| grep -i <bundleName>` | 出现多余 Ability ⇒ 有独立闪屏窗口（A3） | A3 |
| **V7** | **背面验证：后端就绪信号是否到达页面** | 在 renderer 里 `console.log` 一次 `onBackendReady` 回调；用 `--remote-debugging-port` 或 `openDevTools()` 看 | 回调到达 ⇒ 方案 1 的管道可用，只差 UI | C3 |
| **V8** | **`setOpacity(0)` 是否真的无效** | 主窗口创建后调 `win.setOpacity(0)`，看窗口是否真的看不见 | 仍可见/半可见 ⇒ 证实"最低阈值"差异（B6）；此结论决定"能否用透明度做淡入淡出" | B6 |
| **V9** | **排除 GPU 渲染故障** | 抓 hilog 搜 `GPU process start` / `WaitForGetOffsetInRange` / `StartChildProcess` | 出现反复重启刷屏 ⇒ 内容区白屏属于渲染故障（C5），与闪屏无关，先修它 | C5 |
| **V10** | **冷启动 vs 二次建窗的启动画面差异** | ① 杀掉应用后从桌面图标冷启动，看首屏；② 应用内触发第二次 `new BrowserWindow`，看它出现前屏幕是什么 | 冷启动有白色+图标、二次建窗"什么都没有" ⇒ 证实 §2.2 的"空白+透明"结论（A4） | A4 |
| **V11** | **★ 验证 B7：非首窗口会不会静默建不出来** | 在 `main.js` 里两次 `new BrowserWindow()`，并在建窗前后各打一行日志 + 延时 3 秒打印 `BrowserWindow.getAllWindows().length` | 若窗口数没增加、且 hilog 里**没有** `AppWindowAdapter` 的建窗日志 ⇒ **B7 已在实际触发**（空 buffer 造图失败），必须补 `.catch()` | **B7** |
| **V12** | **★ 验证方案 2 的前提：ArkUI 能否叠在 SURFACE 之上** | 把 `Index.ets` 的 `Row(){ WebWindow() }` 临时改成 `Stack(){ WebWindow(); Text('SPLASH').fontSize(40) }` | 能看到 "SPLASH" 且**能盖住 Electron 画面** ⇒ 方案 2 可行；看不到/被画面盖住 ⇒ 方案 2 需改用 `XComponentType.TEXTURE` 或放弃 | **方案 2** |

### 7.3 日志判读速查表

| 日志/现象 | 结论 |
|---|---|
| `[tray] create failed` | B1 命中；**先修这个再查其它** |
| hilog 里**没有** `AppWindowAdapter` 的 createWindow 相关行 | 建窗逻辑压根没走到（多半先等后端或异常早退） → B4 |
| hilog 出现 `terminateSelf` | B2 命中 |
| `showAbility fail` | B3 命中（可见性/上下文问题） |
| `showAbility success` 但屏幕无变化 | 窗口存在但未 attach 到可见 surface → 查 §3.3 托盘 / A1 |
| `[window] ... mode=simple applied=setSimpleFullScreen` | 窗口铺满逻辑正常（与本文无关，但可交叉验证窗口链路是通的） |
| 有纯色段但无动画 | A1（架构错位） |

### 7.4 取证清单（建议一次抓全，避免反复上机）

1. `hdc shell hilog` 全量日志文件（至少覆盖启动后 30 秒）
2. 启动过程录屏（逐帧可分析）
3. `hdc shell aa dump -a` 输出
4. 亮色 + 暗色系统主题各测一次（C4 需要）
5. `USE_EMBEDDED_BACKEND=false` 与 `true` 各测一次（B5 需要）
6. 代码快照：你的 `main.js` 建窗段 + renderer 的 HTML 头部

### 7.5 验收标准

| 目标 | 可判定标准 |
|---|---|
| 无"无画面期" | 从点图标到出现内容，**全程无空白帧** |
| 无视觉突变 | 逐帧颜色序列中**不出现**明显的亮/暗跳变 |
| 有等待反馈 | 业务未就绪期间**有持续动画**，且动画在动（非静态图） |
| 正常收敛 | 业务就绪后动画**淡出**，且淡出后**不挡操作**（能点按钮） |
| 失败可见 | 后端起不来时**有明确提示**，而不是无限转圈或空白 |
| 不回归 | 窗口尺寸/无边框/自绘三键行为不变 |

---

## 8. 待确认清单（无真机时无法确定，上机后逐条销项）

| # | 待确认 | 影响 | 对应用例 |
|---|---|---|---|
| 1 | 模块 @ohos.window 是否允许从 ArkTS 侧直接创建窗口 | 决定方案 2 能否复用 `showHuaweiQuickLogin` 的范式 | V3 |
| 2 | `init_color_argb` 的 alpha 是否产生真实透明效果 | 决定 A2 的替代方案 | V5 |
| 3 | `win.setOpacity()` 在鸿蒙上的实际效果（API 表标注"支持"） | 同上 | V5 |
| 4 | 第一个 `new BrowserWindow` 是否**必然**复用入口 EntryAbility | 决定 B2 严重度 | V4、V6 |
| 5 | 首窗口 `close()` 是"应用退出"还是仅"窗口消失" | 决定 B2 严重度 | V4 |
| 6 | `prefers-color-scheme` 在鸿蒙上是否生效 | 决定 C4 的暗色方案 | V1（暗色） |
| 7 | 阶段 ②–③ 的实际时长（Electron 冷启动耗时） | 决定方案 2 的定时兜底 N 值是否可行 | V1 |
| 8 | 系统启动窗口能否自定义为动画 | 若可以，A1 的整体结论要改 | （建议查官方文档） |
| 9 | 托盘创建失败时的真实表现 | 决定 B1 的实际严重度 | V2 |
| 10 | ~~冷启动显示白色还是透明启动窗口？~~ **已由源码链确定 = 白色**（§2.2 末），V10 仅作低成本确认 | 方案 0 对齐白色 | V10（确认） |
| 11 | `setOpacity(0)` 在真机上是否真的无效、最低阈值是多少 | 决定能否用透明度做淡入淡出（B6） | V8 |
| 12 | CSDN 所述的 GPU 白屏在**真机**上是否复现（原文是模拟器场景） | 决定 C5 是否需要单列排查 | V9 |
| 13 | ~~`callArkTSFunction` 能否用~~ **降级为可选**：A 路已确认本壳未注册任何 `EtsBridge.*`、随包 so 里也搜不到该字符串 → **优先走方案 2 的出路①（`setBackgroundColor` 回调）**，不要依赖它 | 方案 2 退场信号 | — |
| 14 | `win.setAlwaysOnTop` 在**主窗**上确实可用（官方称子窗/悬浮窗不支持） | 决定闪屏窗口若用悬浮窗形态能否置顶 | V5 |
| 15 | **★ ArkUI 组件能否叠加在 `XComponentType.SURFACE` 之上**（方案 2 的可行性前提，源码无证据） | 决定方案 2 是否可行 | V12 |
| 16 | `image.createPixelMap(new ArrayBuffer(0), ...)` 在真机上成功还是 reject（决定 B7 是否**已经在**触发） | 决定 B7 的紧急程度 | V11 |
| 17 | `getActiveContext()` 在 `app.whenReady()` 时刻是否已可用（决定 B8 的循环依赖是否实际发生） | 决定 B8 的严重度 | V2 |

---

## 9. 附录

### A. 证据索引（本文引用的全部 文件:行号）

| 证据 | 位置 | 证明了什么 |
|---|---|---|
| `loadContent('pages/Index')` | `web_engine/src/main/ets/ability/WebAbility.ets:163` | 阶段 ② 起点 |
| `getContentPath() → 'pages/Index'` | `.../ability/WebBaseAbility.ets:107-109` | 同上 |
| 装饰可见性 / 悬停 | `.../ability/WebAbility.ets:171,178,182,187` | 无边框相关（旁证） |
| `windowVisibilityChange` 转发 | `.../ability/WebAbility.ets:145-147` | ArkTS→Electron 通知面 |
| `startupVisibility` 定死可见性 | `.../adapter/AppWindowAdapter.ets:125` | **B3** |
| `processMode: ATTACH_TO_STATUS_BAR_ITEM` | `.../adapter/AppWindowAdapter.ets:124` | **B1** |
| `closeWindow → terminateSelf` | `.../adapter/AppWindowAdapter.ets:143-150` | **B2** |
| `showWindow → showAbility` | `.../adapter/AppWindowAdapter.ets:228-236` | **B3** |
| `hideWindow → hideAbility` | `.../adapter/AppWindowAdapter.ets:238-246` | B2 的对照 |
| 原生 ArkTS 建窗范式 | `.../adapter/AppWindowAdapter.ets:644-730`（建窗 `:679-690`、show `:712`、loadContent `:722`） | **方案 2 的可行性依据** |
| `NewWindowParam`（**无 transparent**） | `.../interface/CommonInterface.ts:300-317` | **A2** |
| `WindowType{MAIN,SUB,FLOAT}` | `.../interface/CommonInterface.ts:292-298` | 窗口类型 |
| `hideTitleBar` 默认 true | `.../ability/WebBaseAbility.ets:51` | 默认装饰隐藏 |
| 窗口 ID 前缀 `browser` | `.../common/Constants.ets:33` | **B2** 的 ID 规则 |
| 窗口 ID 组装 | `.../common/AbilityManager.ets:60` | 同上 |
| `AppWindow.CreateWindow` 绑定 | `.../jsbindings/AppWindowAdapterBind.ets:40-41, 203` | **A2** 的传导链 |
| 托盘绑定入口 | `.../jsbindings/StatusBarManagerAdapterBind.ets:46,50,54` | **B1** |
| XComponent onLoad → runBrowser | `.../components/WebWindow.ets:92-95` | 阶段 ③ |
| ArkTS 页初始底色 `ffffffff` | `electron/src/main/ets/pages/Index.ets`（`initStyle`） | **C4** |
| `EntryAbility` 是 `WebAbility` 空壳 | `electron/src/main/ets/entryability/EntryAbility.ets:37-65` | 托盘不由 ArkTS 启动时创建 |
| 启动窗口配置 | `electron/src/main/module.json5:28-29` | 阶段 ① |
| 启动窗口底色 `#FFFFFF` | `electron/src/main/resources/base/element/color.json` | **C4** |
| 建窗先于等后端 | `.../app/main.js:326,328,330` | **B4 已修** |
| 托盘 try/catch 静默 | `.../app/main.js:269-285` | **B1 风险点** |
| 后端未就绪弹模态框 | `.../app/main.js:174-186` | **B5** |
| `onBackendReady` 已暴露 | `.../app/preload.js:44` | C3 管道已通 |
| `EVT_BACKEND_READY` 通道 | `.../app/ipc/channels.js:31` | C3 |
| renderer **无**闪屏 UI | `.../app/renderer/index.html`（全文件无 `splash`/`ring`/`onBackendReady`） | **C3** |
| 页面底色 | `.../app/renderer/index.html:14,35-37` | **C4** |
| `setSkipTaskbar` 不支持 | `research/api_index.md:285` | 方案 3 第 5 条 |
| `dialog.showMessageBox` 支持 | `research/api_index.md:400` | **B5** |
| Tray 支持面 | `research/api_index.md:883-917` | **B1**（`new-Tray` 支持） |
| `win-shadow` 不支持 | `research/api_index.md:321` | 窗口外观限制 |
| **★ 建窗用空白图 + 全透明底** | `.../adapter/AppWindowAdapter.ets:60,107-116,130-131` | **A4** |
| 建窗 abilityName / instanceKey | `.../adapter/AppWindowAdapter.ets:87,93` | **A4**、§2.2 |
| 官方「窗口显示隐藏」原文 | `research/rawgitcode_electron_readme.md:465-467`（改法在 `:478-489`） | §3.3 |
| 官方 `win.show`/`win.hide` 差异说明 | 官方文档集 `docs/api/BrowserWindow/method-win-show.md`、`method-win-hide.md` | §3.3 |
| 官方 `setOpacity` 差异（不支持设到 0） | 官方文档集 `method-win-setOpacity.md` | **B6** |
| 官方 `callArkTSFunction` 指南 | 官方文档集 `docs/call-arkts-function-guide/README.md` | §3.6 修正 |
| GPU 白屏（社区） | `research/csdn_markdownify.txt:450-486,511-569`；`research/csdn_keng.txt:514-559` | **C5** |
| `research/` 全域「闪屏」零命中 | `research/` 全目录搜索 | 素材缺口（见 §9-E） |

### A2. 官方文档来源一览（可复核 URL）

| 内容 | URL |
|---|---|
| 官方 README（窗口显示隐藏 / 首窗口指定大小 / 悬浮窗） | `https://raw.gitcode.com/zhangqingnan_codeing/Electron_CPF/raw/main/README.md` |
| 各 API 差异说明 | `https://raw.gitcode.com/zhangqingnan_codeing/Electron_CPF/raw/main/docs/api/BrowserWindow/<文件名>.md` |
| `callArkTSFunction` 指南 | `https://raw.gitcode.com/zhangqingnan_codeing/Electron_CPF/raw/main/docs/call-arkts-function-guide/README.md` |
| v40.1.0 源码（含 `ohos/` ArkTS 全套） | `https://raw.gitcode.com/zhangqingnan_codeing/Electron_CPF/raw/v40.1.0-openharmony/<路径>` |

> 带 `/` 的分支名需 URL 编码：`raw/feat%2Fapi-doc-optimization/...`。
> 已发现的全部分支：`main`（纯文档）、`feat/api-doc-optimization`、`main-api-doc-update`、`master-udpate-com`、`master-update-api-doc`、`v34.0.2-openharmony`、`v37.2.0-openharmony`、`v40.1.0-openharmony`。

### B. 与既有文档的关系与勘误

| 既有文档 | 状态 |
|---|---|
| 《鸿蒙PC迁移专项_启动闪屏定位与解决方案.md》 | 结论方向**正确**（三步定位法、六类问题、页面覆盖层方案均成立）。本文补充它未覆盖的内容：**A2**（`transparent` 无原生通道）、**A4**（建窗用空白图+全透明底）、**B6**（`setOpacity` 不能设 0）、**C5**（GPU 白屏易误判）、**§2.2**（系统启动窗口有两种）、**§3.6**（信号通道现状）、**§9-F/G**（素材缺口与口径冲突） |
| 同上 §5 末尾 | ⚠️ **已过期**：原文称"模板自身的坑：`await ensureBackend()` → `createWindow()`，本次仅记录，未改代码"。**实际已在提交 `25063b3` 修复**（`main.js:326` 建窗前移 + `EVT_BACKEND_READY` 事件链） |
| 同上 §2 对照表"等后端就绪后才 createWindow"一行 | ⚠️ **同上，已过期** |
| 同上 §5 ② | ⚠️ **需修正而非否定**：原文称"隐藏时机可用官方 `callArkTSFunction`"。经查该 API **官方确实存在**（有独立指南文档），但**本工程 E34 壳里未注册**，且官方列了 4 条限制（不支持异步、不支持结构化 Object 等）。原文缺了"需要自行在 AKI 层注册"这个前提，详见 §3.6 |
| 同上 §5 ② 与 §4 P4 的"透明"相关建议 | 与 **A2** 一致（改用实底 + CSS 圆角），本文补上了源码级依据 |
| 《鸿蒙PC迁移实施手册.md》A-42/A-43/A-44 | **仍未做**，本文 §7 已给出可执行用例（并新增 V7–V10） |
| 《鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md》 | 与本问题正交（管窗口尺寸/外框），但**同源**：都受 §3.2 可见性模型影响；且其 v1.1 修订中发现的 `setTitleAndDockHoverShown` 原语（`WebAbility.ets:187`）与本问题同属"壳工程既有能力未被文档记录"这一类 |

### C. 一页纸速查（上机时只看这页）

```
【上机前】V0 静态自查：搜 transparent / skipTaskbar / show:false / new Tray( 位置 / splash.close()
        ★ 再加两条源码缺陷自查（无需真机）：
          · AppWindowAdapter.createWindow 有没有 .catch()？（没有 = B7 静默失败风险）
          · 用了 setOpacity(0) 吗？（用不了 = B6）

【开机第一件事】
  hdc shell hilog | grep -iE "\[tray\]|\[window\]|\[backend\]|terminateSelf|showAbility|no active window context"

【30 秒分流】
  应用退出            → B2（首窗口 close=terminateSelf）
  纯色无动画          → A1（架构错位，最可能）
  完全没窗口          → B1/B3/B4/B7（托盘顺序 / show:false / 等后端才建窗 / ★建窗静默失败）
  看到主界面没闪屏    → C3（覆盖层压根没接）
  不透明方块          → A2/C2（transparent 无原生通道）
  动画不动            → C1（改 CSS/SVG 动画）
  内容区空白但窗口在  → C5（GPU 渲染故障，不是闪屏问题）

【三条最容易被忽略的"隐形杀手"】
  ★ B7  createWindow 无 .catch() → 建窗失败且零日志（数窗口数才发现）
  ★ B8  托盘创建需要"活动窗口上下文"→ 与"先建托盘"形成隐式循环依赖
  ★ B6  setOpacity(0) 无效 → 任何"透明度做隐藏"的方案都会露馅

【修复优先级】
  方案 0 视觉对齐（零风险，必做；对齐目标是白色，见 §2.2 末）
  → 方案 1 页面覆盖层（推荐，管道已通只差 UI）
  → 方案 2 ArkTS 层闪屏（覆盖最早阶段；先跑 V12 确认 SURFACE 能否叠加，
                          退场信号优先用 setBackgroundColor 回调，见方案 2）
  ✗ 方案 3 独立闪屏窗口（三条约束叠加，别碰）
```

### D. 术语表

| 术语 | 含义 |
|---|---|
| **系统启动窗口** | 系统绘制的静态闪屏（`startWindowIcon` + `startWindowBackground`），本文阶段 ① |
| **首窗口** | 第一个 UIAbility 窗口（`browser1`），官方模板 README 的"启动窗口大小"指它 |
| **XComponent / SURFACE** | ArkTS 侧承载 Electron 画面的绘制表面 |
| **`runBrowser()`** | XComponent `onLoad` 后启动 Electron 浏览器进程的调用 |
| **`ATTACH_TO_STATUS_BAR_ITEM`** | 窗口与托盘项绑定的 processMode |
| **`terminateSelf()`** | 销毁 UIAbility；Electron `win.close()` 的底层实现 |
| **`startWindowIcon` / `startWindowBackground`** | 系统启动窗口的图标与底色。**注意有两种**：`module.json5` 里那份（冷启动用）与 `AppWindowAdapter` 建窗时下发的那份（**空白+透明**），见 §2.2 |
| **AKI** | Electron 鸿蒙版的 ArkTS↔C++ 绑定框架；`callArkTSFunction` 依赖它注册函数 |

### E. ★ 离线检索环境（本次新建，后续排查直接复用）

官方 Electron_CPF 仓库（8 个分支，含 v40.1.0 全量 Electron fork 源码）已 clone 到本地：

```
_research/repo/            # 523MB，已加入 .gitignore，不会入库
```

**用法**（无需联网，比翻网页快得多）：

```bash
cd _research/repo

# 逐 API 差异说明（本次大量结论的来源）
grep -rn "差异说明" docs/api/BrowserWindow/method-win-show.md
cat docs/api/BrowserWindow/method-win-setOpacity.md

# 窗口显隐官方原文
git show main:README.md | sed -n '469,495p'

# 跨分支对比：本工程(E34) vs 最新(v40) 的建窗实现差异
git show v34.0.2-openharmony:ohos/app/ohos_hap/web_engine/src/main/ets/adapter/AppWindowAdapter.ets | sed -n '100,150p'
git show v40.1.0-openharmony:ohos/app/ohos_hap/web_engine/src/main/ets/adapter/AppWindowAdapter.ets | sed -n '100,135p'

# 确认某特性在哪个版本被移除
git grep -n "startupVisibility" $(git branch -r | grep -v HEAD | tr -d ' ')
```

### F. ★ 素材缺口（已知的"查不到"，避免重复劳动）

| 缺口 | 说明 |
|---|---|
| **官方「Electron启动白屏如何定位」帖正文** | 官方 README 只给了一个论坛外链（`topic/0204203363319759021`）。该页**由客户端 JS 渲染，抓不到正文**；本地 `research/` 里只有目录标题（`topic_0204203363319759021.txt:129`、`all_posts.txt:133`）。**若需要官方排障口径，必须人工在浏览器里打开该帖** |
| **`research/` 全域「闪屏」零命中** | 素材里没有"闪屏"这个词，只有「启动白屏」（内容区渲染问题）与 `startWindowIcon`（启动窗口配置）。**这两个是不同问题**，引用时勿混 |
| **官方文档对"启动闪屏"零描述** | 8 个分支全量 grep：`startWindowIcon`/`startWindowBackground` 只出现在 README 的 module.json5 示例中，**无行为说明、无差异说明**；`闪屏`/`splash` 零命中。→ **本问题属于官方文档未覆盖区**，只能从"窗口显隐 × 托盘绑定"反推 |
| **`showAbility` / `hideAbility` 官方零描述** | 全 8 分支 grep 零命中；`terminateSelf` 也仅在源码中出现、无文档 |
| **BrowserWindow 构造选项无官方支持矩阵** | 官方文档集 `docs/api/` 下**没有构造选项页**（`show`/`transparent`/`frame`/`alwaysOnTop`/`skipTaskbar` 均无独立文档）。**不能引用"构造选项支持表"——它不存在**；只能引 README 散文或 `setXxx` 方法页 |

### G. ⚠️ 发现的两处官方/社区口径冲突（引用前必须知道）

| 冲突 | 双方说法 | 处置建议 |
|---|---|---|
| **鸿蒙到底有没有托盘能力** | 官方 README + API 表 `new-Tray 支持`（`api_index.md:901`）**说支持且必须先建**；CSDN 文章（`research/csdn_markdownify.txt:184`）称"鸿蒙运行时没有传统桌面系统托盘能力"，并给了"鸿蒙端正常退出、不建托盘"的代码 | **以官方为准**。CSDN 那篇讲的是"关闭窗口后隐藏到托盘"的产品行为取舍，不是平台能力缺失 |
| **构造选项 `opacity` / `skipTaskbar`** | 上游 Electron 文档：`opacity` **仅 Windows/macOS 实现**、`skipTaskbar` 是 macOS/Windows 项；鸿蒙文档：`setOpacity` **支持**（有阈值差异）、`setSkipTaskbar` **明确不支持** | **方法页口径优先**（`setOpacity` 支持、`setSkipTaskbar` 不支持）；构造选项以实测为准 |

---

*本文编写时未接触真机。所有 ⚠️/🟡 标注项必须先按 §7 实测，再据此更新本文与手册附录 A。*
*文档口径部分已由官方 Electron_CPF 仓库 `main` 分支 + v34/v40 源码交叉核对；源码口径部分以本工程 `project-template` 的 E34 壳源码为准。*
