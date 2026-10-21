#!/usr/bin/env node
/**
 * kook派单系统 · 一键启动。
 *
 * 1. 检查 Node.js 版本（需要 22.5 及以上，用到自带的 SQLite）
 * 2. 检查机器人 Token（项目根目录 kook-token.txt 或环境变量 KOOK_TOKEN）
 * 3. 启动派单平台（dispatch/server.mjs），启动成功后自动用浏览器打开管理网页
 *
 * 用法：node scripts/start.mjs　（Windows 可双击 start.bat，macOS / Linux 运行 ./start.sh）
 * 关闭：在这个窗口按 Ctrl+C，或直接关掉窗口。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8787);
const url = `http://127.0.0.1:${port}`;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`✘ 当前 Node.js 版本是 ${process.versions.node}，需要 22.5 或更高。请到 https://nodejs.org 下载 LTS 版本安装后重试。`);
  process.exit(1);
}

const tokenPath = join(root, 'kook-token.txt');
const hasToken = Boolean(process.env.KOOK_TOKEN?.trim()) || (existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim());
if (!hasToken) {
  console.error('✘ 没找到机器人 Token。');
  console.error(`  请在项目根目录新建 kook-token.txt，里面只放 KOOK 机器人的 Token 一行：\n  ${tokenPath}`);
  console.error('  Token 在 KOOK 开发者后台 → 你的应用 → 机器人 页面，详见 README「第一步」。');
  process.exit(1);
}

console.log('正在启动 kook派单系统……');
const server = spawn(process.execPath, [join(root, 'dispatch', 'server.mjs')], { cwd: join(root, 'dispatch'), env: { ...process.env, PORT: String(port) }, stdio: ['inherit', 'pipe', 'inherit'] });

let opened = false;
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (!opened && chunk.includes('派单平台已启动')) {
    opened = true;
    console.log(`\n→ 管理网页：${url}\n→ 登录密码在：${join(root, 'dispatch', 'admin-password.txt')}\n→ 关闭平台：在这个窗口按 Ctrl+C\n`);
    if (process.env.NO_BROWSER !== '1') openBrowser(url);
  }
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));

function openBrowser(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* 打不开就让用户手动访问 */ }
}
