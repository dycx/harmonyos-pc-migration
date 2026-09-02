/**
 * main.js —— 鸿蒙 PC 项目模板的 Electron 主进程入口
 *
 * 功能：
 *  1. 创建托盘（模板约束：窗口显示/隐藏与托盘强绑定，必须先建）
 *  2. 探测后端端口（127.0.0.1:8080）
 *  3. 后端拉起：
 *     - USE_EMBEDDED_BACKEND=true  （形态 B：spawn 自包含 JDK，需 ALLOW_WRITABLE_CODE_MEMORY 权限获批）
 *     - USE_EMBEDDED_BACKEND=false （形态 A：提示用户在终端启动，开发期默认）
 *  4. 域名映射：app.localhost → 127.0.0.1:8080（webRequest 重定向）
 *  5. 创建主窗口，加载本地 renderer/index.html
 *
 * 配置项见下方 CONFIG 区。
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
  WINDOW: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
};
/* ============================================= */

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
  ses.webRequest.onHeadersReceived({ urls: [`*://${domain}/*`] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });
  console.log(`[redirect] ${domain} -> ${target}`);
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------- 生命周期 ---------- */
app.whenReady().then(async () => {
  createTray();                 // 1. 先建托盘（模板约束）
  await ensureBackend();        // 2. 后端就绪（探测/拉起/提示）
  setupDomainRedirect();        // 3. 域名映射
  createWindow();               // 4. 主窗口
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
