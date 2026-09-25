/**
 * main.js —— 鸿蒙 PC 项目模板的 Electron 主进程入口
 *
 * 功能：
 *  1. 创建托盘（模板约束：窗口显示/隐藏与托盘强绑定，必须先建）
 *  2. 探测后端端口（127.0.0.1:8080）
 *  3. 后端拉起：
 *     - USE_EMBEDDED_BACKEND=true  （形态 B：spawn 自包含 JDK，需 ALLOW_WRITABLE_CODE_MEMORY 权限获批）
 *     - USE_EMBEDDED_BACKEND=false （形态 A：提示用户在终端启动，开发期默认）
 *  4. 域名映射：app.localhost → 127.0.0.1:8080（webRequest 重定向 + CORS 头回显）
 *  5. 创建主窗口（★ 无边框 + 自绘标题栏），加载本地 renderer/index.html
 *  6. 首窗口铺满屏幕（maximize / setBounds 兜底）
 *
 * 配置项见下方 CONFIG 区。
 *
 * ★ 关于"窗口外框"和"跨域登录"两个高频问题，见仓库根：
 *   《鸿蒙PC迁移专项_窗口全屏与跨域登录方案.md》
 */
const { app, BrowserWindow, Tray, dialog } = require('electron');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

/* ============ CONFIG（模板配置区） ============ */
const CONFIG = {
  // 后端服务地址（渲染层无感知，统一走虚拟域名）
  VIRTUAL_DOMAIN: 'app.localhost',      // 前端使用的虚拟域名（可改成你的正式域名）
  BACKEND_HOST: '127.0.0.1',
  BACKEND_PORT: 8080,

  // 后端运行形态：
  //  false = 形态 A：终端启动（开发期，无需 JIT 权限）
  //  true  = 形态 B：应用内 spawn 自包含 JDK（上架形态，需 ALLOW_WRITABLE_CODE_MEMORY 获批；
  //                  JIT 受限时可用 -Xint 降级，见 JVM_ARGS）
  USE_EMBEDDED_BACKEND: false,

  // 形态 B 的自包含 JDK（HNP 打包后）java 路径与 JVM 参数
  EMBEDDED_JAVA: '/data/app/bin/java',          // 软链（调试）或 /data/app/<bundle>/jdk17_1.0/bin/java（上架）
  JVM_ARGS: ['-Xmx256m'],                        // JIT 权限未获批时追加 '-Xint'

  // 启动窗口
  WINDOW: {
    width: 1280, height: 800, minWidth: 800, minHeight: 600,
    // ★★ 鸿蒙关键项：false 才会隐藏系统标题栏/窗口边框。
    //    你的应用若沿用 Electron 默认的 frame:true，鸿蒙上会出现系统标题栏 + 窗口边框，
    //    看起来就是"模板工程的窗口成了原应用的外边框"（详见专项文档 §1）。
    //    置 false 后，窗口拖动由页面内 -webkit-app-region: drag 区域负责（见 renderer/index.html）。
    frame: false,
    // ★★ 首窗口铺满屏幕：鸿蒙首窗口的启动尺寸由 electron/src/main/module.json5 的
    //    ohos.ability.window.* 决定，BrowserWindow 的 width/height 对首窗口不生效；
    //    这里在运行期再调 maximize() 兜底（win.maximize / win.setFullScreen 官方 API 表均标注"支持"）。
    startMaximized: true,
  },

  // 开发期兜底：关闭 webSecurity（等价命令行 --disable-web-security）
  //  ⚠️ 官方 README 明确标注"仅开发/测试，切勿生产"；且鸿蒙上未必生效。
  //     正确解法（真实 origin + 后端 CORS + 主进程代理）见专项文档 §2。
  DEV_DISABLE_WEB_SECURITY: false,

  // 用特权自定义协议（app://）加载前端产物，使页面拥有真实 origin（而不是 file:// 的 null），
  //  带 Cookie 的跨域/登录请求才有可能成功。⚠️ 需真机实测（专项文档 §2.3，实测项 A-32）
  USE_APP_SCHEME: false,
  APP_SCHEME: 'app',
};
/* ============================================= */

