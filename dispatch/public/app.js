// KOOK 派单平台 · 网页前端（无框架）
const $ = (sel) => document.querySelector(sel);
const state = { tab: 'orders', statusNames: {}, roles: [], members: [], roleFilter: null };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kook-admin' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('请先登录'); }
  if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.data = data; throw err; }
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function toast(message, isError = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast${isError ? ' error' : ''}`;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 3500);
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '');
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}

// ---------- 登录 ----------
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#password').focus(); }

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await start();
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

// ---------- 概览 ----------
async function loadOverview() {
  const o = await api('/api/overview');
  state.statusNames = o.statusNames;
  const gatewayText = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', failed: '连接失败', stopped: '已停止', idle: '未启动' }[o.gateway] || o.gateway;
  $('#status').replaceChildren(
    el('span', { class: `dot ${o.gateway === 'connected' ? 'ok' : 'bad'}` }), `机器人 ${o.bot} · 网关${gatewayText} · 识别：${o.llm.modeName}`,
  );
  const total = Object.values(o.stats).reduce((a, b) => a + b, 0);
  $('#stats').replaceChildren(
    stat('全部订单', total),
    ...Object.entries(o.statusNames).map(([key, name]) => stat(name, o.stats[key] || 0, key)),
  );
  const select = $('#order-status');
  if (select.options.length === 1) {
    for (const [key, name] of Object.entries(o.statusNames)) select.append(el('option', { value: key }, name));
  }
}

function stat(label, value, key) {
  return el('div', { class: `stat ${key ? `s-${key}` : ''}` }, el('div', { class: 'stat-value' }, String(value)), el('div', { class: 'stat-label' }, label));
}

// ---------- 订单 ----------
const openDetails = new Set(); // 自动刷新时保持已展开的详情

async function loadOrders() {
  const params = new URLSearchParams();
  if ($('#order-status').value) params.set('status', $('#order-status').value);
  if ($('#order-q').value.trim()) params.set('q', $('#order-q').value.trim());
  const orders = await api(`/api/orders?${params}`);
  const body = $('#orders');
  body.replaceChildren();
  $('#orders-empty').hidden = orders.length > 0;
  for (const o of orders) {
    const detail = el('tr', { class: 'detail', hidden: !openDetails.has(o.order_no) }, el('td', { colspan: 8 }, orderDetail(o)));
    const row = el('tr', {},
      el('td', { class: 'mono' }, o.order_no),
      el('td', {}, el('div', {}, fmtTime(o.created_at)), o.start_at ? el('div', { class: 'muted small' }, `开始 ${fmtTime(o.start_at)}`) : null,
        o.completed_at ? el('div', { class: 'muted small' }, `结束 ${fmtTime(o.completed_at)}`) : null),
      el('td', {}, el('span', { class: `badge s-${o.status}` }, state.statusNames[o.status] || o.status)),
      el('td', {}, person(o.dispatcher_name, o.dispatcher_tag)),
      el('td', {}, el('div', {}, [o.game, o.requirement].filter(Boolean).join(' · ') || '—'), el('div', { class: 'muted small' }, `人数 ${o.headcount} · 时间 ${o.play_time || '未说明'}`)),
      el('td', {}, o.assignee_id ? person(o.assignee_name, o.assignee_tag) : el('span', { class: 'muted' }, o.applicants.length ? `${o.applicants.length} 人报名` : '暂无'),
        o.rating ? el('div', { class: 'stars', title: `${o.rating} 星` }, stars(o.rating)) : null),
      el('td', { class: 'nowrap' }, fmtDuration(o.duration_ms)),
      el('td', { class: 'actions' },
        el('button', { class: 'ghost', onclick: () => {
          detail.hidden = !detail.hidden;
          if (detail.hidden) openDetails.delete(o.order_no); else openDetails.add(o.order_no);
        } }, '详情'),
        ['open', 'applied'].includes(o.status) ? el('button', { class: 'ghost danger', onclick: () => cancelOrder(o.order_no) }, '取消') : null),
    );
    body.append(row, detail);
  }
}

function person(name, tag) {
  return el('div', {}, el('div', {}, name || '—'), tag ? el('div', { class: 'muted small' }, tag) : null);
}

function orderDetail(o) {
  return el('div', { class: 'detail-grid' },
    el('div', {}, el('h4', {}, '原始消息'), el('p', { class: 'pre' }, o.raw_text || '—'),
      el('p', { class: 'muted small' }, `来源：${o.source === 'dm' ? '私信' : '频道 @机器人'} · 识别方式：${{ llm: '大模型', format: '固定格式' }[o.parsed_by] || o.parsed_by} · 已推送 ${o.pushed_count} 位打手`)),
    el('div', {}, el('h4', {}, '用户信息'),
      el('p', {}, `游戏：${o.game || '—'}`), el('p', {}, `要求：${o.requirement || '—'}`), el('p', {}, `人数：${o.headcount}`),
      el('p', {}, `时间：${o.play_time || '—'}`), o.notes ? el('p', {}, `备注：${o.notes}`) : null),
    el('div', {}, el('h4', {}, `报名打手（${o.applicants.length}）`),
      o.applicants.length ? el('ul', {}, o.applicants.map((a) => el('li', {}, `${a.user_name}${a.user_tag ? `（${a.user_tag}）` : ''} · ${fmtTime(a.applied_at)}${a.user_id === o.assignee_id ? ' ✔ 已选中' : ''}`))) : el('p', { class: 'muted' }, '暂无'),
      el('h4', {}, '时间线'),
      el('p', {}, `创单：${fmtTime(o.created_at)}`),
      o.assigned_at ? el('p', {}, `派单：${fmtTime(o.assigned_at)}`) : null,
      o.start_at ? el('p', {}, `开始：${fmtTime(o.start_at)}（创单 + 5 分钟）`) : null,
      o.submitted_at ? el('p', {}, `打手提交结单：${fmtTime(o.submitted_at)}`) : null,
      o.completed_at ? el('p', {}, `结束（老板结单）：${fmtTime(o.completed_at)}`) : null,
      o.duration_ms !== null && o.duration_ms !== undefined ? el('p', {}, `持续时长：${fmtDuration(o.duration_ms)}（结束 + 5 分钟 − 创单）`) : null,
      o.rating ? el('p', {}, '评分：', el('span', { class: 'stars' }, stars(o.rating))) : null,
      o.invite_url ? el('p', {}, `邀请链接（${o.invite_channel}）：`, el('a', { href: o.invite_url, target: '_blank', rel: 'noopener' }, o.invite_url)) : null),
  );
}

async function cancelOrder(orderNo) {
  if (!confirm(`确定取消订单 ${orderNo}？取消后打手不能再接单。`)) return;
  try { await api(`/api/orders/${orderNo}/cancel`, { method: 'POST' }); toast('已取消'); await Promise.all([loadOrders(), loadOverview()]); }
  catch (error) { toast(error.message, true); }
}

// ---------- 成员角色 ----------
async function loadMembers(refresh = false) {
  const [roles, members] = await Promise.all([api('/api/roles'), api(`/api/members${refresh ? '?refresh=1' : ''}`)]);
  state.roles = roles.sort((a, b) => a.position - b.position);
  state.members = members;
  renderRoleFilter();
  renderMembers();
}

const roleById = (id) => state.roles.find((r) => r.id === id);

function roleChip(role, onRemove) {
  const chip = el('span', { class: `chip${role.admin ? ' admin' : ''}` }, role.name);
  if (role.color) chip.style.setProperty('--chip', `#${Number(role.color).toString(16).padStart(6, '0')}`);
  if (onRemove) chip.append(el('button', { class: 'chip-x', title: `撤销「${role.name}」`, onclick: onRemove }, '×'));
  return chip;
}

