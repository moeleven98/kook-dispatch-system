/**
 * KOOK 派单平台 · 派单流程。
 *
 *   ① 「老板」私信机器人，或在频道 @机器人，描述需求
 *   ② 识别成订单 → 私信所有「打手」一张带 [接单] 按钮的卡片
 *   ③ 打手点 [接单] → 私信老板一张带 [选TA] 按钮的卡片
 *   ④ 老板点 [选TA] → 生成老板所在语音频道（不在语音时用下单的文字频道 / 整个服务器）的邀请链接，
 *      连同订单开始时间（创单 + 5 分钟）和 [提交结单] 按钮私信给被选中的打手；其他报名者收到「已被接走」通知
 *   ⑤ 打手点 [提交结单] → 私信老板一张结单卡片：★1~★5 评分按钮（点了即结单）+ [暂不结单]
 *   ⑥ 老板点星级 → 已完成，记录结束时间和持续时长；点 [暂不结单] → 退回进行中，打手可再次提交
 *
 * 安全：KOOK 里的文字只当订单内容；身份一律按 KOOK 角色和按钮点击者的用户ID判断；
 * 本模块不做任何角色/踢人等管理操作。
 *
 * kook 适配器需要提供：botId、memberRoles(uid)、membersWithRole(roleId)、dm(uid, text)、dmCard(uid, card)、
 * reply(channelId, text, quoteMsgId)、findVoiceChannel(uid)、createInvite({channelId}) → {url, channel}
 */
import { STATUS } from './db.mjs';

const MAX_PUSH = 30;

