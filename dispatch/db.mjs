/**
 * KOOK 派单平台 · 数据库（Node 自带 SQLite，零依赖）。
 *
 * 表：
 *   orders      每一笔订单
 *   applicants  每笔订单的报名打手
 *   audit       操作日志（网站上改角色、取消订单等）
 */
import { DatabaseSync } from 'node:sqlite';

export const STATUS = {
  open: '待接单',       // 已推送，还没人报名
  applied: '待选人',    // 有人报名，等老板选
  assigned: '进行中',   // 老板已选人，邀请链接已发
  submitted: '待结单',  // 打手已提交结单，等老板确认和评分
  completed: '已完成',  // 老板已结单并评分
  cancelled: '已取消',
};

export const START_DELAY_MS = 5 * 60000; // 订单开始时间 = 创单时间 + 5 分钟

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      dispatcher_id TEXT NOT NULL,
      dispatcher_name TEXT,
      dispatcher_tag TEXT,
      source TEXT,
      source_channel_id TEXT,
      raw_text TEXT,
      game TEXT,
      requirement TEXT,
      headcount INTEGER,
      play_time TEXT,
      notes TEXT,
      parsed_by TEXT,
      pushed_count INTEGER DEFAULT 0,
      assignee_id TEXT,
      assignee_name TEXT,
      assignee_tag TEXT,
      assigned_at TEXT,
      invite_url TEXT,
      invite_channel TEXT,
      start_at TEXT,
      submitted_at TEXT,
      completed_at TEXT,
      rating INTEGER,
      duration_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS applicants (
      order_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      user_tag TEXT,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (order_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT
    );
  `);
  // 旧数据库补新列（第一版没有开始时间和结单字段）
  const columns = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name));
  for (const [name, type] of [['start_at', 'TEXT'], ['submitted_at', 'TEXT'], ['completed_at', 'TEXT'], ['rating', 'INTEGER'], ['duration_ms', 'INTEGER']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
  return wrap(db);
}

function wrap(db) {
  const now = () => new Date().toISOString();

  // 订单号：KD + 北京时间日期 + 当天序号，例如 KD20261022-001
  function nextOrderNo() {
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
    const prefix = `KD${day}-`;
    const row = db.prepare('SELECT order_no FROM orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1').get(`${prefix}%`);
    const seq = row ? Number(row.order_no.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(3, '0')}`;
  }

  function getOrder(orderNo) {
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
    if (!order) return null;
    return { ...order, applicants: db.prepare('SELECT user_id, user_name, user_tag, applied_at FROM applicants WHERE order_id = ? ORDER BY applied_at').all(order.id) };
  }

  return {
    raw: db,

    createOrder(fields) {
      const orderNo = nextOrderNo();
      const at = now();
      db.prepare(`INSERT INTO orders (order_no, created_at, updated_at, status, dispatcher_id, dispatcher_name, dispatcher_tag,
        source, source_channel_id, raw_text, game, requirement, headcount, play_time, notes, parsed_by)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        orderNo, at, at, fields.dispatcher_id, fields.dispatcher_name ?? null, fields.dispatcher_tag ?? null,
        fields.source ?? null, fields.source_channel_id ?? null, fields.raw_text ?? null,
        fields.game ?? '', fields.requirement ?? '', fields.headcount ?? 1, fields.play_time ?? '', fields.notes ?? '', fields.parsed_by ?? null,
      );
      return getOrder(orderNo);
    },

    getOrder,

    listOrders({ status, q } = {}) {
      const where = [];
      const args = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (q) {
        where.push('(order_no LIKE ? OR dispatcher_name LIKE ? OR dispatcher_tag LIKE ? OR assignee_name LIKE ? OR game LIKE ? OR requirement LIKE ? OR raw_text LIKE ?)');
        args.push(...Array(7).fill(`%${q}%`));
      }
      const rows = db.prepare(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`).all(...args);
      const applicants = db.prepare('SELECT user_id, user_name, user_tag, applied_at FROM applicants WHERE order_id = ? ORDER BY applied_at');
      return rows.map((row) => ({ ...row, applicants: applicants.all(row.id) }));
    },

    setPushed(orderNo, count) {
      db.prepare('UPDATE orders SET pushed_count = ?, updated_at = ? WHERE order_no = ?').run(count, now(), orderNo);
    },

    // 返回 false 表示重复报名
    addApplicant(orderNo, user) {
      const order = getOrder(orderNo);
      const result = db.prepare('INSERT OR IGNORE INTO applicants (order_id, user_id, user_name, user_tag, applied_at) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, user.id, user.name ?? null, user.tag ?? null, now());
      if (result.changes === 0) return false;
      db.prepare("UPDATE orders SET status = 'applied', updated_at = ? WHERE id = ? AND status = 'open'").run(now(), order.id);
      return true;
    },

    assign(orderNo, user, invite) {
      const order = getOrder(orderNo);
      const startAt = new Date(Date.parse(order.created_at) + START_DELAY_MS).toISOString();
      db.prepare(`UPDATE orders SET status = 'assigned', assignee_id = ?, assignee_name = ?, assignee_tag = ?, assigned_at = ?,
        invite_url = ?, invite_channel = ?, start_at = ?, updated_at = ? WHERE order_no = ?`)
        .run(user.id, user.name ?? null, user.tag ?? null, now(), invite?.url ?? null, invite?.channel ?? null, startAt, now(), orderNo);
      return getOrder(orderNo);
    },

    // 以下三个都带状态条件，返回 false 表示状态不对（已被处理过）
    submit(orderNo) {
      return db.prepare("UPDATE orders SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE order_no = ? AND status = 'assigned'").run(now(), now(), orderNo).changes > 0;
    },

    reopen(orderNo) {
      return db.prepare("UPDATE orders SET status = 'assigned', submitted_at = NULL, updated_at = ? WHERE order_no = ? AND status = 'submitted'").run(now(), orderNo).changes > 0;
    },

    // 结单：记录结束时间，并按用户给的公式算持续时长 = 结束时间 + 5 分钟 - 创单时间
    complete(orderNo, rating) {
      const order = getOrder(orderNo);
      const endAt = new Date();
      const durationMs = endAt.getTime() + START_DELAY_MS - Date.parse(order.created_at);
      return db.prepare("UPDATE orders SET status = 'completed', rating = ?, completed_at = ?, duration_ms = ?, updated_at = ? WHERE order_no = ? AND status = 'submitted'")
        .run(rating, endAt.toISOString(), durationMs, now(), orderNo).changes > 0;
    },

    cancel(orderNo) {
      return db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE order_no = ? AND status IN ('open', 'applied')").run(now(), orderNo).changes > 0;
    },

    stats() {
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },

    audit(actor, action, detail) {
      db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(now(), actor, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
    },

    listAudit(limit = 200) {
      return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    },
  };
}
