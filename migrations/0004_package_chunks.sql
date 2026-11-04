-- 安装包二进制分块存储（Base64），与 version_packages 通过 pkg_key 关联。
CREATE TABLE IF NOT EXISTS package_chunks (
  pkg_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (pkg_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_pc_key ON package_chunks(pkg_key);
