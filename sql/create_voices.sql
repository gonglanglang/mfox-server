-- ============================================
-- 配音表
-- ============================================
CREATE TABLE IF NOT EXISTS `voices` (
  `id`          INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  `voice_name`  VARCHAR(100) NOT NULL DEFAULT ''                    COMMENT '配音名称',
  `description` TEXT                                                COMMENT '描述',
  `example_url` VARCHAR(500) NOT NULL DEFAULT ''                    COMMENT '示例音频URL',
  `tags`        JSON NOT NULL DEFAULT ('[]')                        COMMENT '标签',
  `created_at`  DATETIME NOT NULL                                   COMMENT '创建时间',
  `updated_at`  DATETIME NOT NULL                                   COMMENT '更新时间',
  `deleted_at`  DATETIME DEFAULT NULL                               COMMENT '软删除时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='配音表';
