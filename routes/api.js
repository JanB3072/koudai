var express = require('express');
var router = express.Router();
var crypto = require('crypto');
var { pool, settleUserPoints, getPointsPlanEnabled, setPointsPlanEnabled, getBillingConfig, logDeduction, settleDailyMinimum, getDailyMinimum, getPointsLog, ensureApiToken, getUserByToken, regenerateApiToken } = require('../db');

function hashPwd(p) {
  return crypto.createHash('sha256').update(String(p)).digest('hex');
}

// 会员鉴权中间件：支持①浏览器 cookie session（req.session.user）②外部工具 Bearer 令牌。
// 令牌来源优先级：Authorization: Bearer <token> > ?token= > body.token。
// 通过后在 req.user 上挂载 { id, username, plan, status }，供后续接口使用（以令牌/会话用户为准）。
async function authenticateUser(req, res, next) {
  if (req.session && req.session.user) {
    req.user = req.session.user;
    return next();
  }
  var token = '';
  var auth = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(auth)) {
    token = auth.replace(/^Bearer\s+/i, '').trim();
  } else if (req.query && req.query.token) {
    token = String(req.query.token);
  } else if (req.body && req.body.token) {
    token = String(req.body.token);
  }
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证令牌（请在 Authorization 头携带 Bearer <token>）' });
  }
  try {
    var u = await getUserByToken(token);
    if (!u) return res.status(401).json({ success: false, message: '令牌无效或已失效' });
    if (u.status === '已过期') return res.status(403).json({ success: false, message: '账号已过期，请联系管理员' });
    req.user = { id: u.id, username: u.username, plan: u.plan, status: u.status };
    next();
  } catch (e) {
    console.error('[auth]', e);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
}

// 注册
/**
 * @openapi
 * /api/register:
 *   post:
 *     tags: [认证]
 *     summary: 用户注册
 *     description: 仅用账号和密码注册会员，会员方案默认为高级版；inviteCode 为可选邀请码（非必填）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: apitester, description: '用户名' }
 *               password: { type: string, example: koudai123, description: '登录密码（明文，服务端 sha256 存储）' }
 *               inviteCode: { type: string, example: '', description: '邀请码（非必填，注册时记录）' }
 *     responses:
 *       200:
 *         description: 注册结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.post('/api/register', async function (req, res) {
  try {
    var username = req.body.username, password = req.body.password, inviteCode = req.body.inviteCode;
    if (!username || !password) {
      return res.json({ success: false, message: '用户名和密码不能为空' });
    }
    var exist = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (exist.length) {
      return res.json({ success: false, message: '用户名已存在' });
    }
    var code = (inviteCode && String(inviteCode).trim()) || null;
    await pool.query(
      'INSERT INTO users (username, password, plan, points, status, invite_code, created_at) ' +
      "VALUES (?, ?, '高级版', 600, '正常', ?, CURDATE())",
      [username, hashPwd(password), code]
    );
    res.json({ success: true, message: '注册成功', points: 600, inviteCode: code });
  } catch (e) {
    console.error('[register]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 登录
/**
 * @openapi
 * /api/login:
 *   post:
 *     tags: [认证]
 *     summary: 用户登录
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: apitester, description: '用户名' }
 *               password: { type: string, example: koudai123, description: '登录密码' }
 *     responses:
 *       200:
 *         description: 登录成功返回用户信息（注意：登录不扣积分；返回的 user.points 为实际小数余额，保留 2 位）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true, description: '是否成功' }
 *                 message: { type: string, example: 登录成功, description: '提示信息' }
 *                 user: { $ref: '#/components/schemas/User' }
 */
