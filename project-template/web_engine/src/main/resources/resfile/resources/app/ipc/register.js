/**
 * ipc/register.js —— IPC 统一注册器
 *
 * 解决三件事（都是"迁移后按钮失效"的根因）：
 *   ① 每个 handler 有入口/出口日志 → 不再静默失效，能判断"有没有进 handler"
 *   ② 异常统一转成 { ok:false, error:{code,message} } → 渲染层能区分"没注册/不支持/业务失败"
 *   ③ 维护"已注册通道清单"，启动时打印 → 与渲染层调用的通道名对账
 *
 * 用法（不要直接用 ipcMain.handle，统一走这里）：
 *   const { handle, on, CH, dumpRegistered } = require('./register');
 *   handle(ipcMain, CH.SYS_OPEN_PATH, (_e, p) => platform.system.openPath(p));
 */
const { CH } = require('./channels');
const { makeLogger } = require('../logger');

const log = makeLogger('ipc');
const registered = new Set();

/** 包装异步 handler：统一日志 + 统一错误结构 */
function wrap(name, fn) {
  registered.add(name);
  return async (event, ...args) => {
    const t0 = Date.now();
    try {
      const data = await fn(event, ...args);
      log.info(`${name} ok ${Date.now() - t0}ms`);
      return { ok: true, data };
    } catch (err) {
      log.error(`${name} FAILED (${Date.now() - t0}ms):`, (err && err.stack) || err);
      return {
        ok: false,
        error: {
          code: (err && err.code) || 'E_IPC',
          message: String((err && err.message) || err),
        },
      };
    }
  };
}

/** ipcMain.handle 的统一入口（请求-响应） */
function handle(ipcMain, name, fn) {
  ipcMain.handle(name, wrap(name, fn));
}

/** ipcMain.on 的统一入口（单向通知；异常只记日志，不返回结构） */
function on(ipcMain, name, fn) {
  registered.add(name);
  ipcMain.on(name, (event, ...args) => {
    try {
      const r = fn(event, ...args);
      if (r && typeof r.then === 'function') {
        r.catch((err) => log.error(`${name} FAILED (async):`, (err && err.stack) || err));
      }
    } catch (err) {
      log.error(`${name} FAILED (sync):`, (err && err.stack) || err);
    }
  });
}

/** 启动时打印通道清单：与渲染层/ preload 里用到的通道对一遍，缺谁一目了然 */
function dumpRegistered() {
  const list = [...registered].sort();
  log.info(`registered channels (${list.length}): ${list.join(', ')}`);
  return list;
}

module.exports = { CH, wrap, handle, on, dumpRegistered };
