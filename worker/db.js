// D1 (SQLite) 数据访问层，替代原 MySQL 版本。
// 所有 SQL 已改写为 SQLite 方言（AUTOINCREMENT / date('now') / INSERT OR IGNORE / ON CONFLICT / MAX 等）。
import { randomTokenHex, fmtDate, fmtDateTime, addDays, asDateStr } from './util.js';

let DB = null;
export function setDB(d1) { DB = d1; }

export async function query(sql, params = []) {
  const r = await DB.prepare(sql).bind(...params).all();
  return r.results || [];
}
export async function queryOne(sql, params = []) {
  return (await DB.prepare(sql).bind(...params).first()) || null;
}
export async function run(sql, params = []) {
  return DB.prepare(sql).bind(...params).run();
}
export async function insert(sql, params = []) {
  const r = await run(sql, params);
  return r && r.meta ? r.meta.last_row_id : null;
}
// 批量执行（D1 中一次 batch 只计 1 次查询，避免逐条写入触发免费版 50 次/调用上限）
// statements: [{ sql, params }]
export async function batch(statements) {
  if (!statements || !statements.length) return [];
  return DB.batch(statements.map(s => DB.prepare(s.sql).bind(...(s.params || []))));
}

// ---------- 行映射 / 辅助 ----------
function toAccount(a) {
  const o = {
    id: a.acc_id || ('acc-' + a.id),
    profileDir: a.profile_dir || a.acc_id || ('acc-' + a.id),
    uid: a.uid,
    name: a.name,
    serverId: a.server_id,
    lastLoginAt: a.last_login_at ? Number(a.last_login_at) : 0,
    serverInfoToken: a.server_info_token,
    tokenExpireAt: a.token_expire_at ? Number(a.token_expire_at) : 0,
    avatar: a.avatar
  };
  o.qqAccessToken = a.qq_access_token || '';
  o.qqOpenid = a.qq_openid || '';
  return o;
}

// 防薅羊毛：同一 (uid, server_id) 仅首次绑定可领首绑奖励 / 注册赠送积分
async function resolveGameBenefit(uid, serverId, accId) {
  if (!uid || !serverId) return { tracked: false, firstBind: true, isNew: false };
  const prev = await query(
    'SELECT acc_id FROM game_account_benefits WHERE uid = ? AND server_id = ? ORDER BY rowid ASC LIMIT 1',
    [uid, serverId]
  );
  const historicalAccId = prev.length ? prev[0].acc_id : accId;
  const isNew = prev.length === 0; // 本次调用是否为该游戏账号首次建立奖励记录
  await run(
    'INSERT OR IGNORE INTO game_account_benefits (uid, server_id, first_account_id) VALUES (?, ?, ?)',
    [uid, serverId, historicalAccId]
  );
  const row = await queryOne(
    'SELECT first_account_id FROM game_account_benefits WHERE uid = ? AND server_id = ?',
    [uid, serverId]
  );
  const firstBind = !!row && String(row.first_account_id) === String(accId);
  return { tracked: true, firstBind, isNew };
}

