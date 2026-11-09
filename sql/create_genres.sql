-- ============================================
-- 题材表
-- ============================================
CREATE TABLE IF NOT EXISTS `genres` (
  `id`         INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  `name`       VARCHAR(50) NOT NULL DEFAULT ''       COMMENT '题材名称',
  `sort_order` INT NOT NULL DEFAULT 0                COMMENT '排序（越小越靠前）',
  `status`     VARCHAR(20) NOT NULL DEFAULT 'online' COMMENT '状态 online/offline',
  `created_at` DATETIME NOT NULL                     COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL                     COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题材表';

-- 初始题材数据
INSERT INTO `genres` (`name`, `sort_order`, `status`, `created_at`, `updated_at`) VALUES
('言情', 1, 'online', NOW(), NOW()),
('悬疑', 2, 'online', NOW(), NOW()),
('科幻', 3, 'online', NOW(), NOW()),
('仙侠', 4, 'online', NOW(), NOW()),
('玄幻', 5, 'online', NOW(), NOW()),
('都市', 6, 'online', NOW(), NOW()),
('现实情感', 7, 'online', NOW(), NOW()),
('惊悚', 8, 'online', NOW(), NOW()),
('武侠', 9, 'online', NOW(), NOW()),
('脑洞', 10, 'online', NOW(), NOW()),
('太空歌剧', 11, 'online', NOW(), NOW()),
('赛博朋克', 12, 'online', NOW(), NOW()),
('游戏', 13, 'online', NOW(), NOW()),
('历史', 14, 'online', NOW(), NOW()),
('奇幻', 15, 'online', NOW(), NOW());
