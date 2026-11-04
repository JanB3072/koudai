-- 口袋助手 D1(SQLite) 初始化迁移
-- 由 Cloudflare 全免费方案替代原 MySQL 的 ensureSchema 自动建表逻辑
-- 执行：wrangler d1 migrations apply koudai --local  (或 --remote)

PRAGMA foreign_keys = ON;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL DEFAULT '',
  game_role VARCHAR(100) NOT NULL DEFAULT '',
  plan VARCHAR(20) NOT NULL DEFAULT '高级版',
  points DECIMAL(10,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT '正常',
  created_at DATE NOT NULL DEFAULT (date('now')),
  billed_hours INT NOT NULL DEFAULT 0,
  last_daily_settled_date DATE NOT NULL DEFAULT '2000-01-01',
  default_account_id VARCHAR(255) NOT NULL DEFAULT '',
  last_settled_at DATETIME NOT NULL DEFAULT (datetime('now')),
  tool_started_at DATETIME NULL DEFAULT NULL,
  invite_code VARCHAR(64) NULL DEFAULT NULL,
  api_token VARCHAR(64) NULL DEFAULT NULL,
  UNIQUE (api_token)
);

-- 游戏账号表
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INT NOT NULL,
  acc_id VARCHAR(255) NOT NULL DEFAULT '',
  profile_dir VARCHAR(255) NOT NULL DEFAULT '',
  uid VARCHAR(255) NOT NULL DEFAULT '',
  name VARCHAR(100) NOT NULL DEFAULT '',
  server_id VARCHAR(255) NOT NULL DEFAULT '',
  last_login_at BIGINT NOT NULL DEFAULT 0,
  server_info_token TEXT,
  token_expire_at BIGINT NOT NULL DEFAULT 0,
  avatar VARCHAR(1024) NOT NULL DEFAULT '',
  qq_access_token VARCHAR(255) NOT NULL DEFAULT '',
  qq_openid VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT '正常',
  created_at DATE NOT NULL DEFAULT (date('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 游戏账号首绑奖励去重表
CREATE TABLE IF NOT EXISTS game_account_benefits (
  uid VARCHAR(255) NOT NULL DEFAULT '',
  server_id VARCHAR(255) NOT NULL DEFAULT '',
  claimed_at DATETIME NOT NULL DEFAULT (datetime('now')),
  first_account_id VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (uid, server_id)
);

-- 每日最低消费：记录用户每天是否启动过工具
CREATE TABLE IF NOT EXISTS tool_run_days (
  user_id INT NOT NULL,
  day DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- 点数扣费流水
CREATE TABLE IF NOT EXISTS points_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INT NOT NULL,
  account_id VARCHAR(255) NOT NULL DEFAULT '',
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  type VARCHAR(20) NOT NULL DEFAULT 'usage',
  added_points DECIMAL(10,2) NOT NULL DEFAULT 0,
  deducted_points DECIMAL(10,2) NOT NULL DEFAULT 0,
  remaining_points DECIMAL(10,2) NOT NULL DEFAULT 0,
  day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- 充值/调整记录
CREATE TABLE IF NOT EXISTS recharge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  added_points DECIMAL(10,2) NOT NULL DEFAULT 0,
  deducted_points DECIMAL(10,2) NOT NULL DEFAULT 0,
  remaining_points DECIMAL(10,2) NOT NULL DEFAULT 0,
  admin VARCHAR(50) NOT NULL DEFAULT '',
  note VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- 后台管理员
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- 充值套餐定价
CREATE TABLE IF NOT EXISTS pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_key VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(20) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  points INT NOT NULL,
  days DECIMAL(10,1) NOT NULL,
  save DECIMAL(10,2) NOT NULL DEFAULT 0
);

-- 会员方案
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  rate_per_hour DECIMAL(5,2) NOT NULL,
  desc VARCHAR(255) NOT NULL DEFAULT ''
);

-- 系统设置键值对
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(50) NOT NULL PRIMARY KEY,
  value VARCHAR(255) NOT NULL DEFAULT ''
);

-- 索引（SQLite 不支持在 CREATE TABLE 内联 INDEX，需独立建）
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_pl_user_day ON points_log(user_id, day);
CREATE INDEX IF NOT EXISTS idx_pl_day ON points_log(day);
CREATE INDEX IF NOT EXISTS idx_rl_user ON recharge_log(user_id);
CREATE INDEX IF NOT EXISTS idx_rl_created ON recharge_log(created_at);

-- ---------- 种子数据 ----------
INSERT OR IGNORE INTO admin (username, password) VALUES ('admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'); -- 默认 admin / admin123

INSERT OR IGNORE INTO pricing (card_key, name, price, points, days, save) VALUES
  ('monthlyCard', '月卡', 58, 720, 30, 26),
  ('quarterlyCard', '季卡', 148, 2160, 90, 70),
  ('halfYearCard', '半年卡', 278, 4380, 182.5, 208),
  ('yearlyCard', '年卡', 488, 8760, 365, 488);

INSERT OR IGNORE INTO plans (plan_key, name, rate_per_hour, desc) VALUES
  ('premium', '高级版', 1.00, '使用高级功能及常用设置自动同步'),
  ('vip', '尊享版', 1.50, '包含高级版功能，并可在本地离线后由云端接管');

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('points_plan_enabled', 'true'),
  ('billing_enabled_rate_per_hour', '1'),
  ('billing_disabled_rate_per_day', '24'),
  ('billing_daily_minimum', '12');
