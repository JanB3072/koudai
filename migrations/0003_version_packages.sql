-- 版本安装包元数据（实际二进制存于 R2 桶 koudai-exe，下载走 /exe/:id）
CREATE TABLE IF NOT EXISTS version_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pkg_key VARCHAR(255) NOT NULL UNIQUE,   -- R2 对象键：upload/<random>
  name VARCHAR(255) NOT NULL,             -- 原始文件名
  version VARCHAR(50) NOT NULL DEFAULT '',
  size INT NOT NULL DEFAULT 0,
  sha256 VARCHAR(64) NOT NULL DEFAULT '',
  uploaded_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vp_created ON version_packages(created_at);
