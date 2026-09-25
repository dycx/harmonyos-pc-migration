# 鸿蒙 PC 专项：多语言（i18n）方案（官方能力调研 + 推荐做法）

> **适用**：Electron 34 鸿蒙壳工程（`templates/ohos_electron_hap-main` / `project-template`）
> **要回答的问题**：应用内已有"中英文切换按钮"（Windows 上用它切界面语言，鸿蒙上也能正常工作），**是继续用应用内切换，还是改成跟随鸿蒙系统语言？官方推荐哪种？**
> **来源标注**：✅ 官方文档/官方 API 支持表核实 ｜ ✅ 模板源码核实（文件:行号）｜ ⚠️ 需真机实测（编号见 §6，已并入手册附录 A）
> **姊妹专项**：《鸿蒙PC迁移专项_启动闪屏定位与解决方案.md》、《鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md》
> **版本**：v1.0

---

## 0. 速览（结论先行）

| 问题 | 结论 |
|---|---|
| 官方推荐哪种？ | 官方**没有**"必须跟随系统语言"的规定，也没有"禁止应用内切换"的说法；官方做的是**把系统语言作为 API 暴露给应用**（`app.getLocale` 等 **4 个 locale API 全部"支持"**，端口实现直接读鸿蒙系统语言）。是否跟随、何时跟随，由应用自己决定 |
| 那我该用哪种？ | **不是二选一，分层即可**：<br>① **应用层文案**（你的界面、菜单、托盘 tooltip）→ **保留你现有的应用内切换**，并升级为"**首次启动跟随系统 + 之后以用户选择为准**"；<br>② **系统层文案**（桌面应用名、系统权限弹窗、启动窗口）→ **只能跟随系统语言**（靠 ArkTS 资源），应用内按钮改不了，产品上接受这一层可能不一致 |
| 能"实时跟随系统"吗？ | **鸿蒙上做不到**：没有运行期语言变化事件——`app.on('locale-changed')` 不在支持表内；`onConfigurationUpdate(config)` 只转发了 `colorMode`，**没有转发 language**。最多做到"**下次启动生效**" |
| 能用 `--lang` 设置语言吗？ | **不推荐**：端口 `getLocaleLang` 直接读 OHOS `Intl`，`--lang` 是否影响 `app.getLocale()` 需实测（A-39）；即使生效也只改 Chromium 的 locale，改不了系统层文案 |

---

## 1. 官方能力调研

### 1.1 支持矩阵

| 能力 | 鸿蒙 Electron 支持 | 端口实现 / 证据 | 含义 |
|---|---|---|---|
| `app.getLocale()` | **支持** | ✅ `research/api_index.md:54`；端口实现读 OHOS `@ohos.intl`：`I18nAdapter.getLocaleLang()` → `new Intl.Locale()).language`（✅ `I18nAdapter.ets:47-49`，绑定名 `OhosI18nAdapter.GetLocaleLang` ✅ `I18nAdapterBind.ets:56`） | **返回鸿蒙系统语言**（不是 Electron 的 `--lang`） |
| `app.getSystemLocale()` | **支持** | ✅ `api_index.md:60` | 系统级 locale |
| `app.getPreferredSystemLanguages()` | **支持** | ✅ `api_index.md:59` | 系统语言偏好列表 |
| `app.getLocaleCountryCode()` | **支持** | ✅ `api_index.md:55` | 区域 |
| 运行期语言变化事件（`locale-changed` 之类） | **不在支持表内** | ✅ 全表检索无此条目 | 系统语言在运行期被改，Electron 侧**收不到通知** |
| ArkTS 侧语言变化回调 | 存在，但**未转发给 Electron** | ✅ `WebAbility.onConfigurationUpdate(config)` **只转发 `colorMode`** 给 `NativeThemeAdapter`（`WebAbility.ets:54-58`），没有转发 `language` | 同上结论 |
| ArkTS 资源多语言（系统层文案） | **原生支持** | ✅ `electron/src/main/resources/{zh_CN,en_US,base}/element/string.json`（应用名 `EntryAbility_label` 等）；`AppScope/resources/base/element/string.json`（`app_name`） | 桌面应用名、系统弹窗等**自动跟随系统语言** |