// ---------- settings ----------
async function getSetting(key, defaultVal) {
  try {
    const rows = await query('SELECT value FROM settings WHERE key = ?', [key]);
    if (!rows.length) return defaultVal;
    return rows[0].value;
  } catch (e) { return defaultVal; }
}
async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}
async function getPointsPlanEnabled() {
  const v = await getSetting('points_plan_enabled', 'true');
  return v !== 'false';
}
async function setPointsPlanEnabled(v) {
  await setSetting('points_plan_enabled', v ? 'true' : 'false');
  return !!v;
}
async function getBillingConfig() {
  const e = await getSetting('billing_enabled_rate_per_hour', '1');
  const d = await getSetting('billing_disabled_rate_per_day', '24');
  return {
    enabledRatePerHour: Number(e) || 1,
    disabledRatePerDay: Number(d) || 24,
    dailyMinimum: await getDailyMinimum()
  };
}
async function saveBillingConfig({ enabledRatePerHour, disabledRatePerDay, dailyMinimum }) {
  await setSetting('billing_enabled_rate_per_hour', Number(enabledRatePerHour) || 1);
  await setSetting('billing_disabled_rate_per_day', Number(disabledRatePerDay) || 24);
  if (dailyMinimum != null) {
    await setSetting('billing_daily_minimum', Number(dailyMinimum) > 0 ? Number(dailyMinimum) : 12);
  }
}
async function getDailyMinimum() {
  const v = await getSetting('billing_daily_minimum', '12');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

// ---------- 每日签到 ----------
// 默认奖励：第 1 天 5 点，依次 +5，共 30 天（一个月一个循环），可在后台配置
function defaultCheckinRewards() {
  const a = [];
  for (let i = 1; i <= 30; i++) a.push(i * 5);
  return a;
}
function cleanRewards(arr) {
  const rewards = (Array.isArray(arr) ? arr : [])
    .map(n => Math.max(0, Math.round(Number(n) || 0)))
    .filter((n, i) => i < 366);
  return rewards.some(n => n > 0) ? rewards : defaultCheckinRewards();
}
async function getCheckinConfig() {
  const enabled = (await getSetting('checkin_enabled', 'true')) !== 'false';
  let rewards = defaultCheckinRewards();
  try {
    const arr = JSON.parse(await getSetting('checkin_rewards', ''));
    rewards = cleanRewards(arr);
  } catch (e) { /* 用默认 */ }
  return { enabled, rewards };
}
async function saveCheckinConfig({ enabled, rewards }) {
  if (enabled != null) await setSetting('checkin_enabled', enabled ? 'true' : 'false');
  if (Array.isArray(rewards) && rewards.length) {
    await setSetting('checkin_rewards', JSON.stringify(cleanRewards(rewards)));
  }
  return getCheckinConfig();
}
// 签到状态：cycle_day 按「已签到总次数」在一个周期内顺延，断签不打断顺序
async function getCheckinStatus(userId) {
  const cfg = await getCheckinConfig();
  const day = (await queryOne("SELECT date('now') AS d")).d;
  const last = await queryOne('SELECT day, cycle_day, reward FROM checkin_log WHERE user_id = ? ORDER BY day DESC, id DESC LIMIT 1', [userId]);
  const todayChecked = !!last && String(last.day) === day;
  const totalRow = await queryOne('SELECT COUNT(*) AS c FROM checkin_log WHERE user_id = ?', [userId]);
  const totalDays = Number(totalRow.c);
  const len = cfg.rewards.length;
  const currentIdx = todayChecked ? (totalDays - 1) % len : totalDays % len;
  return {
    enabled: cfg.enabled,
    rewards: cfg.rewards,
    cycleLength: len,
    today: day,
    todayChecked,
    totalDays,
    cycleDay: todayChecked ? (Number(last.cycle_day) || currentIdx + 1) : currentIdx + 1,
    todayReward: cfg.rewards[currentIdx] || 0,
    lastReward: todayChecked ? (Number(last.reward) || 0) : null,
    nextReward: cfg.rewards[todayChecked ? (totalDays % len) : (totalDays % len)] || 0,
    lastCheckinDay: last ? String(last.day) : ''
  };
}
async function doCheckin(userId) {
  const cfg = await getCheckinConfig();
  if (!cfg.enabled) return { ok: false, code: 'DISABLED', message: '签到功能未开启' };
  const day = (await queryOne("SELECT date('now') AS d")).d;
  const totalRow = await queryOne('SELECT COUNT(*) AS c FROM checkin_log WHERE user_id = ?', [userId]);
  const totalDays = Number(totalRow.c);
  const len = cfg.rewards.length;
  const cycleDay = (totalDays % len) + 1;
  const reward = cfg.rewards[totalDays % len] || 0;
  try {
    await run('INSERT INTO checkin_log (user_id, day, cycle_day, reward) VALUES (?, ?, ?, ?)', [userId, day, cycleDay, reward]);
  } catch (e) {
    return { ok: false, code: 'ALREADY', message: '今日已签到，明天再来吧' };
  }
  let remaining = 0;
  if (reward > 0) {
    await run('UPDATE users SET points = points + ? WHERE id = ?', [reward, userId]);
    const u = await queryOne('SELECT points FROM users WHERE id = ?', [userId]);
    remaining = Math.round(Number(u.points) * 100) / 100;
    // amount 记 0，不参与每日最低消费统计；奖励只记在 added_points
    await run(
      "INSERT INTO points_log (user_id, account_id, amount, type, added_points, deducted_points, remaining_points, day) VALUES (?, '', 0, 'checkin', ?, 0, ?, ?)",
      [userId, reward, remaining, day]
    );
  }
  return {
    ok: true, reward, cycleDay, day, totalDays: totalDays + 1,
    remainingPoints: remaining, nextReward: cfg.rewards[(totalDays + 1) % len] || 0
  };
}

// 积分结算（只读查询，实际扣费由工具上报 / 每日最低结算完成）
async function settleUserPoints(userId) {
  const u = await queryOne('SELECT id, points, tool_started_at FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  return {
    points: Number(u.points),
    enabled: !!u.tool_started_at,
    ratePerHour: 0,
    planEnabled: await getPointsPlanEnabled()
  };
}

async function logDeduction(userId, accountId, amount, type, day, remainingPoints) {
  const amt = Math.round(Number(amount) * 100) / 100;
  await run(
    'INSERT INTO points_log (user_id, account_id, amount, type, added_points, deducted_points, remaining_points, day) ' +
    'VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
    [userId, accountId || '', amt, type || 'usage', amt, Math.round(Number(remainingPoints) * 100) / 100 || 0, day]
  );
}
async function getDailyTotal(userId, day) {
  const rows = await query('SELECT COALESCE(SUM(amount), 0) AS s FROM points_log WHERE user_id = ? AND day = ?', [userId, day]);
  return Number(rows[0].s);
}
async function getPointsLog(userId, opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  const where = ['user_id = ?'];
  const params = [userId];
  if (opts.type) { where.push('type = ?'); params.push(opts.type); }
  const totalRows = await query('SELECT COUNT(*) AS c FROM points_log WHERE ' + where.join(' AND '), params);
  const total = Number(totalRows[0].c);
  const rows = await query(
    'SELECT id, user_id, account_id, amount, added_points, deducted_points, remaining_points, type, day ' +
    'FROM points_log WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total,
    records: rows.map(function (r) {
      return {
        id: Number(r.id), userId: Number(r.user_id), accountId: r.account_id,
        amount: Number(r.amount), addedPoints: Number(r.added_points),
        deductedPoints: Number(r.deducted_points), remainingPoints: Number(r.remaining_points),
        type: r.type, day: (r.day ? String(r.day) : '')
      };
    })
  };
}
async function getAllPointsLog(opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  const where = [];
  const params = [];
  if (opts.userId) { where.push('pl.user_id = ?'); params.push(parseInt(opts.userId, 10)); }
  if (opts.type) { where.push('pl.type = ?'); params.push(opts.type); }
  if (opts.day) { where.push('pl.day = ?'); params.push(opts.day); }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const totalRows = await query('SELECT COUNT(*) AS c FROM points_log pl ' + whereSql, params);
  const total = Number(totalRows[0].c);
  const rows = await query(
    'SELECT pl.id, pl.user_id, u.username, pl.account_id, pl.amount, pl.added_points, pl.deducted_points, pl.remaining_points, pl.type, pl.day, pl.created_at ' +
    'FROM points_log pl LEFT JOIN users u ON u.id = pl.user_id ' + whereSql + ' ORDER BY pl.id DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total,
    records: rows.map(function (r) {
      return {
        id: Number(r.id), userId: Number(r.user_id), username: r.username || '已删除', accountId: r.account_id,
        amount: Number(r.amount), addedPoints: Number(r.added_points), deductedPoints: Number(r.deducted_points),
        remainingPoints: Number(r.remaining_points), type: r.type, day: fmtDate(r.day), createdAt: fmtDateTime(r.created_at)
      };
    })
  };
}
async function settleDailyMinimum(dayStr, onlyUserId) {
  if (!dayStr) {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate() - 1).padStart(2, '0');
    dayStr = y + '-' + m + '-' + d; // 默认结算昨天
  }
  const dailyMin = await getDailyMinimum();
  let users;
  if (onlyUserId) {
    users = await query('SELECT id, points, default_account_id, created_at FROM users WHERE id = ?', [onlyUserId]);
  } else {
    users = await query('SELECT id, points, default_account_id, created_at FROM users');
  }
  let processed = 0, totalCharged = 0;
  const details = [];
  for (const u of users) {
    const created = asDateStr(u.created_at);
    if (created && created > dayStr) continue; // 不结算注册日之前的日期
    const done = await query("SELECT 1 FROM points_log WHERE user_id = ? AND day = ? AND type = 'daily_min' LIMIT 1", [u.id, dayStr]);
    if (done.length) continue; // 已补足，幂等
    const total = await getDailyTotal(u.id, dayStr);
    const charge = dailyMin - total;
    if (charge <= 0) continue;
    const current = Number(u.points);
    const actual = Math.round(Math.min(charge, current) * 100) / 100; // 余额不足扣到 0
    await run('UPDATE users SET points = MAX(points - ?, 0) WHERE id = ?', [charge, u.id]);
    await logDeduction(u.id, u.default_account_id || '', actual, 'daily_min', dayStr, Math.round((current - actual) * 100) / 100);
    totalCharged += actual;
    processed++;
    details.push({ userId: u.id, day: dayStr, beforeTotal: total, charged: actual, remainingPoints: Math.round(Math.max(current - charge, 0) * 100) / 100 });
  }
  return { day: dayStr, dailyMin, processed, totalCharged: Math.round(totalCharged * 100) / 100, details };
}

