-- 客户端程序(exe)二进制分块存储。
-- D1 限制：单条 SQL 语句 100KB、单值 2MB；整个 exe 的 Base64 存单行会触发 SQLITE_TOOBIG。
-- 改为按 32KB 原始数据分块，逐块 Base64 存入本表。
CREATE TABLE IF NOT EXISTS client_resource_chunks (
  name VARCHAR(200) NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (name, seq)
);
CREATE INDEX IF NOT EXISTS idx_crc_name ON client_resource_chunks(name);
