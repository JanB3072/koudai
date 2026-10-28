-- 一次性迁移：建立"用户-游戏账号"一对多关系
USE `koudai`;

-- 1) 游戏账号表
CREATE TABLE IF NOT EXISTS `accounts` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id`    INT UNSIGNED NOT NULL COMMENT '所属用户(users.id)',
  `game_role`  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '游戏角色名',
  `server`     VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '区服',
  `status`     VARCHAR(20)  NOT NULL DEFAULT '正常' COMMENT '账号状态：正常/已封禁/已过期',
  `created_at` DATE         NOT NULL COMMENT '创建日期',
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_accounts_user` (`user_id`),
  CONSTRAINT `fk_accounts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏账号表（一个用户可拥有多个）';

-- 2) 把现有 users.game_role 迁移为账号（仅迁移非空的）
INSERT INTO `accounts` (`user_id`, `game_role`, `status`, `created_at`)
SELECT `id`, `game_role`, `status`, `created_at`
FROM `users`
WHERE `game_role` <> '';

-- 3) 删除 users 表中冗余的 game_role 列（角色信息统一由 accounts 管理）
ALTER TABLE `users` DROP COLUMN `game_role`;
