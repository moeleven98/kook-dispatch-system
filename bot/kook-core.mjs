/**
 * KOOK 接入 · 核心库（零依赖，Node 22+）。
 *
 * 只读：只拉数据，不发消息、不改服务器。
 *   createClient  调 KOOK HTTP API（机器人 Token 鉴权，自动翻页，遇到 429 限速会等一下再试）
 *   Gateway       连 KOOK 实时网关（WebSocket），收服务器里实时发生的消息和事件
 *   MessageStore  把收到的消息存进内存 + data/messages-日期.jsonl，供大模型查询
 *
 * Token 来源：环境变量 KOOK_TOKEN，或项目根目录的 kook-token.txt（只放 Token 一行）。
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const API_BASE = process.env.KOOK_API_BASE || 'https://www.kookapp.cn/api/v3';

export class KookError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function loadToken(dir) {
  if (process.env.KOOK_TOKEN) return process.env.KOOK_TOKEN.trim();
  const path = join(dir, 'kook-token.txt');
  if (!existsSync(path)) return null;
  const token = readFileSync(path, 'utf8').replace(/^﻿/, '').trim();
  return token || null;
}

// ---------- HTTP API ----------
export function createClient({ token, fetchImpl = fetch, base = API_BASE }) {
  async function call(method, path, params = {}) {
    const url = new URL(base + path);
    const init = { method, headers: { Authorization: `Bot ${token}` } };
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(params);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, init);
      if (res.status === 429 && attempt < 2) {
        // 限速：按 X-Rate-Limit-Reset 等待（夹在 1~10 秒），最多重试两次；反复超速机器人可能被封
        const wait = Number(res.headers.get('X-Rate-Limit-Reset')) || 1;
        await sleep(Math.min(Math.max(wait, 1), 10) * 1000);
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!body) throw new KookError(`HTTP ${res.status}，返回内容不是 JSON`, res.status);
      if (body.code !== 0) throw new KookError(`KOOK 返回错误 ${body.code}：${body.message}`, body.code);
      return body.data;
    }
  }

  // 列表接口统一翻页：每页 50 条，按 meta.page_total 翻到底
  async function all(path, params = {}, { maxPages = 200 } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await call('GET', path, { ...params, page, page_size: 50 });
      const batch = data?.items || [];
      items.push(...batch);
      if (batch.length === 0 || page >= (data?.meta?.page_total ?? 1)) break;
    }
    return items;
  }

  return {
    call,
    all,
    me: () => call('GET', '/user/me'),
    guilds: () => all('/guild/list'),
    channels: (guildId) => all('/channel/list', { guild_id: guildId, type: 1 }),
    members: (guildId) => all('/guild/user-list', { guild_id: guildId }),
    history: async (channelId, pageSize = 50) => (await call('GET', '/message/list', { target_id: channelId, page_size: pageSize }))?.items || [],
    gatewayUrl: async () => (await call('GET', '/gateway/index', { compress: 0 })).url,
    // 唯一的写接口：往频道发一条 kmarkdown 消息，可引用回复某条消息
    send: (channelId, content, { quote } = {}) => call('POST', '/message/create', { type: 9, target_id: channelId, content, quote }),
  };
}

// 发出去之前清洗：去掉 @全体 / @在线 / @角色，防止机器人群发提醒；限制长度
export function sanitizeOutgoing(text, maxLength = 1500) {
  const cleaned = String(text ?? '')
    .replace(/\(met\)(all|here)\(met\)/gi, '')
    .replace(/\(rol\)\d+\(rol\)/g, '')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

export function slimMember(user) {
  return {
    id: user.id,
    username: user.identify_num ? `${user.username}#${user.identify_num}` : user.username,
    nickname: user.nickname || '',
    roles: user.roles || [],
    online: Boolean(user.online),
    bot: Boolean(user.bot),
    joined_at: user.joined_at ? new Date(user.joined_at).toISOString() : null,
    active_time: user.active_time ? new Date(user.active_time).toISOString() : null,
  };
}

// 把网关事件 / 历史消息统一成一种扁平结构，大模型读起来省 Token
const TYPE_NAMES = { 1: 'text', 2: 'image', 3: 'video', 4: 'file', 8: 'audio', 9: 'kmarkdown', 10: 'card', 255: 'system' };

export function normalizeEvent(d) {
  const extra = d.extra || {};
  const author = extra.author || {};
  return {
    at: new Date(Number(d.msg_timestamp) || Date.now()).toISOString(),
    msg_id: d.msg_id,
    kind: TYPE_NAMES[d.type] || `type${d.type}`,
    channel_type: d.channel_type, // GROUP=服务器频道，PERSON=私聊，BROADCAST=广播
    guild_id: extra.guild_id || null,
    channel_id: d.channel_type === 'GROUP' ? d.target_id : null,
    channel_name: extra.channel_name || null,
    author_id: d.author_id,
    author_name: author.nickname || author.username || null,
    content: d.type === 255 ? JSON.stringify(extra.body ?? {}) : d.content,
    system_type: d.type === 255 ? extra.type : undefined,
  };
}

export function normalizeHistoryItem(item, channelId) {
  const author = item.author || {};
  return {
    at: new Date(Number(item.create_at) || 0).toISOString(),
    msg_id: item.id,
    kind: TYPE_NAMES[item.type] || `type${item.type}`,
    channel_id: channelId,
    author_id: author.id,
    author_name: author.nickname || author.username || null,
    content: item.content,
  };
}

// ---------- 消息存储 ----------
export class MessageStore {
  constructor({ dir, max = 2000 }) {
    this.dir = dir;
    this.max = max;
    this.items = [];
    this.seen = new Set();
    mkdirSync(dir, { recursive: true });
    this.loadToday();
  }

  file(date = new Date()) { return join(this.dir, `messages-${date.toISOString().slice(0, 10)}.jsonl`); }

  loadToday() {
    const path = this.file();
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { this.remember(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
  }

  remember(message) {
    if (message.msg_id && this.seen.has(message.msg_id)) return false;
    if (message.msg_id) this.seen.add(message.msg_id);
    this.items.push(message);
    if (this.items.length > this.max) this.seen.delete(this.items.shift().msg_id);
    return true;
  }

  add(message) {
    if (!this.remember(message)) return;
    try { appendFileSync(this.file(), `${JSON.stringify(message)}\n`, 'utf8'); } catch { /* 落盘失败不影响内存 */ }
  }

  query({ guildId, channelId, since, limit = 50, includeSystem = false } = {}) {
    const sinceMs = since ? Date.parse(since) : 0;
    const hits = this.items.filter((m) => (!guildId || m.guild_id === guildId)
      && (!channelId || m.channel_id === channelId)
      && (!sinceMs || Date.parse(m.at) >= sinceMs)
      && (includeSystem || m.kind !== 'system'));
    return hits.slice(-Math.min(Math.max(limit, 1), 500));
  }
}

