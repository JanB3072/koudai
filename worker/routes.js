// 全部路由（前台页面 + 后台管理 + 开放 API），由 Hono 实现，运行于 Cloudflare Workers。
import { Hono } from 'hono';
import * as db from './db.js';
import { sha256, hmacSha256Hex, randomTokenHex, fmtDateTime, round2 } from './util.js';
import * as files from './files.js';
import * as clientRes from './clientResources.js';
import * as pkg from './packages.js';
import { getSession, saveSession, destroySession } from './session.js';
import { render } from './render.js';

const app = new Hono();

// 邀请一位新用户注册成功后，奖励邀请人的点数
const INVITE_REWARD_POINTS = 600;

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

// 安装包下载鉴权：超管(会话) / 普通用户(会话) / 工具(Bearer token) 均可，未登录跳转登录页
async function requireDownload(c, next) {
  const s = c.get('session') || {};
  if (s.admin || s.user) {
    c.set('user', s.user || { id: 0, username: s.admin, role: s.role || 'admin' });
    return next();
  }
  // 工具端用 Bearer token；浏览器（无 Authorization 头）走会话/跳转登录页
  const auth = c.req.header('authorization') || '';
  const isBearer = /^Bearer\s+/i.test(auth);
  const token = isBearer ? auth.replace(/^Bearer\s+/i, '').trim() : (c.req.query('token') || '');
  if (!token) {
    return isBearer ? c.json({ success: false, message: '未授权，请先登录' }, 401) : c.redirect('/login');
  }
  try {
    const u = await db.getUserByToken(token);
    if (!u) return isBearer ? c.json({ success: false, message: 'token 无效或已过期' }, 401) : c.redirect('/login');
    if (u.status === '已过期') return isBearer ? c.json({ success: false, message: '账号已过期，请联系管理员' }, 403) : c.redirect('/login');
    c.set('user', { id: u.id, username: u.username, plan: u.plan, status: u.status });
    return next();
  } catch (e) {
    return isBearer ? c.json({ success: false, message: '服务器错误' }, 500) : c.redirect('/login');
  }
}