### 1.2 两个决定性约束

1. **系统语言变化不会通知应用**（见上表最后三行）→ 任何"实时跟随系统"的设计在鸿蒙上都只能退化为"下次启动生效"；
2. **系统层文案不受应用控制**（ArkTS 资源由系统按语言选择）→ 应用内切换与桌面显示名可能不一致，这是平台限制而非 bug。

> ⚠️ 说明：本仓库资料范围内未检索到审核层面对多语言的强制条款；上架前建议在 AGC 审核指南再核一遍（链接见手册附录 E）。

---

## 2. 关键认知：语言要**分层**看

| 层 | 典型文案 | 谁决定 | 应用内按钮能否改变 |
|---|---|---|---|
| **系统层** | 桌面图标名、任务栏名、系统权限弹窗、系统启动窗口、`module_desc` | **系统语言** | ❌ 不能（只能靠 ArkTS 资源跟随系统，见 §5） |
| **应用层** | 你的界面文案、菜单、托盘 tooltip、应用内对话框、错误提示 | **应用** | ✅ 能（你现在的按钮就是这一层） |
| **内核层** | `navigator.language(s)`、日期/数字/排序格式（`Intl`） | Chromium 的 locale（鸿蒙上来自系统） | ⚠️ 需实测（A-38/A-39） |

**所以"用按钮"还是"跟随系统"是伪二选一**——正确做法：
- **应用层文案**：首次启动跟随系统，之后**以用户选择为准**（保留你已验证可用的应用内切换）；
- **系统层文案**：提供 `zh_CN` / `en_US` / `base` 资源，跟系统走。

---

## 3. 推荐方案（首次跟随系统 + 用户可覆盖）

```js
// main.js —— 语言解析：用户选择 > 系统语言 > 兜底
const fs = require('fs');
const LANG_FILE = () => path.join(app.getPath('userData'), 'lang.json');

function readSavedLanguage() {
  try { return JSON.parse(fs.readFileSync(LANG_FILE(), 'utf8')).lang || null; } catch { return null; }
}
function saveLanguage(lang) {
  try { fs.writeFileSync(LANG_FILE(), JSON.stringify({ lang }), 'utf8'); } catch (e) { console.warn('[i18n] save failed', e.message); }
}
function resolveInitialLanguage() {
  const saved = readSavedLanguage();
  if (saved) return saved;                                   // ① 用户选择优先（你现在的按钮写入这里）
  const sys = app.getLocale() || 'zh-CN';                     // ② 首次启动跟随系统（鸿蒙=系统语言）
  console.log('[i18n] system locale =', sys, '| preferred =', app.getPreferredSystemLanguages());
  return sys.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';   // ③ 兜底映射
}

// 渲染层启动时取语言；用户切换时落盘并同步菜单/托盘
ipcMain.handle('i18n:get', () => resolveInitialLanguage());
ipcMain.on('i18n:set', (_e, lang) => { saveLanguage(lang); /* 同步托盘菜单、应用内对话框文案 */ });
```
```js
// preload.js
contextBridge.exposeInMainWorld('i18n', {
  get: () => ipcRenderer.invoke('i18n:get'),
  set: (lang) => ipcRenderer.send('i18n:set', lang),
});
```
```js
// 页面（以 i18next 为例）
const lang = await window.i18n.get();
await i18n.init({ lng: lang, resources, fallbackLng: 'zh-CN' });
switchBtn.onclick = async () => {
  const next = i18n.language.startsWith('zh') ? 'en-US' : 'zh-CN';
  await i18n.changeLanguage(next);
  window.i18n.set(next);            // 持久化，下次启动直接生效
};
```

**三条设计要点**：
1. **不要在运行期反复读 `app.getLocale()` 当作"当前语言"**——它是"系统语言"，不随应用内切换变化；只在启动时读一次作为默认值。
2. 真"实时跟随系统"在鸿蒙上做不到（§1.2）——**最多"下次启动生效"**。若产品强要求实时跟随，只能改 `web_engine` 的 `onConfigurationUpdate` 自行转发 language（改官方模块，升级冲突 + 需自定义事件通道），**不推荐**。
3. 渲染层如果依赖 `navigator.language` 做默认值，注意它与主进程 `app.getLocale()` 可能不一致（⚠️ A-38）；**以主进程为准**，通过 preload 下发。

