-- ============================================
-- 任务表（存储调用 AI 接口时的任务信息，替代 Redis 任务缓存）
-- ============================================
CREATE TABLE IF NOT EXISTS `ai_tasks` (
  `id`           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
  `task_id`      VARCHAR(64)  NOT NULL                            COMMENT '任务 ID（UUID）',
  `user_id`      INT          NOT NULL                            COMMENT '所属用户',
  `type`         VARCHAR(50)  NOT NULL                            COMMENT '任务类型 aiNovel/characterExtract/storyboard/aiImage/polish...',
  `status`       VARCHAR(20)  NOT NULL DEFAULT 'running'          COMMENT '任务状态 running/done',
  `router`       VARCHAR(255) NOT NULL DEFAULT ''                 COMMENT '前端路由，用于刷新后回跳',
  `steps_config` TEXT                                             COMMENT '任务时间链（JSON 字符串）',
  `extra`        JSON                                             COMMENT '调用 AI 接口时的输入参数（content/genre/text/workId 等）',
  `result`       LONGTEXT                                         COMMENT 'AI 输出结果全文',
  `created_at`   DATETIME     NOT NULL                            COMMENT '创建时间',
  `updated_at`   DATETIME     NOT NULL                            COMMENT '更新时间',
  UNIQUE KEY `uk_ai_tasks_task_id` (`task_id`),
  KEY `idx_ai_tasks_user_id` (`user_id`),
  KEY `idx_ai_tasks_type` (`type`),
  KEY `idx_ai_tasks_status` (`status`),
  CONSTRAINT `fk_ai_tasks_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务表（AI 任务存储）';