/* ---------- 开发期兜底开关（必须在 app ready 之前生效） ---------- */
if (CONFIG.DEV_DISABLE_WEB_SECURITY) {
  app.commandLine.appendSwitch('disable-web-security');
  console.warn('[security] webSecurity 已关闭：仅限本机开发/排查，上架前必须改回 false');
}

/* ---------- 特权协议注册（registerSchemesAsPrivileged 必须在 app ready 之前调用） ---------- */
if (CONFIG.USE_APP_SCHEME) {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([{
    scheme: CONFIG.APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

let mainWindow = null;
let tray = null;

/* ---------- 后端端口探测 ---------- */
function probeBackend(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
    socket.connect(CONFIG.BACKEND_PORT, CONFIG.BACKEND_HOST);
  });
}

function waitBackendReady(maxWaitMs = 60000) {
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await probeBackend(800)) { resolve(true); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(tick, 1500);
    };
    tick();
  });
}

/* ---------- 后端启动（形态 B：spawn 自包含 JDK） ---------- */
function startEmbeddedBackend() {
  const jarPath = path.join(__dirname, '../backend/app.jar');
  const args = [...CONFIG.JVM_ARGS, '-jar', jarPath];
  console.log('[backend] spawn:', CONFIG.EMBEDDED_JAVA, args.join(' '));
  const child = spawn(CONFIG.EMBEDDED_JAVA, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => console.log('[backend]', d.toString().trim()));
  child.stderr.on('data', (d) => console.error('[backend]', d.toString().trim()));
  child.on('exit', (code) => console.error('[backend] exited:', code));
  return child;
}

/* ---------- 后端就绪保证 ---------- */
async function ensureBackend() {
  if (await probeBackend()) {
    console.log('[backend] already up');
    return;
  }
  if (CONFIG.USE_EMBEDDED_BACKEND) {
    console.log('[backend] starting embedded JVM...');
    startEmbeddedBackend();
    const ok = await waitBackendReady();
    console.log(ok ? '[backend] ready' : '[backend] NOT ready within timeout');
  } else {
    // 形态 A：提示用户在终端启动（不 spawn，规避子进程 JIT 限制）
    console.log('[backend] not running (dev mode: start it in terminal)');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '后端服务未启动',
      message: '请在鸿蒙 PC 终端中启动后端：\n\n  java -jar <backend>/app.jar\n\n（或将 main.js 的 USE_EMBEDDED_BACKEND 改为 true 自动拉起）',
      buttons: ['我已启动，重试', '稍后再说'],
    });
    if (response === 0 && !(await probeBackend(3000))) {
      dialog.showMessageBox({ type: 'warning', message: '仍未检测到后端服务' });
    }
  }
}

/* ---------- 域名映射（虚拟域名 → 本机后端） ---------- */
function setupDomainRedirect() {
  const { session } = require('electron');
  const ses = session.defaultSession;
  const domain = CONFIG.VIRTUAL_DOMAIN;
  const target = `http://${CONFIG.BACKEND_HOST}:${CONFIG.BACKEND_PORT}`;
  ses.webRequest.onBeforeRequest({ urls: [`*://${domain}/*`] }, (details, callback) => {
    const url = new URL(details.url);
    const newUrl = target + url.pathname + url.search;
    callback({ redirectURL: newUrl });
  });

  // onHeadersReceived 里拿不到请求头，所以先在 onBeforeSendHeaders 里把 Origin 记下来（按请求 id）
  const requestOrigins = new Map();
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const origin = details.requestHeaders && (details.requestHeaders.Origin || details.requestHeaders.origin);
    if (origin) requestOrigins.set(details.id, origin);
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.webRequest.onHeadersReceived({ urls: [`*://${domain}/*`] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    // ★ 这里绝不能写 '*'：`Access-Control-Allow-Origin: *` 与 credentials:'include' 互斥，
    //   带 Cookie 的登录请求会被浏览器直接判失败。必须回显具体 Origin + 允许凭据。
    //   （后端 CORS 也应按同一规则配置，且预检 OPTIONS 交给后端回答，见专项文档 §2.3）
    const origin = requestOrigins.get(details.id) || `http://${domain}`;
    requestOrigins.delete(details.id);
    headers['Access-Control-Allow-Origin'] = [origin];
    headers['Access-Control-Allow-Credentials'] = ['true'];
    headers['Vary'] = ['Origin'];
    callback({ responseHeaders: headers });
  });
  console.log(`[redirect] ${domain} -> ${target}（CORS 头按 Origin 回显）`);
}

