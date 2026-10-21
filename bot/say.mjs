#!/usr/bin/env node
/**
 * KOOK 接入 · 以机器人身份发一条消息（写操作，带护栏）。
 *
 * 用法：node say.mjs <频道ID> [要引用回复的消息ID] < 正文（从标准输入读，UTF-8）
 *
 * 护栏：
 *   - 只能发到机器人所在服务器的现有文字频道
 *   - 自动去掉 @全体 / @在线 / @角色，正文最长 1500 字
 *   - 两条之间至少隔 3 秒（不够就等），每小时最多 60 条（超了直接拒绝）
 *   - 每条发出的消息都记到 data/sent-日期.jsonl
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, createClient, sanitizeOutgoing, sleep } from './kook-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KOOK_DATA_DIR || join(here, 'data');
const MIN_GAP_MS = 3000;
const HOURLY_LIMIT = 60;

const [channelId, quote] = process.argv.slice(2);
const content = sanitizeOutgoing(readFileSync(0, 'utf8'));
const fail = (message) => { console.error(`未发送：${message}`); process.exit(1); };
if (!channelId) fail('缺少频道ID');
if (!content) fail('正文为空');

const token = loadToken(join(here, '..'));
if (!token) fail('没找到 Token');
const client = createClient({ token });

const allowed = new Set();
for (const guild of await client.guilds()) {
  for (const channel of await client.channels(guild.id)) if (!channel.is_category) allowed.add(channel.id);
}
if (!allowed.has(channelId)) fail(`频道 ${channelId} 不是机器人所在服务器的文字频道`);

mkdirSync(DATA_DIR, { recursive: true });
const logPath = join(DATA_DIR, `sent-${new Date().toISOString().slice(0, 10)}.jsonl`);
const recent = existsSync(logPath)
  ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => Date.parse(JSON.parse(line).at))
  : [];
const now = Date.now();
if (recent.filter((t) => now - t < 3600000).length >= HOURLY_LIMIT) fail(`过去一小时已发 ${HOURLY_LIMIT} 条，达到上限`);
const last = Math.max(0, ...recent);
if (now - last < MIN_GAP_MS) await sleep(MIN_GAP_MS - (now - last));

try {
  const result = await client.send(channelId, content, { quote: quote || undefined });
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), channel_id: channelId, quote: quote || null, msg_id: result.msg_id, content })}\n`, 'utf8');
  console.log(`已发送（消息ID ${result.msg_id}）`);
} catch (error) {
  fail(error.message);
}
