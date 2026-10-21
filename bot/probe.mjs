#!/usr/bin/env node
/**
 * KOOK 接入 · 可行性探针（命令行，只读）。
 *
 * 用法（在本文件夹里执行）：
 *   node probe.mjs check                 看 Token 能不能用、机器人在哪些服务器、各有几个文字频道
 *   node probe.mjs members [服务器ID]     拉全部成员，存到 data/members-服务器ID.json
 *   node probe.mjs listen [秒数]          连实时网关，把收到的消息打印出来（默认 60 秒）
 *   node probe.mjs history <频道ID>       拉某个文字频道最近 50 条历史消息
 * 不写服务器ID时默认用机器人所在的第一个服务器。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, createClient, slimMember, normalizeEvent, normalizeHistoryItem, MessageStore, Gateway } from './kook-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KOOK_DATA_DIR || join(here, 'data');

const token = loadToken(join(here, '..'));
if (!token) {
  console.error('没找到 Token：请在项目根目录新建 kook-token.txt，里面只放机器人 Token 一行（或设置环境变量 KOOK_TOKEN）。');
  process.exit(1);
}
const client = createClient({ token });
const [command = 'check', arg] = process.argv.slice(2);

try {
  if (command === 'check') await check();
  else if (command === 'members') await members(arg);
  else if (command === 'listen') await listen(Number(arg) || 60);
  else if (command === 'history') await history(arg);
  else { console.error(`未知命令：${command}`); process.exit(1); }
} catch (error) {
  console.error(`失败：${error.message}`);
  process.exit(1);
}

async function firstGuildId() {
  const guilds = await client.guilds();
  if (!guilds.length) throw new Error('机器人还不在任何服务器里：请先用开发者后台的邀请链接把它拉进你的服务器。');
  return guilds[0].id;
}

async function check() {
  const me = await client.me();
  console.log(`✔ Token 可用，机器人：${me.username}#${me.identify_num}（ID ${me.id}）`);
  const guilds = await client.guilds();
  console.log(`✔ 机器人所在服务器：${guilds.length} 个`);
  for (const guild of guilds) {
    const channels = await client.channels(guild.id);
    const text = channels.filter((c) => !c.is_category);
    console.log(`  - ${guild.name}（服务器ID ${guild.id}）：文字频道 ${text.length} 个`);
    for (const c of text) console.log(`      · #${c.name}（频道ID ${c.id}）`);
  }
}

async function members(guildId) {
  const id = guildId || await firstGuildId();
  const list = (await client.members(id)).map(slimMember);
  mkdirSync(DATA_DIR, { recursive: true });
  const out = join(DATA_DIR, `members-${id}.json`);
  writeFileSync(out, JSON.stringify(list, null, 2), 'utf8');
  console.log(`✔ 共拉到 ${list.length} 位成员（在线 ${list.filter((m) => m.online).length}），已存到 ${out}`);
  for (const m of list.slice(0, 20)) console.log(`  - ${m.nickname || m.username}（${m.username}）角色${JSON.stringify(m.roles)}${m.bot ? ' [机器人]' : ''}`);
  if (list.length > 20) console.log(`  …其余 ${list.length - 20} 位见文件`);
}

async function history(channelId) {
  if (!channelId) throw new Error('请给出频道ID：node probe.mjs history <频道ID>（频道ID可以用 check 命令看到）');
  const items = (await client.history(channelId)).map((item) => normalizeHistoryItem(item, channelId));
  console.log(`✔ 拉到 ${items.length} 条历史消息`);
  for (const m of items) console.log(`  [${m.at}] ${m.author_name}：${String(m.content).slice(0, 120)}`);
}

function listen(seconds) {
  const store = new MessageStore({ dir: DATA_DIR });
  let count = 0;
  const gateway = new Gateway({
    client,
    onEvent: (d) => {
      const m = normalizeEvent(d);
      store.add(m);
      count += 1;
      const where = m.channel_name ? `#${m.channel_name}` : m.channel_type;
      console.log(`[${m.at}] ${where} ${m.author_name || m.author_id}（${m.kind}）：${String(m.content).slice(0, 160)}`);
    },
    onStatus: (s) => console.log(`· 网关状态：${s.state}${s.error ? `（${s.error}）` : ''}${s.inSeconds ? `，${s.inSeconds} 秒后重连` : ''}`),
  });
  console.log(`开始监听 ${seconds} 秒，去你的服务器任意文字频道发几句话试试……`);
  gateway.start();
  return new Promise((resolve) => setTimeout(() => {
    gateway.stop();
    console.log(`结束：共收到 ${count} 条事件，已追加到 ${store.file()}`);
    resolve();
  }, seconds * 1000));
}
