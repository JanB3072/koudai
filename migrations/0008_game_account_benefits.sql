-- 游戏账号首绑奖励追踪表：同一 (uid, server_id) 仅首次绑定可领首绑奖励 / 注册赠送积分
-- 使用 IF NOT EXISTS：线上库该表已存在（手动创建），此为幂等兜底；新环境则会建表
CREATE TABLE IF NOT EXISTS game_account_benefits (
  uid VARCHAR(255) NOT NULL DEFAULT '',
  server_id VARCHAR(255) NOT NULL DEFAULT '',
  claimed_at DATETIME NOT NULL DEFAULT (datetime('now')),
  first_account_id VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (uid, server_id)
);
