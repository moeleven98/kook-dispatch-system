#!/usr/bin/env node
/**
 * KOOK 接入 · MCP 服务器（零依赖，stdio，只读）。
 *
 * 大模型（Claude Code 等 MCP 客户端）通过这里的工具读取 KOOK 服务器数据。
 * 进程启动后会自动连 KOOK 实时网关，把收到的消息存进内存和 data/messages-日期.jsonl；
 * 进程随 MCP 客户端启停，客户端关掉期间的消息收不到（可用 kook_channel_history 补）。
 *
 * 工具：
 *   kook_status            Token、机器人身份、网关连接状态、已缓存消息数
 *   kook_list_guilds       机器人所在的服务器
 *   kook_list_channels     某服务器的文字频道
 *   kook_list_members      某服务器的全部成员
 *   kook_recent_messages   实时收到的消息（可按服务器/频道/时间过滤）
 *   kook_channel_history   直接向 KOOK 拉某频道最近的历史消息
 *
 * 环境变量：KOOK_TOKEN（或项目根目录的 kook-token.txt）、KOOK_DATA_DIR（默认本目录 data/）、
 *          KOOK_GATEWAY=off（不连实时网关，自测用）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, createClient, slimMember, normalizeEvent, normalizeHistoryItem, MessageStore, Gateway } from './kook-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KOOK_DATA_DIR || join(here, 'data');
const SERVER_INFO = { name: 'kook', version: '0.1.0' };

const token = loadToken(join(here, '..'));
const client = token ? createClient({ token }) : null;
const store = new MessageStore({ dir: DATA_DIR });
const gatewayInfo = { state: token ? 'idle' : 'no-token' };
let gateway = null;
if (client && process.env.KOOK_GATEWAY !== 'off') {
  gateway = new Gateway({
    client,
    onEvent: (d) => store.add(normalizeEvent(d)),
    onStatus: (s) => Object.assign(gatewayInfo, { error: undefined, inSeconds: undefined }, s, { at: new Date().toISOString() }),
  });
  gateway.start();
}

const guildArg = { guild_id: { type: 'string', description: '服务器ID；不填则用机器人所在的第一个服务器' } };
const TOOLS = [
  {
    name: 'kook_status',
    description: '查看 KOOK 接入状态：Token 是否可用、机器人身份、实时网关是否连上、已缓存多少条消息。出问题时先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'kook_list_guilds',
    description: '列出机器人所在的 KOOK 服务器（ID 和名称）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'kook_list_channels',
    description: '列出某个服务器的文字频道（ID 和名称）。',
    inputSchema: { type: 'object', properties: guildArg, additionalProperties: false },
  },
  {
    name: 'kook_list_members',
    description: '拉取某个服务器的全部成员：ID、用户名#识别号、服务器昵称、角色ID列表、是否在线、是否机器人、加入时间、最近活跃时间。可用 search 按名字筛选。',
    inputSchema: {
      type: 'object',
      properties: { ...guildArg, search: { type: 'string', description: '按用户名或昵称模糊筛选，可选' } },
      additionalProperties: false,
    },
  },
  {
    name: 'kook_recent_messages',
    description: '读取实时网关收到的服务器消息（本进程运行期间 + 今天已落盘的），按时间从旧到新。只有机器人能看到的频道才会收到。',
    inputSchema: {
      type: 'object',
      properties: {
        ...guildArg,
        channel_id: { type: 'string', description: '只看这个频道，可选' },
        since: { type: 'string', description: 'ISO 时间，只看这之后的消息，可选' },
        limit: { type: 'integer', description: '最多返回多少条，默认 50，上限 500' },
        include_system: { type: 'boolean', description: '是否包含系统事件（成员加入/退出、改昵称等），默认否' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kook_channel_history',
    description: '直接向 KOOK 拉某个文字频道最近的历史消息（不依赖实时网关，可补齐网关没收到的部分）。',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: '频道ID（用 kook_list_channels 查）' },
        page_size: { type: 'integer', description: '条数，默认 50，上限 100' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
];

// ---------- MCP stdio 传输：换行分隔的 JSON-RPC 2.0 ----------
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handleLine(line);
  }
});
process.stdin.on('end', () => { gateway?.stop(); process.exit(0); });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // 通知（如 notifications/initialized）不需要回复
  try {
    switch (method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        } });
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments ?? {});
        send({ jsonrpc: '2.0', id, result });
        return;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
}

function toolResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError };
}

async function callTool(name, args) {
  if (name === 'kook_recent_messages') return recentMessages(args);
  if (name === 'kook_status') return toolResult(await status());
  if (!client) return toolResult({ ok: false, error: '没有 Token：请在项目根目录新建 kook-token.txt，只放机器人 Token 一行，然后重启 MCP 客户端。' }, true);
  try {
    if (name === 'kook_list_guilds') return toolResult((await client.guilds()).map((g) => ({ id: g.id, name: g.name })));
    if (name === 'kook_list_channels') {
      const channels = await client.channels(await resolveGuild(args.guild_id));
      return toolResult(channels.filter((c) => !c.is_category).map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id })));
    }
    if (name === 'kook_list_members') return listMembers(args);
    if (name === 'kook_channel_history') {
      if (!args.channel_id) return toolResult({ ok: false, error: 'channel_id 不能为空' }, true);
      const size = Math.min(Math.max(Number(args.page_size) || 50, 1), 100);
      const items = await client.history(args.channel_id, size);
      return toolResult(items.map((item) => normalizeHistoryItem(item, args.channel_id)).sort((a, b) => a.at.localeCompare(b.at)));
    }
  } catch (error) {
    return toolResult({ ok: false, error: error.message }, true);
  }
  return toolResult({ ok: false, error: `未知工具：${name}` }, true);
}

// ---------- 工具实现 ----------
async function status() {
  const result = { tokenFound: Boolean(token), gateway: gatewayInfo, cachedMessages: store.items.length, dataDir: DATA_DIR };
  if (!client) return { ...result, hint: '没有 Token：请在项目根目录新建 kook-token.txt。' };
  try {
    const me = await client.me();
    result.bot = { id: me.id, name: `${me.username}#${me.identify_num}` };
  } catch (error) {
    result.tokenError = error.message;
  }
  return result;
}

async function resolveGuild(guildId) {
  if (guildId) return guildId;
  const guilds = await client.guilds();
  if (!guilds.length) throw new Error('机器人还不在任何服务器里，请先用邀请链接把它拉进服务器。');
  return guilds[0].id;
}

async function listMembers(args) {
  const guildId = await resolveGuild(args.guild_id);
  let members = (await client.members(guildId)).map(slimMember);
  if (args.search) {
    const needle = String(args.search).toLowerCase();
    members = members.filter((m) => m.username.toLowerCase().includes(needle) || m.nickname.toLowerCase().includes(needle));
  }
  return toolResult({ guild_id: guildId, total: members.length, online: members.filter((m) => m.online).length, members });
}

function recentMessages(args) {
  const messages = store.query({
    guildId: args.guild_id,
    channelId: args.channel_id,
    since: args.since,
    limit: Number(args.limit) || 50,
    includeSystem: Boolean(args.include_system),
  });
  return toolResult({ gateway: gatewayInfo.state, count: messages.length, messages });
}