// ---------- admin ----------
async function getAdminByUsername(username) {
  return queryOne('SELECT * FROM admin WHERE username = ?', [username]);
}
async function updateAdminPassword(username, newPwdHash) {
  await run('UPDATE admin SET password = ? WHERE username = ?', [newPwdHash, username]);
}

// ---------- users ----------
function mapUserRow(r) {
  return {
    id: r.id, username: r.username, gameRole: r.game_role || '',
    plan: r.plan, points: Number(r.points), status: r.status, createdAt: fmtDate(r.created_at)
  };
}
async function getDashboardStats() {
  const total = await query('SELECT COUNT(*) AS c FROM users');
  const active = await query("SELECT COUNT(*) AS c FROM users WHERE status = '正常'");
  const pts = await query('SELECT COALESCE(SUM(points), 0) AS s FROM users');
  const vip = await query("SELECT COUNT(*) AS c FROM users WHERE plan = '尊享版'");
  const recent = await query('SELECT id, username, game_role, plan, points, status, created_at FROM users ORDER BY id DESC LIMIT 8');
  return {
    totalUsers: total[0].c, activeUsers: active[0].c, totalPoints: Number(pts[0].s), vipCount: vip[0].c,
    users: recent.map(mapUserRow)
  };
}
async function getUsersPage(page, pageSize) {
  const total = await query('SELECT COUNT(*) AS c FROM users');
  const totalCount = total[0].c;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const p = Math.min(Math.max(1, page | 0), totalPages);
  const offset = (p - 1) * pageSize;
  const rows = await query(
    'SELECT id, username, game_role, plan, points, status, created_at FROM users ORDER BY id LIMIT ? OFFSET ?',
    [pageSize, offset]
  );
  return { users: rows.map(mapUserRow), page: p, totalPages, total: totalCount };
}
// 供后台下拉选择使用：返回全部用户（id + username），限量避免下拉过长
async function listAllUsers(limit = 1000) {
  return query('SELECT id, username FROM users ORDER BY id LIMIT ?', [limit]);
}
async function addUser({ username, gameRole, plan, points, status }) {
  await run(
    "INSERT INTO users (username, game_role, plan, points, status, created_at, billed_hours, last_daily_settled_date) " +
    "VALUES (?, ?, ?, ?, ?, date('now'), 0, date('now', '-1 day'))",
    [username, gameRole || '', plan || '高级版', Number(points) || 0, status || '正常']
  );
}
async function updateUser(id, { points, plan, status, gameRole }) {
  const sets = [], params = [];
  if (points !== undefined && points !== '') { sets.push('points = ?'); params.push(Number(points)); }
  if (plan) { sets.push('plan = ?'); params.push(plan); }
  if (status) { sets.push('status = ?'); params.push(status); }
  if (gameRole !== undefined) { sets.push('game_role = ?'); params.push(gameRole); }
  if (!sets.length) return;
  params.push(id);
  await run('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', params);
}
async function deleteUser(id) {
  await run('DELETE FROM accounts WHERE user_id = ?', [id]);
  await run('DELETE FROM users WHERE id = ?', [id]);
}

