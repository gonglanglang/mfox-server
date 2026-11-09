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

-- ============================================
-- 画风表
-- ============================================
CREATE TABLE IF NOT EXISTS `visual_styles` (
  `id`           INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  `style_id`     INT NOT NULL UNIQUE                               COMMENT '画风ID',
  `name`         VARCHAR(100) NOT NULL DEFAULT ''                  COMMENT '名称',
  `type`         VARCHAR(50)  NOT NULL DEFAULT 'official'          COMMENT '类型',
  `description`  TEXT                                              COMMENT '描述',
  `effect_image` VARCHAR(500) NOT NULL DEFAULT ''                  COMMENT '效果图',
  `status`       VARCHAR(20)  NOT NULL DEFAULT 'online'            COMMENT '状态',
  `sort_order`   INT NOT NULL DEFAULT 0                            COMMENT '排序',
  `created_at`   DATETIME NOT NULL                                 COMMENT '创建时间',
  `updated_at`   DATETIME NOT NULL                                 COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='画风表';
