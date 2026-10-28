var express = require('express');
var router = express.Router();
var crypto = require('crypto');
var { requireAuth } = require('../middleware/auth');
var {
  getDashboardStats, getUsersPage, addUser, updateUser, deleteUser, applyAdminPointsChange,
  getPricingCards, getBillingConfig, savePricingCards, saveBillingConfig,
  getAdminByUsername, updateAdminPassword, getAllPointsLog, getAllRechargeLog
} = require('../db');

function hashPwd(p) { return crypto.createHash('sha256').update(String(p)).digest('hex'); }

// ---------- 前台页面路由 ----------
router.get('/', function (req, res) { res.render('index'); });
router.get('/features', function (req, res) { res.render('features'); });
router.get('/download', function (req, res) { res.render('download'); });
router.get('/manual', function (req, res) { res.render('manual'); });
router.get('/faq', function (req, res) { res.render('faq'); });
router.get('/login', function (req, res) { res.render('login'); });
router.get('/pricing', async function (req, res) {
  try {
    var pricing = await getPricingCards();
    var billing = await getBillingConfig();
    res.render('pricing', { billing: billing, pricing: pricing });
  } catch (e) {
    console.error('[pricing]', e);
    res.render('pricing', { billing: { enabledRatePerHour: 1, disabledRatePerDay: 24, dailyMinimum: 12 }, pricing: {} });
  }
});

// ---------- 后台管理路由 ----------
// 登录页
router.get('/admin/login', function (req, res) {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

router.post('/admin/login', async function (req, res) {
  try {
    var username = req.body.username, password = req.body.password;
    var admin = await getAdminByUsername(username);
    if (!admin) {
      return res.render('admin/login', { error: '账号或密码错误' });
    }
    var hash = hashPwd(password);
    if (admin.password === hash) {
      req.session.admin = username;
      return res.redirect('/admin');
    }
    // 兼容旧的明文密码存储：明文匹配则自动升级为 sha256
    if (admin.password === password) {
      await updateAdminPassword(username, hash);
      req.session.admin = username;
      return res.redirect('/admin');
    }
    res.render('admin/login', { error: '账号或密码错误' });
  } catch (e) {
    console.error('[admin login]', e);
    res.render('admin/login', { error: '服务器错误' });
  }
});

router.get('/admin/logout', function (req, res) {
  req.session.destroy();
  res.redirect('/admin/login');
});

// 后台首页（仪表盘）
router.get('/admin', requireAuth, async function (req, res) {
  try {
    var stats = await getDashboardStats();
    res.render('admin/dashboard', Object.assign({ admin: req.session.admin }, stats));
  } catch (e) {
    console.error('[admin dashboard]', e);
    res.render('admin/dashboard', {
      admin: req.session.admin, totalUsers: 0, activeUsers: 0, totalPoints: 0, vipCount: 0, recentUsers: []
    });
  }
});

// 用户管理（分页：每页 10 条）
router.get('/admin/users', requireAuth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var r = await getUsersPage(page, 10);
    res.render('admin/users', Object.assign({ admin: req.session.admin }, r));
  } catch (e) {
    console.error('[admin users]', e);
    res.render('admin/users', { admin: req.session.admin, users: [], page: 1, totalPages: 1, total: 0 });
  }
});

// 添加用户
router.post('/admin/users/add', requireAuth, async function (req, res) {
  try {
    await addUser({
      username: req.body.username,
      gameRole: req.body.gameRole,
      plan: req.body.plan,
      points: req.body.points,
      status: req.body.status
    });
  } catch (e) {
    console.error('[add user]', e);
  }
  res.redirect('/admin/users');
});

// 删除用户
router.post('/admin/users/delete/:id', requireAuth, async function (req, res) {
  try {
    await deleteUser(req.params.id);
  } catch (e) {
    console.error('[delete user]', e);
  }
  res.redirect('/admin/users');
});

// 更新用户（点数 / 套餐 / 状态 / 游戏角色）
router.post('/admin/users/update/:id', requireAuth, async function (req, res) {
  try {
    // 修改点数：按新旧差额生成充值/调整记录（amount 有符号）
    if (req.body.points !== undefined && req.body.points !== '') {
      await applyAdminPointsChange(req.params.id, req.body.points, req.session.admin, '后台调整');
    }
    await updateUser(req.params.id, {
      plan: req.body.plan,
      status: req.body.status,
      gameRole: req.body.gameRole
    });
  } catch (e) {
    console.error('[update user]', e);
  }
  res.redirect('/admin/users');
});

