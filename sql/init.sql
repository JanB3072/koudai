-- 口袋管家数据库初始化脚本
-- 数据库名：koudai
-- 执行方式（命令行）：
--   mysql -u <用户名> -p < sql/init.sql
--   或在 MySQL 客户端内执行：source sql/init.sql;
-- 说明：本项目不使用任何 JSON 模拟数据，所有数据（管理员 / 用户 / 账号 / 定价 / 套餐 / 计费规则）均来自数据库。
--       以下为表结构与必要的初始配置（默认管理员、定价、套餐、计费规则），业务用户与游戏账号由前台注册 / 接口写入。

CREATE DATABASE IF NOT EXISTS `koudai`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `koudai`;

-- ============ 管理员 ============
CREATE TABLE IF NOT EXISTS `admin` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `username`   VARCHAR(50)  NOT NULL UNIQUE COMMENT '登录账号',
  `password`   VARCHAR(100) NOT NULL COMMENT '登录密码(sha256)',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台管理员';

-- ============ 用户（会员/注册用户） ============
CREATE TABLE IF NOT EXISTS `users` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `username`   VARCHAR(50)  NOT NULL UNIQUE COMMENT '登录账号',
  `password`   VARCHAR(100) NULL     COMMENT '登录密码(sha256)',
  `game_role`  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '游戏角色名（后台用户管理展示）',
  `plan`       VARCHAR(20)  NOT NULL DEFAULT '高级版' COMMENT '会员方案：高级版/尊享版',
  `points`     DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '剩余点数（支持小数，按小时结算）',
  `status`     VARCHAR(20)  NOT NULL DEFAULT '正常' COMMENT '会员状态：正常/已过期/已封禁',
  `default_account_id` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '默认游戏账号acc_id（首个账号）',
  `last_settled_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '积分按时间结算的基准时间',
  `tool_started_at`   DATETIME NULL DEFAULT NULL COMMENT '工具启动时间(null=未启动，启用费率计费起算点)',
  `invite_code`       VARCHAR(64) NULL DEFAULT NULL COMMENT '注册邀请码(非必填)',
  `created_at` DATE         NOT NULL COMMENT '创建日期',
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表（一个用户可拥有多个游戏账号）';

-- ============ 游戏账号（一个用户多个） ============
CREATE TABLE IF NOT EXISTS `accounts` (
  `id`              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id`         INT UNSIGNED NOT NULL COMMENT '所属用户(users.id)',
  `acc_id`          VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '账号配置ID(UUID)',
  `profile_dir`     VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '配置目录',
  `uid`             VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '游戏UID',
  `name`            VARCHAR(100) NOT NULL DEFAULT '' COMMENT '游戏角色名',
  `server_id`       VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '区服ID',
  `last_login_at`   BIGINT       NOT NULL DEFAULT 0 COMMENT '最后登录时间(毫秒时间戳)',
  `server_info_token` TEXT        COMMENT '服务器信息token',
  `token_expire_at` BIGINT       NOT NULL DEFAULT 0 COMMENT 'token过期时间(毫秒时间戳)',
  `avatar`          VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '头像',
  `qq_access_token` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'QQ登录token',
  `qq_openid`       VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'QQ openid',
  `status`          VARCHAR(20)  NOT NULL DEFAULT '正常' COMMENT '账号状态：正常/已封禁/已过期',
  `created_at`      DATE         NOT NULL COMMENT '创建日期',
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_accounts_user` (`user_id`),
  CONSTRAINT `fk_accounts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏账号表';

