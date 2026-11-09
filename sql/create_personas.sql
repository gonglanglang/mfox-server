-- ============================================
-- 人物/场景/道具素材表
-- ============================================
CREATE TABLE IF NOT EXISTS `personas` (
  `id`          INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  `work_id`     INT NOT NULL                                              COMMENT '关联作品ID',
  `chapters_id` INT NOT NULL                                              COMMENT '关联章节ID',
  `user_id`     INT NOT NULL                                              COMMENT '关联用户ID',
  `voice_id`    INT DEFAULT NULL                                           COMMENT '关联配音ID',
  `name`        VARCHAR(100) NOT NULL DEFAULT ''                          COMMENT '名称',
  `source_type` ENUM('persona','scene','prop') NOT NULL DEFAULT 'persona' COMMENT '素材类型：人物/场景/道具',
  `gender`      ENUM('male','female','unknown') NOT NULL DEFAULT 'unknown' COMMENT '性别',
  `images`      JSON NOT NULL DEFAULT ('[]')                              COMMENT '图片列表',
  `images_history` JSON NOT NULL DEFAULT ('[]')                           COMMENT '图片历史记录',
  `created_at`  DATETIME NOT NULL                                         COMMENT '创建时间',
  `updated_at`  DATETIME NOT NULL                                         COMMENT '更新时间',
  `deleted_at`  DATETIME DEFAULT NULL                                     COMMENT '软删除时间',

  INDEX `idx_personas_work_id`     (`work_id`),
  INDEX `idx_personas_chapters_id` (`chapters_id`),
  INDEX `idx_personas_user_id`     (`user_id`),
  INDEX `idx_personas_source_type` (`source_type`),
  INDEX `idx_personas_voice_id`    (`voice_id`),

  CONSTRAINT `fk_personas_work`    FOREIGN KEY (`work_id`)     REFERENCES `works` (`id`)    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_personas_chapter` FOREIGN KEY (`chapters_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_personas_user`    FOREIGN KEY (`user_id`)     REFERENCES `users` (`id`)    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_personas_voice`   FOREIGN KEY (`voice_id`)    REFERENCES `voices` (`id`)   ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='人物/场景/道具素材表';