// ---------- 前台页面 ----------
app.get('/', (c) => render(c, 'index', { inviteReward: INVITE_REWARD_POINTS }));
app.get('/features', (c) => render(c, 'features'));
app.get('/download', async (c) => {
  try {
    const version = await clientRes.getClientVersion();
    const resources = await clientRes.listResources(); // 仅 .exe 资源
    // 取上传时间最新的一份 exe 作为下载目标（与数据库最新版本保持一致）
    const latest = resources
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
    return render(c, 'download', {
      version,
      exe: latest
        ? { name: latest.name, url: '/api/client/resource/' + encodeURIComponent(latest.name), size: latest.size }
        : null
    });
  } catch (e) {
    return render(c, 'download', { version: '0', exe: null });
  }
});
app.get('/manual', (c) => render(c, 'manual'));
app.get('/faq', (c) => render(c, 'faq'));
app.get('/login', (c) => render(c, 'login'));
app.get('/checkin', (c) => render(c, 'checkin', { inviteReward: INVITE_REWARD_POINTS }));
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
    const q = c.req.query();
    const page = parseInt(q.page) || 1;
    const r = await db.getAllRechargeLog({ userId: q.userId, day: q.day, page, pageSize: 20 });
    const totalPages = Math.ceil(r.total / 20) || 1;
    const users = await db.listAllUsers();
    const msgMap = { done: '充值成功，点数已累加至用户账户' };
    const errMap = {
      userempty: '请选择用户',
      amount: '充值点数必须为正数',
      usernotfound: '未找到该用户',
      INVALID_AMOUNT: '充值点数必须为正数',
      USER_NOT_FOUND: '未找到该用户'
    };
    return render(c, 'admin/recharge', {
      admin: c.get('session').admin,
      filter: { userId: q.userId || '', day: q.day || '' },
      users,
      records: r.records, total: r.total, page, totalPages,
      msg: msgMap[q.done] !== undefined ? msgMap[q.done] : null,
      error: errMap[q.doerror] !== undefined ? errMap[q.doerror] : (q.doerror || null)
    });
  } catch (e) {
    return render(c, 'admin/recharge', { admin: c.get('session').admin, filter: { userId: '', day: '' }, users: [], records: [], total: 0, page: 1, totalPages: 1, msg: null, error: null });
  }
});
// 充值操作：选择用户（ID 或用户名），点数累加到现有余额
app.post('/admin/recharge/do', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    const raw = String(b.user || b.userId || '').trim();
    const amount = round2(b.amount);
    if (!raw) return c.redirect('/admin/recharge?doerror=userempty');
    if (!(amount > 0)) return c.redirect('/admin/recharge?doerror=amount');
    const found = /^\d+$/.test(raw)
      ? await db.query('SELECT id FROM users WHERE id = ?', [Number(raw)])
      : await db.query('SELECT id FROM users WHERE username = ?', [raw]);
    if (!found.length) return c.redirect('/admin/recharge?doerror=usernotfound');
    await db.rechargeUser(found[0].id, amount, c.get('session').admin, b.note || '');
    return c.redirect('/admin/recharge?done=1');
  } catch (e) {
    const m = String((e && e.message) || e);
    const code = /INVALID_AMOUNT/.test(m) ? 'INVALID_AMOUNT' : /USER_NOT_FOUND/.test(m) ? 'USER_NOT_FOUND' : 'usernotfound';
    return c.redirect('/admin/recharge?doerror=' + code);
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
        userPoints: u ? round2(u.points) : null,
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
    let accId, benefit;
    // 允许同一游戏账号被多个用户各自绑定。仅当同一用户重复绑定同一游戏账号时，更新原有记录，避免产生重复行
    if (uid && serverId) {
      const exist = await db.queryOne('SELECT id, acc_id, user_id FROM accounts WHERE uid = ? AND server_id = ? AND user_id = ? LIMIT 1', [uid, serverId, userId]);
      if (exist) {
        accId = exist.acc_id || ('acc-' + exist.id);
        await db.run(
          'UPDATE accounts SET name = ?, profile_dir = ?, last_login_at = ?, server_info_token = ?, token_expire_at = ?, avatar = ?, qq_access_token = ?, qq_openid = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
          [name, profileDir || accId, lastLoginAt, serverInfoToken, tokenExpireAt, avatar, qqAccessToken, qqOpenid, status, exist.id]
        );
        benefit = await db.resolveGameBenefit(uid, serverId, accId);
        return c.json({ success: true, id: accId, firstBind: benefit.isNew, benefitEligible: benefit.isNew, tracked: benefit.tracked, giftPoints: 0, message: '更新成功（同一账号重复绑定，已更新原记录）' });
      }
    }
    // 全新游戏账号：新建唯一记录，并在首次绑定时发放赠送积分
    const newId = await db.insert(
      "INSERT INTO accounts (user_id, name, uid, server_id, last_login_at, server_info_token, token_expire_at, avatar, qq_access_token, qq_openid, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'))",
      [userId, name, uid, serverId, lastLoginAt, serverInfoToken, tokenExpireAt, avatar, qqAccessToken, qqOpenid, status]
    );
    accId = id || profileDir || ('acc-' + newId);
    const profileDirVal = profileDir || id || accId;
    await db.run('UPDATE accounts SET acc_id = ?, profile_dir = ? WHERE id = ?', [accId, profileDirVal, newId]);
    const du = await db.queryOne('SELECT default_account_id FROM users WHERE id = ?', [userId]);
    if (!du || !du.default_account_id) await db.run('UPDATE users SET default_account_id = ? WHERE id = ?', [accId, userId]);
    benefit = await db.resolveGameBenefit(uid, serverId, accId);
    // 防薅羊毛：赠送积分只在「该游戏账号首次被绑定」时发放；已被其他用户绑定过的账号不再赠送
    let giftPoints = 0;
    if (benefit.isNew) {
      giftPoints = 600;
      await db.run('UPDATE users SET points = points + ? WHERE id = ?', [giftPoints, userId]);
    }
    const message = benefit.isNew
      ? ('创建成功，已发放该游戏账号首绑赠送积分 ' + giftPoints + ' 点')
      : '创建成功（该游戏账号此前已被绑定过，不重复发放赠送积分）';
    return c.json({ success: true, id: accId, firstBind: benefit.isNew, benefitEligible: benefit.isNew, tracked: benefit.tracked, giftPoints, message });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.put('/api/accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await jb(c);
    const fields = [
      ['name', 'name'], ['uid', 'uid'], ['serverId', 'server_id'], ['profileDir', 'profile_dir'],
      ['lastLoginAt', 'last_login_at'], ['serverInfoToken', 'server_info_token'], ['tokenExpireAt', 'token_expire_at'],
      ['avatar', 'avatar'], ['qqAccessToken', 'qq_access_token'], ['qqOpenid', 'qq_openid'], ['status', 'status']
    ];
    const sets = [], params = [];
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
    // 为新用户生成专属邀请码（用于他之后去邀请别人）
    const myCode = await db.genInviteCode();
    // 解析「邀请人」：根据填写的邀请码找到对应的老用户
    let invitedBy = null;
    if (inviteCode && String(inviteCode).trim()) {
      const inviter = await db.getUserByInviteCode(inviteCode);
      if (inviter) invitedBy = inviter.id;
    }
    await db.run(
      "INSERT INTO users (username, password, plan, points, status, invite_code, invited_by, created_at) VALUES (?, ?, '高级版', 0, '正常', ?, ?, date('now'))",
      [username, await sha256(password), myCode, invitedBy]
    );
    const newId = (await db.query('SELECT last_insert_rowid() AS id'))[0].id;
    // 若带有效邀请码，给邀请人发放奖励点数
    if (invitedBy && newId) {
      await db.rewardInviter(invitedBy, newId, INVITE_REWARD_POINTS);
    }
    return c.json({ success: true, message: '注册成功', points: 0, inviteCode: myCode });
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
    u.points = round2(u.points);
    return c.json({ success: true, message: '登录成功', token, user: u });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
app.get('/api/me', authenticateUser, async (c) => {
  try {
    const u = await db.queryOne('SELECT id, username, plan, points, status, invite_code FROM users WHERE id = ?', [c.get('user').id]);
    if (!u) return c.json({ success: false, loggedIn: false });
    u.points = round2(u.points);
    const inviteCode = u.invite_code || '';
    let origin = '';
    try { origin = new URL(c.req.url).origin; } catch (e) {}
    const inviteLink = inviteCode && origin ? origin + '/login?invite=' + encodeURIComponent(inviteCode) : '';
    return c.json({ success: true, loggedIn: true, user: { id: u.id, username: u.username, plan: u.plan, points: u.points, status: u.status, inviteCode, inviteLink } });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }); }
});
// 前台「我的邀请」页：展示并复制自己的邀请链接
app.get('/invite', async (c) => render(c, 'invite', { inviteReward: INVITE_REWARD_POINTS }));
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
      points = round2((minutes / 60) * rate);
    }
    points = round2(points);
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
      deducted: round2(deducted), remainingPoints: round2(remaining), insufficient: points > current
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
    const out = Object.assign({}, r, { files: (r.files || []).map(f => Object.assign({}, f, { created_at: fmtDateTime(f.created_at) })) });
    return signedJson(c, out);
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

