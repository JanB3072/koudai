require('dotenv').config();
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');

var indexRouter = require('./routes/index');
var accountsRouter = require('./routes/accounts');
var apiRouter = require('./routes/api');
var { swaggerUi, specs } = require('./swagger');
var { fmtDateTime, fmtDate } = require('./db');

var app = express();

// 模板全局时间格式化辅助：DATE -> YYYY-MM-DD，DATETIME/毫秒时间戳 -> YYYY-MM-DD HH:mm:ss（按服务器本地时区，即中国时区）
app.locals.fmtDateTime = fmtDateTime;
app.locals.fmtDate = fmtDate;

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// 部署在反向代理（nginx 等）后，信任 X-Forwarded-* 头，使 secure cookie / 客户端 IP 正确
app.set('trust proxy', 1);
var SESSION_SECRET = process.env.SESSION_SECRET || 'koudai-guanjia-secret-2026';
var NODE_ENV = process.env.NODE_ENV || 'development';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    // 生产环境走 https 时启用 secure cookie（仅在代理透传 https 时生效）
    secure: NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// 跨域（CORS）中间件
app.use(function (req, res, next) {
  var origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Swagger 接口文档（访问 /api-docs）
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

app.use('/', indexRouter);
app.use('/', accountsRouter);
app.use('/', apiRouter);

// 404 处理
app.use(function (req, res, next) {
  res.status(404).render('index');
});

// error handler
app.use(function (err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
