// 全部路由（前台页面 + 后台管理 + 开放 API），由 Hono 实现，运行于 Cloudflare Workers。
import { Hono } from 'hono';
import * as db from './db.js';
import { sha256, hmacSha256Hex, randomTokenHex } from './util.js';
import * as files from './files.js';
import { getSession, saveSession, destroySession } from './session.js';
import { render } from './render.js';

const app = new Hono();

// 统一错误处理（不暴露内部堆栈）
app.onError((err, c) => c.text('服务器内部错误', 500));

// 安全头 / CORS / 会话解析
app.use('*', async (c, next) => {
  db.setDB(c.env.DB);
  const origin = c.req.header('origin');
  if (origin) c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  c.set('session', await getSession(c));
  await next();
});

// 请求体解析辅助
async function jb(c) { try { return (await c.req.json()) || {}; } catch (e) { return {}; } }
async function fb(c) { try { return (await c.req.parseBody()) || {}; } catch (e) { return {}; } }

// 响应签名：X-Sign = HMAC-SHA256(用户token, timestamp + '.' + nonce + '.' + 响应体)
// 工具端用本地保存的 token 重新计算即可校验响应未被篡改/伪造；不携带 token 的密钥无法伪造签名。
async function signedJson(c, payload, status = 200) {
  const body = JSON.stringify(payload);
  const ts = Date.now().toString();
  const nonce = randomTokenHex(8);
  const sign = await hmacSha256Hex(c.get('token') || '', ts + '.' + nonce + '.' + body);
  c.header('X-Timestamp', ts);
  c.header('X-Nonce', nonce);
  c.header('X-Sign', sign);
  c.header('X-Sign-Alg', 'HMAC-SHA256');
  return c.json(payload, status);
}

// ---------- 鉴权中间件 ----------
function requireAuth(c, next) {
  const s = c.get('session') || {};
  if (s.admin) return next();
  return c.redirect('/admin/login');
}
async function authenticateUser(c, next) {
  const s = c.get('session') || {};
  if (s.user) { c.set('user', s.user); return next(); }
  const auth = c.req.header('authorization') || '';
  let token = '';
  if (/^Bearer\s+/i.test(auth)) token = auth.replace(/^Bearer\s+/i, '').trim();
  else token = c.req.query('token') || '';
  if (!token) {
    const body = await jb(c);
    token = body.token || '';
  }
  if (!token) return c.json({ success: false, message: '未提供认证令牌（请在 Authorization 头携带 Bearer <token>）' }, 401);
  try {
    const u = await db.getUserByToken(token);
    if (!u) return c.json({ success: false, message: '令牌无效或已失效' }, 401);
    if (u.status === '已过期') return c.json({ success: false, message: '账号已过期，请联系管理员' }, 403);
    c.set('user', { id: u.id, username: u.username, plan: u.plan, status: u.status });
    c.set('token', token);
    return next();
  } catch (e) {
    return c.json({ success: false, message: '服务器错误' }, 500);
  }
}

// ---------- 前台页面 ----------
app.get('/', (c) => render(c, 'index'));
app.get('/features', (c) => render(c, 'features'));
app.get('/download', (c) => render(c, 'download'));
app.get('/manual', (c) => render(c, 'manual'));
app.get('/faq', (c) => render(c, 'faq'));
app.get('/login', (c) => render(c, 'login'));
app.get('/checkin', (c) => render(c, 'checkin'));
app.get('/pricing', async (c) => {
  try {
    const pricing = await db.getPricingCards();
    const billing = await db.getBillingConfig();
    return render(c, 'pricing', { billing, pricing });
  } catch (e) {
    return render(c, 'pricing', { billing: { enabledRatePerHour: 1, disabledRatePerDay: 24, dailyMinimum: 12 }, pricing: {} });
  }
});

// ---------- 后台登录 ----------
app.get('/admin/login', (c) => {
  const s = c.get('session') || {};
  if (s.admin) return c.redirect('/admin');
  return render(c, 'admin/login', { error: null });
});
app.post('/admin/login', async (c) => {
  try {
    const b = await fb(c);
    const username = b.username, password = b.password;
    const admin = await db.getAdminByUsername(username);
    if (!admin) return render(c, 'admin/login', { error: '账号或密码错误' });
    const hash = await sha256(password);
    if (admin.password === hash) {
      await saveSession(c, { admin: username });
      return c.redirect('/admin');
    }
    if (admin.password === password) {
      await db.updateAdminPassword(username, hash);
      await saveSession(c, { admin: username });
      return c.redirect('/admin');
    }
    return render(c, 'admin/login', { error: '账号或密码错误' });
  } catch (e) {
    return render(c, 'admin/login', { error: '服务器错误' });
  }
});
app.get('/admin/logout', (c) => { destroySession(c); return c.redirect('/admin/login'); });