router.post('/api/login', async function (req, res) {
  try {
    var username = req.body.username, password = req.body.password;
    if (!username || !password) {
      return res.json({ success: false, message: '用户名和密码不能为空' });
    }
    var rows = await pool.query(
      'SELECT id, username, plan, points, status FROM users WHERE username = ? AND password = ?',
      [username, hashPwd(password)]
    );
    if (!rows.length) {
      return res.json({ success: false, message: '用户名或密码错误' });
    }
    var u = rows[0];
    if (u.status === '已过期') {
      return res.json({ success: false, message: '账号已过期，请联系管理员' });
    }
    req.session.user = { id: u.id, username: u.username };
    // 生成/获取该会员的 API 令牌（供外部工具通过 Bearer 调用，替代 cookie）
    var token = await ensureApiToken(u.id);
    // points 数据库为 DECIMAL（按小时精确计费），返回实际小数余额（保留 2 位），不再取整，避免账本对不上
    u.points = Math.round(Number(u.points) * 100) / 100;
    res.json({ success: true, message: '登录成功', token: token, user: u });
  } catch (e) {
    console.error('[login]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 当前登录用户
/**
 * @openapi
 * /api/me:
 *   get:
 *     tags: [认证]
 *     summary: 获取当前登录用户
 *     description: '需要 Bearer 令牌鉴权，请求头携带 Authorization 头（格式为 Bearer 加空格加 token），token 来自 /api/login 或 /api/token。'
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: 当前会话用户（未带有效凭证时 loggedIn=false）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, description: '是否成功' }
 *                 loggedIn: { type: boolean, description: '是否已登录' }
 *                 user: { $ref: '#/components/schemas/User' }
 */
router.get('/api/me', authenticateUser, async function (req, res) {
  try {
    var u = await pool.query('SELECT id, username, plan, points, status FROM users WHERE id = ?', [req.user.id]);
    if (!u.length) return res.json({ success: false, loggedIn: false });
    var user = u[0];
    user.points = Math.round(Number(user.points) * 100) / 100;
    res.json({
      success: true,
      loggedIn: true,
      user: { id: user.id, username: user.username, plan: user.plan, points: user.points, status: user.status }
    });
  } catch (e) {
    console.error('[me]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 退出登录
/**
 * @openapi
 * /api/logout:
 *   post:
 *     tags: [认证]
 *     summary: 退出登录
 *     description: 需要 Bearer 令牌鉴权。退出时会重置该会员的 API 令牌，旧 token 立即失效（工具需重新登录获取新 token）。
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: 退出结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.post('/api/logout', authenticateUser, async function (req, res) {
  try {
    // 退出时轮换（重置）令牌，使当前及任何已分发的旧 token 立即失效，避免被继续调用
    await regenerateApiToken(req.user.id);
  } catch (e) {
    console.error('[logout] regen token', e);
  }
  req.session.destroy();
  res.json({ success: true, message: '已退出登录' });
});

// 获取 / 重置会员 API 令牌（需先登录：浏览器 session 或已有令牌）。
// GET  ?regen=1 重置令牌（旧令牌立即失效）；POST 同理（body.regen=true）。
// 返回 { success, token }；工具用此令牌在后续请求携带 Authorization: Bearer <token>。
/**
 * @openapi
 * /api/token:
 *   get:
 *     tags: [认证]
 *     summary: 获取（或重置）会员 API 令牌
 *     description: 需要 Bearer 令牌鉴权。加 ?regen=1（或 POST body.regen=true）重置令牌，旧令牌立即失效。
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: regen
 *         schema: { type: string, example: '1' }
 *         description: 传 1 表示重置令牌
 *     responses:
 *       200:
 *         description: 返回令牌
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 token: { type: string, example: 'b2281d361b72a9d36b0c174de64e49034989398bc0c51c36', description: '48 位十六进制令牌' }
 */
router.all('/api/token', authenticateUser, async function (req, res) {
  try {
    var regen = (req.query && req.query.regen === '1') || (req.body && req.body.regen);
    var token = regen ? await regenerateApiToken(req.user.id) : await ensureApiToken(req.user.id);
    res.json({ success: true, token: token });
  } catch (e) {
    console.error('[token]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// ---------- 扣费计划接口 ----------
/**
 * @openapi
 * /api/points/plan:
 *   get:
 *     tags: [积分扣费]
 *     summary: 查询扣费计划开关
 *     responses:
 *       200:
 *         description: 开关状态
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PointsPlan' }
 */
router.get('/api/points/plan', async function (req, res) {
  try {
    var enabled = await getPointsPlanEnabled();
    res.json({ success: true, enabled: enabled });
  } catch (e) {
    console.error('[points plan]', e);
    res.json({ success: true, enabled: true });
  }
});

/**
 * @openapi
 * /api/points/plan:
 *   post:
 *     tags: [积分扣费]
 *     summary: 设置扣费计划开关
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean, example: true, description: '是否启用按时间结算扣分' }
 *     responses:
 *       200:
 *         description: 更新后的开关
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PointsPlan' }
 */
router.post('/api/points/plan', async function (req, res) {
  try {
    var enabled = await setPointsPlanEnabled(req.body && req.body.enabled);
    res.json({ success: true, enabled: enabled });
  } catch (e) {
    console.error('[points plan set]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

/**
 * @openapi
 * /api/points/settle:
 *   post:
 *     tags: [积分扣费]
 *     summary: 每日最低消费结算（所有用户每天必扣 dailyMin 点）
 *     description: >
 *       按天结算「每日最低消费」：对 day（默认昨天，今天尚未结束不提前结算）每个用户，
 *       统计当天已扣总额（工具上报 usage + 此前补足 daily_min）；若不足 dailyMin（默认 8），
 *       则补足差额并写 daily_min 流水。所有用户每天必扣 dailyMin（含零上报用户直接扣 dailyMin）。
 *       幂等：已补足的日期不会重复扣。建议由定时任务（cron）每天调用一次。
 *       传 { userId } 仅结算该用户；传 { day } 指定结算日期（YYYY-MM-DD）。
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId: { type: integer, example: 12, description: '指定用户；不传则结算全体' }
 *               day: { type: string, example: '2026-10-13', description: '结算日期(YYYY-MM-DD)；不传默认昨天' }
 *     responses:
 *       200:
 *         description: 结算结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SettleResult' }
 */
router.post('/api/points/settle', async function (req, res) {
  try {
    var userId = req.body && req.body.userId;
    var day = req.body && req.body.day;
    var r = await settleDailyMinimum(day || null, userId || null);
    res.json({ success: true, day: r.day, dailyMin: r.dailyMin, processed: r.processed, totalCharged: r.totalCharged, details: r.details });
  } catch (e) {
    console.error('[points settle]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 工具上报扣费：由工具主动上报扣减（携带 accountId / userId / points）
// 服务端只做扣减与账号归属校验，不再按时间自动计算（避免与工具上报重复计费）
/**
 * @openapi
 * /api/points/deduct:
 *   post:
 *     tags: [积分扣费]
 *     summary: 工具上报扣费（usage，按分钟计算点数）
 *     description: >
 *       鉴权：需携带会员 API 令牌（Authorization: Bearer <token>，由登录或 GET /api/token 获取；也可用 ?token= 或 body.token）。
 *       工具运行期间主动上报扣减。点数计算保留 2 位小数：每小时 1 点，即每分钟 1/60 点
 *       （每分钟扣除点数 = 每小时费率 / 60）。推荐直接传 minutes（使用时长，分钟），服务端据此计算
 *       points = round(minutes / 60 × 每小时费率, 2)；也可直接传 points（同样保留 2 位小数）。
 *       服务端校验 accountId 必须属于该 userId，校验通过后将 points 从用户余额扣除（余额不足则扣到 0），
 *       不再做按时间的自动计费；每次上报都会写入 points_log 流水（type=usage），供每日最低结算按天累计。
 *       返回剩余点数（DECIMAL(10,2)，保留 2 位小数）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, accountId]
 *             properties:
 *               userId: { type: integer, example: 1, description: '用户ID（users.id）' }
 *               accountId: { type: string, example: 'acc-1', description: '游戏账号ID（acc_id 或数字 id），必须属于该用户' }
 *               minutes: { type: number, example: 36, description: '使用时长（分钟）。传入则覆盖 points，按 1/60 点/分钟（×每小时费率）计算' }
 *               points: { type: number, example: 0.6, description: '本次扣除点数（正数，保留2位小数）；若同时传 minutes 则以 minutes 计算为准' }
 *     responses:
 *       200:
 *         description: 扣减结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/DeductResult' }
 */
router.post('/api/points/deduct', authenticateUser, async function (req, res) {
  try {
    var body = req.body || {};
    var userId = req.user.id; // 以令牌/会话用户为准，忽略 body.userId，避免越权扣他人
    var accountId = body.accountId;
    var points = Number(body.points);
    if (!userId) return res.json({ success: false, message: 'userId 不能为空' });
    if (accountId == null || accountId === '') return res.json({ success: false, message: 'accountId 不能为空' });
    // 优先按使用时长（分钟）计算：每分钟 = 每小时费率 / 60，结果保留 2 位小数（覆盖直接传入的 points）
    if (body.minutes != null && body.minutes !== '') {
      var minutes = Number(body.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return res.json({ success: false, message: '使用时长 minutes 必须为正数' });
      var rate = (await getBillingConfig()).enabledRatePerHour || 1;
      points = Math.round((minutes / 60) * rate * 100) / 100;
    }
    points = Math.round(points * 100) / 100; // 无论来源，最终扣除点数统一保留 2 位小数
    if (!Number.isFinite(points) || points <= 0) return res.json({ success: false, message: '扣除点数必须为正数' });

    var u = await pool.query('SELECT id, points FROM users WHERE id = ?', [userId]);
    if (!u.length) return res.json({ success: false, message: '用户不存在' });

    // 校验账号归属：账号（acc_id 或数字 id）必须属于该用户，否则拒绝扣费
    var acc = await pool.query(
      'SELECT acc_id FROM accounts WHERE (id = ? OR acc_id = ?) AND user_id = ?',
      [accountId, String(accountId), userId]
    );
    if (!acc.length) {
      return res.json({ success: false, message: '账号不属于该用户', code: 'ACCOUNT_MISMATCH' });
    }
    var accountUuid = acc[0].acc_id; // 统一以账号配置UUID(acc_id)记录，保证流水一致可关联

    var current = Number(u[0].points);
    var deducted = points > current ? current : points; // 实际扣除（余额不足时只扣到 0）
    var remaining = Math.max(current - points, 0);
    await pool.query('UPDATE users SET points = GREATEST(points - ?, 0) WHERE id = ?', [points, userId]);
    var cur = (await pool.query('SELECT CURDATE() AS d'))[0].d;
    await logDeduction(userId, accountUuid, deducted, 'usage', cur, remaining); // 记录扣费流水（account_id 统一为 acc_id UUID）
    res.json({
      success: true,
      userId: Number(userId),
      accountId: accountUuid,
      deducted: Math.round(deducted * 100) / 100,
      remainingPoints: Math.round(remaining * 100) / 100,
      insufficient: points > current
    });
  } catch (e) {
    console.error('[points deduct]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 查询某用户扣费流水（供后台/客户端查看）
/**
 * @openapi
 * /api/points/records:
 *   get:
 *     tags: [积分扣费]
 *     summary: 查询扣费流水（分页）
 *     description: >
 *       分页列出某用户的扣费流水（points_log）。type=usage 为工具上报扣减，type=daily_min 为每日最低消费补足。
 *       按记录倒序返回（最新在前）。
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema: { type: integer, example: 1 }
 *         description: 用户ID
 *       - in: query
 *         name: type
 *         required: false
 *         schema: { type: string, enum: [usage, daily_min], example: usage }
 *         description: 流水类型过滤（不传则返回全部）
 *       - in: query
 *         name: page
 *         required: false
 *         schema: { type: integer, example: 1 }
 *         description: 页码（从 1 开始，默认 1）
 *       - in: query
 *         name: pageSize
 *         required: false
 *         schema: { type: integer, example: 20 }
 *         description: 每页条数（1~200，默认 20）
 *     responses:
 *       200:
 *         description: 扣费流水列表
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PointsLogResult' }
 */
router.get('/api/points/records', authenticateUser, async function (req, res) {
  try {
    var userId = req.user.id; // 以令牌/会话用户为准，只看自己的流水
    var type = req.query.type;
    if (type && type !== 'usage' && type !== 'daily_min') {
      return res.json({ success: false, message: 'type 仅支持 usage / daily_min' });
    }
    var page = req.query.page ? parseInt(req.query.page, 10) : 1;
    var pageSize = req.query.pageSize ? parseInt(req.query.pageSize, 10) : 20;
    var data = await getPointsLog(userId, { type: type, page: page, pageSize: pageSize });
    res.json({
      success: true,
      userId: userId,
      page: Math.max(1, page || 1),
      pageSize: Math.min(200, Math.max(1, pageSize || 20)),
      total: data.total,
      records: data.records
    });
  } catch (e) {
    console.error('[points records]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 启动工具：开始按 10 点/小时计费
/**
 * @openapi
 * /api/points/start:
 *   post:
 *     tags: [积分扣费]
 *     summary: 启动工具（标记运行中，仅作状态；计费由工具上报扣减）
 *     description: >
 *       仅标记该用户「工具运行中」（写入 tool_started_at），供客户端展示运行状态，服务端不再按时间计费。
 *       实际扣费模型：工具运行期间按 1 点/小时，由工具通过 POST /api/points/deduct 主动上报扣减；
 *       服务端每日通过 POST /api/points/settle 结算「每日最低消费」（默认 12 点/天，所有用户必扣）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: integer, example: 1, description: '用户ID（启动该用户的工具计费）' }
 *     responses:
 *       200:
 *         description: 启动结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.post('/api/points/start', authenticateUser, async function (req, res) {
  try {
    var userId = req.user.id; // 以令牌/会话用户为准
    if (!userId) return res.json({ success: false, message: 'userId 不能为空' });
    var u = await pool.query('SELECT id, tool_started_at FROM users WHERE id = ?', [userId]);
    if (!u.length) return res.json({ success: false, message: '用户不存在' });
    if (u[0].tool_started_at) {
      return res.json({ success: true, alreadyRunning: true, running: true, message: '工具已在运行' });
    }
    await settleUserPoints(userId); // 刷新运行状态（结算已改为工具上报）
    await pool.query('UPDATE users SET tool_started_at = NOW(), billed_hours = 0, last_settled_at = NOW() WHERE id = ?', [userId]);
    await pool.query('INSERT IGNORE INTO tool_run_days (user_id, day) VALUES (?, CURDATE())', [userId]); // 标记当天启动过（保留历史字段）
    var cfg = await getBillingConfig();
    var dailyMin = await getDailyMinimum();
    res.json({ success: true, running: true, ratePerHour: cfg.enabledRatePerHour, message: '工具已启动，运行期间按 ' + cfg.enabledRatePerHour + ' 点/小时计费；每日最低消费 ' + dailyMin + ' 点/天' });
  } catch (e) {
    console.error('[points start]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 停止工具：仅清除运行中状态（计费由工具上报 + 每日最低结算）
/**
 * @openapi
 * /api/points/stop:
 *   post:
 *     tags: [积分扣费]
 *     summary: 停止工具（清除运行中状态，仅作状态；不影响已发生扣费）
 *     description: >
 *       仅清除该用户「工具运行中」状态（tool_started_at 置空），供客户端展示；不影响已通过
 *       POST /api/points/deduct 上报的扣费，也不影响每日最低消费结算（POST /api/points/settle）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: integer, example: 1, description: '用户ID（停止该用户的工具计费）' }
 *     responses:
 *       200:
 *         description: 停止结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.post('/api/points/stop', authenticateUser, async function (req, res) {
  try {
    var userId = req.user.id; // 以令牌/会话用户为准
    if (!userId) return res.json({ success: false, message: 'userId 不能为空' });
    var u = await pool.query('SELECT id, tool_started_at FROM users WHERE id = ?', [userId]);
    if (!u.length) return res.json({ success: false, message: '用户不存在' });
    if (!u[0].tool_started_at) {
      return res.json({ success: true, alreadyStopped: true, running: false, message: '工具未在运行' });
    }
    await settleUserPoints(userId); // 刷新状态（结算已改为工具上报）
    await pool.query("UPDATE users SET tool_started_at = NULL, billed_hours = 0, last_settled_at = NOW() WHERE id = ?", [userId]);
    var cfg = await getBillingConfig();
    var dailyMin = await getDailyMinimum();
    res.json({ success: true, running: false, ratePerHour: cfg.enabledRatePerHour, message: '工具已停止。计费规则：运行 ' + cfg.enabledRatePerHour + ' 点/小时，每日最低消费 ' + dailyMin + ' 点/天' });
  } catch (e) {
    console.error('[points stop]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

module.exports = router;
