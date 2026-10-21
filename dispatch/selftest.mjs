#!/usr/bin/env node
/**
 * KOOK 派单平台 · 离线自测（不联网、不碰真 KOOK、不调大模型）。
 * 用法：node selftest.mjs
 */
import { createServer } from 'node:net';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { parseFormat, recognize, validate, createRecognizer, listPending, saveLlmConfig } from './recognize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'kook-dispatch-selftest-'));
import { createDispatcher, esc } from './dispatch.mjs';
import { createApp } from './server.mjs';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failed += 1;
}

// ---------- 1. 识别 ----------
console.log('1. 订单识别');
{
  const f = parseFormat('(met)9000(met) 派单 游戏：三角洲 要求:改枪 人数:2 时间:今晚9点 备注:要会玩狙');
  check('固定格式解析', f?.game === '三角洲' && f.requirement === '改枪' && f.headcount === 2 && f.play_time === '今晚9点' && f.notes === '要会玩狙', JSON.stringify(f));
  check('没有「派单」不当固定格式', parseFormat('游戏:三角洲 要求:改枪') === null);
  check('人数夹在 1~20、字段截断', validate({ is_order: true, game: 'x', headcount: 999 }).headcount === 20);
  check('没有游戏和要求就不算订单', validate({ is_order: true }).is_order === false);

  let sent;
  const fakeFetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ is_order: true, game: '三角洲', requirement: '带打', headcount: '1', play_time: '现在', notes: '', extra: '多余字段' }) } }] }) };
  };
  const r = await recognize('来个人带我打三角洲，现在就要', { apiKey: 'k', baseUrl: 'https://llm.test', model: 'm', fetchImpl: fakeFetch });
  check('大模型识别并校验输出', r.parsed_by === 'llm' && r.game === '三角洲' && r.headcount === 1 && !('extra' in r), JSON.stringify(r));
  check('大模型请求带 Key、JSON 模式、原话包在 <message> 里', sent.auth === 'Bearer k' && sent.body.response_format.type === 'json_object' && sent.body.messages[1].content.includes('<message>'));
  const none = await recognize('随便聊聊', {});
  check('没配 Key 且非固定格式时不算订单', none.is_order === false && none.parsed_by === 'none');
  check('KMarkdown 转义并去掉 @全体', esc('(met)all(met)**粗**') === '\\*\\*粗\\*\\*', esc('(met)all(met)**粗**'));

  // Claude 人工识别队列：平台写 pending → 外部回填 answers → 平台拿到并校验（默认关闭，这里先打开）
  check('人工识别默认关闭', (await createRecognizer({ dir: tmp, queueDir: join(tmp, 'q') })('随便聊聊')).parsed_by === 'none');
  saveLlmConfig(tmp, { claudeFallback: true });
  const recognizer = createRecognizer({ dir: tmp, queueDir: join(tmp, 'q'), claudeTimeoutMs: 5000 });
  let notified = false;
  const waiting = recognizer('今晚来个人带我打三角洲', { notify: () => { notified = true; } });
  let item;
  for (let i = 0; i < 50 && !item; i++) { await new Promise((r) => setTimeout(r, 50)); item = listPending(join(tmp, 'q'))[0]; }
  check('没 Key 时进入 Claude 待识别队列，并先通知老板', item?.text === '今晚来个人带我打三角洲' && notified, JSON.stringify(item));
  const answered = spawnSync(process.execPath, [join(here, 'answer.mjs'), item.id], {
    input: JSON.stringify({ is_order: true, game: '三角洲', requirement: '带打', headcount: 99, play_time: '今晚' }),
    env: { ...process.env, RECOGNIZE_QUEUE_DIR: join(tmp, 'q') }, encoding: 'utf8',
  });
  check('answer.mjs 回填成功', answered.status === 0, answered.stderr);
  const got = await waiting;
  check('平台拿到人工识别结果并校验（人数夹到 20）', got.parsed_by === 'claude' && got.game === '三角洲' && got.headcount === 20, JSON.stringify(got));
  check('识别完清理队列', listPending(join(tmp, 'q')).length === 0);
  saveLlmConfig(tmp, { claudeFallback: false });
  check('关掉人工识别且没 Key 时只认固定格式', (await recognizer('随便聊聊')).parsed_by === 'none');
  saveLlmConfig(tmp, { claudeFallback: true });
}

