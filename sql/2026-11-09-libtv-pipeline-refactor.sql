-- ============================================
-- LibTV 流水线对标与 MFox 重构迁移脚本 (2026-11-09)
-- 1. 新增 shot_assets 表（产物与多版本管理、局部重跑）
-- 2. ai_models 新增 capabilities JSON 字段（模型能力 schema 与 modeType 矩阵）
-- ============================================

CREATE TABLE IF NOT EXISTS `shot_assets` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `work_id` INT NOT NULL,
  `chapter_id` INT NOT NULL,
  `scene_idx` INT NOT NULL,          -- 场景下标（合成成片为 -1）
  `shot_idx` INT NOT NULL,           -- 镜头下标（合成成片为 -1）
  `kind` VARCHAR(16) NOT NULL,       -- image | video | audio
  `role` VARCHAR(16) NOT NULL,       -- start_frame | end_frame | keyframe | clip | tts | compose
  `version` INT NOT NULL DEFAULT 1,
  `url` VARCHAR(500) NOT NULL,
  `thumb_url` VARCHAR(500) DEFAULT '',
  `seed` BIGINT NULL,
  `model` VARCHAR(255) DEFAULT '',
  `params` JSON NULL,                -- 生成参数快照
  `status` VARCHAR(16) NOT NULL DEFAULT 'done', -- running|done|failed
  `is_current` TINYINT NOT NULL DEFAULT 1,      -- 当前选用版本
  `parent_asset_id` BIGINT NULL,     -- 依赖（如尾帧依赖首帧）
  `cost` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  KEY `idx_shot` (`chapter_id`, `scene_idx`, `shot_idx`, `kind`),
  KEY `idx_current` (`chapter_id`, `is_current`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 为 ai_models 表补充 capabilities JSON 列（幂等存储过程）
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ai_models'
    AND column_name = 'capabilities'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE `ai_models` ADD COLUMN `capabilities` JSON NULL COMMENT ''模型能力schema（modes/modeInputLimits/params）'' AFTER `size_map`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