// ---------- 客户端版本管理（工具端拉取资源） ----------
// 版本检查：GET /api/version（公开，工具端启动先读取版本号）
app.get('/api/version', async (c) => {
  try {
    const version = await clientRes.getClientVersion();
    const resources = await clientRes.listResources();
    return c.json({
      success: true,
      version,
      // 顶层 updatedAt 取「所有资源里更新时间最新」的那一次，而不是 ORDER BY name 的第一条，
      // 否则再上传其它资源时版本更新时间不会变化
      updatedAt: resources.length
        ? fmtDateTime(resources.reduce((m, r) => (String(r.updatedAt || '') > String(m) ? r.updatedAt : m), ''))
        : null,
      resources: resources.map((r) => ({
        name: r.name,
        url: '/api/client/resource/' + encodeURIComponent(r.name),
        sha256: r.sha256,
        size: r.size,
        updatedAt: fmtDateTime(r.updatedAt)
      }))
    });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }, 500); }
});

// 版本对比：GET /api/version/check?current=<本地版本号>（公开）。
// 直接返回 upToDate（与服务器最新版是否一致）、latest（服务器最新版）、hasNewer（是否有更新），以及可下载的 exe 资源列表。
app.get('/api/version/check', async (c) => {
  try {
    const current = String(c.req.query('current') || '').trim();
    const version = await clientRes.getClientVersion();
    const resources = await clientRes.listResources();
    const cmp = (a, b) => {
      const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
      const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
      const n = Math.max(pa.length, pb.length);
      for (let i = 0; i < n; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    };
    return c.json({
      success: true,
      current,
      latest: version,
      upToDate: current !== '' && current === version,
      hasNewer: current !== '' && cmp(current, version) < 0,
      resources: resources.map((r) => ({
        name: r.name,
        sha256: r.sha256,
        size: r.size,
        updatedAt: fmtDateTime(r.updatedAt),
        url: '/api/client/resource/' + encodeURIComponent(r.name)
      }))
    });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }, 500); }
});