// 扣费流水（后台，可按 用户/类型/日期 筛选，每页 20 条）
router.get('/admin/logs', requireAuth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var r = await getAllPointsLog({
      userId: req.query.userId,
      type: req.query.type,
      day: req.query.day,
      page: page,
      pageSize: 20
    });
    var totalPages = Math.ceil(r.total / 20) || 1;
    res.render('admin/logs', {
      admin: req.session.admin,
      filter: { userId: req.query.userId || '', type: req.query.type || '', day: req.query.day || '' },
      records: r.records,
      total: r.total,
      page: page,
      totalPages: totalPages
    });
  } catch (e) {
    console.error('[admin logs]', e);
    res.render('admin/logs', { admin: req.session.admin, filter: { userId: '', type: '', day: '' }, records: [], total: 0, page: 1, totalPages: 1 });
  }
});

// 充值记录（后台，可按 用户/日期 筛选，每页 20 条）
router.get('/admin/recharge', requireAuth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var r = await getAllRechargeLog({
      userId: req.query.userId,
      day: req.query.day,
      page: page,
      pageSize: 20
    });
    var totalPages = Math.ceil(r.total / 20) || 1;
    res.render('admin/recharge', {
      admin: req.session.admin,
      filter: { userId: req.query.userId || '', day: req.query.day || '' },
      records: r.records,
      total: r.total,
      page: page,
      totalPages: totalPages
    });
  } catch (e) {
    console.error('[admin recharge]', e);
    res.render('admin/recharge', { admin: req.session.admin, filter: { userId: '', day: '' }, records: [], total: 0, page: 1, totalPages: 1 });
  }
});

// 收费规则配置
router.get('/admin/pricing', requireAuth, async function (req, res) {
  try {
    var pricing = await getPricingCards();
    var billing = await getBillingConfig();
    res.render('admin/pricing', { admin: req.session.admin, pricing: pricing, billing: billing, saved: !!req.query.saved });
  } catch (e) {
    console.error('[admin pricing]', e);
    res.render('admin/pricing', { admin: req.session.admin, pricing: {}, billing: { enabledRatePerHour: 1, disabledRatePerDay: 24, dailyMinimum: 12 }, saved: false });
  }
});

// 保存收费规则
router.post('/admin/pricing/save', requireAuth, async function (req, res) {
  try {
    var b = req.body;
    await savePricingCards({
      monthlyCard: { name: '月卡', price: b.m_price, points: b.m_points, days: b.m_days, save: b.m_save },
      quarterlyCard: { name: '季卡', price: b.q_price, points: b.q_points, days: b.q_days, save: b.q_save },
      halfYearCard: { name: '半年卡', price: b.h_price, points: b.h_points, days: b.h_days, save: b.h_save },
      yearlyCard: { name: '年卡', price: b.y_price, points: b.y_points, days: b.y_days, save: b.y_save }
    });
    await saveBillingConfig({
      enabledRatePerHour: b.enabled_rate,
      disabledRatePerDay: b.disabled_rate,
      dailyMinimum: b.daily_minimum
    });
    res.redirect('/admin/pricing?saved=1');
  } catch (e) {
    console.error('[save pricing]', e);
    res.redirect('/admin/pricing');
  }
});

// 修改管理员密码
router.get('/admin/settings', requireAuth, function (req, res) {
  res.render('admin/settings', { admin: req.session.admin, error: null, success: null });
});

router.post('/admin/settings', requireAuth, async function (req, res) {
  try {
    var oldPassword = req.body.oldPassword, newPassword = req.body.newPassword;
    var admin = await getAdminByUsername(req.session.admin);
    if (!admin) {
      return res.render('admin/settings', { admin: req.session.admin, error: '管理员不存在', success: null });
    }
    var hash = hashPwd(newPassword);
    // 原密码校验（兼容明文 / sha256 两种存储）
    if (admin.password !== hashPwd(oldPassword) && admin.password !== oldPassword) {
      return res.render('admin/settings', { admin: req.session.admin, error: '原密码错误', success: null });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.render('admin/settings', { admin: req.session.admin, error: '新密码至少6位', success: null });
    }
    await updateAdminPassword(req.session.admin, hash);
    res.render('admin/settings', { admin: req.session.admin, error: null, success: '密码修改成功' });
  } catch (e) {
    console.error('[admin settings]', e);
    res.render('admin/settings', { admin: req.session.admin, error: '服务器错误', success: null });
  }
});

module.exports = router;
