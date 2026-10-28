// 后台鉴权中间件：未登录则跳转到登录页
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

module.exports = { requireAuth };
