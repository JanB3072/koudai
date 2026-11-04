-- 文件传输（工具端）存储表：D1 分块存储，单文件上限 20MB
-- 执行：wrangler d1 migrations apply koudai --local  (或 --remote)

-- 文件元数据
CREATE TABLE IF NOT EXISTS files (
  id VARCHAR(40) PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  size INT NOT NULL DEFAULT 0,
  sha256 CHAR(64) NOT NULL DEFAULT '',
  mime VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  chunks INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files (user_id, created_at);

-- 文件内容分块（Base64）
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id VARCHAR(40) NOT NULL,
  seq INT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (file_id, seq)
);
