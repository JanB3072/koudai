-- 每日签到：记录表（配置存 settings，无需新表）
-- 执行：wrangler d1 migrations apply koudai --local  (或 --remote)

CREATE TABLE IF NOT EXISTS checkin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INT NOT NULL,
  day DATE NOT NULL,
  cycle_day INT NOT NULL DEFAULT 1,
  reward DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_checkin_user ON checkin_log(user_id, day);