export function createDispatcher({ db, kook, recognizeText, roles, log = () => {}, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // 同一订单的按钮点击排队串行处理，防止两个打手同时点、或老板连点导致重复派单
  const queues = new Map();
  function serial(key, task) {
    const run = (queues.get(key) || Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  async function handleEvent(d) {
    try {
      if (d.type === 255 && d.extra?.type === 'message_btn_click') return await onButton(d.extra.body || {});
      if (d.type !== 1 && d.type !== 9) return;
      const author = d.extra?.author || {};
      if (d.author_id === kook.botId || author.bot) return;
      const isDm = d.channel_type === 'PERSON';
      const atMe = (d.extra?.mention || []).includes(kook.botId);
      if (!isDm && !(d.channel_type === 'GROUP' && atMe)) return;
      return await onRequest({
        userId: d.author_id,
        name: author.nickname || author.username || d.author_id,
        tag: author.username ? `${author.username}#${author.identify_num}` : null,
        text: d.content,
        source: isDm ? 'dm' : 'channel',
        channelId: isDm ? null : d.target_id,
        msgId: d.msg_id,
      });
    } catch (error) {
      log({ level: 'error', where: 'handleEvent', error: error.message });
    }
  }

  async function onRequest(req) {
    const answer = (text) => (req.source === 'dm' ? kook.dm(req.userId, text) : kook.reply(req.channelId, text, req.msgId));
    const userRoles = await kook.memberRoles(req.userId);
    if (!userRoles.includes(roles.boss)) return answer('只有「老板」角色可以派单哦。');

    let parsed;
    try {
      parsed = await recognizeText(req.text, { notify: () => answer('收到～正在识别订单，请稍等…') });
    } catch (error) {
      log({ level: 'error', where: 'recognize', error: error.message });
      return answer('订单识别暂时出错了，请稍后再试，或用固定格式：派单 游戏:三角洲 要求:改枪 人数:1 时间:今晚9点');
    }
    if (!parsed.is_order) {
      return answer('没识别出订单～请说明 游戏 / 要求 / 人数 / 时间，例如：派单 游戏:三角洲 要求:改枪 人数:1 时间:今晚9点');
    }

    const order = db.createOrder({
      dispatcher_id: req.userId, dispatcher_name: req.name, dispatcher_tag: req.tag,
      source: req.source, source_channel_id: req.channelId, raw_text: req.text,
      game: parsed.game, requirement: parsed.requirement, headcount: parsed.headcount,
      play_time: parsed.play_time, notes: parsed.notes, parsed_by: parsed.parsed_by,
    });
    log({ level: 'info', event: 'order-created', order: order.order_no, by: req.tag });

    const takers = (await kook.membersWithRole(roles.taker)).filter((u) => u.id !== req.userId && !u.bot).slice(0, MAX_PUSH);
    let pushed = 0;
    for (const taker of takers) {
      try {
        await kook.dmCard(taker.id, orderCard(order, { title: `新订单 ${order.order_no}`, button: { text: '接单', value: `accept:${order.order_no}` } }));
        pushed += 1;
      } catch (error) {
        log({ level: 'warn', event: 'push-failed', order: order.order_no, to: taker.id, error: error.message });
      }
      await pause(1100);
    }
    db.setPushed(order.order_no, pushed);

    await kook.dm(req.userId, `订单 **${order.order_no}** 已创建，已推送给 ${pushed} 位打手。有人接单会私信通知你选人。\n${summary(order)}`);
    if (req.source === 'channel') await kook.reply(req.channelId, `收到～订单 ${order.order_no} 已创建，后续通过私信通知你。`, req.msgId);
  }

  async function onButton({ user_id: userId, value, user_info: info = {} }) {
    const [action, orderNo, targetId] = String(value || '').split(':');
    if (!orderNo) return;
    return serial(orderNo, async () => {
      const order = db.getOrder(orderNo);
      if (!order) return;
      const user = { id: userId, name: info.nickname || info.username || userId, tag: info.username ? `${info.username}#${info.identify_num}` : null };
      if (action === 'accept') return onAccept(order, user);
      if (action === 'pick') return onPick(order, user, targetId);
      if (action === 'submit') return onSubmit(order, user);
      if (action === 'rate') return onRate(order, user, Number(targetId));
      if (action === 'reject') return onReject(order, user);
    });
  }

  async function onSubmit(order, user) {
    if (user.id !== order.assignee_id) return; // 只有接单打手本人能提交结单
    if (order.status === 'submitted') return kook.dm(user.id, `订单 ${order.order_no} 已经提交过结单，等老板确认～`);
    if (order.status !== 'assigned') return kook.dm(user.id, `订单 ${order.order_no} 当前状态是「${STATUS[order.status]}」，不能提交结单。`);
    db.submit(order.order_no);
    const updated = db.getOrder(order.order_no);
    log({ level: 'info', event: 'submitted', order: order.order_no, by: user.tag });
    await kook.dm(user.id, `已提交订单 **${order.order_no}** 的结单申请，等老板确认和评分。`);
    await kook.dmCard(order.dispatcher_id, closeCard(updated));
  }

  async function onRate(order, user, stars) {
    if (user.id !== order.dispatcher_id) return; // 只有派单老板本人能结单评分
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return;
    if (order.status === 'completed') return kook.dm(user.id, `订单 ${order.order_no} 已经结单了（${starText(order.rating)}）。`);
    if (order.status !== 'submitted') return kook.dm(user.id, `订单 ${order.order_no} 打手还没提交结单，暂时不能结单。`);
    db.complete(order.order_no, stars);
    const done = db.getOrder(order.order_no);
    log({ level: 'info', event: 'completed', order: order.order_no, rating: stars, duration_ms: done.duration_ms });
    const line = `结束时间：${fmtTime(done.completed_at)}　持续时长：${fmtDuration(done.duration_ms)}`;
    await kook.dm(user.id, `订单 **${order.order_no}** 已结单，你给 ${esc(done.assignee_name)} 的评分：${starText(stars)}\n${line}`);
    await kook.dm(done.assignee_id, `订单 **${order.order_no}** 老板已结单，评分：${starText(stars)}\n${line}\n辛苦了～`);
  }

  async function onReject(order, user) {
    if (user.id !== order.dispatcher_id) return;
    if (order.status !== 'submitted') return kook.dm(user.id, `订单 ${order.order_no} 当前状态是「${STATUS[order.status]}」，没有待确认的结单。`);
    db.reopen(order.order_no);
    log({ level: 'info', event: 'reopened', order: order.order_no });
    await kook.dm(user.id, `已退回订单 ${order.order_no} 的结单申请，订单继续进行。`);
    await kook.dm(order.assignee_id, `老板暂未确认订单 **${order.order_no}** 结单，请和老板沟通；完成后可以在之前的卡片里再次点 [提交结单]。`);
  }

  async function onAccept(order, user) {
    if (order.status === 'assigned' || order.status === 'cancelled') return kook.dm(user.id, `订单 ${order.order_no} ${STATUS[order.status]}，不能再接了。`);
    if (user.id === order.dispatcher_id) return kook.dm(user.id, '不能接自己的订单。');
    if (!(await kook.memberRoles(user.id)).includes(roles.taker)) return kook.dm(user.id, '只有「打手」角色可以接单。');
    if (!db.addApplicant(order.order_no, user)) return kook.dm(user.id, `你已经报名过订单 ${order.order_no} 了，等老板选择～`);
    log({ level: 'info', event: 'applied', order: order.order_no, by: user.tag });
    await kook.dm(user.id, `已报名订单 **${order.order_no}**，等老板选择，选中后会私信你频道邀请链接。`);
    await kook.dmCard(order.dispatcher_id, orderCard(order, {
      title: `${user.name} 想接订单 ${order.order_no}`,
      extra: `**打手**：${esc(user.name)}${user.tag ? `（${esc(user.tag)}）` : ''}`,
      button: { text: '选TA', value: `pick:${order.order_no}:${user.id}` },
    }));
  }

  async function onPick(order, user, targetId) {
    if (user.id !== order.dispatcher_id) return; // 只有派单老板本人能选人；其他人点击直接忽略
    if (order.status === 'assigned') return kook.dm(user.id, `订单 ${order.order_no} 已经派给 ${order.assignee_name} 了。`);
    if (order.status === 'cancelled') return kook.dm(user.id, `订单 ${order.order_no} 已取消。`);
    const chosen = order.applicants.find((a) => a.user_id === targetId);
    if (!chosen) return kook.dm(user.id, '这位打手没有报名这笔订单。');

    const voice = await kook.findVoiceChannel(order.dispatcher_id);
    const invite = await kook.createInvite({ channelId: voice?.id || order.source_channel_id || null, channelName: voice?.name });
    const updated = db.assign(order.order_no, { id: chosen.user_id, name: chosen.user_name, tag: chosen.user_tag }, invite);
    log({ level: 'info', event: 'assigned', order: order.order_no, to: chosen.user_tag, channel: invite.channel });

    // 用卡片的「邀请模块」发，KOOK 会渲染成可一键加入的邀请卡；卡片发不出去时退回到可点击的文字链接
    try {
      await kook.dmCard(chosen.user_id, inviteCard(updated, invite));
    } catch (error) {
      log({ level: 'warn', event: 'invite-card-failed', order: order.order_no, error: error.message });
      await kook.dm(chosen.user_id, `老板选择了你！订单 **${order.order_no}**\n${summary(updated)}\n频道（${esc(invite.channel)}）邀请链接：${link(invite.url)}`);
      await kook.dmCard(chosen.user_id, orderCard(updated, { title: `订单 ${order.order_no} 完成后点这里`, button: { text: '提交结单', value: `submit:${order.order_no}` } }))
        .catch((err) => log({ level: 'warn', event: 'submit-card-failed', order: order.order_no, error: err.message }));
    }
    await kook.dm(order.dispatcher_id, `已把订单 ${order.order_no} 派给 ${esc(chosen.user_name)}，邀请链接已私信给 TA。\n订单开始时间：${fmtTime(updated.start_at)}。打手完成后会提交结单，到时请你确认并评分。${voice ? '' : '\n（你当时不在语音频道，所以发的是' + esc(invite.channel) + '的链接）'}`);
    for (const other of order.applicants.filter((a) => a.user_id !== chosen.user_id)) {
      try { await kook.dm(other.user_id, `订单 ${order.order_no} 已被其他打手接走，下次加油～`); } catch { /* 通知失败不影响派单 */ }
    }
  }

  return { handleEvent };
}

// KMarkdown 转义 + 去掉 @ 标记，防止订单内容里夹带格式或群发提醒
export function esc(text) {
  return String(text ?? '')
    .replace(/\((met|rol|chn)\)[^()]*\((met|rol|chn)\)/g, '')
    .replace(/([\\*~`>[\]()])/g, '\\$1');
}

export function summary(order) {
  return [
    `**订单号**：${order.order_no}`,
    `**游戏**：${esc(order.game) || '未说明'}`,
    `**要求**：${esc(order.requirement) || '未说明'}`,
    `**人数**：${order.headcount}`,
    `**时间**：${esc(order.play_time) || '未说明'}`,
    order.notes ? `**备注**：${esc(order.notes)}` : '',
    `**老板**：${esc(order.dispatcher_name)}`,
    order.assignee_name ? `**打手**：${esc(order.assignee_name)}` : '',
    `**创单时间**：${fmtTime(order.created_at)}`,
    order.start_at ? `**开始时间**：${fmtTime(order.start_at)}` : '',
    order.submitted_at ? `**提交结单**：${fmtTime(order.submitted_at)}` : '',
  ].filter(Boolean).join('\n');
}

// 北京时间 月-日 时:分
export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}

export const starText = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

const button = (text, value, theme = 'primary') => ({ type: 'button', theme, value, click: 'return-val', text: { type: 'plain-text', content: text } });

// 老板的结单卡片：★1~★5（点了即结单并评分）+ 暂不结单；每组按钮不超过 4 个
export function closeCard(order) {
  const no = order.order_no;
  return [{
    type: 'card', theme: 'warning', size: 'lg', modules: [
      { type: 'header', text: { type: 'plain-text', content: `${order.assignee_name} 提交了结单 ${no}` } },
      { type: 'section', text: { type: 'kmarkdown', content: summary(order) } },
      { type: 'divider' },
      { type: 'section', text: { type: 'kmarkdown', content: '确认完成就点星级给打手评分（点了即结单）；还没完成点 **暂不结单**。' } },
      { type: 'action-group', elements: [button('★', `rate:${no}:1`, 'secondary'), button('★★', `rate:${no}:2`, 'secondary'), button('★★★', `rate:${no}:3`, 'secondary')] },
      { type: 'action-group', elements: [button('★★★★', `rate:${no}:4`), button('★★★★★', `rate:${no}:5`), button('暂不结单', `reject:${no}`, 'danger')] },
    ],
  }];
}

// KMarkdown 不会自动把网址变成链接，要写成 [文字](网址)
export function link(url) {
  return /^https:\/\/[\w./-]+$/.test(url) ? `[${url}](${url})` : esc(url);
}

export function inviteCard(order, invite) {
  return [{
    type: 'card', theme: 'success', size: 'lg', modules: [
      { type: 'header', text: { type: 'plain-text', content: `老板选择了你！订单 ${order.order_no}` } },
      { type: 'section', text: { type: 'kmarkdown', content: summary(order) } },
      { type: 'divider' },
      { type: 'section', text: { type: 'kmarkdown', content: `点下面的邀请加入频道 **${esc(invite.channel)}**：${link(invite.url)}` } },
      { type: 'invite', code: invite.url },
      { type: 'divider' },
      { type: 'section', text: { type: 'kmarkdown', content: '订单完成后点 **提交结单**，老板确认后会给你评分。' } },
      { type: 'action-group', elements: [button('提交结单', `submit:${order.order_no}`, 'success')] },
    ],
  }];
}

export function orderCard(order, { title, extra, button }) {
  const modules = [
    { type: 'header', text: { type: 'plain-text', content: title.slice(0, 100) } },
    { type: 'section', text: { type: 'kmarkdown', content: [summary(order), extra].filter(Boolean).join('\n') } },
  ];
  if (button) {
    modules.push({ type: 'action-group', elements: [{ type: 'button', theme: 'primary', value: button.value, click: 'return-val', text: { type: 'plain-text', content: button.text } }] });
  }
  return [{ type: 'card', theme: 'secondary', size: 'lg', modules }];
}
