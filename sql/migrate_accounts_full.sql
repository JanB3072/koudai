-- 扩展开放 accounts 表，匹配游戏账号真实数据结构（保留已有数据）
USE `koudai`;

ALTER TABLE `accounts`
  CHANGE COLUMN `game_role` `name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '游戏角色名',
  CHANGE COLUMN `server` `server_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '区服ID',
  ADD COLUMN `acc_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '账号配置ID(UUID)' AFTER `user_id`,
  ADD COLUMN `profile_dir` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '配置目录' AFTER `acc_id`,
  ADD COLUMN `uid` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '游戏UID' AFTER `name`,
  ADD COLUMN `last_login_at` BIGINT NOT NULL DEFAULT 0 COMMENT '最后登录时间(毫秒时间戳)',
  ADD COLUMN `server_info_token` TEXT COMMENT '服务器信息token',
  ADD COLUMN `token_expire_at` BIGINT NOT NULL DEFAULT 0 COMMENT 'token过期时间(毫秒时间戳)',
  ADD COLUMN `avatar` VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '头像',
  ADD COLUMN `qq_access_token` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'QQ登录token',
  ADD COLUMN `qq_openid` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'QQ openid';

-- 为已有账号补齐 acc_id / profile_dir
UPDATE `accounts` SET `acc_id` = CONCAT('acc-', `id`), `profile_dir` = CONCAT('acc-', `id`) WHERE `acc_id` = '';