// 会员 API 令牌（Bearer 鉴权）
async function ensureApiToken(userId) {
  const rows = await query('SELECT api_token FROM users WHERE id = ?', [userId]);
  if (!rows.length) return '';
  if (rows[0].api_token) return rows[0].api_token;
  const token = randomTokenHex(24);
  await run('UPDATE users SET api_token = ? WHERE id = ?', [token, userId]);
  return token;
}
async function getUserByToken(token) {
  if (!token) return null;
  const rows = await query('SELECT id, username, plan, points, status FROM users WHERE api_token = ?', [String(token)]);
  return rows.length ? rows[0] : null;
}
async function regenerateApiToken(userId) {
  const token = randomTokenHex(24);
  await run('UPDATE users SET api_token = ? WHERE id = ?', [token, userId]);
  return token;
}

async function logRecharge(userId, amount, admin, note, remainingPoints) {
  const amt = Math.round(Number(amount) * 100) / 100;
  const added = amt > 0 ? amt : 0;
  const deducted = amt < 0 ? -amt : 0;
  await run(
    'INSERT INTO recharge_log (user_id, amount, added_points, deducted_points, remaining_points, admin, note) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, amt, added, deducted, Math.round(Number(remainingPoints) * 100) / 100 || 0, admin || '', note || '']
  );
}
async function applyAdminPointsChange(userId, newPoints, admin, note) {
  const rows = await query('SELECT points FROM users WHERE id = ?', [userId]);
  const oldPoints = rows.length ? Number(rows[0].points) : 0;
  const np = Math.round(Number(newPoints) * 100) / 100;
  await updateUser(userId, { points: np });
  const delta = Math.round((np - oldPoints) * 100) / 100;
  if (delta !== 0) {
    await logRecharge(userId, delta, admin, note || '后台调整', np);
  }
  return { oldPoints, newPoints: np, delta };
}
// 充值：在现有点数基础上累加；amt 必须为正数
async function rechargeUser(userId, amount, admin, note) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) throw new Error('INVALID_AMOUNT');
  const rows = await query('SELECT id, points FROM users WHERE id = ?', [userId]);
  if (!rows.length) throw new Error('USER_NOT_FOUND');
  const oldPoints = Number(rows[0].points) || 0;
  const newPoints = Math.round((oldPoints + amt) * 100) / 100;
  await run('UPDATE users SET points = ? WHERE id = ?', [newPoints, userId]);
  await logRecharge(userId, amt, admin, note || '后台充值', newPoints);
  return { oldPoints, newPoints, added: amt };
}
async function getAllRechargeLog(opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  const where = [];
  const params = [];
  if (opts.userId) { where.push('r.user_id = ?'); params.push(parseInt(opts.userId, 10)); }
  if (opts.day) { where.push("date(r.created_at) = ?"); params.push(opts.day); }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const totalRows = await query('SELECT COUNT(*) AS c FROM recharge_log r ' + whereSql, params);
  const total = Number(totalRows[0].c);
  const rows = await query(
    'SELECT r.id, r.user_id, u.username, r.amount, r.added_points, r.deducted_points, r.remaining_points, r.admin, r.note, r.created_at ' +
    'FROM recharge_log r LEFT JOIN users u ON u.id = r.user_id ' + whereSql + ' ORDER BY r.id DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total,
    records: rows.map(function (rw) {
      return {
        id: Number(rw.id), userId: Number(rw.user_id), username: rw.username || '已删除',
        amount: Number(rw.amount), addedPoints: Number(rw.added_points), deductedPoints: Number(rw.deducted_points),
        remainingPoints: Number(rw.remaining_points), admin: rw.admin || '-', note: rw.note || '', createdAt: fmtDateTime(rw.created_at)
      };
    })
  };
}