// ---------- 后台页面 ----------
app.get('/admin', requireAuth, async (c) => {
  try {
    const stats = await db.getDashboardStats();
    return render(c, 'admin/dashboard', Object.assign({ admin: c.get('session').admin }, stats));
  } catch (e) {
    return render(c, 'admin/dashboard', { admin: c.get('session').admin, totalUsers: 0, activeUsers: 0, totalPoints: 0, vipCount: 0, users: [] });
  }
});
app.get('/admin/users', requireAuth, async (c) => {
  try {
    const page = parseInt(c.req.query('page')) || 1;
    const r = await db.getUsersPage(page, 10);
    return render(c, 'admin/users', Object.assign({ admin: c.get('session').admin }, r));
  } catch (e) {
    return render(c, 'admin/users', { admin: c.get('session').admin, users: [], page: 1, totalPages: 1, total: 0 });
  }
});
app.post('/admin/users/add', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    await db.addUser({ username: b.username, gameRole: b.gameRole, plan: b.plan, points: b.points, status: b.status });
  } catch (e) { /* 忽略，重定向回列表 */ }
  return c.redirect('/admin/users');
});
app.post('/admin/users/delete/:id', requireAuth, async (c) => {
  try { await db.deleteUser(c.req.param('id')); } catch (e) {}
  return c.redirect('/admin/users');
});
app.post('/admin/users/update/:id', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    if (b.points !== undefined && b.points !== '') {
      await db.applyAdminPointsChange(c.req.param('id'), b.points, c.get('session').admin, '后台调整');
    }
    await db.updateUser(c.req.param('id'), { plan: b.plan, status: b.status, gameRole: b.gameRole });
  } catch (e) {}
  return c.redirect('/admin/users');
});
app.get('/admin/logs', requireAuth, async (c) => {
  try {
    const page = parseInt(c.req.query('page')) || 1;
    const r = await db.getAllPointsLog({ userId: c.req.query('userId'), type: c.req.query('type'), day: c.req.query('day'), page, pageSize: 20 });
    const totalPages = Math.ceil(r.total / 20) || 1;
    return render(c, 'admin/logs', {
      admin: c.get('session').admin,
      filter: { userId: c.req.query('userId') || '', type: c.req.query('type') || '', day: c.req.query('day') || '' },
      records: r.records, total: r.total, page, totalPages
    });
  } catch (e) {
    return render(c, 'admin/logs', { admin: c.get('session').admin, filter: { userId: '', type: '', day: '' }, records: [], total: 0, page: 1, totalPages: 1 });
  }
});
app.get('/admin/recharge', requireAuth, async (c) => {
  try {
    const page = parseInt(c.req.query('page')) || 1;
    const r = await db.getAllRechargeLog({ userId: c.req.query('userId'), day: c.req.query('day'), page, pageSize: 20 });
    const totalPages = Math.ceil(r.total / 20) || 1;
    return render(c, 'admin/recharge', {
      admin: c.get('session').admin,
      filter: { userId: c.req.query('userId') || '', day: c.req.query('day') || '' },
      records: r.records, total: r.total, page, totalPages
    });
  } catch (e) {
    return render(c, 'admin/recharge', { admin: c.get('session').admin, filter: { userId: '', day: '' }, records: [], total: 0, page: 1, totalPages: 1 });
  }
});
app.get('/admin/pricing', requireAuth, async (c) => {
  try {
    const pricing = await db.getPricingCards();
    const billing = await db.getBillingConfig();
    return render(c, 'admin/pricing', { admin: c.get('session').admin, pricing, billing, saved: !!c.req.query('saved') });
  } catch (e) {
    return render(c, 'admin/pricing', { admin: c.get('session').admin, pricing: {}, billing: { enabledRatePerHour: 1, disabledRatePerDay: 24, dailyMinimum: 12 }, saved: false });
  }
});
app.post('/admin/pricing/save', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    await db.savePricingCards({
      monthlyCard: { name: '月卡', price: b.m_price, points: b.m_points, days: b.m_days, save: b.m_save },
      quarterlyCard: { name: '季卡', price: b.q_price, points: b.q_points, days: b.q_days, save: b.q_save },
      halfYearCard: { name: '半年卡', price: b.h_price, points: b.h_points, days: b.h_days, save: b.h_save },
      yearlyCard: { name: '年卡', price: b.y_price, points: b.y_points, days: b.y_days, save: b.y_save }
    });
    await db.saveBillingConfig({ enabledRatePerHour: b.enabled_rate, disabledRatePerDay: b.disabled_rate, dailyMinimum: b.daily_minimum });
    return c.redirect('/admin/pricing?saved=1');
  } catch (e) {
    return c.redirect('/admin/pricing');
  }
});
app.get('/admin/checkin', requireAuth, async (c) => {
  try {
    const cfg = await db.getCheckinConfig();
    return render(c, 'admin/checkin', { admin: c.get('session').admin, cfg, saved: !!c.req.query('saved') });
  } catch (e) {
    return render(c, 'admin/checkin', { admin: c.get('session').admin, cfg: { enabled: true, rewards: Array.from({ length: 30 }, (_, i) => (i + 1) * 5) }, saved: false });
  }
});
app.post('/admin/checkin/save', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    const rewards = String(b.rewards || '')
      .split(/[\r\n,，、\s]+/).map(s => s.trim()).filter(Boolean).map(Number);
    await db.saveCheckinConfig({
      enabled: b.enabled === 'on' || b.enabled === '1' || b.enabled === 'true',
      rewards
    });
  } catch (e) {}
  return c.redirect('/admin/checkin?saved=1');
});
app.get('/admin/settings', requireAuth, (c) => render(c, 'admin/settings', { admin: c.get('session').admin, error: null, success: null }));
app.post('/admin/settings', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    const oldPassword = b.oldPassword, newPassword = b.newPassword;
    const admin = await db.getAdminByUsername(c.get('session').admin);
    if (!admin) return render(c, 'admin/settings', { admin: c.get('session').admin, error: '管理员不存在', success: null });
    const hash = await sha256(newPassword);
    if (admin.password !== hash && admin.password !== oldPassword) {
      return render(c, 'admin/settings', { admin: c.get('session').admin, error: '原密码错误', success: null });
    }
    if (!newPassword || newPassword.length < 6) {
      return render(c, 'admin/settings', { admin: c.get('session').admin, error: '新密码至少6位', success: null });
    }
    await db.updateAdminPassword(c.get('session').admin, hash);
    return render(c, 'admin/settings', { admin: c.get('session').admin, error: null, success: '密码修改成功' });
  } catch (e) {
    return render(c, 'admin/settings', { admin: c.get('session').admin, error: '服务器错误', success: null });
  }
});
app.get('/admin/accounts', requireAuth, async (c) => {
  try {
    const pageSize = 10;
    const totalRow = await db.query('SELECT COUNT(*) AS c FROM accounts');
    const total = totalRow[0].c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    let page = parseInt(c.req.query('page')) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const offset = (page - 1) * pageSize;
    const accounts = await db.query(
      'SELECT a.*, u.username AS owner FROM accounts a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.id LIMIT ? OFFSET ?',
      [pageSize, offset]
    );
    const users = await db.query('SELECT id, username FROM users ORDER BY id');
    return render(c, 'admin/accounts', { admin: c.get('session').admin, accounts, users, page, totalPages, total });
  } catch (e) {
    return render(c, 'admin/accounts', { admin: c.get('session').admin, accounts: [], users: [], page: 1, totalPages: 1, total: 0 });
  }
});