---

## 4. 不推荐的三种做法

| 做法 | 为什么不推荐 |
|---|---|
| `app.commandLine.appendSwitch('lang', 'zh-CN')` 当作"设置语言" | 端口 `getLocaleLang` 直接读 OHOS Intl，`--lang` 是否影响 `app.getLocale()` **需实测**（A-39）；即使影响也只改 Chromium locale（`navigator.language`、日期格式），改不了系统层文案 |
| 为了"完全跟随系统"去改 `web_engine/.../WebAbility.ets` 转发 language | 改官方模块 → 后续升级冲突；且要自建 Electron 侧事件通道 |
| 完全依赖应用内按钮、首次启动写死中文 | 英文系统用户首次启动体验不一致；也浪费了官方支持的 `app.getLocale()` |

---

## 5. ArkTS 资源多语言（系统层文案）配置清单

| 位置 | 作用 | 需要补的多语言目录 |
|---|---|---|
| `AppScope/resources/base/element/string.json` | 应用名 `app_name`（桌面/任务栏显示名） | 增加 `AppScope/resources/{zh_CN,en_US}/element/string.json` |
| `electron/src/main/resources/base/element/string.json` | Ability 描述、按钮文案等 | 模板已有 `zh_CN`/`en_US`（✅ 已就位），按需补 key |
| `electron/src/main/resources/base/element/color.json` | `start_window_background`（启动窗口底色） | 一般不需要多语言 |
| `AppScope/resources/base/media/startIcon.png` | 启动窗口图标 | 不需要多语言 |

> 提醒：这一层**不受应用内切换影响**。若产品要求"桌面名也跟着应用内语言变"，平台层面做不到，只能在产品上接受或改为不暴露该切换项。

---

## 6. 实测项（A-37~A-41，已并入手册附录 A）

| # | 实测项 | 通过标准 / 判读 |
|---|---|---|
| **A-37** | `app.getLocale()` 在鸿蒙上的实际返回值 | 是 `zh-CN` 还是 `zh`？大小写？与 `getPreferredSystemLanguages()` 的关系 |
| **A-38** | 渲染层 `navigator.language` / `navigator.languages` 取值 | 是否等于系统语言；与 `app.getLocale()` 是否一致 |
| **A-39** | `--lang` / `appendSwitch('lang', ...)` 是否影响 `app.getLocale()` 与 `navigator.language` | 决定能否用它做兜底 |
| **A-40** | 运行期系统语言切换是否有应用侧通知 | `onConfigurationUpdate` 是否被触发、`config.language` 是否有值 |
| **A-41** | ArkTS 资源多语言是否生效 | 切换系统语言后，桌面应用名/系统弹窗文案是否随之变化（`AppScope` + `electron` 模块） |

---

## 7. 相关文件

**本仓库**
- 实施手册：`鸿蒙PC迁移实施手册.md`（附录 A 实测表、附录 C「Electron 数据写哪/怎么验证」）
- 姊妹专项：`鸿蒙PC迁移专项_启动闪屏定位与解决方案.md`、`鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md`
- API 支持表：`research/api_index.md`（`app.getLocale` :54、`getLocaleCountryCode` :55、`getPreferredSystemLanguages` :59、`getSystemLocale` :60）
- 模板源码：`project-template/web_engine/src/main/ets/adapter/I18nAdapter.ets`（:47-49 语言来源）、`jsbindings/I18nAdapterBind.ets`（:56-59 绑定）、`ability/WebAbility.ets`（:54-58 配置更新只转发 colorMode）
- ArkTS 资源：`project-template/electron/src/main/resources/{base,zh_CN,en_US}/element/string.json`、`project-template/AppScope/resources/base/element/string.json`

**外部**
- 官方仓库：<https://gitcode.com/openharmony-sig/electron>
- Electron 官方文档：`app.getLocale` / `app.getPreferredSystemLanguages` / `app.getSystemLocale`