function renderRoleFilter() {
  const box = $('#role-filter');
  const count = (id) => state.members.filter((m) => m.roles.includes(id)).length;
  box.replaceChildren(
    el('button', { class: `filter${state.roleFilter === null ? ' active' : ''}`, onclick: () => { state.roleFilter = null; renderRoleFilter(); renderMembers(); } }, `全部 ${state.members.length}`),
    el('button', { class: `filter${state.roleFilter === 0 ? ' active' : ''}`, onclick: () => { state.roleFilter = 0; renderRoleFilter(); renderMembers(); } }, `无角色 ${state.members.filter((m) => !m.roles.length).length}`),
    ...state.roles.map((r) => el('button', { class: `filter${state.roleFilter === r.id ? ' active' : ''}`, onclick: () => { state.roleFilter = r.id; renderRoleFilter(); renderMembers(); } }, `${r.name} ${count(r.id)}`)),
  );
}

function renderMembers() {
  const q = $('#member-q').value.trim().toLowerCase();
  const onlyOnline = $('#member-online').checked;
  const list = state.members.filter((m) => (!q || m.username.toLowerCase().includes(q) || m.nickname.toLowerCase().includes(q))
    && (!onlyOnline || m.online)
    && (state.roleFilter === null || (state.roleFilter === 0 ? !m.roles.length : m.roles.includes(state.roleFilter))));
  $('#members-count').textContent = `显示 ${list.length} / ${state.members.length} 人`;
  $('#members').replaceChildren(...list.map((m) => {
    const select = el('select', { onchange: (e) => { const id = Number(e.target.value); e.target.value = ''; if (id) changeRole(m, id, 'grant'); } },
      el('option', { value: '' }, '+ 添加…'),
      state.roles.filter((r) => !m.roles.includes(r.id) && !r.isBot).map((r) => el('option', { value: r.id }, r.name + (r.admin ? '（管理员权限）' : ''))));
    return el('tr', {},
      el('td', {}, person(m.nickname || m.username, `${m.username}${m.bot ? ' · 机器人' : ''}`)),
      el('td', { class: 'nowrap' }, el('span', { class: `dot ${m.online ? 'ok' : 'off'}` }), m.online ? '在线' : '离线'),
      el('td', { class: 'chips' }, m.roles.length ? m.roles.map((id) => roleById(id)).filter(Boolean).map((r) => roleChip(r, m.bot ? null : () => changeRole(m, r.id, 'revoke'))) : el('span', { class: 'muted' }, '—')),
      el('td', {}, m.bot ? el('span', { class: 'muted' }, '—') : select),
    );
  }));
}