// ---------- 开放 API：账号管理 ----------
app.get('/api/accounts', async (c) => {
  try {
    const userId = c.req.query('userId');
    if (userId) {
      const rows = await db.query('SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [userId]);
      const u = await db.queryOne('SELECT points, default_account_id, tool_started_at FROM users WHERE id = ?', [userId]);
      const running = u && !!u.tool_started_at;
      const cfg = await db.getBillingConfig();
      return c.json({
        success: true, data: rows.map(db.toAccount),
        userPoints: u ? Math.round(Number(u.points)) : null,
        defaultAccountId: u ? u.default_account_id : '',
        toolRunning: running, toolEnabled: running,
        ratePerHour: running ? cfg.enabledRatePerHour : (cfg.disabledRatePerDay / 24)
      });
    }
    const all = await db.query('SELECT * FROM accounts ORDER BY id');
    return c.json({ success: true, data: all.map(db.toAccount) });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/accounts', async (c) => {
  try {
    const body = await jb(c);
    const id = body.id || '';
    const userId = body.userId, name = body.name;
    const uid = body.uid || '', serverId = body.serverId || '', profileDir = body.profileDir || '';
    const lastLoginAt = body.lastLoginAt || 0, serverInfoToken = body.serverInfoToken || '', tokenExpireAt = body.tokenExpireAt || 0, avatar = body.avatar || '';
    const qqAccessToken = body.qqAccessToken || '', qqOpenid = body.qqOpenid || '', status = body.status || '正常';
    if (!userId || !name) return c.json({ success: false, message: 'userId 和 name(角色名)不能为空' });
    const newId = await db.insert(
      "INSERT INTO accounts (user_id, name, uid, server_id, last_login_at, server_info_token, token_expire_at, avatar, qq_access_token, qq_openid, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'))",
      [userId, name, uid, serverId, lastLoginAt, serverInfoToken, tokenExpireAt, avatar, qqAccessToken, qqOpenid, status]
    );
    const accId = id || profileDir || ('acc-' + newId);
    const profileDirVal = profileDir || id || accId;
    await db.run('UPDATE accounts SET acc_id = ?, profile_dir = ? WHERE id = ?', [accId, profileDirVal, newId]);
    const du = await db.queryOne('SELECT default_account_id FROM users WHERE id = ?', [userId]);
    if (!du || !du.default_account_id) await db.run('UPDATE users SET default_account_id = ? WHERE id = ?', [accId, userId]);
    const benefit = await db.resolveGameBenefit(uid, serverId, accId);
    const message = (benefit.tracked && !benefit.firstBind)
      ? '创建成功（该游戏账号此前已绑定过，属于重复绑定，不发放首绑奖励）'
      : '创建成功';
    return c.json({ success: true, id: accId, firstBind: benefit.firstBind, benefitEligible: benefit.firstBind, tracked: benefit.tracked, message });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.put('/api/accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const fields = [
      ['name', 'name'], ['uid', 'uid'], ['serverId', 'server_id'], ['profileDir', 'profile_dir'],
      ['lastLoginAt', 'last_login_at'], ['serverInfoToken', 'server_info_token'], ['tokenExpireAt', 'token_expire_at'],
      ['avatar', 'avatar'], ['qqAccessToken', 'qq_access_token'], ['qqOpenid', 'qq_openid'], ['status', 'status']
    ];
    const sets = [], params = [];
    const body = await jb(c);
    for (const [bodyKey, col] of fields) {
      if (body[bodyKey] !== undefined) { sets.push(col + ' = ?'); params.push(body[bodyKey]); }
    }
    if (!sets.length) return c.json({ success: false, message: '没有可更新字段' });
    let whereSql, whereParams;
    if (/^\d+$/.test(id)) { whereSql = 'id = ?'; whereParams = [Number(id)]; }
    else { whereSql = 'acc_id = ?'; whereParams = [id]; }
    const r = await db.run('UPDATE accounts SET ' + sets.join(', ') + ' WHERE ' + whereSql, params.concat(whereParams));
    if (r.meta.changes === 0) return c.json({ success: false, message: '账号不存在' });
    return c.json({ success: true, message: '更新成功' });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.delete('/api/accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    let whereSql, whereParams;
    if (/^\d+$/.test(id)) { whereSql = 'id = ?'; whereParams = [Number(id)]; }
    else { whereSql = 'acc_id = ?'; whereParams = [id]; }
    const delRows = await db.query('SELECT id, acc_id, user_id FROM accounts WHERE ' + whereSql, whereParams);
    if (!delRows.length) return c.json({ success: false, message: '账号不存在' });
    const del = delRows[0];
    await db.run('DELETE FROM accounts WHERE id = ?', [del.id]);
    if (del.acc_id && del.user_id) {
      const u = await db.queryOne('SELECT default_account_id FROM users WHERE id = ?', [del.user_id]);
      if (u && u.default_account_id === del.acc_id) {
        const remain = await db.query('SELECT acc_id FROM accounts WHERE user_id = ? ORDER BY id ASC LIMIT 1', [del.user_id]);
        await db.run('UPDATE users SET default_account_id = ? WHERE id = ?', [remain.length ? remain[0].acc_id : '', del.user_id]);
      }
    }
    return c.json({ success: true, message: '删除成功' });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});

// ---------- 开放 API：认证与积分 ----------
app.post('/api/register', async (c) => {
  try {
    const b = await jb(c);
    const username = b.username, password = b.password, inviteCode = b.inviteCode;
    if (!username || !password) return c.json({ success: false, message: '用户名和密码不能为空' });
    const exist = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (exist.length) return c.json({ success: false, message: '用户名已存在' });
    const code = (inviteCode && String(inviteCode).trim()) || null;
    await db.run(
      "INSERT INTO users (username, password, plan, points, status, invite_code, created_at) VALUES (?, ?, '高级版', 600, '正常', ?, date('now'))",
      [username, await sha256(password), code]
    );
    return c.json({ success: true, message: '注册成功', points: 600, inviteCode: code });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/login', async (c) => {
  try {
    const b = await jb(c);
    const username = b.username, password = b.password;
    if (!username || !password) return c.json({ success: false, message: '用户名和密码不能为空' });
    const rows = await db.query('SELECT id, username, plan, points, status FROM users WHERE username = ? AND password = ?', [username, await sha256(password)]);
    if (!rows.length) return c.json({ success: false, message: '用户名或密码错误' });
    const u = rows[0];
    if (u.status === '已过期') return c.json({ success: false, message: '账号已过期，请联系管理员' });
    await saveSession(c, { user: { id: u.id, username: u.username } });
    const token = await db.ensureApiToken(u.id);
    u.points = Math.round(Number(u.points) * 100) / 100;
    return c.json({ success: true, message: '登录成功', token, user: u });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.get('/api/me', authenticateUser, async (c) => {
  try {
    const u = await db.queryOne('SELECT id, username, plan, points, status FROM users WHERE id = ?', [c.get('user').id]);
    if (!u) return c.json({ success: false, loggedIn: false });
    u.points = Math.round(Number(u.points) * 100) / 100;
    return c.json({ success: true, loggedIn: true, user: { id: u.id, username: u.username, plan: u.plan, points: u.points, status: u.status } });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/logout', authenticateUser, async (c) => {
  try { await db.regenerateApiToken(c.get('user').id); } catch (e) {}
  destroySession(c);
  return c.json({ success: true, message: '已退出登录' });
});
app.all('/api/token', authenticateUser, async (c) => {
  try {
    const body = await jb(c);
    const regen = (c.req.query('regen') === '1') || body.regen;
    const token = regen ? await db.regenerateApiToken(c.get('user').id) : await db.ensureApiToken(c.get('user').id);
    return c.json({ success: true, token });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});

app.get('/api/points/plan', async (c) => {
  try { return c.json({ success: true, enabled: await db.getPointsPlanEnabled() }); }
  catch (e) { return c.json({ success: true, enabled: true }); }
});
app.post('/api/points/plan', async (c) => {
  try { const body = await jb(c); const enabled = await db.setPointsPlanEnabled(body.enabled); return c.json({ success: true, enabled }); }
  catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/points/settle', async (c) => {
  try {
    const b = await jb(c);
    const r = await db.settleDailyMinimum(b.day || null, b.userId || null);
    return c.json({ success: true, day: r.day, dailyMin: r.dailyMin, processed: r.processed, totalCharged: r.totalCharged, details: r.details });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/points/deduct', authenticateUser, async (c) => {
  try {
    const body = await jb(c);
    const userId = c.get('user').id;
    const accountId = body.accountId;
    let points = Number(body.points);
    if (!userId) return c.json({ success: false, message: 'userId 不能为空' });
    if (accountId == null || accountId === '') return c.json({ success: false, message: 'accountId 不能为空' });
    if (body.minutes != null && body.minutes !== '') {
      const minutes = Number(body.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return c.json({ success: false, message: '使用时长 minutes 必须为正数' });
      const rate = (await db.getBillingConfig()).enabledRatePerHour || 1;
      points = Math.round((minutes / 60) * rate * 100) / 100;
    }
    points = Math.round(points * 100) / 100;
    if (!Number.isFinite(points) || points <= 0) return c.json({ success: false, message: '扣除点数必须为正数' });
    const u = await db.queryOne('SELECT id, points FROM users WHERE id = ?', [userId]);
    if (!u) return c.json({ success: false, message: '用户不存在' });
    const acc = await db.query('SELECT acc_id FROM accounts WHERE (id = ? OR acc_id = ?) AND user_id = ?', [accountId, String(accountId), userId]);
    if (!acc.length) return c.json({ success: false, message: '账号不属于该用户', code: 'ACCOUNT_MISMATCH' });
    const accountUuid = acc[0].acc_id;
    const current = Number(u.points);
    const deducted = points > current ? current : points;
    const remaining = Math.max(current - points, 0);
    await db.run('UPDATE users SET points = MAX(points - ?, 0) WHERE id = ?', [points, userId]);
    const cur = (await db.queryOne("SELECT date('now') AS d")).d;
    await db.logDeduction(userId, accountUuid, deducted, 'usage', cur, remaining);
    return c.json({
      success: true, userId: Number(userId), accountId: accountUuid,
      deducted: Math.round(deducted * 100) / 100, remainingPoints: Math.round(remaining * 100) / 100, insufficient: points > current
    });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.get('/api/points/records', authenticateUser, async (c) => {
  try {
    const userId = c.get('user').id;
    const type = c.req.query('type');
    if (type && type !== 'usage' && type !== 'daily_min' && type !== 'checkin') return c.json({ success: false, message: 'type 仅支持 usage / daily_min / checkin' });
    const page = c.req.query('page') ? parseInt(c.req.query('page'), 10) : 1;
    const pageSize = c.req.query('pageSize') ? parseInt(c.req.query('pageSize'), 10) : 20;
    const data = await db.getPointsLog(userId, { type, page, pageSize });
    return c.json({ success: true, userId, page: Math.max(1, page || 1), pageSize: Math.min(200, Math.max(1, pageSize || 20)), total: data.total, records: data.records });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/points/start', authenticateUser, async (c) => {
  try {
    const userId = c.get('user').id;
    const u = await db.queryOne('SELECT id, tool_started_at FROM users WHERE id = ?', [userId]);
    if (!u) return c.json({ success: false, message: '用户不存在' });
    if (u.tool_started_at) return c.json({ success: true, alreadyRunning: true, running: true, message: '工具已在运行' });
    await db.settleUserPoints(userId);
    await db.run("UPDATE users SET tool_started_at = datetime('now'), billed_hours = 0, last_settled_at = datetime('now') WHERE id = ?", [userId]);
    await db.run("INSERT OR IGNORE INTO tool_run_days (user_id, day) VALUES (?, date('now'))", [userId]);
    const cfg = await db.getBillingConfig();
    const dailyMin = await db.getDailyMinimum();
    return c.json({ success: true, running: true, ratePerHour: cfg.enabledRatePerHour, message: '工具已启动，运行期间按 ' + cfg.enabledRatePerHour + ' 点/小时计费；每日最低消费 ' + dailyMin + ' 点/天' });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.post('/api/points/stop', authenticateUser, async (c) => {
  try {
    const userId = c.get('user').id;
    const u = await db.queryOne('SELECT id, tool_started_at FROM users WHERE id = ?', [userId]);
    if (!u) return c.json({ success: false, message: '用户不存在' });
    if (!u.tool_started_at) return c.json({ success: true, alreadyStopped: true, running: false, message: '工具未在运行' });
    await db.settleUserPoints(userId);
    await db.run("UPDATE users SET tool_started_at = NULL, billed_hours = 0, last_settled_at = datetime('now') WHERE id = ?", [userId]);
    const cfg = await db.getBillingConfig();
    const dailyMin = await db.getDailyMinimum();
    return c.json({ success: true, running: false, ratePerHour: cfg.enabledRatePerHour, message: '工具已停止。计费规则：运行 ' + cfg.enabledRatePerHour + ' 点/小时，每日最低消费 ' + dailyMin + ' 点/天' });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});

// ---------- 每日签到（前台页面 + 工具端通用，带 token 鉴权 + 响应签名） ----------
// 状态：GET /api/checkin
app.get('/api/checkin', authenticateUser, async (c) => {
  try {
    return signedJson(c, Object.assign({ success: true }, await db.getCheckinStatus(c.get('user').id)));
  } catch (e) { return signedJson(c, { success: false, message: '服务器错误' }, 500); }
});
// 签到：POST /api/checkin
app.post('/api/checkin', authenticateUser, async (c) => {
  try {
    const r = await db.doCheckin(c.get('user').id);
    if (!r.ok) {
      return signedJson(c, { success: false, code: r.code, message: r.message }, r.code === 'DISABLED' ? 403 : 400);
    }
    return signedJson(c, Object.assign({ success: true, message: '签到成功，获得 ' + r.reward + ' 点数' }, r));
  } catch (e) { return signedJson(c, { success: false, message: '服务器错误' }, 500); }
});

// ---------- 开放 API：文件传输（工具端，带 token 鉴权 + 响应签名） ----------
// 上传：multipart/form-data（file 字段）或 JSON { name, mime, dataBase64 }
app.post('/api/files/upload', authenticateUser, async (c) => {
  try {
    const userId = c.get('user').id;
    const ctype = c.req.header('content-type') || '';
    let name = '', mime = '', bytes = null;
    if (/multipart\/form-data/i.test(ctype)) {
      const form = await c.req.parseBody();
      const f = form.file || Object.values(form).find(v => v && typeof v === 'object' && 'arrayBuffer' in v);
      if (!f) return signedJson(c, { success: false, message: '缺少 file 字段' }, 400);
      name = f.name || 'file.bin';
      mime = f.type || '';
      bytes = new Uint8Array(await f.arrayBuffer());
    } else {
      const b = await jb(c);
      name = b.name || 'file.bin';
      mime = b.mime || '';
      if (!b.dataBase64) return signedJson(c, { success: false, message: '缺少 dataBase64 字段（或改用 multipart/form-data 上传 file 字段）' }, 400);
      const bin = atob(String(b.dataBase64).replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    if (bytes.byteLength > files.MAX_FILE_SIZE) {
      return signedJson(c, { success: false, message: '文件过大，单文件上限 ' + Math.floor(files.MAX_FILE_SIZE / 1024 / 1024) + 'MB' }, 413);
    }
    const saved = await files.saveFile(userId, name, bytes, mime);
    return signedJson(c, { success: true, message: '上传成功', file: saved });
  } catch (e) {
    return signedJson(c, { success: false, message: '服务器错误' }, 500);
  }
});

// 列表：GET /api/files?page=1&pageSize=50
app.get('/api/files', authenticateUser, async (c) => {
  try {
    const page = parseInt(c.req.query('page')) || 1;
    const pageSize = parseInt(c.req.query('pageSize')) || 50;
    const r = await files.listFiles(c.get('user').id, page, pageSize);
    return signedJson(c, Object.assign({ success: true }, r));
  } catch (e) { return signedJson(c, { success: false, message: '服务器错误' }, 500); }
});

// 下载：GET /api/files/:id（二进制；响应头带 X-File-Sha256 供完整性校验）
app.get('/api/files/:id', authenticateUser, async (c) => {
  try {
    const r = await files.readFileBytes(c.req.param('id'), c.get('user').id);
    if (!r) return signedJson(c, { success: false, message: '文件不存在' }, 404);
    c.header('Content-Type', r.meta.mime || 'application/octet-stream');
    c.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(r.meta.name));
    c.header('X-File-Id', String(r.meta.id));
    c.header('X-File-Name', encodeURIComponent(r.meta.name));
    c.header('X-File-Size', String(r.meta.size));
    c.header('X-File-Sha256', String(r.meta.sha256));
    c.header('X-Sign-Alg', 'HMAC-SHA256');
    return c.body(r.bytes, 200);
  } catch (e) { return signedJson(c, { success: false, message: '服务器错误' }, 500); }
});

// 删除：DELETE /api/files/:id
app.delete('/api/files/:id', authenticateUser, async (c) => {
  try {
    const ok = await files.deleteFile(c.req.param('id'), c.get('user').id);
    if (!ok) return signedJson(c, { success: false, message: '文件不存在' }, 404);
    return signedJson(c, { success: true, message: '删除成功' });
  } catch (e) { return signedJson(c, { success: false, message: '服务器错误' }, 500); }
});

// 未匹配路由回退到首页（与原 404 渲染 index 行为一致）
app.notFound((c) => render(c, 'index'));

export { app };
