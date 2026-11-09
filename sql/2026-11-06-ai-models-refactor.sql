-- ============================================================
-- 模型配置重构与长文防截断迁移脚本 (2026-11-06，幂等可重复执行)
-- 对应文档：《模型配置重构设计.md》第 3 节、《AI漫剧工作流与提示词重构设计.md》
-- ============================================================

-- 1. 迁移前重复数据检查（人工核查结果必须均为空后再执行下方唯一索引 DDL）
-- 检查 1：全表是否有重复 model
SELECT model, COUNT(*) AS cnt, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(provider_id) AS providers
FROM ai_models
GROUP BY model
HAVING cnt > 1;

-- 检查 2：ai_service_configs.provider 是否有重复
SELECT provider, COUNT(*) AS cnt, GROUP_CONCAT(id) AS ids
FROM ai_service_configs
GROUP BY provider
HAVING cnt > 1;

-- 2. ai_models.sort_order 列（幂等守卫：若 warmupPool 已创建则跳过）
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_models' AND COLUMN_NAME = 'sort_order'
);
SET @sql_col := IF(
  @col_exists = 0,
  'ALTER TABLE `ai_models` ADD COLUMN `sort_order` INT NOT NULL DEFAULT 0 COMMENT ''同类型内展示顺序'' AFTER `status`',
  'SELECT ''ai_models.sort_order already exists'' AS info'
);
PREPARE stmt FROM @sql_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. ai_models.uk_ai_models_model 唯一索引（幂等守卫）
SET @uk_model_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_models' AND INDEX_NAME = 'uk_ai_models_model'
);
SET @sql_uk_model := IF(
  @uk_model_exists = 0,
  'ALTER TABLE `ai_models` ADD UNIQUE INDEX `uk_ai_models_model` (`model`)',
  'SELECT ''uk_ai_models_model already exists'' AS info'
);
PREPARE stmt FROM @sql_uk_model;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. ai_models.idx_models_provider_type 复合索引（幂等守卫）
SET @idx_pt_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_models' AND INDEX_NAME = 'idx_models_provider_type'
);
SET @sql_idx_pt := IF(
  @idx_pt_exists = 0,
  'ALTER TABLE `ai_models` ADD INDEX `idx_models_provider_type` (`provider_id`, `content_type`)',
  'SELECT ''idx_models_provider_type already exists'' AS info'
);
PREPARE stmt FROM @sql_idx_pt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 5. ai_service_configs.uk_provider 唯一索引（自动消岐历史重复 provider 后幂等建索引）
UPDATE `ai_service_configs` t1
JOIN (
  SELECT `provider`, MIN(`id`) AS keep_id
  FROM `ai_service_configs`
  GROUP BY `provider`
  HAVING COUNT(*) > 1
) t2 ON t1.`provider` = t2.`provider` AND t1.`id` <> t2.keep_id
SET t1.`provider` = CASE
  WHEN t1.`name` = '火山引擎' THEN 'Volcengine'
  ELSE CONCAT(t1.`provider`, '_', t1.`id`)
END;

SET @uk_provider_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_service_configs' AND INDEX_NAME = 'uk_provider'
);
SET @sql_uk_provider := IF(
  @uk_provider_exists = 0,
  'ALTER TABLE `ai_service_configs` ADD UNIQUE INDEX `uk_provider` (`provider`)',
  'SELECT ''uk_provider already exists'' AS info'
);
PREPARE stmt FROM @sql_uk_provider;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 6. chapters.content 扩容为 MEDIUMTEXT（防止 >64KB 长章节原文被截断）
ALTER TABLE `chapters`
  MODIFY COLUMN `content` MEDIUMTEXT NULL;

-- ============================================================
-- 回滚脚本（仅在需要回退本次索引/列变更时手动执行）
-- ============================================================
-- ALTER TABLE `ai_models` DROP INDEX `uk_ai_models_model`;
-- ALTER TABLE `ai_models` DROP INDEX `idx_models_provider_type`;
-- ALTER TABLE `ai_models` DROP COLUMN `sort_order`;
-- ALTER TABLE `ai_service_configs` DROP INDEX `uk_provider`;
