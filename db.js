// MySQL 连接池（数据库：koudai），使用 mysql 驱动
// 配置读取环境变量，便于部署到服务器（本地开发可用默认值）
require('dotenv').config();
const mysql = require('mysql');
const crypto = require('crypto');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'koudai',
  charset: 'utf8mb4',
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10)
});
// 实际连接的数据库名：INFORMATION_SCHEMA 查询要用它，不能写死 'koudai'，否则部署库名不同时迁移会提前报错
const DB_NAME = process.env.DB_NAME || 'koudai';

// 把 mysql 回调式 pool.query 包装成返回 Promise 的函数（只 resolve results，便于 await）
const _query = pool.query.bind(pool);
pool.query = (sql, params) => new Promise((resolve, reject) => {
  _query(sql, params || [], (err, results) => (err ? reject(err) : resolve(results)));
});

function hashPwd(p) {
  return crypto.createHash('sha256').update(String(p)).digest('hex');
}

// 日期工具（统一使用本地 YYYY-MM-DD，便于与 MySQL DATE 比较）
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function addDays(dateStr, n) {
  const parts = String(dateStr).split('-');
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  dt.setDate(dt.getDate() + n);
  return fmtDate(dt);
}
// mysql 驱动把 DATE 列返回为 Date 对象，统一转成 YYYY-MM-DD 字符串
function asDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return fmtDate(v);
  return String(v);
}

// 将数据库行映射为接口返回格式
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
  // qq 相关字段为账号属性，始终返回（空也返回，保证拉取一定有该字段）
  o.qqAccessToken = a.qq_access_token || '';
  o.qqOpenid = a.qq_openid || '';
  return o;
}

// 防薅羊毛：判断某 (uid, server_id) 是否为「首次绑定」
// - 仅当 uid 与 server_id 都不为空时才参与去重（否则无法唯一定位游戏账号）
// - 返回 { tracked, firstBind }：firstBind=true 表示本次可发放首绑奖励
// - 使用 INSERT IGNORE + 回查，保证并发下只有一次首绑
async function resolveGameBenefit(uid, serverId, accId) {
  if (!uid || !serverId) {
    return { tracked: false, firstBind: true };
  }
  const prev = await pool.query(
    'SELECT acc_id FROM accounts WHERE uid = ? AND server_id = ? ORDER BY id ASC LIMIT 1',
    [uid, serverId]
  );
  const historicalAccId = prev.length ? prev[0].acc_id : accId;
  await pool.query(
    'INSERT IGNORE INTO game_account_benefits (uid, server_id, first_account_id) VALUES (?, ?, ?)',
    [uid, serverId, historicalAccId]
  );
  const row = await pool.query(
    'SELECT first_account_id FROM game_account_benefits WHERE uid = ? AND server_id = ?',
    [uid, serverId]
  );
  const firstBind = row.length > 0 && String(row[0].first_account_id) === String(accId);
  return { tracked: true, firstBind };
}

// ---------- 系统设置（settings 表，替代原 store.json 的模拟配置） ----------
async function getSetting(key, defaultVal) {
  try {
    const rows = await pool.query('SELECT `value` FROM settings WHERE `key` = ?', [key]);
    if (!rows.length) return defaultVal;
    return rows[0].value;
  } catch (e) { return defaultVal; }
}
async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [key, String(value)]
  );
}
// 扣费计划总开关（是否启用按时间结算扣费）
async function getPointsPlanEnabled() {
  const v = await getSetting('points_plan_enabled', 'true');
  return v !== 'false';
}
async function setPointsPlanEnabled(v) {
  await setSetting('points_plan_enabled', v ? 'true' : 'false');
  return !!v;
}
// 计费规则：每小时点数(ratePerHour)、每天满额点数(ratePerDay=ratePerHour*24)、每日最低消费(dailyMinimum)
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

// 积分结算（历史按时间计费）：计费模型已改为「工具主动上报扣减」(POST /api/points/deduct)，
// 服务端不再按时间自动计算扣费，避免与工具上报重复计费。
// 本函数保留为只读查询，仅返回当前余额与运行状态，不再做任何扣减。
async function settleUserPoints(userId) {
  const u = await pool.query(
    'SELECT id, points, tool_started_at FROM users WHERE id = ?',
    [userId]
  );
  if (!u.length) return null;
  const user = u[0];
  return {
    points: Number(user.points),
    enabled: !!user.tool_started_at,
    ratePerHour: 0,
    planEnabled: await getPointsPlanEnabled()
  };
}