// ---------- 实时网关 ----------
/**
 * 简化版网关客户端：
 *   - compress=0，收发都是 JSON 文本
 *   - 按 sn 顺序处理事件，乱序的先缓存，重复的丢掉
 *   - 每 30 秒（±5 秒抖动）发一次 PING，6 秒没 PONG 视为断线
 *   - 断线或收到 RECONNECT：重新拿网关地址，sn 清零，2/4/8…最长 60 秒退避重连
 *   - 没实现 RESUME：断线期间的消息可能漏掉，需要时用 history 接口补
 *   - Token 无效（40101/40102）直接停止，不反复重连
 */
export class Gateway {
  constructor({ client, onEvent, onStatus = () => {}, WebSocketImpl = globalThis.WebSocket, timers = globalThis }) {
    this.client = client;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.state = 'idle';
    this.sn = 0;
    this.pending = new Map();
    this.backoff = 0;
    this.stopped = false;
    this.lastError = null;
    this.sessionId = null;
    this.connectedAt = null;
  }

  start() { this.stopped = false; void this.connect(); }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(); } catch { /* 忽略 */ }
    this.setState('stopped');
  }

  setState(state, extra = {}) { this.state = state; this.onStatus({ state, ...extra }); }

  clearTimers() {
    for (const key of ['helloTimer', 'pingTimer', 'pongTimer', 'retryTimer']) {
      if (this[key]) this.timers.clearTimeout(this[key]);
      this[key] = null;
    }
  }

  async connect() {
    if (this.stopped) return;
    this.clearTimers();
    this.setState('connecting');
    let url;
    try {
      url = await this.client.gatewayUrl();
    } catch (error) {
      this.lastError = error.message;
      if (error.code === 401 || error.code === 40101 || error.code === 40102) return this.fatal(error.message);
      return this.retry();
    }
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    this.helloTimer = this.timers.setTimeout(() => { this.lastError = '6 秒内没收到 HELLO'; this.drop(ws); }, 6000);
    ws.onmessage = (event) => this.handle(ws, event.data);
    ws.onclose = () => { if (this.ws === ws) this.drop(ws); };
    ws.onerror = () => { this.lastError = 'WebSocket 出错'; };
  }

  handle(ws, raw) {
    if (this.ws !== ws) return;
    let packet;
    try { packet = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    switch (packet.s) {
      case 1: {
        this.timers.clearTimeout(this.helloTimer);
        const code = packet.d?.code;
        if (code !== 0) {
          this.lastError = `HELLO 失败，错误码 ${code}`;
          if (code === 40101 || code === 40102) return this.fatal(this.lastError);
          return this.drop(ws);
        }
        this.sessionId = packet.d.session_id;
        this.connectedAt = new Date().toISOString();
        this.backoff = 0;
        this.lastError = null;
        this.setState('connected', { sessionId: this.sessionId });
        this.schedulePing(ws);
        return;
      }
      case 0: return this.receive(packet);
      case 3: this.timers.clearTimeout(this.pongTimer); this.pongTimer = null; return;
      case 5: this.sn = 0; this.pending.clear(); this.lastError = `服务端要求重连（${packet.d?.code ?? ''}）`; return this.drop(ws);
      default: return; // s=6 RESUME ACK 等，本实现不需要处理
    }
  }

  receive(packet) {
    const sn = packet.sn;
    if (typeof sn !== 'number') return this.emit(packet.d);
    if (this.sn !== 0 && sn <= this.sn) return; // 重复
    if (this.sn !== 0 && sn > this.sn + 1) {
      this.pending.set(sn, packet.d); // 乱序：先缓存，等缺的那条
      if (this.pending.size < 50) return;
      // 缓存太多说明缺的那条不会来了，按顺序全部放行
      for (const key of [...this.pending.keys()].sort((a, b) => a - b)) {
        this.emit(this.pending.get(key));
        this.sn = key;
      }
      this.pending.clear();
      return;
    }
    this.emit(packet.d);
    this.sn = sn;
    while (this.pending.has(this.sn + 1)) {
      this.sn += 1;
      this.emit(this.pending.get(this.sn));
      this.pending.delete(this.sn);
    }
  }

  emit(d) {
    try { this.onEvent(d); } catch { /* 单条处理失败不影响连接 */ }
  }

  schedulePing(ws) {
    const delay = 25000 + Math.floor(Math.random() * 10000);
    this.pingTimer = this.timers.setTimeout(() => {
      if (this.ws !== ws) return;
      try { ws.send(JSON.stringify({ s: 2, sn: this.sn })); } catch { return this.drop(ws); }
      this.pongTimer = this.timers.setTimeout(() => { this.lastError = '6 秒内没收到 PONG'; this.drop(ws); }, 6000);
      this.schedulePing(ws);
    }, delay);
  }

  drop(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    try { ws.close(); } catch { /* 忽略 */ }
    this.sn = 0;
    this.pending.clear();
    this.retry();
  }

  retry() {
    if (this.stopped) return;
    this.clearTimers();
    this.backoff = Math.min(this.backoff ? this.backoff * 2 : 2, 60);
    this.setState('reconnecting', { inSeconds: this.backoff, error: this.lastError });
    this.retryTimer = this.timers.setTimeout(() => void this.connect(), this.backoff * 1000);
  }

  fatal(message) {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(); } catch { /* 忽略 */ }
    this.ws = null;
    this.lastError = message;
    this.setState('failed', { error: `${message}（Token 无效或已失效，请检查 kook-token.txt）` });
  }
}

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
