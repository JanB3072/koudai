-- 邀请功能：记录邀请人 + 为每个用户生成唯一邀请码
-- 执行：wrangler d1 migrations apply koudai --remote  （本地用 --local）

-- 1) 新增「被谁邀请」字段
ALTER TABLE users ADD COLUMN invited_by INTEGER NULL REFERENCES users(id);

-- 2) 清理历史错误数据：旧逻辑把用户「自己填的码」存进了 invite_code，需清空后重新生成专属码
UPDATE users SET invite_code = NULL WHERE invite_code IS NOT NULL AND invite_code <> '';

-- 3) 为所有没有邀请码的用户（含历史账号）生成唯一码：'KD' + 16 位 hex（randomblob 碰撞概率可忽略）
UPDATE users SET invite_code = 'KD' || lower(hex(randomblob(8))) WHERE invite_code IS NULL OR invite_code = '';

-- 4) 保证邀请码唯一（SQLite 唯一索引允许 NULL，但非空必须唯一）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code);