// 每日最低消费（默认 12 点/天），可经 settings 调整
async function getDailyMinimum() {
  const v = await getSetting('billing_daily_minimum', '12');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

// 记录一次扣费流水（工具上报 usage / 每日最低补足 daily_min）
// remainingPoints: 扣费后该用户剩余点数（用于对账）
async function logDeduction(userId, accountId, amount, type, day, remainingPoints) {
  const amt = Math.round(Number(amount) * 100) / 100;
  await pool.query(
    'INSERT INTO points_log (user_id, account_id, amount, type, added_points, deducted_points, remaining_points, day) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
    [userId, accountId || '', amt, type || 'usage', amt, Math.round(Number(remainingPoints) * 100) / 100 || 0, day]
  );
}

// 某用户某天已扣总额（usage + daily_min 合计）
async function getDailyTotal(userId, day) {
  const rows = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM points_log WHERE user_id = ? AND day = ?',
    [userId, day]
  );
  return Number(rows[0].s);
}

// 分页查询某用户扣费流水（usage=工具上报 / daily_min=每日最低补足）
// opts: { type, page, pageSize }，返回 { total, records }
async function getPointsLog(userId, opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  const where = ['user_id = ?'];
  const params = [userId];
  if (opts.type) {
    where.push('type = ?');
    params.push(opts.type);
  }
  const totalRows = await pool.query(
    'SELECT COUNT(*) AS c FROM points_log WHERE ' + where.join(' AND '),
    params
  );
  const total = Number(totalRows[0].c);
  const rows = await pool.query(
    'SELECT id, user_id, account_id, amount, added_points, deducted_points, remaining_points, type, day FROM points_log WHERE ' +
      where.join(' AND ') + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total,
    records: rows.map(function (r) {
      return {
        id: Number(r.id),
        userId: Number(r.user_id),
        accountId: r.account_id,
        amount: Number(r.amount),
        addedPoints: Number(r.added_points),
        deductedPoints: Number(r.deducted_points),
        remainingPoints: Number(r.remaining_points),
        type: r.type,
        day: (r.day ? String(r.day) : '')
      };
    })
  };
}

// 时间格式化：DATE -> YYYY-MM-DD，DATETIME/毫秒时间戳 -> YYYY-MM-DD HH:mm:ss（按服务器本地时区，即中国时区）
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'number') return new Date(d);
  if (typeof d === 'string') {
    if (/^\d+$/.test(d)) return new Date(Number(d)); // 毫秒时间戳字符串
    return new Date(d);
  }
  return new Date(d);
}
function fmtDate(d) {
  if (!d) return '';
  var dt = toDate(d);
  if (isNaN(dt.getTime())) return '';
  return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
}
function fmtDateTime(d) {
  if (!d) return '';
  var dt = toDate(d);
  if (isNaN(dt.getTime())) return '';
  return fmtDate(dt) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds());
}

// 后台：分页查询全部用户扣费流水（可按 userId/type/day 筛选），JOIN users 取用户名
// opts: { userId, type, day, page, pageSize }，返回 { total, records }
async function getAllPointsLog(opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  const where = [];
  const params = [];
  if (opts.userId) {
    where.push('pl.user_id = ?');
    params.push(parseInt(opts.userId, 10));
  }
  if (opts.type) {
    where.push('pl.type = ?');
    params.push(opts.type);
  }
  if (opts.day) {
    where.push('pl.day = ?');
    params.push(opts.day);
  }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const totalRows = await pool.query('SELECT COUNT(*) AS c FROM points_log pl ' + whereSql, params);
  const total = Number(totalRows[0].c);
  const rows = await pool.query(
    'SELECT pl.id, pl.user_id, u.username, pl.account_id, pl.amount, pl.added_points, pl.deducted_points, pl.remaining_points, pl.type, pl.day, pl.created_at ' +
      'FROM points_log pl LEFT JOIN users u ON u.id = pl.user_id ' +
      whereSql + ' ORDER BY pl.id DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total,
    records: rows.map(function (r) {
      return {
        id: Number(r.id),
        userId: Number(r.user_id),
        username: r.username || '已删除',
        accountId: r.account_id,
        amount: Number(r.amount),
        addedPoints: Number(r.added_points),
        deductedPoints: Number(r.deducted_points),
        remainingPoints: Number(r.remaining_points),
        type: r.type,
        day: fmtDate(r.day),
        createdAt: fmtDateTime(r.created_at)
      };
    })
  };
}

