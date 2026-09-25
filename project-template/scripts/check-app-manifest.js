#!/usr/bin/env node
/**
 * check-app-manifest.js —— 构建期产物清单校验
 *
 * 解决什么问题：
 *   迁移后"某个 .js 没被打进包"是**最隐蔽**的一类故障——应用能启动，
 *   但 require 失败或被 try/catch 吞掉后，界面按钮点了没反应，日志里什么都没有。
 *   把"源 app 目录"与"HAP 内 app 目录"做一次清单比对，就能在构建期拦住。
 *
 * 用法：
 *   node scripts/check-app-manifest.js <源app目录> <HAP内app目录>
 * 例：
 *   node scripts/check-app-manifest.js \
 *     app \
 *     project-template/web_engine/src/main/resources/resfile/resources/app
 *
 * 退出码：0=一致 ｜ 1=有差异 ｜ 2=参数/目录错误
 *
 * 建议接入到打包流程（package.json）：
 *   "scripts": {
 *     "check:app": "node scripts/check-app-manifest.js app project-template/web_engine/src/main/resources/resfile/resources/app"
 *   }
 */
const fs = require('fs');
const path = require('path');

/** 这些文件必须存在于产物中（模块化骨架的核心文件，缺一个就会出现"按钮失效"） */
const REQUIRED = [
  'main.js',
  'preload.js',
  'logger.js',
  'ipc/channels.js',
  'ipc/register.js',
  'ipc/process-manage.js',
  'platform/index.js',
  'platform/generic.js',
  'platform/ohos.js',
  'platform/windows.js',
];

/** 不参与比对的路径 */
const IGNORE = [
  /^node_modules\//,
  /\.map$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.git\//,
];

function walk(root) {
  const out = [];
  (function rec(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (IGNORE.some((re) => re.test(rel))) continue;
      if (entry.isDirectory()) rec(abs);
      else out.push(rel);
    }
  })(root);
  return out.sort();
}

function main() {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) {
    console.error('用法: node scripts/check-app-manifest.js <源app目录> <HAP内app目录>');
    process.exit(2);
  }
  for (const [label, dir] of [['源目录', src], ['产物目录', dst]]) {
    if (!fs.existsSync(dir)) {
      console.error(`[清单校验] ${label}不存在：${dir}`);
      process.exit(2);
    }
  }

  const srcFiles = walk(src);
  const dstFiles = walk(dst);
  const missing = srcFiles.filter((f) => !dstFiles.includes(f));
  const extra = dstFiles.filter((f) => !srcFiles.includes(f));

  console.log(`[清单校验] 源=${srcFiles.length} 个文件，产物=${dstFiles.length} 个文件`);

  // 1) 核心模块是否齐备
  const lackCore = REQUIRED.filter((f) => !dstFiles.includes(f));
  if (lackCore.length) {
    console.error(`[清单校验] ❌ 产物缺少核心模块 ${lackCore.length} 个：\n  ${lackCore.join('\n  ')}`);
  }

  // 2) 逐文件比对
  if (missing.length) {
    console.error(`[清单校验] ❌ 产物缺失 ${missing.length} 个文件（会导致 require 失败 / 按钮静默失效）：\n  ${missing.join('\n  ')}`);
  }
  if (extra.length) {
    console.warn(`[清单校验] ⚠️ 产物多出 ${extra.length} 个文件（可能是旧版本残留，建议清理）：\n  ${extra.join('\n  ')}`);
  }

  if (!missing.length && !extra.length && !lackCore.length) {
    console.log('[清单校验] ✅ 一致');
    process.exit(0);
  }
  process.exit(1);
}

main();