-- ============ 游戏账号首绑奖励去重（防薅羊毛） ============
-- 同一 (uid + 区服) 视为同一个游戏账号，仅首次绑定可领取奖励；
-- 之后无论换哪个用户重复绑定都不再发奖，但绑定本身允许（一个游戏账号可绑定多个用户）。
CREATE TABLE IF NOT EXISTS `game_account_benefits` (
  `uid`              VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '游戏UID',
  `server_id`        VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '区服ID',
  `claimed_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首绑记录时间',
  `first_account_id` VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '首次绑定的acc_id',
  PRIMARY KEY (`uid`, `server_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏账号首绑奖励去重表';

-- ============ 充值套餐定价 ============
CREATE TABLE IF NOT EXISTS `pricing` (
  `id`       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `card_key` VARCHAR(20)  NOT NULL UNIQUE COMMENT 'monthlyCard/quarterlyCard/halfYearCard/yearlyCard',
  `name`     VARCHAR(20)  NOT NULL COMMENT '套餐名称（月卡/季卡/半年卡/年卡）',
  `price`    DECIMAL(10,2) NOT NULL COMMENT '售价（元）',
  `points`   INT          NOT NULL COMMENT '赠送点数',
  `days`     DECIMAL(10,1) NOT NULL COMMENT '有效期（天）',
  `save`     DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '相比原价节省（元）'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值套餐定价表';

-- ============ 充值/调整记录 ============
-- 后台修改用户点数时按新旧差额生成（amount 有符号：正=充值/加，负=扣减/调整）
CREATE TABLE IF NOT EXISTS `recharge_log` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id`    INT UNSIGNED NOT NULL COMMENT '用户ID(users.id)',
  `amount`     DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '变动点数（有符号：正=充值/加，负=扣减/调整）',
  `admin`      VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '操作管理员(admin.username)',
  `note`       VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注（如 后台调整/套餐名）',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  KEY `idx_rl_user` (`user_id`),
  KEY `idx_rl_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值/调整记录（后台修改用户点数生成）';

-- ============ 会员方案 ============
CREATE TABLE IF NOT EXISTS `plans` (
  `id`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `plan_key`     VARCHAR(20)  NOT NULL UNIQUE COMMENT 'premium/vip',
  `name`         VARCHAR(50)  NOT NULL COMMENT '方案名称',
  `rate_per_hour` DECIMAL(5,2) NOT NULL COMMENT '每小时消耗点数',
  `desc`         VARCHAR(255) NOT NULL DEFAULT '' COMMENT '方案描述'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会员方案表';

-- ============ 系统设置（扣费开关 / 计费费率等） ============
CREATE TABLE IF NOT EXISTS `settings` (
  `key`   VARCHAR(50) NOT NULL PRIMARY KEY COMMENT '设置项键',
  `value` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '设置项值'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统设置键值对';

-- ============ 初始配置数据 ============

-- 默认管理员（admin / admin123，密码为 sha256）
INSERT INTO `admin` (`username`, `password`)
SELECT 'admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'
WHERE NOT EXISTS (SELECT 1 FROM `admin` WHERE `username` = 'admin');

-- 充值套餐定价（默认配置，可在后台 /admin/pricing 修改）
INSERT INTO `pricing` (`card_key`, `name`, `price`, `points`, `days`, `save`) VALUES
('monthlyCard',   '月卡',   58.00, 720,  30,   26.00),
('quarterlyCard', '季卡',   148.00,2160, 90,   70.00),
('halfYearCard',  '半年卡', 278.00,4380, 182.5,208.00),
('yearlyCard',    '年卡',   488.00,8760, 365,  488.00)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- 会员方案（默认配置）
INSERT INTO `plans` (`plan_key`, `name`, `rate_per_hour`, `desc`) VALUES
('premium', '高级版', 1.00, '使用高级功能及常用设置自动同步'),
('vip',     '尊享版', 1.50, '包含高级版功能，并可在本地离线后由云端接管')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- 系统设置（扣费开关默认开启；计费费率默认值，可在后台 /admin/pricing 修改）
INSERT INTO `settings` (`key`, `value`) VALUES
('points_plan_enabled', 'true'),
('billing_enabled_rate_per_hour', '10'),
('billing_disabled_rate_per_day', '20')
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`);