// 每日最低消费结算：对 day（默认昨天）每个用户，保证当天累计 >= dailyMin，不足补足并写 daily_min 流水。
// 所有用户每天必扣 dailyMin（含零上报用户，直接扣 dailyMin）；用户注册日之前的日期跳过。
// 幂等：已补足的日期不会重复扣（daily_min 流水计入当天总额）。
async function settleDailyMinimum(dayStr, onlyUserId) {
  if (!dayStr) {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate() - 1).padStart(2, '0');
    dayStr = y + '-' + m + '-' + d; // 默认结算昨天（今天尚未结束，不提前结算）
  }
  const dailyMin = await getDailyMinimum();
  let users;
  if (onlyUserId) {
    users = await pool.query('SELECT id, points, default_account_id, created_at FROM users WHERE id = ?', [onlyUserId]);
  } else {
    users = await pool.query('SELECT id, points, default_account_id, created_at FROM users');
  }
  let processed = 0, totalCharged = 0;
  const details = [];
  for (const u of users) {
    const created = asDateStr(u.created_at);
    if (created && created > dayStr) continue; // 不结算注册日之前的日期
    // 当天已做过最低结算（已写 daily_min 流水）则跳过，保证幂等、不重复扣
    const done = await pool.query(
      "SELECT 1 FROM points_log WHERE user_id = ? AND day = ? AND type = 'daily_min' LIMIT 1",
      [u.id, dayStr]
    );
    if (done.length) continue;
    const total = await getDailyTotal(u.id, dayStr); // 此时仅 usage 累计（daily_min 尚未写入）
    const charge = dailyMin - total;
    if (charge <= 0) continue; // 当天已上报 >= 最低消费，无需补足（不写流水，天然幂等）
    const current = Number(u.points);
    const actual = Math.round(Math.min(charge, current) * 100) / 100; // 余额不足扣到 0，保留 2 位小数
    await pool.query('UPDATE users SET points = GREATEST(points - ?, 0) WHERE id = ?', [charge, u.id]);
    await logDeduction(u.id, u.default_account_id || '', actual, 'daily_min', dayStr, Math.round((current - actual) * 100) / 100);
    totalCharged += actual;
    processed++;
    details.push({ userId: u.id, day: dayStr, beforeTotal: total, charged: actual, remainingPoints: Math.round(Math.max(current - charge, 0) * 100) / 100 });
  }
  return { day: dayStr, dailyMin: dailyMin, processed: processed, totalCharged: Math.round(totalCharged * 100) / 100, details: details };
}

// ---------- 后台：管理员（admin 表，替代原 store.json 的 admin） ----------
async function getAdminByUsername(username) {
  const rows = await pool.query('SELECT * FROM admin WHERE username = ?', [username]);
  return rows.length ? rows[0] : null;
}
async function updateAdminPassword(username, newPwdHash) {
  await pool.query('UPDATE admin SET password = ? WHERE username = ?', [newPwdHash, username]);
}

// ---------- 后台：用户管理（users 表，替代原 store.json 的演示用户） ----------
function mapUserRow(r) {
  return {
    id: r.id,
    username: r.username,
    gameRole: r.game_role || '',
    plan: r.plan,
    points: Number(r.points),
    status: r.status,
    createdAt: fmtDate(r.created_at)
  };
}
// 仪表盘统计 + 最近用户
async function getDashboardStats() {
  const total = await pool.query('SELECT COUNT(*) AS c FROM users');
  const active = await pool.query("SELECT COUNT(*) AS c FROM users WHERE status = '正常'");
  const pts = await pool.query('SELECT COALESCE(SUM(points),0) AS s FROM users');
  const vip = await pool.query("SELECT COUNT(*) AS c FROM users WHERE plan = '尊享版'");
  const recent = await pool.query(
    'SELECT id, username, game_role, plan, points, status, created_at FROM users ORDER BY id DESC LIMIT 8'
  );
  return {
    totalUsers: total[0].c,
    activeUsers: active[0].c,
    totalPoints: Number(pts[0].s),
    vipCount: vip[0].c,
    users: recent.map(mapUserRow)
  };
}
// 用户分页
async function getUsersPage(page, pageSize) {
  const total = await pool.query('SELECT COUNT(*) AS c FROM users');
  const totalCount = total[0].c;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const p = Math.min(Math.max(1, page | 0), totalPages);
  const offset = (p - 1) * pageSize;
  const rows = await pool.query(
    'SELECT id, username, game_role, plan, points, status, created_at FROM users ORDER BY id LIMIT ? OFFSET ?',
    [pageSize, offset]
  );
  return { users: rows.map(mapUserRow), page: p, totalPages, total: totalCount };
}
async function addUser({ username, gameRole, plan, points, status }) {
  await pool.query(
    'INSERT INTO users (username, game_role, plan, points, status, created_at, billed_hours, last_daily_settled_date) ' +
    'VALUES (?, ?, ?, ?, ?, CURDATE(), 0, DATE_SUB(CURDATE(), INTERVAL 1 DAY))',
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
  await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', params);
}
async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = ?', [id]);
}