async function changeRole(member, roleId, action) {
  const role = roleById(roleId);
  const who = member.nickname || member.username;
  const verb = action === 'grant' ? '授予' : '撤销';
  if (!confirm(`确定给「${who}」${verb}角色「${role.name}」？\n这会直接修改 KOOK 服务器。`)) return;
  const body = { action, role_id: roleId };
  try {
    await api(`/api/members/${member.id}/roles`, { method: 'POST', body });
  } catch (error) {
    if (!error.data?.needConfirm) return toast(error.message, true);
    if (!confirm(`⚠️「${role.name}」拥有管理员权限：可以踢人、封禁、删频道、改所有人角色。\n真的要${verb}给「${who}」吗？`)) return;
    try { await api(`/api/members/${member.id}/roles`, { method: 'POST', body: { ...body, confirm_admin: true } }); }
    catch (err) { return toast(err.message, true); }
  }
  toast(`已${verb}「${role.name}」`);
  if (action === 'grant') member.roles.push(roleId); else member.roles = member.roles.filter((id) => id !== roleId);
  renderRoleFilter();
  renderMembers();
}

// ---------- 日志 ----------
async function loadAudit() {
  const rows = await api('/api/audit');
  $('#audit').replaceChildren(...(rows.length ? rows.map((r) => el('tr', {}, el('td', {}, fmtTime(r.at)), el('td', {}, r.actor), el('td', {}, r.action), el('td', { class: 'mono small' }, r.detail || '')))
    : [el('tr', {}, el('td', { colspan: 4, class: 'muted center' }, '暂无操作记录'))]));
}

// ---------- 识别设置 ----------
function renderLlm(s) {
  $('#llm-mode').textContent = s.modeName;
  $('#llm-key-state').textContent = s.keySet ? `已设置（${s.keyTail}）` : '未设置';
  $('#llm-base').value = s.baseUrl;
  $('#llm-model').value = s.model;
  $('#llm-claude').checked = s.claudeFallback;
  $('#llm-clear').hidden = !s.keySet;
  $('#llm-pending').textContent = s.pending ? `有 ${s.pending} 条订单正在等 Claude 识别` : '';
}

async function loadSettings() { renderLlm(await api('/api/settings/llm')); }

async function saveSettings(body, message) {
  try {
    renderLlm(await api('/api/settings/llm', { method: 'POST', body }));
    $('#llm-key').value = '';
    toast(message);
    await loadOverview();
  } catch (error) { toast(error.message, true); }
}

$('#llm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const body = { baseUrl: $('#llm-base').value, model: $('#llm-model').value, claudeFallback: $('#llm-claude').checked };
  if ($('#llm-key').value.trim()) body.apiKey = $('#llm-key').value.trim();
  saveSettings(body, '已保存');
});
$('#llm-clear').addEventListener('click', () => { if (confirm('确定清除 API Key？')) saveSettings({ clearKey: true }, '已清除 Key'); });

// ---------- 切换与启动 ----------
const loaders = { orders: loadOrders, members: () => loadMembers(), audit: loadAudit, settings: loadSettings };

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const name of Object.keys(loaders)) $(`#tab-${name}`).hidden = name !== state.tab;
    loaders[state.tab]().catch((e) => toast(e.message, true));
  });
}

let searchTimer;
$('#order-status').addEventListener('change', () => loadOrders().catch((e) => toast(e.message, true)));
$('#order-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadOrders().catch((e) => toast(e.message, true)), 300); });
$('#order-refresh').addEventListener('click', () => Promise.all([loadOrders(), loadOverview()]).catch((e) => toast(e.message, true)));
$('#member-q').addEventListener('input', renderMembers);
$('#member-online').addEventListener('change', renderMembers);
$('#member-refresh').addEventListener('click', () => loadMembers(true).then(() => toast('已从 KOOK 刷新')).catch((e) => toast(e.message, true)));

async function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await loadOverview();
  await loaders[state.tab]();
}

(async () => {
  const { loggedIn } = await api('/api/session');
  if (loggedIn) await start(); else showLogin();
  setInterval(() => { if (!$('#app').hidden && state.tab === 'orders') Promise.all([loadOrders(), loadOverview()]).catch(() => {}); }, 15000);
})();
