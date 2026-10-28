var express = require('express');
var router = express.Router();
var { pool, toAccount, resolveGameBenefit, getBillingConfig } = require('../db');
var { requireAuth } = require('../middleware/auth');

// 后台账号管理页面（分页：每页 10 条）
router.get('/admin/accounts', requireAuth, async function (req, res) {
  try {
    var pageSize = 10;
    var totalRow = await pool.query('SELECT COUNT(*) AS c FROM accounts');
    var total = totalRow[0].c;
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    var page = parseInt(req.query.page) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    var offset = (page - 1) * pageSize;
    var accounts = await pool.query(
      'SELECT a.*, u.username AS owner FROM accounts a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.id LIMIT ? OFFSET ?',
      [pageSize, offset]
    );
    var users = await pool.query('SELECT id, username FROM users ORDER BY id');
    res.render('admin/accounts', { admin: req.session.admin, accounts: accounts, users: users, page: page, totalPages: totalPages, total: total });
  } catch (e) {
    console.error('[admin/accounts]', e);
    res.render('admin/accounts', { admin: req.session.admin, accounts: [], users: [], page: 1, totalPages: 1, total: 0 });
  }
});

// 账号列表
/**
 * @openapi
 * /api/accounts:
 *   get:
 *     tags: [账号管理]
 *     summary: 游戏账号列表
 *     description: 返回全部游戏账号；可传 userId 只返回某用户的账号。本接口只读当前余额与运行状态，不触发结算扣费（登录 / 取账号不扣点）
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema: { type: integer }
 *         description: 用户ID，过滤只返回该用户的账号
 *     responses:
 *       200:
 *         description: 账号数组
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, description: '是否成功' }
 *                 data: { type: array, description: '游戏账号数组（见 Account）', items: { $ref: '#/components/schemas/Account' } }
 *                 userPoints: { type: number, description: '该用户当前剩余积分（整数，传 userId 时返回）' }
 *                 defaultAccountId: { type: string, description: '该用户默认账号 acc_id（传 userId 时返回）' }
 *                 toolRunning: { type: boolean, description: '工具是否正在运行（传 userId 时返回，true=工具运行中，按每小时点数计费）' }
 *                 toolEnabled: { type: boolean, description: '同 toolRunning，历史兼容字段（传 userId 时返回）' }
 *                 ratePerHour: { type: number, description: '当前计费费率（点/小时，传 userId 时返回；运行或未运行均为每小时点数）' }
 */