// 会员 API 令牌：供外部工具通过 Authorization: Bearer <token> 鉴权（替代 cookie session）
// 返回该用户的令牌；若尚未生成则自动生成一个（48 位十六进制）
async function ensureApiToken(userId) {
  const rows = await pool.query('SELECT api_token FROM users WHERE id = ?', [userId]);
  if (!rows.length) return '';
  if (rows[0].api_token) return rows[0].api_token;
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET api_token = ? WHERE id = ?', [token, userId]);
  return token;
}
// 按令牌查用户（令牌无效/为空返回 null）
async function getUserByToken(token) {
  if (!token) return null;
  const rows = await pool.query(
    'SELECT id, username, plan, points, status FROM users WHERE api_token = ?',
    [String(token)]
  );
  return rows.length ? rows[0] : null;
}
// 重置（轮换）令牌：使旧令牌立即失效，返回新令牌
async function regenerateApiToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET api_token = ? WHERE id = ?', [token, userId]);
  return token;
}

// 记录一条充值/调整流水（amount 为有符号点数：正=充值/加，负=扣减/调整）
// remainingPoints: 变动后该用户剩余点数（用于对账）
async function logRecharge(userId, amount, admin, note, remainingPoints) {
  const amt = Math.round(Number(amount) * 100) / 100;
  const added = amt > 0 ? amt : 0;
  const deducted = amt < 0 ? -amt : 0;
  await pool.query(
    'INSERT INTO recharge_log (user_id, amount, added_points, deducted_points, remaining_points, admin, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, amt, added, deducted, Math.round(Number(remainingPoints) * 100) / 100 || 0, admin || '', note || '']
  );
}

// 后台修改用户点数：更新余额并按差额写充值记录（amount 有符号）
async function applyAdminPointsChange(userId, newPoints, admin, note) {
  const rows = await pool.query('SELECT points FROM users WHERE id = ?', [userId]);
  const oldPoints = rows.length ? Number(rows[0].points) : 0;
  const np = Math.round(Number(newPoints) * 100) / 100;
  await updateUser(userId, { points: np });
  const delta = Math.round((np - oldPoints) * 100) / 100;
  if (delta !== 0) {
    await logRecharge(userId, delta, admin, note || '后台调整', np);
  }
  return { oldPoints: oldPoints, newPoints: np, delta: delta };
}

// 后台：分页查询充值记录（可按 userId/day 筛选），JOIN users 取用户名
async function getAllRechargeLog(opts) {
  opts = opts || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  const where = [];
  const params = [];
  if (opts.userId) {
    where.push('r.user_id = ?');
    params.push(parseInt(opts.userId, 10));
  }
  if (opts.day) {
    where.push('DATE(r.created_at) = ?');
    params.push(opts.day);
  }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const totalRows = await pool.query('SELECT COUNT(*) AS c FROM recharge_log r ' + whereSql, params);
  const total = Number(totalRows[0].c);
  const rows = await pool.query(
    'SELECT r.id, r.user_id, u.username, r.amount, r.added_points, r.deducted_points, r.remaining_points, r.admin, r.note, r.created_at ' +
      'FROM recharge_log r LEFT JOIN users u ON u.id = r.user_id ' +
      whereSql + ' ORDER BY r.id DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total,
    records: rows.map(function (rw) {
      return {
        id: Number(rw.id),
        userId: Number(rw.user_id),
        username: rw.username || '已删除',
        amount: Number(rw.amount),
        addedPoints: Number(rw.added_points),
        deductedPoints: Number(rw.deducted_points),
        remainingPoints: Number(rw.remaining_points),
        admin: rw.admin || '-',
        note: rw.note || '',
        createdAt: fmtDateTime(rw.created_at)
      };
    })
  };
}

// ---------- 后台：定价（pricing 表，替代原 store.json 的 pricing） ----------
async function getPricingCards() {
  const rows = await pool.query('SELECT * FROM pricing ORDER BY id');
  const out = {};
  for (const r of rows) {
    out[r.card_key] = {
      name: r.name,
      price: Number(r.price),
      points: Number(r.points),
      days: Number(r.days),
      save: Number(r.save)
    };
  }
  return out;
}
async function savePricingCards(cards) {
  for (const key of Object.keys(cards)) {
    const c = cards[key];
    await pool.query(
      'UPDATE pricing SET name=?, price=?, points=?, days=?, save=? WHERE card_key=?',
      [c.name, Number(c.price), Number(c.points), Number(c.days), Number(c.save), key]
    );
  }
}

