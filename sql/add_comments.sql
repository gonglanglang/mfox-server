-- ============================================
-- 给 volumes 和 chapters 表字段添加 MySQL COMMENT
-- 在 npx drizzle-kit push 之后执行即可
-- ============================================

ALTER TABLE volumes
  MODIFY COLUMN id          INT          NOT NULL AUTO_INCREMENT COMMENT '数字类型.自动生成叠加数字.唯一标识',
  MODIFY COLUMN work_id     INT          NOT NULL                  COMMENT '外键 → 作品表',
  MODIFY COLUMN user_id     INT          NOT NULL                  COMMENT '外键 → 用户表',
  MODIFY COLUMN title       VARCHAR(100) NOT NULL DEFAULT ''       COMMENT '卷标题，如"第一卷·初入江湖"',
  MODIFY COLUMN description TEXT                                   COMMENT '卷简介/导语',
  MODIFY COLUMN volume_no   INT          NOT NULL DEFAULT 1        COMMENT '卷序号，如第1卷、第2卷',
  MODIFY COLUMN created_at  DATETIME     NOT NULL                  COMMENT '创建时间',
  MODIFY COLUMN updated_at  DATETIME     NOT NULL                  COMMENT '更新时间',
  MODIFY COLUMN deleted_at  DATETIME     NULL                      COMMENT '软删除时间';

ALTER TABLE chapters
  MODIFY COLUMN id          INT          NOT NULL AUTO_INCREMENT COMMENT '数字类型.自动生成叠加数字.唯一标识',
  MODIFY COLUMN work_id     INT          NOT NULL                  COMMENT '外键 → 作品表',
  MODIFY COLUMN volume_id   INT          NULL                      COMMENT '外键 → 卷表（可空，不分卷时直接挂作品下）',
  MODIFY COLUMN user_id     INT          NOT NULL                  COMMENT '外键 → 用户表',
  MODIFY COLUMN title       VARCHAR(100) NOT NULL DEFAULT ''       COMMENT '章节标题，如"第一章·下山"',
  MODIFY COLUMN content     LONGTEXT                               COMMENT '章节正文',
  MODIFY COLUMN chapter_no  INT          NOT NULL DEFAULT 0        COMMENT '章节序号（卷内排序）',
  MODIFY COLUMN word_count  INT          NOT NULL DEFAULT 0        COMMENT '本章字数',
  MODIFY COLUMN status      ENUM('draft','published') NOT NULL DEFAULT 'draft' COMMENT '草稿/已发布',
  MODIFY COLUMN created_at  DATETIME     NOT NULL                  COMMENT '创建时间',
  MODIFY COLUMN updated_at  DATETIME     NOT NULL                  COMMENT '更新时间',
  MODIFY COLUMN deleted_at  DATETIME     NULL                      COMMENT '软删除时间';
