-- 记录每个安装包被下载的次数，用于后台统计
ALTER TABLE version_packages ADD COLUMN downloads INT NOT NULL DEFAULT 0;
