-- 2026-11-08 市场主流分镜关键帧模式（单帧 I2V 默认 / 视频末帧无缝续接 / 首尾双帧可选）与不可逆世界状态账本迁移脚本

-- 1. works 表新增作品级默认关键帧模式 frame_mode（默认 'single' 主流单帧驱动）
ALTER TABLE `works`
  ADD COLUMN IF NOT EXISTS `frame_mode` VARCHAR(20) NOT NULL DEFAULT 'single' COMMENT '关键帧模式：single=主流单帧驱动/dual=首尾双帧/video_tail=视频末帧续接' AFTER `use_prev_video`;

-- 2. storyboard 表新增镜头级 frame_mode 与不可逆世界状态账本 world_state
ALTER TABLE `storyboard`
  ADD COLUMN IF NOT EXISTS `frame_mode` VARCHAR(20) NOT NULL DEFAULT 'single' COMMENT '关键帧模式：single/dual/video_tail' AFTER `continuity_status`,
  ADD COLUMN IF NOT EXISTS `world_state` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '前序不可逆世界与道具状态锁' AFTER `frame_mode`;
