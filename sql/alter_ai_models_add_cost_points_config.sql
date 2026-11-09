ALTER TABLE `ai_models`
  ADD COLUMN `cost_points_config` JSON NULL COMMENT '图片模型按质量档位配置积分，如 {"1K":1,"2K":2}' AFTER `cost_points`;
