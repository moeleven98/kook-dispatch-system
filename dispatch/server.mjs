#!/usr/bin/env node
/**
 * KOOK 派单平台 · 主程序：连 KOOK 实时网关跑派单流程 + 本机管理网站。
 *
 * 用法（在本文件夹执行）：node server.mjs
 * 然后浏览器打开 http://127.0.0.1:8787 ，用 admin-password.txt 里的密码登录。
 *
 * 安全：
 *   - 网站只监听 127.0.0.1（别的电脑访问不到），并校验 Host 头，防止 DNS 重绑定
 *   - 必须登录；会改东西的请求还要带 X-Requested-With 头，挡住跨站伪造
 *   - 授予带「管理员」权限的角色需要二次确认
 * Token 读项目根目录的 kook-token.txt（或环境变量 KOOK_TOKEN）。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadToken, createClient, Gateway, slimMember, sleep } from '../bot/kook-core.mjs';
import { openDb, STATUS } from './db.mjs';
import { createDispatcher } from './dispatch.mjs';
import { createRecognizer, loadLlmConfig, saveLlmConfig, describeLlmConfig, listPending } from './recognize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const ROLE_NAMES = { boss: process.env.BOSS_ROLE || '老板', taker: process.env.TAKER_ROLE || '打手' };
const SESSION_MS = 12 * 3600000;

// ---------- KOOK 适配器：把 HTTP 接口包成派单流程需要的样子 ----------
export async function createKookAdapter(client) {
  const me = await client.me();
  const guildId = process.env.KOOK_GUILD_ID || (await client.guilds())[0]?.id;
  if (!guildId) throw new Error('机器人不在任何服务器里');
  const memberCache = { at: 0, list: [] };

  const adapter = {
    botId: me.id,
    botName: `${me.username}#${me.identify_num}`,
    guildId,
    async memberRoles(userId) {
      const data = await client.call('GET', '/guild/user-list', { guild_id: guildId, filter_user_id: userId });
      return data?.items?.[0]?.roles || [];
    },
    membersWithRole: (roleId) => client.all('/guild/user-list', { guild_id: guildId, role_id: roleId }),
    dm: (userId, text) => client.call('POST', '/direct-message/create', { type: 9, target_id: userId, content: text }),
    dmCard: (userId, card) => client.call('POST', '/direct-message/create', { type: 10, target_id: userId, content: JSON.stringify(card) }),
    reply: (channelId, text, quote) => client.call('POST', '/message/create', { type: 9, target_id: channelId, content: text, quote }),
    async findVoiceChannel(userId) {
      const channels = (await client.all('/channel/list', { guild_id: guildId, type: 2 })).filter((c) => !c.is_category);
      for (const channel of channels) {
        const users = await client.call('GET', '/channel/user-list', { channel_id: channel.id });
        if ((users || []).some((u) => u.id === userId)) return { id: channel.id, name: channel.name };
      }
      return null;
    },
    async createInvite({ channelId, channelName }) {
      const params = channelId ? { channel_id: channelId } : { guild_id: guildId };
      let data;
      try {
        data = await client.call('POST', '/invite/create', { ...params, duration: 86400, setting_times: -1 });
      } catch {
        data = await client.call('POST', '/invite/create', params); // 有效期参数不被接受时退回默认（7 天）
      }
      let name = channelName;
      if (!name && channelId) name = (await client.call('GET', '/channel/view', { target_id: channelId }).catch(() => null))?.name;
      return { url: data.url, channel: name ? `#${name}` : '服务器' };
    },
    // 网站用
    async members(force = false) {
      if (!force && Date.now() - memberCache.at < 60000) return memberCache.list;
      memberCache.list = (await client.all('/guild/user-list', { guild_id: guildId })).map(slimMember);
      memberCache.at = Date.now();
      return memberCache.list;
    },
    roles: () => client.all('/guild-role/list', { guild_id: guildId }),
    async setRole(userId, roleId, action) {
      const path = action === 'grant' ? '/guild-role/grant' : '/guild-role/revoke';
      const data = await client.call('POST', path, { guild_id: guildId, user_id: userId, role_id: roleId });
      memberCache.at = 0;
      return data;
    },
  };
  return adapter;
}

// ---------- 网站 ----------
export function createApp({ db, kook, password, port = PORT, gatewayState = () => 'unknown', configDir = here, queueDir = join(here, 'data', 'recognize') }) {
  const sessions = new Map();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10240) { reject(new Error('请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('不是合法 JSON')); } });
  });

  const sessionOf = (req) => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '')?.[1];
    const session = sid && sessions.get(sid);
    if (!session || session.expires < Date.now()) return null;
    return sid;
  };

  const passwordOk = (input) => {
    const a = Buffer.from(String(input ?? ''));
    const b = Buffer.from(password);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  async function route(req, res) {
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Host 不允许' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && staticFiles[path]) {
      const [file, type] = staticFiles[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" });
      return res.end(readFileSync(join(here, 'public', file)));
    }
    if (!path.startsWith('/api/')) return send(res, 404, { error: '没有这个页面' });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'kook-admin') return send(res, 403, { error: '缺少请求头' });

    if (path === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!passwordOk(body.password)) { await sleep(800); return send(res, 401, { error: '密码不对' }); }
      const sid = randomBytes(24).toString('hex');
      sessions.set(sid, { expires: Date.now() + SESSION_MS });
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
    }
    const sid = sessionOf(req);
    if (path === '/api/session') return send(res, 200, { loggedIn: Boolean(sid) });
    if (!sid) return send(res, 401, { error: '请先登录' });
    if (path === '/api/logout' && req.method === 'POST') {
      sessions.delete(sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (path === '/api/overview' && req.method === 'GET') {
      return send(res, 200, { bot: kook.botName, guildId: kook.guildId, gateway: gatewayState(), llm: describeLlmConfig(loadLlmConfig(configDir)), stats: db.stats(), statusNames: STATUS, roleNames: ROLE_NAMES });
    }
    if (path === '/api/settings/llm' && req.method === 'GET') {
      return send(res, 200, { ...describeLlmConfig(loadLlmConfig(configDir)), pending: listPending(queueDir).length });
    }
    if (path === '/api/settings/llm' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = saveLlmConfig(configDir, body);
        db.audit('网站', '修改识别设置', {
          key: body.clearKey ? '已清除' : body.apiKey ? `已设置（${result.keyTail}）` : '未改',
          baseUrl: result.baseUrl, model: result.model, claudeFallback: result.claudeFallback,
        });
        return send(res, 200, result);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (path === '/api/orders' && req.method === 'GET') {
      return send(res, 200, db.listOrders({ status: url.searchParams.get('status') || undefined, q: url.searchParams.get('q') || undefined }));
    }
    const cancel = /^\/api\/orders\/([A-Z0-9-]+)\/cancel$/.exec(path);
    if (cancel && req.method === 'POST') {
      const ok = db.cancel(cancel[1]);
      if (ok) db.audit('网站', '取消订单', { order_no: cancel[1] });
      return send(res, ok ? 200 : 409, ok ? { ok } : { error: '订单不存在，或已派单不能取消' });
    }
    if (path === '/api/members' && req.method === 'GET') {
      return send(res, 200, await kook.members(url.searchParams.get('refresh') === '1'));
    }
    if (path === '/api/roles' && req.method === 'GET') {
      const roles = (await kook.roles()).filter((r) => r.role_id !== 0)
        .map((r) => ({ id: r.role_id, name: r.name, position: r.position, color: r.color, admin: (r.permissions & 1) === 1, isBot: r.name === kook.botName.split('#')[0] }));
      return send(res, 200, roles);
    }
    const roleChange = /^\/api\/members\/(\d+)\/roles$/.exec(path);
    if (roleChange && req.method === 'POST') {
      const body = await readBody(req);
      const roleId = Number(body.role_id);
      if (!['grant', 'revoke'].includes(body.action) || !Number.isInteger(roleId) || roleId <= 0) return send(res, 400, { error: '参数不对' });
      const role = (await kook.roles()).find((r) => r.role_id === roleId);
      if (!role) return send(res, 404, { error: '角色不存在' });
      if (body.action === 'grant' && (role.permissions & 1) === 1 && body.confirm_admin !== true) {
        return send(res, 409, { error: `「${role.name}」带管理员权限，需要二次确认`, needConfirm: true });
      }
      try {
        const result = await kook.setRole(roleChange[1], roleId, body.action);
        db.audit('网站', body.action === 'grant' ? '授予角色' : '撤销角色', { user_id: roleChange[1], role: role.name });
        return send(res, 200, { ok: true, roles: result?.roles });
      } catch (error) {
        db.audit('网站', '角色操作失败', { user_id: roleChange[1], role: role.name, action: body.action, error: error.message });
        return send(res, 502, { error: error.message });
      }
    }
    if (path === '/api/audit' && req.method === 'GET') return send(res, 200, db.listAudit());
    return send(res, 404, { error: '没有这个接口' });
  }

  return createServer((req, res) => {
    route(req, res).catch((error) => { if (!res.headersSent) send(res, 500, { error: error.message }); });
  });
}

// ---------- 启动 ----------
async function main() {
  const dataDir = join(here, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    console.log(line);
    try { appendFileSync(join(dataDir, `dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`), `${line}\n`); } catch { /* 忽略 */ }
  };

  const token = loadToken(join(here, '..'));
  if (!token) throw new Error('没找到 Token：请在项目根目录新建 kook-token.txt（只放机器人 Token 一行）');
  const passwordPath = join(here, 'admin-password.txt');
  if (!existsSync(passwordPath)) writeFileSync(passwordPath, randomBytes(9).toString('base64url'), 'utf8');
  const password = readFileSync(passwordPath, 'utf8').trim();

  const client = createClient({ token });
  const kook = await createKookAdapter(client);
  const roles = await kook.roles();
  const roleIds = {
    boss: roles.find((r) => r.name === ROLE_NAMES.boss)?.role_id,
    taker: roles.find((r) => r.name === ROLE_NAMES.taker)?.role_id,
  };
  if (!roleIds.boss || !roleIds.taker) throw new Error(`服务器里找不到「${ROLE_NAMES.boss}」或「${ROLE_NAMES.taker}」角色`);

  const queueDir = join(dataDir, 'recognize');
  const db = openDb(join(dataDir, 'orders.db'));
  const recognizeText = createRecognizer({ dir: here, queueDir });
  const dispatcher = createDispatcher({ db, kook, roles: roleIds, log, recognizeText });

  let gatewayState = 'idle';
  const gateway = new Gateway({ client, onEvent: (d) => void dispatcher.handleEvent(d), onStatus: (s) => { gatewayState = s.state; log({ level: 'info', event: 'gateway', ...s }); } });
  gateway.start();

  createApp({ db, kook, password, gatewayState: () => gatewayState, queueDir }).listen(PORT, '127.0.0.1', () => {
    console.log(`✔ 派单平台已启动：http://127.0.0.1:${PORT}　（登录密码在 admin-password.txt）`);
    console.log(`  机器人 ${kook.botName}，老板角色 ${roleIds.boss}，打手角色 ${roleIds.taker}，识别方式：${describeLlmConfig(loadLlmConfig(here)).modeName}`);
  });
  const stop = () => { gateway.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(`启动失败：${error.message}`); process.exit(1); });
}