router.get('/api/accounts', async function (req, res) {
  try {
    var userId = req.query.userId;
    if (userId) {
      // 取账号不再触发结算扣费（登录不扣点）；直接读取当前点数与运行状态
      var rows = await pool.query('SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [userId]);
      var u = await pool.query('SELECT points, default_account_id, tool_started_at FROM users WHERE id = ?', [userId]);
      var running = u.length && !!u[0].tool_started_at;
      var cfg = await getBillingConfig();
      res.json({
        success: true,
        data: rows.map(toAccount),
        userPoints: u.length ? Math.round(Number(u[0].points)) : null,
        defaultAccountId: u.length ? u[0].default_account_id : '',
        toolRunning: running,
        toolEnabled: running,
        ratePerHour: running ? cfg.enabledRatePerHour : (cfg.disabledRatePerDay / 24)
      });
      return;
    }
    var all = await pool.query('SELECT * FROM accounts ORDER BY id');
    res.json({ success: true, data: all.map(toAccount) });
  } catch (e) {
    console.error('[accounts GET]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 创建账号
/**
 * @openapi
 * /api/accounts:
 *   post:
 *     tags: [账号管理]
 *     summary: 新建游戏账号
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, name]
 *             properties:
 *               userId: { type: integer, example: 1, description: '所属用户ID（users.id）' }
 *               id: { type: string, example: acc-7, description: '游戏账号ID（acc_id）；不传则自动用 profileDir 或 acc-<自增id>' }
 *               name: { type: string, example: 逍遥浮尘, description: '游戏角色名（必填）' }
 *               uid: { type: string, example: '12554951429915', description: '游戏UID（用于防薅去重）' }
 *               serverId: { type: string, example: '4018', description: '区服ID（uid+区服 唯一标识一个游戏账号）' }
 *               profileDir: { type: string, example: acc-1, description: '配置目录（缺省则用 acc-<id>）' }
 *               lastLoginAt: { type: integer, example: 1790389116315, description: '最后登录时间（毫秒时间戳）' }
 *               serverInfoToken: { type: string, description: '服务器信息token' }
 *               tokenExpireAt: { type: integer, example: 1790391695893000, description: 'token过期时间（毫秒时间戳）' }
 *               avatar: { type: string, description: '头像URL' }
 *               qqAccessToken: { type: string, description: 'QQ登录access token' }
 *               qqOpenid: { type: string, description: 'QQ openid' }
 *               status: { type: string, example: 正常, description: '账号状态（正常/已封禁/已过期）' }
 *     responses:
 *       200:
 *         description: 创建结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.post('/api/accounts', async function (req, res) {
  try {
    var body = req.body;
    var id = body.id || '';
    var userId = body.userId, name = body.name;
    var uid = body.uid || '', serverId = body.serverId || '', profileDir = body.profileDir || '';
    var lastLoginAt = body.lastLoginAt || 0, serverInfoToken = body.serverInfoToken || '', tokenExpireAt = body.tokenExpireAt || 0, avatar = body.avatar || '';
    var qqAccessToken = body.qqAccessToken || '', qqOpenid = body.qqOpenid || '', status = body.status || '正常';
    if (!userId || !name) {
      return res.json({ success: false, message: 'userId 和 name(角色名)不能为空' });
    }
    var result = await pool.query(
      'INSERT INTO accounts (user_id, name, uid, server_id, last_login_at, server_info_token, token_expire_at, avatar, qq_access_token, qq_openid, status, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())',
      [userId, name, uid, serverId, lastLoginAt, serverInfoToken, tokenExpireAt, avatar, qqAccessToken, qqOpenid, status]
    );
    var newId = result.insertId;
    var accId = id || profileDir || ('acc-' + newId);
    var profileDirVal = profileDir || id || accId;
    await pool.query('UPDATE accounts SET acc_id = ?, profile_dir = ? WHERE id = ?', [accId, profileDirVal, newId]);

    // 默认账号：该用户首个游戏账号即设为默认账号（积分跟随默认账号）
    var du = await pool.query('SELECT default_account_id FROM users WHERE id = ?', [userId]);
    if (!du.length || !du[0].default_account_id) {
      await pool.query('UPDATE users SET default_account_id = ? WHERE id = ?', [accId, userId]);
    }

    // 防薅羊毛：同一 (uid, server_id) 仅首次绑定可领奖励
    var benefit = await resolveGameBenefit(uid, serverId, accId);

    var message = (benefit.tracked && !benefit.firstBind)
      ? '创建成功（该游戏账号此前已绑定过，属于重复绑定，不发放首绑奖励）'
      : '创建成功';
    res.json({
      success: true,
      id: accId,
      firstBind: benefit.firstBind,
      benefitEligible: benefit.firstBind,
      tracked: benefit.tracked,
      message: message
    });
  } catch (e) {
    console.error('[accounts POST]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 更新账号（id 为 acc_id 或数字 id）
/**
 * @openapi
 * /api/accounts/{id}:
 *   put:
 *     tags: [账号管理]
 *     summary: 更新游戏账号
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: acc_id（如 acc-1）或数字 id
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, description: '游戏角色名' }
 *               uid: { type: string, description: '游戏UID' }
 *               serverId: { type: string, description: '区服ID' }
 *               profileDir: { type: string, description: '配置目录' }
 *               lastLoginAt: { type: integer, description: '最后登录时间（毫秒时间戳）' }
 *               serverInfoToken: { type: string, description: '服务器信息token' }
 *               tokenExpireAt: { type: integer, description: 'token过期时间（毫秒时间戳）' }
 *               avatar: { type: string, description: '头像URL' }
 *               qqAccessToken: { type: string, description: 'QQ登录access token' }
 *               qqOpenid: { type: string, description: 'QQ openid' }
 *               status: { type: string, description: '账号状态（正常/已封禁/已过期）' }
 *     responses:
 *       200:
 *         description: 更新结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.put('/api/accounts/:id', async function (req, res) {
  try {
    var id = req.params.id;
    var fields = [
      ['name', 'name'], ['uid', 'uid'], ['serverId', 'server_id'],
      ['profileDir', 'profile_dir'], ['lastLoginAt', 'last_login_at'],
      ['serverInfoToken', 'server_info_token'], ['tokenExpireAt', 'token_expire_at'],
      ['avatar', 'avatar'], ['qqAccessToken', 'qq_access_token'],
      ['qqOpenid', 'qq_openid'], ['status', 'status']
    ];
    var sets = [], params = [];
    for (var i = 0; i < fields.length; i++) {
      var bodyKey = fields[i][0], col = fields[i][1];
      if (req.body[bodyKey] !== undefined) { sets.push(col + ' = ?'); params.push(req.body[bodyKey]); }
    }
    if (!sets.length) return res.json({ success: false, message: '没有可更新字段' });
    var whereSql, whereParams;
    if (/^\d+$/.test(id)) { whereSql = 'id = ?'; whereParams = [Number(id)]; }
    else { whereSql = 'acc_id = ?'; whereParams = [id]; }
    var r = await pool.query('UPDATE accounts SET ' + sets.join(', ') + ' WHERE ' + whereSql, params.concat(whereParams));
    if (r.affectedRows === 0) return res.json({ success: false, message: '账号不存在' });
    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    console.error('[accounts PUT]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 删除账号
/**
 * @openapi
 * /api/accounts/{id}:
 *   delete:
 *     tags: [账号管理]
 *     summary: 删除游戏账号（按账号主键删除对应的一条）
 *     description: >
 *       按账号主键 id（或 acc_id）定位到唯一一条记录后删除，仅删除对应的那一条。
 *       当两个用户绑定了相同的游戏账号（相同 uid + 区服）时，删除其中一个用户的账号不会误删另一个用户的记录。
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: acc_id（如 acc-1）或数字 id
 *     responses:
 *       200:
 *         description: 删除结果
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiResult' }
 */
router.delete('/api/accounts/:id', async function (req, res) {
  try {
    var id = req.params.id;
    var whereSql, whereParams;
    if (/^\d+$/.test(id)) { whereSql = 'id = ?'; whereParams = [Number(id)]; }
    else { whereSql = 'acc_id = ?'; whereParams = [id]; }
    var delRows = await pool.query('SELECT id, acc_id, user_id FROM accounts WHERE ' + whereSql, whereParams);
    if (!delRows.length) return res.json({ success: false, message: '账号不存在' });
    var del = delRows[0];
    // 仅按主键 id 删除「对应的那一条」，避免 acc_id 冲突时误删其他用户绑定了相同账号的记录
    await pool.query('DELETE FROM accounts WHERE id = ?', [del.id]);

    // 若删除的是默认账号，则将该用户剩余账号中最早的一个设为新默认（无则清空）
    if (del.acc_id && del.user_id) {
      var u = await pool.query('SELECT default_account_id FROM users WHERE id = ?', [del.user_id]);
      if (u.length && u[0].default_account_id === del.acc_id) {
        var remain = await pool.query(
          'SELECT acc_id FROM accounts WHERE user_id = ? ORDER BY id ASC LIMIT 1', [del.user_id]
        );
        await pool.query('UPDATE users SET default_account_id = ? WHERE id = ?',
          [remain.length ? remain[0].acc_id : '', del.user_id]);
      }
    }
    res.json({ success: true, message: '删除成功' });
  } catch (e) {
    console.error('[accounts DELETE]', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

module.exports = router;