/* ---------- 特权协议 app:// → 本地 renderer 目录（让页面有真实 origin） ---------- */
function setupAppSchemeHandler() {
  const { protocol, net: electronNet } = require('electron');
  const root = path.join(__dirname, 'renderer');
  protocol.handle(CONFIG.APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.normalize(path.join(root, rel));
    if (!filePath.startsWith(root)) {                       // 防路径穿越
      return new Response('forbidden', { status: 403 });
    }
    return electronNet.fetch(require('url').pathToFileURL(filePath).toString());
  });
  console.log(`[scheme] ${CONFIG.APP_SCHEME}://bundle/ -> ${root}`);
}

/* ---------- 自绘标题栏三键（页面 → IPC → 主进程） ---------- */
function setupWindowControls() {
  const { ipcMain } = require('electron');
  ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle('window:is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));
}

/* ---------- 启动尺寸：兜底铺满屏幕 ---------- */
function applyStartupSizing(win) {
  try {
    const { screen } = require('electron');
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    console.log(`[window] workArea=${width}x${height} maximized=${win.isMaximized()}`);
    if (CONFIG.WINDOW.startMaximized) {
      win.maximize();
    } else if (width < CONFIG.WINDOW.width || height < CONFIG.WINDOW.height) {
      win.setBounds({
        x: 0, y: 0,
        width: Math.min(width, CONFIG.WINDOW.width),
        height: Math.min(height, CONFIG.WINDOW.height),
      });
    }
  } catch (e) {
    console.warn('[window] 启动尺寸调整失败:', e.message);
  }
}

/* ---------- 创建托盘（模板约束：窗口显隐与托盘绑定） ---------- */
function createTray() {
  try {
    const { nativeImage, Menu } = require('electron');
    const icon = nativeImage.createFromPath(path.join(__dirname, 'electron_white.png'));
    tray = new Tray(icon);
    tray.setToolTip(app.getName());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); } } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  } catch (e) {
    console.warn('[tray] create failed:', e.message);
  }
}

/* ---------- 主窗口 ---------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: CONFIG.WINDOW.width,
    height: CONFIG.WINDOW.height,
    minWidth: CONFIG.WINDOW.minWidth,
    minHeight: CONFIG.WINDOW.minHeight,
    // ★★ 鸿蒙关键项：frame:false → 原生侧 setWindowDecorVisible(false)，
    //    去掉系统标题栏与窗口边框，网页内容铺满整窗（详见专项文档 §1.2）
    frame: CONFIG.WINDOW.frame,
    titleBarStyle: CONFIG.WINDOW.frame ? 'default' : 'hidden',
    // 无边框窗口默认不显示系统三键；若想用系统三键，在 load 之前加：
    //   mainWindow.setWindowButtonVisibility(true); mainWindow.maximizable = true;
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 兜底项：真正依赖跨域的工程请改用真实 origin / 后端 CORS / 主进程代理（专项文档 §2）
      webSecurity: !CONFIG.DEV_DISABLE_WEB_SECURITY,
    },
  });

  if (CONFIG.USE_APP_SCHEME) {
    mainWindow.loadURL(`${CONFIG.APP_SCHEME}://bundle/index.html`);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    applyStartupSizing(mainWindow);
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------- 生命周期 ---------- */
app.whenReady().then(async () => {
  createTray();                 // 1. 先建托盘（模板约束）
  if (CONFIG.USE_APP_SCHEME) setupAppSchemeHandler();
  setupWindowControls();        // 2. 自绘标题栏三键 IPC
  await ensureBackend();        // 3. 后端就绪（探测/拉起/提示）
  setupDomainRedirect();        // 4. 域名映射 + CORS 头
  createWindow();               // 5. 主窗口（无边框 + 启动铺满）
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
