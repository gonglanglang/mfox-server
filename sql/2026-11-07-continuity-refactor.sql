-- ============================================================
-- 分镜连贯性专项重构迁移脚本 (2026-11-07，幂等可重复执行)
-- 对应《分镜连贯性专项重构需求文档》第 5 节数据库调整
-- ============================================================

CREATE TABLE IF NOT EXISTS `storyboard` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `chapter_id` INT NOT NULL COMMENT '章节ID',
  `scene_idx` INT NOT NULL DEFAULT 0 COMMENT '场次索引',
  `shot_idx` INT NOT NULL DEFAULT 0 COMMENT '场内镜头索引',
  `panel_idx` INT NOT NULL DEFAULT 0 COMMENT '全局面板索引',
  `shot_key` VARCHAR(64) NOT NULL COMMENT '唯一镜头键 chapter_id:scene_idx:shot_idx',
  `subject_id` INT NULL COMMENT '主体角色ID',
  `color_tone` VARCHAR(120) NOT NULL DEFAULT '' COMMENT '色调与色温锚点',
  `motion_direction` VARCHAR(60) NOT NULL DEFAULT 'static' COMMENT '运动方向',
  `shot_size` VARCHAR(30) NOT NULL DEFAULT '中景' COMMENT '景别',
  `prev_shot_id` VARCHAR(64) NULL COMMENT '前序镜头标识',
  `next_shot_id` VARCHAR(64) NULL COMMENT '后继镜头标识',
  `style_anchor_id` INT NULL COMMENT '全局风格锚点ID（works.style_id）',
  `continuity_status` VARCHAR(30) NOT NULL DEFAULT 'pending' COMMENT '连贯性状态 pending/continuity_checking/passed/warning/qc_failed/regenerating',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE INDEX `uk_storyboard_shot_key` (`shot_key`),
  INDEX `idx_storyboard_chapter` (`chapter_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `transition_decision` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `chapter_id` INT NOT NULL COMMENT '章节ID',
  `from_shot` VARCHAR(64) NOT NULL COMMENT '起始镜头标识',
  `to_shot` VARCHAR(64) NOT NULL COMMENT '目标镜头标识',
  `type` VARCHAR(50) NOT NULL DEFAULT '硬切' COMMENT '转场类型',
  `duration` DOUBLE NOT NULL DEFAULT 0 COMMENT '转场时长（秒）',
  `reason` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '智能转场决策原因',
  `created_at` DATETIME NOT NULL,
  UNIQUE INDEX `uk_transition_decision_pair` (`chapter_id`, `from_shot`, `to_shot`),
  INDEX `idx_transition_decision_chapter` (`chapter_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qc_record` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `render_id` VARCHAR(64) NOT NULL COMMENT '渲染/质检批次ID',
  `chapter_id` INT NULL COMMENT '章节ID',
  `panel_idx` INT NULL COMMENT '分镜面板索引（整片质检时为 NULL）',
  `check_item` VARCHAR(64) NOT NULL COMMENT '质检项 black_frame/audio_silence/av_sync/subtitle_overflow/continuity_norm',
  `result` VARCHAR(20) NOT NULL DEFAULT 'pass' COMMENT 'pass/warn/fail',
  `score` INT NOT NULL DEFAULT 100 COMMENT '单项评分 0-100',
  `regenerate_flag` TINYINT NOT NULL DEFAULT 0 COMMENT '是否触发自动回退重生成（0=否 1=是）',
  `detail` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '质检详情描述',
  `created_at` DATETIME NOT NULL,
  INDEX `idx_qc_record_render` (`render_id`),
  INDEX `idx_qc_record_chapter_panel` (`chapter_id`, `panel_idx`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
