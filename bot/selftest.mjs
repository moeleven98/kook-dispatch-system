#!/usr/bin/env node
/**
 * KOOK 接入 · 离线自测（不联网、不需要真 Token）。
 * 用假的 HTTP 和假的 WebSocket 检查：翻页、错误处理、网关握手/心跳/乱序/重连、消息存储、MCP 链路。
 * 用法：node selftest.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createClient, Gateway, MessageStore, normalizeEvent, slimMember } from './kook-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failed += 1;
}

function fakeResponse(body, status = 200, headers = {}) {
  return { status, headers: { get: (k) => headers[k] ?? null }, json: async () => body };
}

// ---------- 1. HTTP 客户端 ----------
console.log('1. HTTP 客户端');
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    const page = Number(url.searchParams.get('page'));
    return fakeResponse({ code: 0, message: '', data: { items: [{ id: `u${page}a` }, { id: `u${page}b` }], meta: { page, page_total: 3, page_size: 50, total: 6 } } });
  };
  const client = createClient({ token: 'T', fetchImpl, base: 'https://x.test/api/v3' });
  const members = await client.members('G1');
  check('自动翻页拉满 3 页共 6 人', members.length === 6, JSON.stringify(members));
  check('鉴权头是 Bot Token', calls.every((c) => c.auth === 'Bot T'));
  check('带上 guild_id 和 page_size=50', calls[0].url.includes('guild_id=G1') && calls[0].url.includes('page_size=50'), calls[0].url);

  const bad = createClient({ token: 'T', fetchImpl: async () => fakeResponse({ code: 401, message: '你的用户凭证不正确', data: {} }), base: 'https://x.test/api/v3' });
  let error;
  try { await bad.me(); } catch (e) { error = e; }
  check('错误码转成可读报错', error?.code === 401 && error.message.includes('凭证'), error?.message);

  let hits = 0;
  const limited = createClient({ token: 'T', base: 'https://x.test/api/v3', fetchImpl: async () => (++hits === 1
    ? fakeResponse({ code: 429, message: 'too many' }, 429, { 'X-Rate-Limit-Reset': '1' })
    : fakeResponse({ code: 0, message: '', data: { id: 'bot' } })) });
  check('429 限速后等待重试成功', (await limited.me()).id === 'bot' && hits === 2);
}

// ---------- 2. 网关 ----------
console.log('2. 实时网关');
{
  // 假计时器：手动推进时间
  const timers = (() => {
    let now = 0; let seq = 0; const list = new Map();
    return {
      setTimeout: (fn, ms) => { const id = ++seq; list.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: (id) => list.delete(id),
      advance(ms) {
        now += ms;
        for (;;) {
          const due = [...list.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          list.delete(due[0]);
          due[1].fn();
        }
      },
    };
  })();
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; }
    push(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
  }
  let gatewayCalls = 0;
  const client = { gatewayUrl: async () => `wss://gw.test/${++gatewayCalls}?compress=0` };
  const events = [];
  const states = [];
  const gw = new Gateway({ client, onEvent: (d) => events.push(d.msg_id), onStatus: (s) => states.push(s.state), WebSocketImpl: FakeWS, timers });
  gw.start();
  await new Promise((r) => setImmediate(r));
  const ws = sockets[0];
  check('拿到网关地址并建立连接', ws?.url === 'wss://gw.test/1?compress=0');
  ws.push({ s: 1, d: { code: 0, session_id: 'S1' } });
  check('HELLO 成功后状态为 connected', gw.state === 'connected' && gw.sessionId === 'S1');

  ws.push({ s: 0, sn: 1, d: { msg_id: 'm1' } });
  ws.push({ s: 0, sn: 3, d: { msg_id: 'm3' } }); // 乱序
  ws.push({ s: 0, sn: 2, d: { msg_id: 'm2' } });
  ws.push({ s: 0, sn: 2, d: { msg_id: 'm2' } }); // 重复
  check('乱序按 sn 重排、重复丢弃', JSON.stringify(events) === '["m1","m2","m3"]', JSON.stringify(events));

  for (let t = 0; t < 36 && !ws.sent.some((p) => p.s === 2); t++) timers.advance(1000);
  const ping = ws.sent.find((p) => p.s === 2);
  check('30±5 秒内发出 PING 且带最新 sn', ping?.sn === 3, JSON.stringify(ws.sent));
  ws.push({ s: 3 });
  timers.advance(7000);
  check('收到 PONG 后不会断线', !ws.closed);

  ws.push({ s: 5, d: { code: 40108 } });
  check('收到 RECONNECT 后关闭旧连接并清零 sn', ws.closed && gw.sn === 0 && gw.state === 'reconnecting');
  timers.advance(2000);
  await new Promise((r) => setImmediate(r));
  check('退避 2 秒后重新拿网关地址重连', sockets.length === 2 && sockets[1].url.endsWith('/2?compress=0'));

  sockets[1].push({ s: 1, d: { code: 40101 } });
  check('Token 无效时停止、不再重连', gw.state === 'failed' && gw.stopped);
  gw.stop();
}

// ---------- 3. 消息存储 ----------
console.log('3. 消息存储');
const tmp = mkdtempSync(join(tmpdir(), 'kook-selftest-'));
{
  const event = {
    channel_type: 'GROUP', type: 1, target_id: 'C1', author_id: 'U1', content: '你好', msg_id: 'M1', msg_timestamp: Date.now(),
    extra: { type: 1, guild_id: 'G1', channel_name: '闲聊', author: { id: 'U1', username: 'alice', nickname: '爱丽丝' } },
  };
  const m = normalizeEvent(event);
  check('事件整理成扁平结构', m.channel_id === 'C1' && m.guild_id === 'G1' && m.author_name === '爱丽丝' && m.kind === 'text', JSON.stringify(m));
  const store = new MessageStore({ dir: tmp });
  store.add(m);
  store.add(m);
  store.add({ ...m, msg_id: 'M2', guild_id: 'G2', channel_id: 'C9' });
  store.add({ ...m, msg_id: 'M3', kind: 'system' });
  check('同一条消息不重复存', store.items.length === 3);
  check('按服务器过滤、默认不含系统事件', store.query({ guildId: 'G1' }).length === 1);
  const reloaded = new MessageStore({ dir: tmp });
  check('落盘后重启能读回今天的消息', reloaded.items.length === 3);
  check('成员信息精简', slimMember({ id: 'U1', username: 'alice', identify_num: '1234', online: true, roles: [5] }).username === 'alice#1234');
}

// ---------- 4. MCP 端到端（假 Token，不连网关） ----------
console.log('4. MCP 端到端');
{
  const server = spawn(process.execPath, [join(here, 'kook-mcp.mjs')], {
    env: { ...process.env, KOOK_TOKEN: 'fake', KOOK_DATA_DIR: tmp, KOOK_GATEWAY: 'off' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  let out = '';
  server.stdout.on('data', (chunk) => {
    out += chunk;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const msg = JSON.parse(out.slice(0, i));
      out = out.slice(i + 1);
      replies.set(msg.id, msg);
    }
  });
  const rpc = (id, method, params) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => (replies.has(id) ? resolve(replies.get(id)) : Date.now() - start > 5000 ? reject(new Error(`等不到回复 ${method}`)) : setTimeout(poll, 20));
      poll();
    });
  };
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  check('initialize 握手成功', init.result?.serverInfo?.name === 'kook');
  const list = await rpc(2, 'tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('6 个工具都在', ['kook_status', 'kook_list_guilds', 'kook_list_channels', 'kook_list_members', 'kook_recent_messages', 'kook_channel_history'].every((n) => names.includes(n)), names.join(','));
  const recent = await rpc(3, 'tools/call', { name: 'kook_recent_messages', arguments: { guild_id: 'G1' } });
  const body = JSON.parse(recent.result.content[0].text);
  check('kook_recent_messages 读到落盘消息', body.count === 1 && body.messages[0].content === '你好', recent.result.content[0].text);
  server.stdin.end();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n✘ ${failed} 项失败` : '\n✔ 全部通过');
process.exit(failed ? 1 : 0);
