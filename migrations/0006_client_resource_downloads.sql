-- 记录每个客户端资源（版本 / exe）被下载的次数与最近下载时间，用于后台统计
ALTER TABLE client_resources ADD COLUMN downloads INT NOT NULL DEFAULT 0;
ALTER TABLE client_resources ADD COLUMN last_downloaded_at DATETIME;