// 资源下载：GET /api/client/resource/:name（二进制；响应头带 X-File-Sha256 供完整性校验）
app.get('/api/client/resource/:name', async (c) => {
  try {
    const r = await clientRes.getResourceMeta(c.req.param('name'));
    if (!r) return c.json({ success: false, message: '资源不存在' }, 404);
    // 记录下载次数（后台统计）；先计数再返回二进制流
    await clientRes.recordDownload(r.name);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(r.name));
    c.header('X-File-Name', encodeURIComponent(r.name));
    c.header('X-File-Size', String(r.size));
    c.header('X-File-Sha256', String(r.sha256));
    return c.body(clientRes.streamResource(r.name), 200);
  } catch (e) { return c.json({ success: false, message: '服务器错误' }, 500); }
});

// ---------- 后台：客户端资源管理（requireAuth） ----------
app.get('/admin/client', requireAuth, async (c) => {
  try {
    const version = await clientRes.getClientVersion();
    const resources = await clientRes.listResources();
    const totalDownloads = resources.reduce((s, r) => s + (r.downloads || 0), 0);
    const topResource = resources.slice().sort((a, b) => (b.downloads || 0) - (a.downloads || 0))[0] || null;
    const q = c.req.query();
    const msg = q.uploaded ? ('已上传 ' + q.uploaded + ' 个文件')
      : q.version ? ('版本已更新为 ' + q.version)
      : q.deleted ? '已删除资源'
      : null;
    const errMap = {
      missing: '请选择要上传的文件',
      badversion: '请填写合法的版本号（如 1.0.1），版本号需与本次发布绑定',
      exeonly: '客户端资源仅支持 .exe 文件；脚本 / ZIP 包请到「安装包管理」上传',
      empty: '文件内容为空',
      toolarge: '文件超过 20MB 上限，请压缩后再上传',
      dberror: '写入数据库失败，请重试；若持续失败请联系管理员',
      unknown: '上传失败，请重试'
    };
    return render(c, 'admin/client', {
      admin: c.get('session').admin,
      version, resources, totalDownloads, topResource,
      msg,
      error: errMap[q.error] !== undefined ? errMap[q.error] : (q.error || null)
    });
  } catch (e) {
    return render(c, 'admin/client', { admin: c.get('session').admin, version: '0', resources: [], msg: null, error: '服务器错误' });
  }
});

app.post('/admin/client/resource', requireAuth, async (c) => {
  try {
    const form = await c.req.parseBody({ all: true });
    // 版本号与本次发布绑定：上传即发布，必须填写版本号
    const version = String(form.version || '').trim();
    if (!/^\d+(\.\d+){0,3}$/.test(version)) return c.redirect('/admin/client?error=badversion');
    const uploaded = Array.isArray(form.file) ? form.file : (form.file ? [form.file] : []);
    if (!uploaded.length) return c.redirect('/admin/client?error=missing');
    // 客户端资源只接收 Windows 安装程序（.exe）
    for (const f of uploaded) {
      if (!/\.exe$/i.test(String(f.name || ''))) return c.redirect('/admin/client?error=exeonly');
    }
    for (const f of uploaded) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      await clientRes.saveResource(f.name, bytes);
    }
    // 上传成功即对外发布该版本号，避免文件更新了但版本号仍停留在旧值
    await clientRes.setClientVersion(version);
    return c.redirect('/admin/client?uploaded=' + uploaded.length + '&version=' + encodeURIComponent(version));
  } catch (e) {
    const m = String((e && e.message) || e);
    const code = /EMPTY_FILE/.test(m) ? 'empty'
      : /FILE_TOO_LARGE/.test(m) ? 'toolarge'
      : /D1_ERROR|SQLITE/i.test(m) ? 'dberror'
      : 'unknown';
    return c.redirect('/admin/client?error=' + encodeURIComponent(code));
  }
});

app.post('/admin/client/resource/delete', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    if (b.name) await clientRes.deleteResource(b.name);
    return c.redirect('/admin/client?deleted=1');
  } catch (e) { return c.redirect('/admin/client'); }
});

// ---------- 后台：版本安装包管理（仅超管 requireAuth） ----------
const PKG_MAX = 20 * 1024 * 1024; // 单包上限 20MB（D1 分块存储）
// 安装包管理 = 脚本 / ZIP 类资源包；exe 客户端程序归「客户端资源」
const PKG_EXT = ['zip', 'war', 'jar', 'tar', 'gz', 'tgz', '7z', 'rar', 'z', 'xz', 'bz2', 'sh', 'py', 'bat', 'cmd', 'ps1', 'js', 'json', 'txt', 'xml', 'html', 'css'];
function pkgExt(name) { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }

app.get('/admin/packages', requireAuth, async (c) => {
  try {
    const packages = await pkg.listPackages();
    const totalDownloads = packages.reduce((s, r) => s + (Number(r.downloads) || 0), 0);
    const topPackage = packages.slice().sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0))[0] || null;
    const q = c.req.query();
    return render(c, 'admin/packages', {
      admin: c.get('session').admin,
      packages, totalDownloads, topPackage,
      msg: q.uploaded ? '上传成功' : q.deleted ? '已删除' : null,
      error: q.error || null
    });
  } catch (e) {
    return render(c, 'admin/packages', { admin: c.get('session').admin, packages: [], msg: null, error: '服务器错误' });
  }
});

app.post('/admin/packages/upload', requireAuth, async (c) => {
  try {
    const form = await c.req.parseBody();
    const f = form.file;
    if (!f || typeof f === 'string' || typeof f.arrayBuffer !== 'function') return c.redirect('/admin/packages?error=nofile');
    const name = f.name || 'package.bin';
    if (!PKG_EXT.includes(pkgExt(name))) return c.redirect('/admin/packages?error=ext');
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!bytes.byteLength) return c.redirect('/admin/packages?error=empty');
    if (bytes.byteLength > PKG_MAX) return c.redirect('/admin/packages?error=size');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = pkg.newKey();
    await pkg.savePackageBytes(key, bytes);
    const b = await fb(c);
    await pkg.savePackage({ pkgKey: key, name, version: b.version || '', size: bytes.byteLength, sha256: sha, uploadedBy: c.get('session').admin });
    return c.redirect('/admin/packages?uploaded=1');
  } catch (e) {
    return c.redirect('/admin/packages?error=' + encodeURIComponent(String((e && e.message) || e)));
  }
});

app.post('/admin/packages/delete', requireAuth, async (c) => {
  try {
    const b = await fb(c);
    const meta = await pkg.getPackageByKey(b.key);
    if (meta) {
      await pkg.deletePackageByKey(meta.pkg_key);
    }
    return c.redirect('/admin/packages?deleted=1');
  } catch (e) { return c.redirect('/admin/packages'); }
});

// 工具/登录用户：列出可用安装包
app.get('/api/packages', requireDownload, async (c) => {
  try {
    const packages = await pkg.listPackages();
    return c.json({
      success: true,
      packages: packages.map((p) => ({
        key: p.pkg_key,
        name: p.name,
        version: p.version,
        size: p.size,
        sha256: p.sha256,
        createdAt: fmtDateTime(p.created_at),
        url: '/pkg/' + encodeURIComponent(p.pkg_key)
      }))
    });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }, 500); }
});

// 统一同步检查：返回资源包与安装包清单（含 sha256 与上传时间），供桌面工具判断本地是否最新
// 鉴权同 /api/packages（登录会话或 Bearer token）。返回时间均为 D1 存储的 UTC 时间字符串。
app.get('/api/sync', requireDownload, async (c) => {
  try {
    const version = await clientRes.getClientVersion();
    const resources = await clientRes.listResources();
    const packages = await pkg.listPackages();
    return c.json({
      success: true,
      serverTime: new Date().toISOString(),
      clientVersion: version,
      resources: resources.map((r) => ({
        name: r.name,
        sha256: r.sha256,
        size: r.size,
        updatedAt: fmtDateTime(r.updatedAt),
        url: '/api/client/resource/' + encodeURIComponent(r.name)
      })),
      packages: packages.map((p) => ({
        key: p.pkg_key,
        name: p.name,
        version: p.version,
        sha256: p.sha256,
        size: p.size,
        createdAt: fmtDateTime(p.created_at),
        uploadedBy: p.uploaded_by,
        url: '/pkg/' + encodeURIComponent(p.pkg_key)
      }))
    });
  } catch (e) { return c.json({ success: false, message: '服务器错误' }, 500); }
});

// 下载安装包（需登录）：/pkg/:id，id 即 pkg_key（后台上传的版本安装压缩包/脚本）
app.get('/pkg/:id', requireDownload, async (c) => {
  try {
    const id = c.req.param('id');
    const meta = await pkg.getPackageByKey(id);
    if (!meta) return c.json({ success: false, message: '安装包不存在' }, 404);
    // 记录下载次数（后台统计）；先计数再返回二进制流
    await pkg.recordDownload(id);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(meta.name));
    c.header('X-File-Size', String(meta.size));
    c.header('X-File-Sha256', String(meta.sha256));
    return c.body(pkg.streamPackageBytes(meta.pkg_key), 200);
  } catch (e) { return c.json({ success: false, message: '服务器错误' }, 500); }
});

// 未匹配路由回退到首页（与原 404 渲染 index 行为一致）
app.notFound((c) => render(c, 'index', { inviteReward: INVITE_REWARD_POINTS }));

export { app };