// 确保数据库表与字段齐全（首次运行自动创建/补齐，不影响已有数据）
async function ensureSchema() {
  const cols = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = '" + DB_NAME + "' AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password'"
  );
  if (cols.length === 0) {
    await pool.query(
      "ALTER TABLE `users` ADD COLUMN `password` VARCHAR(100) NULL COMMENT '登录密码(sha256)' AFTER `username`"
    );
    console.log('  [DB] users.password 字段已自动创建');
  }

  const tables = await pool.query("SHOW TABLES LIKE 'accounts'");
  if (tables.length === 0) {
    await pool.query(
      "CREATE TABLE `accounts` (" +
      "`id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, " +
      "`user_id` INT UNSIGNED NOT NULL COMMENT '所属用户(users.id)', " +
      "`acc_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '账号配置ID(UUID)', " +
      "`profile_dir` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '配置目录', " +
      "`uid` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '游戏UID', " +
      "`name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '游戏角色名', " +
      "`server_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '区服ID', " +
      "`last_login_at` BIGINT NOT NULL DEFAULT 0 COMMENT '最后登录时间(毫秒)', " +
      "`server_info_token` TEXT COMMENT '服务器信息token', " +
      "`token_expire_at` BIGINT NOT NULL DEFAULT 0 COMMENT 'token过期时间(毫秒)', " +
      "`avatar` VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '头像', " +
      "`qq_access_token` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'QQ登录token', " +
      "`qq_openid` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'QQ openid', " +
      "`status` VARCHAR(20) NOT NULL DEFAULT '正常' COMMENT '账号状态：正常/已封禁/已过期', " +
      "`created_at` DATE NOT NULL COMMENT '创建日期', " +
      "`updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
      "KEY `idx_accounts_user` (`user_id`), " +
      "CONSTRAINT `fk_accounts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏账号表（一个用户可拥有多个）'"
    );
    console.log('  [DB] accounts 表已自动创建');
  }

  const benefitTables = await pool.query("SHOW TABLES LIKE 'game_account_benefits'");
  if (benefitTables.length === 0) {
    await pool.query(
      "CREATE TABLE `game_account_benefits` (" +
      "`uid` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '游戏UID', " +
      "`server_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '区服ID', " +
      "`claimed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首绑记录时间', " +
      "`first_account_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '首次绑定的acc_id', " +
      "PRIMARY KEY (`uid`, `server_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏账号首绑奖励去重表（同一uid+区服仅首绑一次，防薅羊毛）'"
    );
    console.log('  [DB] game_account_benefits 表已自动创建');
  }

  const ptCol = await pool.query(
    "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA='" + DB_NAME + "' AND TABLE_NAME='users' AND COLUMN_NAME='points'"
  );
  if (ptCol.length && !/decimal/i.test(ptCol[0].COLUMN_TYPE)) {
    await pool.query('ALTER TABLE `users` MODIFY COLUMN `points` DECIMAL(10,2) NOT NULL DEFAULT 0');
    console.log('  [DB] users.points 已转换为 DECIMAL(10,2)');
  }
  const extraCols = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA='" + DB_NAME + "' AND TABLE_NAME='users' AND COLUMN_NAME IN ('default_account_id','last_settled_at','tool_started_at','invite_code','game_role')"
  );
  const haveCols = extraCols.map(c => c.COLUMN_NAME);
  if (!haveCols.includes('default_account_id')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `default_account_id` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '默认游戏账号acc_id'");
    console.log('  [DB] users.default_account_id 已创建');
  }
  if (!haveCols.includes('last_settled_at')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `last_settled_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '积分按时间结算的基准时间'");
    console.log('  [DB] users.last_settled_at 已创建');
  }
  if (!haveCols.includes('tool_started_at')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `tool_started_at` DATETIME NULL DEFAULT NULL COMMENT '工具启动时间(null=未启动，启用费率计费起算点)'");
    console.log('  [DB] users.tool_started_at 已创建');
  }
  if (!haveCols.includes('invite_code')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `invite_code` VARCHAR(64) NULL DEFAULT NULL COMMENT '注册邀请码(非必填)'");
    console.log('  [DB] users.invite_code 已创建');
  }
  if (!haveCols.includes('game_role')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `game_role` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '游戏角色名(后台用户管理展示)' AFTER `username`");
    console.log('  [DB] users.game_role 已创建');
  }

  // 会员 API 令牌：供外部工具通过 Bearer 令牌鉴权（替代 cookie session）
  const tkCol = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA='" + DB_NAME + "' AND TABLE_NAME='users' AND COLUMN_NAME='api_token'"
  );
  if (tkCol.length === 0) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `api_token` VARCHAR(64) NULL DEFAULT NULL COMMENT '会员API令牌(工具调用鉴权)；为空表示未生成'");
    console.log('  [DB] users.api_token 已创建');
  }
  try {
    await pool.query('ALTER TABLE `users` ADD UNIQUE INDEX uk_users_api_token (api_token)');
  } catch (e) { /* 索引已存在或暂无可去重数据，忽略 */ }

  // 按小时/按天计费所需字段
  const billCols = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA='" + DB_NAME + "' AND TABLE_NAME='users' AND COLUMN_NAME IN ('billed_hours','last_daily_settled_date')"
  );
  const haveBillCols = billCols.map(c => c.COLUMN_NAME);
  if (!haveBillCols.includes('billed_hours')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `billed_hours` INT NOT NULL DEFAULT 0 COMMENT '已按小时计费的整小时数(运行中累计，避免重复计费)'");
    console.log('  [DB] users.billed_hours 已创建');
  }
  if (!haveBillCols.includes('last_daily_settled_date')) {
    await pool.query("ALTER TABLE `users` ADD COLUMN `last_daily_settled_date` DATE NOT NULL DEFAULT '2000-01-01' COMMENT '已结算过每日20点费用的最近日期(次日扣费标记)'");
    console.log('  [DB] users.last_daily_settled_date 已创建');
  }
  // 已有用户初始化为昨天，避免追溯历史天重复扣费
  await pool.query(
    "UPDATE users SET last_daily_settled_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY) " +
    "WHERE last_daily_settled_date IS NULL OR last_daily_settled_date = '0000-00-00' OR last_daily_settled_date < '2000-01-02'"
  );

  // 记录用户每天是否启动过工具（用于按天 20 点扣费豁免）
  const trd = await pool.query("SHOW TABLES LIKE 'tool_run_days'");
  if (trd.length === 0) {
    await pool.query(
      "CREATE TABLE `tool_run_days` (" +
      "`user_id` INT UNSIGNED NOT NULL COMMENT '用户ID(users.id)', " +
      "`day` DATE NOT NULL COMMENT '启动工具的日期(标记当天不计每日20点)', " +
      "PRIMARY KEY (`user_id`, `day`), " +
      "KEY `idx_trd_day` (`day`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='记录用户每天是否启动过工具(用于按天20点扣费豁免)'"
    );
    console.log('  [DB] tool_run_days 表已自动创建');
  }

  // 点数扣费流水表：每次工具上报(usage)与每日最低消费补足(daily_min)都记录，用于按天累计
  const pl = await pool.query("SHOW TABLES LIKE 'points_log'");
  if (pl.length === 0) {
    await pool.query(
      "CREATE TABLE `points_log` (" +
      "`id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, " +
      "`user_id` INT UNSIGNED NOT NULL COMMENT '用户ID(users.id)', " +
      "`account_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '游戏账号acc_id(usage类有值；daily_min可空)', " +
      "`amount` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '扣除点数(正数)', " +
      "`type` VARCHAR(20) NOT NULL DEFAULT 'usage' COMMENT 'usage=工具按小时上报; daily_min=每日最低消费补足', " +
      "`added_points` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '新增点数(扣费模块恒为0)', " +
      "`deducted_points` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '扣费点数(本次实际扣除)', " +
      "`remaining_points` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '剩余点数(扣费后余额)', " +
      "`day` DATE NOT NULL COMMENT '计费日期(按天累计)', " +
      "`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间', " +
      "KEY `idx_pl_user_day` (`user_id`, `day`), " +
      "KEY `idx_pl_day` (`day`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点数扣费流水(工具上报与每日最低补足均记录)'"
    );
    console.log('  [DB] points_log 表已自动创建');
  }

  // 充值/调整记录表：后台修改用户点数时记录差额（amount 有符号，正=充值/加，负=扣减/调整）
  const rl = await pool.query("SHOW TABLES LIKE 'recharge_log'");
  if (rl.length === 0) {
    await pool.query(
      "CREATE TABLE `recharge_log` (" +
      "`id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, " +
      "`user_id` INT UNSIGNED NOT NULL COMMENT '用户ID(users.id)', " +
      "`amount` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '变动点数（有符号：正=充值/加，负=扣减/调整）', " +
      "`added_points` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '新增点数(正变动)', " +
      "`deducted_points` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '扣费点数(负变动)', " +
      "`remaining_points` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '剩余点数(变动后余额)', " +
      "`admin` VARCHAR(50) NOT NULL DEFAULT '' COMMENT '操作管理员(admin.username)', " +
      "`note` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注（如 后台调整/套餐名）', " +
      "`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间', " +
      "KEY `idx_rl_user` (`user_id`), " +
      "KEY `idx_rl_created` (`created_at`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值/调整记录（后台修改用户点数生成）'"
    );
    console.log('  [DB] recharge_log 表已自动创建');
  }

  // 对账字段迁移：扣费流水(points_log) 与 充值记录(recharge_log) 统一补充 新增点数/扣费点数/剩余点数
  const ledgerCols = [
    ['points_log', 'added_points', "DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '新增点数(扣费模块恒为0)'"],
    ['points_log', 'deducted_points', "DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '扣费点数(本次实际扣除)'"],
    ['points_log', 'remaining_points', "DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '剩余点数(扣费后余额)'"],
    ['recharge_log', 'added_points', "DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '新增点数(正变动)'"],
    ['recharge_log', 'deducted_points', "DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '扣费点数(负变动)'"],
    ['recharge_log', 'remaining_points', "DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '剩余点数(变动后余额)'"]
  ];
  for (const [tbl, col, def] of ledgerCols) {
    const c = await pool.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='" + DB_NAME + "' AND TABLE_NAME=? AND COLUMN_NAME=?", [tbl, col]
    );
    if (c.length === 0) {
      await pool.query("ALTER TABLE `" + tbl + "` ADD COLUMN `" + col + "` " + def);
      console.log('  [DB] ' + tbl + '.' + col + ' 已自动创建');
    }
  }

  // 账号 ID 相关字段统一扩到 VARCHAR(255)，并补齐 server_info_token
  const widenCols = [
    ['accounts', 'acc_id', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '账号配置ID(UUID)'"],
    ['accounts', 'profile_dir', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '配置目录'"],
    ['accounts', 'uid', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '游戏UID'"],
    ['accounts', 'server_id', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '区服ID'"],
    ['accounts', 'server_info_token', "TEXT COMMENT '服务器信息token'"],
    ['users', 'default_account_id', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '默认游戏账号acc_id'"],
    ['game_account_benefits', 'uid', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '游戏UID'"],
    ['game_account_benefits', 'server_id', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '区服ID'"],
    ['game_account_benefits', 'first_account_id', "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '首次绑定的acc_id'"]
  ];
  for (const [tbl, col, def] of widenCols) {
    const c = await pool.query(
      "SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA='" + DB_NAME + "' AND TABLE_NAME=? AND COLUMN_NAME=?", [tbl, col]
    );
    if (c.length && Number(c[0].CHARACTER_MAXIMUM_LENGTH) < 255) {
      await pool.query("ALTER TABLE `" + tbl + "` MODIFY COLUMN `" + col + "` " + def);
      console.log('  [DB] ' + tbl + '.' + col + ' 已扩展为 VARCHAR(255)');
    }
  }

  // 回填空的 acc_id 为 UUID（早期数据 acc_id 为空，会导致前台删除/编辑无法定位行）
  const emptyAcc = await pool.query("SELECT id FROM accounts WHERE acc_id IS NULL OR acc_id = ''");
  for (const row of emptyAcc) {
    const uuid = crypto.randomUUID();
    await pool.query('UPDATE accounts SET acc_id = ? WHERE id = ?', [uuid, row.id]);
  }
  if (emptyAcc.length) console.log('  [DB] 已为 ' + emptyAcc.length + ' 个空 acc_id 账号回填 UUID');

  // ---------- 以下为「原 JSON 模拟数据」全部迁移到数据库后的兜底建表与种子 ----------
  // 管理员表
  const adminT = await pool.query("SHOW TABLES LIKE 'admin'");
  if (adminT.length === 0) {
    await pool.query(
      "CREATE TABLE `admin` (" +
      "`id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, " +
      "`username` VARCHAR(50) NOT NULL UNIQUE COMMENT '登录账号', " +
      "`password` VARCHAR(100) NOT NULL COMMENT '登录密码(sha256)', " +
      "`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台管理员'"
    );
    console.log('  [DB] admin 表已自动创建');
  }
  const adminCnt = await pool.query('SELECT COUNT(*) AS c FROM admin');
  if (!adminCnt[0].c) {
    await pool.query('INSERT INTO admin (username, password) VALUES (?, ?)', ['admin', hashPwd('admin123')]);
    console.log('  [DB] 已写入默认管理员 admin / admin123 (sha256)');
  }

  // 定价表
  const pricingT = await pool.query("SHOW TABLES LIKE 'pricing'");
  if (pricingT.length === 0) {
    await pool.query(
      "CREATE TABLE `pricing` (" +
      "`id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, " +
      "`card_key` VARCHAR(20) NOT NULL UNIQUE COMMENT 'monthly/quarterly/halfYear/yearly', " +
      "`name` VARCHAR(20) NOT NULL COMMENT '套餐名称', " +
      "`price` DECIMAL(10,2) NOT NULL COMMENT '售价(元)', " +
      "`points` INT NOT NULL COMMENT '赠送点数', " +
      "`days` DECIMAL(10,1) NOT NULL COMMENT '有效期(天)', " +
      "`save` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '相比原价节省(元)'" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值套餐定价表'"
    );
    console.log('  [DB] pricing 表已自动创建');
  }
  const pricingCnt = await pool.query('SELECT COUNT(*) AS c FROM pricing');
  if (!pricingCnt[0].c) {
    const seed = [
      ['monthlyCard', '月卡', 58, 720, 30, 26],
      ['quarterlyCard', '季卡', 148, 2160, 90, 70],
      ['halfYearCard', '半年卡', 278, 4380, 182.5, 208],
      ['yearlyCard', '年卡', 488, 8760, 365, 488]
    ];
    for (const s of seed) {
      await pool.query('INSERT INTO pricing (card_key, name, price, points, days, save) VALUES (?, ?, ?, ?, ?, ?)', s);
    }
    console.log('  [DB] 已写入默认定价');
  }

  // 会员方案表
  const plansT = await pool.query("SHOW TABLES LIKE 'plans'");
  if (plansT.length === 0) {
    await pool.query(
      "CREATE TABLE `plans` (" +
      "`id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, " +
      "`plan_key` VARCHAR(20) NOT NULL UNIQUE COMMENT 'premium/vip', " +
      "`name` VARCHAR(50) NOT NULL COMMENT '方案名称', " +
      "`rate_per_hour` DECIMAL(5,2) NOT NULL COMMENT '每小时消耗点数', " +
      "`desc` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '方案描述'" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会员方案表'"
    );
    console.log('  [DB] plans 表已自动创建');
  }
  const plansCnt = await pool.query('SELECT COUNT(*) AS c FROM plans');
  if (!plansCnt[0].c) {
    await pool.query(
      "INSERT INTO plans (plan_key, name, rate_per_hour, `desc`) VALUES " +
      "('premium', '高级版', 1.00, '使用高级功能及常用设置自动同步'), " +
      "('vip', '尊享版', 1.50, '包含高级版功能，并可在本地离线后由云端接管')"
    );
    console.log('  [DB] 已写入默认会员方案');
  }

  // 系统设置表（扣费开关 / 计费费率等）
  const settingsT = await pool.query("SHOW TABLES LIKE 'settings'");
  if (settingsT.length === 0) {
    await pool.query(
      "CREATE TABLE `settings` (" +
      "`key` VARCHAR(50) NOT NULL PRIMARY KEY, " +
      "`value` VARCHAR(255) NOT NULL DEFAULT ''" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统设置键值对'"
    );
    console.log('  [DB] settings 表已自动创建');
  }
  const settingsSeed = [
    ['points_plan_enabled', 'true'],
    ['billing_enabled_rate_per_hour', '1'],
    ['billing_disabled_rate_per_day', '24'],
    ['billing_daily_minimum', '12']
  ];
  for (const [k, v] of settingsSeed) {
    const cnt = await pool.query('SELECT COUNT(*) AS c FROM settings WHERE `key` = ?', [k]);
    if (!cnt[0].c) {
      await pool.query('INSERT INTO settings (`key`, `value`) VALUES (?, ?)', [k, v]);
    }
  }
  // 历史默认值迁移：将旧的计费默认值升级为新规则（仅对仍为旧默认值的记录生效）
  await pool.query("UPDATE settings SET `value` = '1' WHERE `key` = 'billing_enabled_rate_per_hour' AND `value` = '10'");
  await pool.query("UPDATE settings SET `value` = '24' WHERE `key` = 'billing_disabled_rate_per_day' AND `value` = '20'");
  await pool.query("UPDATE settings SET `value` = '12' WHERE `key` = 'billing_daily_minimum' AND `value` = '8'");
}

module.exports = {
  pool, ensureSchema, toAccount, resolveGameBenefit, settleUserPoints,
  hashPwd, getSetting, setSetting,
  getPointsPlanEnabled, setPointsPlanEnabled, getBillingConfig, saveBillingConfig,
  getDailyMinimum, logDeduction, getDailyTotal, getPointsLog, getAllPointsLog, settleDailyMinimum, logRecharge, applyAdminPointsChange, getAllRechargeLog,
  getAdminByUsername, updateAdminPassword,
  getDashboardStats, getUsersPage, addUser, updateUser, deleteUser,
  getPricingCards, savePricingCards,
  ensureApiToken, getUserByToken, regenerateApiToken,
  fmtDateTime, fmtDate
};

// 数据库结构自检/迁移：只要本模块被 require（app.js / routes / bin/www 都会 require 它）就自动执行，
// 不依赖特定启动入口（如直接 `node app.js` 也能补齐 api_token 等字段）。失败仅记录错误，不阻断启动。
ensureSchema().catch(function (e) { console.error('[DB ensureSchema]', e); });