// ---------- 2. 派单流程 ----------
console.log('2. 派单流程');
const BOT = '9000', BOSS = '1001', T1 = '2001', T2 = '2002', NOBODY = '3001';
const ROLES = { boss: 100, taker: 200 };
const memberRoles = { [BOSS]: [100], [T1]: [200], [T2]: [200], [NOBODY]: [] };
const outbox = [];
const kook = {
  botId: BOT,
  botName: 'bot#0001',
  guildId: 'G',
  memberRoles: async (id) => memberRoles[id] || [],
  membersWithRole: async (roleId) => Object.entries(memberRoles).filter(([, r]) => r.includes(roleId)).map(([id]) => ({ id })),
  dm: async (id, text) => outbox.push({ to: id, text }),
  dmCard: async (id, card) => outbox.push({ to: id, card }),
  reply: async (ch, text, quote) => outbox.push({ ch, text, quote }),
  findVoiceChannel: async (id) => (id === BOSS ? { id: 'V1', name: '语音1' } : null),
  createInvite: async ({ channelId, channelName }) => ({ url: `https://kook.top/${channelId}`, channel: `#${channelName}` }),
  members: async () => [{ id: T1, username: 't1#0001', nickname: '打手一', roles: [200], online: true, bot: false }],
  roles: async () => [{ role_id: 1, name: '管理员', permissions: 1, position: 2 }, { role_id: 200, name: '打手', permissions: 0, position: 9 }, { role_id: 0, name: '@全体成员', permissions: 0, position: 999 }],
  setRole: async (uid, roleId) => ({ roles: [roleId] }),
};
const db = openDb(':memory:');
const recognizeText = (text) => recognize(text, {});
const dispatcher = createDispatcher({ db, kook, roles: ROLES, recognizeText, pause: async () => {} });
const dmEvent = (from, content, name = from) => ({ type: 9, channel_type: 'PERSON', author_id: from, content, msg_id: `m-${Math.random()}`, extra: { author: { username: name, identify_num: '0001', nickname: name } } });
const click = (from, value) => ({ type: 255, channel_type: 'PERSON', extra: { type: 'message_btn_click', body: { user_id: from, value, user_info: { username: from, identify_num: '0001', nickname: from } } } });
const to = (id) => outbox.filter((m) => m.to === id);
{
  await dispatcher.handleEvent(dmEvent(NOBODY, '派单 游戏:三角洲 要求:改枪'));
  check('非「老板」不能派单', db.listOrders().length === 0 && to(NOBODY).at(-1)?.text.includes('只有「老板」'));

  await dispatcher.handleEvent(dmEvent(BOSS, '派单 游戏:三角洲 要求:改枪 人数:1 时间:今晚9点', '老板A'));
  const [order] = db.listOrders();
  check('老板私信下单 → 生成订单', order?.order_no.startsWith('KD') && order.game === '三角洲' && order.status === 'open' && order.dispatcher_name === '老板A', JSON.stringify(order));
  check('只推送给打手（不含老板本人）', to(T1).some((m) => m.card) && to(T2).some((m) => m.card) && !to(BOSS).some((m) => m.card) && order.pushed_count === 2);
  check('推送卡片带接单按钮', JSON.stringify(to(T1).find((m) => m.card).card).includes(`accept:${order.order_no}`));

  await dispatcher.handleEvent(click(NOBODY, `accept:${order.order_no}`));
  check('非打手点接单被拒', db.getOrder(order.order_no).applicants.length === 0);

  await Promise.all([
    dispatcher.handleEvent(click(T1, `accept:${order.order_no}`)),
    dispatcher.handleEvent(click(T2, `accept:${order.order_no}`)),
    dispatcher.handleEvent(click(T1, `accept:${order.order_no}`)),
  ]);
  const applied = db.getOrder(order.order_no);
  check('两个打手同时接单都记上、重复报名不重复记', applied.applicants.length === 2 && applied.status === 'applied', JSON.stringify(applied.applicants));
  const pickCards = to(BOSS).filter((m) => m.card);
  check('老板收到每位打手的选人卡片', pickCards.length === 2 && JSON.stringify(pickCards[0].card).includes(`pick:${order.order_no}:`));

  await dispatcher.handleEvent(click(T2, `pick:${order.order_no}:${T2}`));
  check('只有派单老板本人能选人', db.getOrder(order.order_no).status === 'applied');

  await Promise.all([
    dispatcher.handleEvent(click(BOSS, `pick:${order.order_no}:${T1}`)),
    dispatcher.handleEvent(click(BOSS, `pick:${order.order_no}:${T2}`)),
  ]);
  const done = db.getOrder(order.order_no);
  check('老板选人 → 已派单，且连点不会派两次', done.status === 'assigned' && done.assignee_id === T1, JSON.stringify(done));
  check('邀请链接是老板所在语音频道', done.invite_url === 'https://kook.top/V1' && done.invite_channel === '#语音1');
  const inviteMsg = to(T1).find((m) => JSON.stringify(m.card || '').includes('"invite"'));
  check('被选中的打手收到带「邀请模块」的卡片', inviteMsg && JSON.stringify(inviteMsg.card).includes('"code":"https://kook.top/V1"') && JSON.stringify(inviteMsg.card).includes('[https://kook.top/V1](https://kook.top/V1)'), JSON.stringify(inviteMsg));
  check('落选打手收到通知', to(T2).some((m) => m.text?.includes('已被其他打手接走')));
  check('开始时间 = 创单 + 5 分钟', Date.parse(done.start_at) - Date.parse(done.created_at) === 5 * 60000, `${done.created_at} → ${done.start_at}`);
  check('打手的邀请卡片带 [提交结单] 按钮', JSON.stringify(inviteMsg.card).includes(`submit:${order.order_no}`));

  // 结单与评分
  await dispatcher.handleEvent(click(T2, `submit:${order.order_no}`));
  check('非接单打手不能提交结单', db.getOrder(order.order_no).status === 'assigned');
  await dispatcher.handleEvent(click(BOSS, `rate:${order.order_no}:5`));
  check('打手没提交前老板不能结单', db.getOrder(order.order_no).status === 'assigned');
  await dispatcher.handleEvent(click(T1, `submit:${order.order_no}`));
  const closeMsg = to(BOSS).filter((m) => m.card).at(-1);
  check('打手提交结单 → 待结单，老板收到 ★1~★5 + 暂不结单卡片', db.getOrder(order.order_no).status === 'submitted'
    && [1, 2, 3, 4, 5].every((n) => JSON.stringify(closeMsg.card).includes(`rate:${order.order_no}:${n}`)) && JSON.stringify(closeMsg.card).includes(`reject:${order.order_no}`));
  check('每组按钮不超过 4 个', closeMsg.card[0].modules.filter((m) => m.type === 'action-group').every((g) => g.elements.length <= 4));
  await dispatcher.handleEvent(click(BOSS, `reject:${order.order_no}`));
  check('老板点暂不结单 → 退回进行中，打手收到通知', db.getOrder(order.order_no).status === 'assigned' && to(T1).some((m) => m.text?.includes('暂未确认')));
  await dispatcher.handleEvent(click(T1, `submit:${order.order_no}`));
  await dispatcher.handleEvent(click(T1, `rate:${order.order_no}:5`));
  await dispatcher.handleEvent(click(BOSS, `rate:${order.order_no}:9`));
  check('打手不能给自己评分、星级超范围无效', db.getOrder(order.order_no).status === 'submitted');
  await Promise.all([dispatcher.handleEvent(click(BOSS, `rate:${order.order_no}:4`)), dispatcher.handleEvent(click(BOSS, `rate:${order.order_no}:1`))]);
  const closed = db.getOrder(order.order_no);
  check('老板点 4 星 → 已完成，连点不会改分', closed.status === 'completed' && closed.rating === 4, JSON.stringify(closed));
  check('持续时长 = 结束 + 5 分钟 − 创单', closed.duration_ms === Date.parse(closed.completed_at) + 5 * 60000 - Date.parse(closed.created_at), String(closed.duration_ms));
  check('打手收到结单评分通知', to(T1).some((m) => m.text?.includes('★★★★☆')));

  await dispatcher.handleEvent({ type: 9, channel_type: 'GROUP', author_id: BOSS, target_id: 'C1', content: '派单 游戏:原神', msg_id: 'g1', extra: { mention: [], author: { username: 'boss' } } });
  check('频道里没 @机器人 的消息不处理', db.listOrders().length === 1);
  await dispatcher.handleEvent({ type: 9, channel_type: 'GROUP', author_id: BOSS, target_id: 'C1', content: `(met)${BOT}(met) 派单 游戏:原神 要求:陪玩`, msg_id: 'g2', extra: { mention: [BOT], author: { username: 'boss' } } });
  check('频道 @机器人 下单 → 生成订单并在频道回复', db.listOrders().length === 2 && outbox.some((m) => m.ch === 'C1' && m.quote === 'g2'));
  check('已派单的订单不能取消', db.cancel(order.order_no) === false);
}

