-- ============================================
-- personas 表新增 detail 列（结构化扩展信息）
-- scene 素材专用：存放 time/location/interior/mood/key_events/characters 等结构化字段
-- 新装库请直接看 create_personas.sql（已同步该列）；已有库执行下面这条即可
-- ============================================
ALTER TABLE `personas`
  ADD COLUMN `detail` JSON NULL COMMENT '结构化扩展信息（scene 素材：time/location/interior/mood/key_events/characters 等）' AFTER `description`;
