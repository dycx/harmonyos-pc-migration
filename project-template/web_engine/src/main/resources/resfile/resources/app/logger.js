/**
 * logger.js —— 主进程统一日志（零依赖）
 *
 * 为什么要单独一个文件：
 *   迁移后最常见的问题是"静默失效"——按钮点了没反应，日志里什么都没有。
 *   统一出口 + 统一前缀后，可以在 hilog / 日志文件里一眼过滤出主进程链路：
 *     hdc shell hilog | grep -i "\[app\]"
 *
 * 输出格式：[app][<模块名>] LEVEL HH:mm:ss.SSS 内容
 */
function ts() {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function makeLogger(tag) {
  const prefix = `[app]${tag ? `[${tag}]` : ''}`;
  const line = (level) => (...args) => [`${prefix} ${level} ${ts()}`, ...args];
  return {
    info: (...a) => console.log(...line('INFO ')(...a)),
    warn: (...a) => console.warn(...line('WARN ')(...a)),
    error: (...a) => console.error(...line('ERROR')(...a)),
  };
}

module.exports = { makeLogger, ...makeLogger('boot') };