// ---------- pricing ----------
async function getPricingCards() {
  const rows = await query('SELECT * FROM pricing ORDER BY id');
  const out = {};
  for (const r of rows) {
    out[r.card_key] = { name: r.name, price: Number(r.price), points: Number(r.points), days: Number(r.days), save: Number(r.save) };
  }
  return out;
}
async function savePricingCards(cards) {
  for (const key of Object.keys(cards)) {
    const c = cards[key];
    await run('UPDATE pricing SET name = ?, price = ?, points = ?, days = ?, save = ? WHERE card_key = ?',
      [c.name, Number(c.price), Number(c.points), Number(c.days), Number(c.save), key]);
  }
}

// 原 ensureSchema 的建表/补齐逻辑已改为迁移脚本（migrations/0001_init.sql）执行，此处保留为空函数以保持兼容。
async function ensureSchema() { return; }

export {
  toAccount, resolveGameBenefit,
  getSetting, setSetting, getPointsPlanEnabled, setPointsPlanEnabled, getBillingConfig, saveBillingConfig,
  getDailyMinimum, logDeduction, getDailyTotal, getPointsLog, getAllPointsLog, settleDailyMinimum, settleUserPoints,
  getAdminByUsername, updateAdminPassword,
  getDashboardStats, getUsersPage, listAllUsers, addUser, updateUser, deleteUser, applyAdminPointsChange,
  getPricingCards, savePricingCards,
  ensureApiToken, getUserByToken, regenerateApiToken, logRecharge, getAllRechargeLog, rechargeUser,
  getCheckinConfig, saveCheckinConfig, getCheckinStatus, doCheckin,
  fmtDateTime, fmtDate, ensureSchema
};
