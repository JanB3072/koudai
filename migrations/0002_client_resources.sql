-- 客户端版本管理：资源清单 + 当前版本号，供桌面工具按需拉取。
-- 资源以 Base64 文本存储（与 files.js 一致），规避 D1 单行 BLOB 大小限制。

CREATE TABLE IF NOT EXISTS client_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(200) NOT NULL UNIQUE,
  content_b64 TEXT,
  size INT NOT NULL DEFAULT 0,
  sha256 VARCHAR(64) NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cr_name ON client_resources(name);

INSERT OR IGNORE INTO settings (key, value) VALUES ('client_version', '0');