// 旧版数据库（没有开始时间/结单字段）打开时自动补列
{
  const oldPath = join(tmp, 'old.db');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(oldPath);
  old.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, dispatcher_id TEXT NOT NULL)");
  old.close();
  const migrated = openDb(oldPath);
  const cols = migrated.raw.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  check('旧数据库自动补上新字段', ['start_at', 'submitted_at', 'completed_at', 'rating', 'duration_ms'].every((c) => cols.includes(c)), cols.join(','));
  migrated.raw.close();
}

// ---------- 3. 网站 ----------
console.log('3. 本机网站');
{
  const port = await new Promise((resolve) => { const probe = createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
  const server = createApp({ db, kook, password: 'secret-pass', port, configDir: tmp, queueDir: join(tmp, 'q') });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const call = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-Requested-With': 'kook-admin' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  check('首页能打开', (await fetch(`${base}/`)).status === 200);
  check('没登录不能看订单', (await call('/api/orders')).status === 401);
  check('密码错误被拒', (await call('/api/login', { method: 'POST', body: { password: 'wrong' } })).status === 401);
  const login = await call('/api/login', { method: 'POST', body: { password: 'secret-pass' } });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  check('密码正确登录成功，Cookie 是 HttpOnly', login.status === 200 && /HttpOnly/.test(login.headers.get('set-cookie')));
  const orders = await (await call('/api/orders', { cookie })).json();
  check('订单列表含订单号/派单人/接单人/评分/时长', orders.length === 2 && orders[1].assignee_id === T1 && orders[1].applicants.length === 2 && orders[1].rating === 4 && orders[1].duration_ms > 0);
  check('按状态筛选', (await (await call('/api/orders?status=completed', { cookie })).json()).length === 1);
  check('缺少防伪造请求头的修改请求被拒', (await fetch(`${base}/api/orders/${orders[0].order_no}/cancel`, { method: 'POST', headers: { Cookie: cookie } })).status === 403);
  check('取消未派单的订单', (await call(`/api/orders/${orders[0].order_no}/cancel`, { method: 'POST', cookie })).status === 200);
  const roles = await (await call('/api/roles', { cookie })).json();
  check('角色列表标出管理员权限、去掉 @全体成员', roles.length === 2 && roles.find((r) => r.id === 1).admin === true);
  const adminGrant = await call(`/api/members/${T1}/roles`, { method: 'POST', cookie, body: { action: 'grant', role_id: 1 } });
  check('授予管理员角色需要二次确认', adminGrant.status === 409 && (await adminGrant.json()).needConfirm === true);
  check('确认后授予成功', (await call(`/api/members/${T1}/roles`, { method: 'POST', cookie, body: { action: 'grant', role_id: 1, confirm_admin: true } })).status === 200);
  const audit = await (await call('/api/audit', { cookie })).json();
  check('操作写进日志', audit.some((a) => a.action === '授予角色') && audit.some((a) => a.action === '取消订单'));
  const evilStatus = await new Promise((resolve) => {
    request({ host: '127.0.0.1', port, path: '/api/session', headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).end();
  });
  check('外部 Host 头被拒（防 DNS 重绑定）', evilStatus === 403, String(evilStatus));

  const before = await (await call('/api/settings/llm', { cookie })).json();
  check('识别设置：没 Key 且开了人工识别时为 Claude 人工识别', before.mode === 'claude' && before.keySet === false, JSON.stringify(before));
  check('接口地址必须 https', (await call('/api/settings/llm', { method: 'POST', cookie, body: { baseUrl: 'http://evil.example' } })).status === 400);
  const saved = await (await call('/api/settings/llm', { method: 'POST', cookie, body: { apiKey: 'sk-test-abcd1234', model: 'deepseek-chat' } })).json();
  check('保存 Key 后切到大模型模式，返回里只有末 4 位', saved.mode === 'llm' && saved.keyTail === '…1234' && !JSON.stringify(saved).includes('sk-test'), JSON.stringify(saved));
  check('Key 存进 llm-key.txt', existsSync(join(tmp, 'llm-key.txt')) && readFileSync(join(tmp, 'llm-key.txt'), 'utf8') === 'sk-test-abcd1234');
  const auditAfter = await (await call('/api/audit', { cookie })).json();
  check('日志里不出现完整 Key', !JSON.stringify(auditAfter).includes('sk-test') && auditAfter.some((a) => a.action === '修改识别设置'));
  const cleared = await (await call('/api/settings/llm', { method: 'POST', cookie, body: { clearKey: true } })).json();
  check('清除 Key 后退回 Claude 人工识别', cleared.mode === 'claude' && !existsSync(join(tmp, 'llm-key.txt')));
  server.close();
}
rmSync(tmp, { recursive: true, force: true });

console.log(failed ? `\n✘ ${failed} 项失败` : '\n✔ 全部通过');
process.exit(failed ? 1 : 0);
