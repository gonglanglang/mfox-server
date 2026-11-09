-- ============================================
-- 卷表 + 章节表（带 MySQL COMMENT）
-- 如果还未建表，直接跑这个；已建表则跑 add_comments.sql
-- ============================================

CREATE TABLE IF NOT EXISTS volumes (
  id          INT AUTO_INCREMENT PRIMARY KEY               COMMENT '数字类型.自动生成叠加数字.唯一标识',
  work_id     INT NOT NULL                                  COMMENT '外键 → 作品表',
  user_id     INT NOT NULL                                  COMMENT '外键 → 用户表',
  title       VARCHAR(100) NOT NULL DEFAULT ''              COMMENT '卷标题，如"第一卷·初入江湖"',
  description TEXT                                          COMMENT '卷简介/导语',
  volume_no   INT NOT NULL DEFAULT 1                        COMMENT '卷序号，如第1卷、第2卷',
  created_at  DATETIME NOT NULL                             COMMENT '创建时间',
  updated_at  DATETIME NOT NULL                             COMMENT '更新时间',
  deleted_at  DATETIME NULL                                 COMMENT '软删除时间',

  INDEX idx_volumes_work_id (work_id),
  INDEX idx_volumes_user_id (user_id),

  CONSTRAINT fk_volumes_work FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_volumes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
) COMMENT='作品卷表（第一卷、第二卷...）';


CREATE TABLE IF NOT EXISTS chapters (
  id          INT AUTO_INCREMENT PRIMARY KEY               COMMENT '数字类型.自动生成叠加数字.唯一标识',
  work_id     INT NOT NULL                                  COMMENT '外键 → 作品表',
  volume_id   INT NULL                                      COMMENT '外键 → 卷表（可空，不分卷时直接挂作品下）',
  user_id     INT NOT NULL                                  COMMENT '外键 → 用户表',
  title       VARCHAR(100) NOT NULL DEFAULT ''              COMMENT '章节标题，如"第一章·下山"',
  content     LONGTEXT                                      COMMENT '章节正文',
  chapter_no  INT NOT NULL DEFAULT 0                        COMMENT '章节序号（卷内排序）',
  word_count  INT NOT NULL DEFAULT 0                        COMMENT '本章字数',
  status      ENUM('draft','published') NOT NULL DEFAULT 'draft' COMMENT '草稿/已发布',
  created_at  DATETIME NOT NULL                             COMMENT '创建时间',
  updated_at  DATETIME NOT NULL                             COMMENT '更新时间',
  deleted_at  DATETIME NULL                                 COMMENT '软删除时间',

  INDEX idx_chapters_work_id   (work_id),
  INDEX idx_chapters_volume_id (volume_id),
  INDEX idx_chapters_user_id   (user_id),

  CONSTRAINT fk_chapters_work   FOREIGN KEY (work_id)   REFERENCES works(id)   ON DELETE CASCADE   ON UPDATE CASCADE,
  CONSTRAINT fk_chapters_volume FOREIGN KEY (volume_id) REFERENCES volumes(id) ON DELETE SET NULL  ON UPDATE CASCADE,
  CONSTRAINT fk_chapters_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE   ON UPDATE CASCADE
) COMMENT='作品章节表';
