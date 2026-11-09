import { createPool } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'

// 从环境变量中读取数据库配置
const dbConfig = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,    // 连接池的最大连接数[reference:7]
    queueLimit: 0
};

// 创建连接池
const pool = createPool(dbConfig);

// 新增一个 warmup 函数
/** 缺列则补列（幂等；表名/列名均为代码内常量，不接受外部输入） */
async function ensureColumn(connection: any, table: string, column: string, definition: string) {
    const [columns] = await connection.query(`SHOW COLUMNS FROM \`${table}\` LIKE '${column}'`);
    if (Array.isArray(columns) && columns.length > 0) return;
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`已自动补充 ${table}.${column} 字段`);
}

/** 缺索引则建索引（幂等；表名/索引名/列名均为代码内常量，不接受外部输入） */
async function ensureIndex(connection: any, table: string, indexName: string, columns: string[]) {
    const [rows] = await connection.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = '${indexName}'`);
    if (Array.isArray(rows) && rows.length > 0) return;
    await connection.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns.map(c => `\`${c}\``).join(', ')})`);
    console.log(`已自动创建索引 ${table}.${indexName}`);
}

/** 缺唯一索引则建（幂等；用于支付回调 transaction_id 等去重） */
async function ensureUniqueIndex(connection: any, table: string, indexName: string, columns: string[]) {
    const [rows] = await connection.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = '${indexName}'`);
    if (Array.isArray(rows) && rows.length > 0) return;
    await connection.query(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${indexName}\` (${columns.map(c => `\`${c}\``).join(', ')})`);
    console.log(`已自动创建唯一索引 ${table}.${indexName}`);
}

/** 缺表则建表（幂等；DDL 为代码内常量） */
async function ensureTable(connection: any, table: string, ddl: string) {
    const [rows] = await connection.query(`SHOW TABLES LIKE '${table}'`);
    if (Array.isArray(rows) && rows.length > 0) return;
    await connection.query(ddl);
    console.log(`已自动创建表 ${table}`);
}

/** 将列改为可空（幂等；用于 chapters_id 跨章复用等放宽约束的场景） */
async function ensureColumnNullable(connection: any, table: string, column: string, definition: string) {
    const [rows] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}' AND is_nullable = 'NO'`
    );
    if (!Array.isArray(rows) || rows.length === 0) return; // 已可空或不存在
    await connection.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` ${definition}`);
    console.log(`已将 ${table}.${column} 改为可空`);
}

export async function warmupPool() {
    try {
        // 强行从池子里借出一个连接，执行一个最简单的查询
        const connection = await pool.getConnection();
        await connection.ping(); // 或者执行 SELECT 1
        // 人物身高（厘米）：统一人物尺度的锚点，缺失时按未填处理
        await ensureColumn(connection, 'personas', 'height',
            'INT NULL COMMENT \'身高（厘米）：人物尺度锚点\' AFTER `age`');
        // 章节列表按 (work_id, chapter_no) 排序，而行内含大体量 JSON（content_configs 单行可达 256KB）：
        // 缺这个复合索引时 MySQL 只能 filesort，把整行塞进 sort_buffer_size（默认同为 256KB），
        // 行体积一旦超过它就报 ER_OUT_OF_SORTMEMORY。走索引后按序直接读，既快又不吃排序内存。
        await ensureIndex(connection, 'chapters', 'idx_chapters_work_chapter', ['work_id', 'chapter_no']);
        await ensureIndex(connection, 'volumes', 'idx_volumes_work_volume', ['work_id', 'volume_no']);
        // 服务商协议 + 模型端点/固定参数：让"后台可配、主后端按协议分发"成立
        await ensureColumn(connection, 'ai_service_configs', 'protocol',
            'VARCHAR(50) NOT NULL DEFAULT \'\' COMMENT \'调用协议 dashscope-async / openai-images / openai-chat\' AFTER `provider`');
        await ensureColumn(connection, 'ai_models', 'endpoint',
            'VARCHAR(255) NOT NULL DEFAULT \'\' COMMENT \'相对 api_url 的接口路径，留空用协议默认\' AFTER `model`');
        await ensureColumn(connection, 'ai_models', 'params',
            'JSON NULL COMMENT \'请求固定参数，与用户选择项合并\' AFTER `endpoint`');
        // 价格档位：[{label, value, price}]（label 显示、value 请求与匹配、price 积分）
        await ensureColumn(connection, 'ai_models', 'price_config',
            'JSON NULL COMMENT \'价格档位 [{label,value,price}]\' AFTER `params`');
        // 尺寸映射：{档位: {宽高比: "宽x高"}}——同一档位不同模型的像素值不同，所以挂在模型上
        await ensureColumn(connection, 'ai_models', 'size_map',
            'JSON NULL COMMENT \'尺寸映射 {tier:{ratio:"WxH"}}\' AFTER `price_config`');
        await ensureColumn(connection, 'ai_models', 'capabilities',
            'JSON NULL COMMENT \'模型能力schema（modes/modeInputLimits/params）\' AFTER `size_map`');
        await ensureColumn(connection, 'ai_models', 'sort_order',
            'INT NOT NULL DEFAULT 0 COMMENT \'同类型内展示顺序\' AFTER `status`');
        await ensureIndex(connection, 'ai_models', 'idx_models_provider_type', ['provider_id', 'content_type']);
        await ensureUniqueIndex(connection, 'ai_models', 'uk_ai_models_model', ['model']);
        // 历史库若存在同名 provider（如两条 AI Hub），先消岐再建唯一索引，确保启动不因历史脏数据崩溃
        await connection.query(`
            UPDATE \`ai_service_configs\` t1
            JOIN (
              SELECT \`provider\`, MIN(\`id\`) AS keep_id
              FROM \`ai_service_configs\`
              GROUP BY \`provider\`
              HAVING COUNT(*) > 1
            ) t2 ON t1.\`provider\` = t2.\`provider\` AND t1.\`id\` <> t2.keep_id
            SET t1.\`provider\` = CASE
              WHEN t1.\`name\` = '火山引擎' THEN 'Volcengine'
              ELSE CONCAT(t1.\`provider\`, '_', t1.\`id\`)
            END
        `);
        await ensureUniqueIndex(connection, 'ai_service_configs', 'uk_provider', ['provider']);
        // 确保 chapters.content 为 MEDIUMTEXT，防止长章节原文超过 64KB 被截断
        const [contentCol] = await connection.query(`SHOW COLUMNS FROM \`chapters\` LIKE 'content'`) as any;
        if (Array.isArray(contentCol) && contentCol[0] && String(contentCol[0].Type || '').toLowerCase() !== 'mediumtext') {
            await connection.query(`ALTER TABLE \`chapters\` MODIFY COLUMN \`content\` MEDIUMTEXT NULL`);
            console.log('已将 chapters.content 升级为 MEDIUMTEXT');
        }
        // 作品级视口宽高比（分辨率由所选模型决定，这里只保存比例）
        await ensureColumn(connection, 'works', 'aspect_ratio',
            'VARCHAR(20) NOT NULL DEFAULT \'16:9\' COMMENT \'视口宽高比，如 16:9\' AFTER `style_id`');
        await ensureColumn(connection, 'works', 'use_prev_video',
            'TINYINT NOT NULL DEFAULT 0 COMMENT \'分镜视频是否参考上一镜成片（0=否 1=是）\' AFTER `narration_voice_id`');
        await ensureColumn(connection, 'works', 'frame_mode',
            'VARCHAR(20) NOT NULL DEFAULT \'single\' COMMENT \'关键帧模式：single=主流单帧驱动/dual=首尾双帧/video_tail=视频末帧续接\' AFTER `use_prev_video`');
        // 自定义画风归属用户：NULL 表示官方内置画风（所有用户可见）
        await ensureColumn(connection, 'visual_styles', 'user_id',
            'INT NULL COMMENT \'自定义画风归属用户；NULL=官方内置\' AFTER `type`');
        // 章节成品视频（各分镜视频重编码拼接后的成片）
        await ensureColumn(connection, 'chapters', 'composed_video_url',
            'VARCHAR(500) NOT NULL DEFAULT \'\' COMMENT \'章节成品视频 URL（分镜合成）\' AFTER `bgm_url`');

        // ===== P0 迁移：任务重试 / 回调幂等 / 积分流水 / 素材跨章复用 =====
        await ensureColumn(connection, 'ai_tasks', 'retry_count',
            'INT NOT NULL DEFAULT 0 COMMENT \'失败重试次数（上限 1~2）\' AFTER `status`');
        await ensureUniqueIndex(connection, 'recharge_orders', 'uk_recharge_orders_transaction_id', ['transaction_id']);
        await ensureColumnNullable(connection, 'personas', 'chapters_id', 'INT NULL');
        await ensureTable(connection, 'points_ledger', `
            CREATE TABLE IF NOT EXISTS \`points_ledger\` (
              \`id\` INT AUTO_INCREMENT PRIMARY KEY,
              \`user_id\` INT NOT NULL COMMENT '用户ID',
              \`change\` INT NOT NULL COMMENT '变动值：正入账/负扣减',
              \`balance_after\` INT NOT NULL COMMENT '变动后余额',
              \`biz_type\` VARCHAR(50) NOT NULL COMMENT 'recharge/consume/refund/grant',
              \`biz_id\` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '关联业务ID（订单号/任务ID）',
              \`created_at\` DATETIME NOT NULL,
              INDEX \`idx_points_ledger_user\` (\`user_id\`),
              INDEX \`idx_points_ledger_biz\` (\`biz_type\`, \`biz_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // ===== 分镜连贯性专项重构：storyboard / transition_decision / qc_record 表 =====
        await ensureTable(connection, 'storyboard', `
            CREATE TABLE IF NOT EXISTS \`storyboard\` (
              \`id\` INT AUTO_INCREMENT PRIMARY KEY,
              \`chapter_id\` INT NOT NULL COMMENT '章节ID',
              \`scene_idx\` INT NOT NULL DEFAULT 0 COMMENT '场次索引',
              \`shot_idx\` INT NOT NULL DEFAULT 0 COMMENT '场内镜头索引',
              \`panel_idx\` INT NOT NULL DEFAULT 0 COMMENT '全局面板索引',
              \`shot_key\` VARCHAR(64) NOT NULL COMMENT '唯一镜头键 chapter_id:scene_idx:shot_idx',
              \`subject_id\` INT NULL COMMENT '主体角色ID',
              \`color_tone\` VARCHAR(120) NOT NULL DEFAULT '' COMMENT '色调与色温锚点',
              \`motion_direction\` VARCHAR(60) NOT NULL DEFAULT 'static' COMMENT '运动方向',
              \`shot_size\` VARCHAR(30) NOT NULL DEFAULT '中景' COMMENT '景别',
              \`prev_shot_id\` VARCHAR(64) NULL COMMENT '前序镜头标识',
              \`next_shot_id\` VARCHAR(64) NULL COMMENT '后继镜头标识',
              \`style_anchor_id\` INT NULL COMMENT '全局风格锚点ID（works.style_id）',
              \`continuity_status\` VARCHAR(30) NOT NULL DEFAULT 'pending' COMMENT '连贯性状态 pending/continuity_checking/passed/warning/qc_failed/regenerating',
              \`frame_mode\` VARCHAR(20) NOT NULL DEFAULT 'single' COMMENT '关键帧模式 single/dual/video_tail',
              \`world_state\` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '不可逆世界与道具状态锁',
              \`created_at\` DATETIME NOT NULL,
              \`updated_at\` DATETIME NOT NULL,
              UNIQUE INDEX \`uk_storyboard_shot_key\` (\`shot_key\`),
              INDEX \`idx_storyboard_chapter\` (\`chapter_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await ensureColumn(connection, 'storyboard', 'frame_mode',
            'VARCHAR(20) NOT NULL DEFAULT \'single\' COMMENT \'关键帧模式 single/dual/video_tail\' AFTER `continuity_status`');
        await ensureColumn(connection, 'storyboard', 'world_state',
            'VARCHAR(500) NOT NULL DEFAULT \'\' COMMENT \'不可逆世界与道具状态锁\' AFTER `frame_mode`');
        await ensureTable(connection, 'transition_decision', `
            CREATE TABLE IF NOT EXISTS \`transition_decision\` (
              \`id\` INT AUTO_INCREMENT PRIMARY KEY,
              \`chapter_id\` INT NOT NULL COMMENT '章节ID',
              \`from_shot\` VARCHAR(64) NOT NULL COMMENT '起始镜头标识',
              \`to_shot\` VARCHAR(64) NOT NULL COMMENT '目标镜头标识',
              \`type\` VARCHAR(50) NOT NULL DEFAULT '硬切' COMMENT '转场类型',
              \`duration\` DOUBLE NOT NULL DEFAULT 0 COMMENT '转场时长（秒）',
              \`reason\` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '智能转场决策原因',
              \`created_at\` DATETIME NOT NULL,
              UNIQUE INDEX \`uk_transition_decision_pair\` (\`chapter_id\`, \`from_shot\`, \`to_shot\`),
              INDEX \`idx_transition_decision_chapter\` (\`chapter_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await ensureTable(connection, 'qc_record', `
            CREATE TABLE IF NOT EXISTS \`qc_record\` (
              \`id\` INT AUTO_INCREMENT PRIMARY KEY,
              \`render_id\` VARCHAR(64) NOT NULL COMMENT '渲染/质检批次ID',
              \`chapter_id\` INT NULL COMMENT '章节ID',
              \`panel_idx\` INT NULL COMMENT '分镜面板索引（整片质检时为 NULL）',
              \`check_item\` VARCHAR(64) NOT NULL COMMENT '质检项 black_frame/audio_silence/av_sync/subtitle_overflow/continuity_norm',
              \`result\` VARCHAR(20) NOT NULL DEFAULT 'pass' COMMENT 'pass/warn/fail',
              \`score\` INT NOT NULL DEFAULT 100 COMMENT '单项评分 0-100',
              \`regenerate_flag\` TINYINT NOT NULL DEFAULT 0 COMMENT '是否触发自动回退重生成（0=否 1=是）',
              \`detail\` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '质检详情描述',
              \`created_at\` DATETIME NOT NULL,
              INDEX \`idx_qc_record_render\` (\`render_id\`),
              INDEX \`idx_qc_record_chapter_panel\` (\`chapter_id\`, \`panel_idx\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // ===== LibTV 流水线对标重构：shot_assets 产物与多版本管理表 =====
        await ensureTable(connection, 'shot_assets', `
            CREATE TABLE IF NOT EXISTS \`shot_assets\` (
              \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
              \`work_id\` INT NOT NULL,
              \`chapter_id\` INT NOT NULL,
              \`scene_idx\` INT NOT NULL COMMENT '场景下标（合成成片为 -1）',
              \`shot_idx\` INT NOT NULL COMMENT '镜头下标（合成成片为 -1）',
              \`kind\` VARCHAR(16) NOT NULL COMMENT 'image | video | audio',
              \`role\` VARCHAR(16) NOT NULL COMMENT 'start_frame | end_frame | keyframe | clip | tts | compose',
              \`version\` INT NOT NULL DEFAULT 1,
              \`url\` VARCHAR(500) NOT NULL,
              \`thumb_url\` VARCHAR(500) DEFAULT '',
              \`seed\` BIGINT NULL,
              \`model\` VARCHAR(255) DEFAULT '',
              \`params\` JSON NULL COMMENT '生成参数快照',
              \`status\` VARCHAR(16) NOT NULL DEFAULT 'done' COMMENT 'running | done | failed',
              \`is_current\` TINYINT NOT NULL DEFAULT 1 COMMENT '当前选用版本',
              \`parent_asset_id\` BIGINT NULL COMMENT '依赖（如尾帧依赖首帧）',
              \`cost\` INT NOT NULL DEFAULT 0,
              \`created_at\` DATETIME NOT NULL,
              KEY \`idx_shot\` (\`chapter_id\`, \`scene_idx\`, \`shot_idx\`, \`kind\`),
              KEY \`idx_current\` (\`chapter_id\`, \`is_current\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        connection.release(); // 立即释放回池子
    } catch (error) {
        console.error('❌ Database connection failed on startup:', error);
        // 在这里可以选择退出进程，防止后续请求雪崩
        process.exit(1); 
    }
}
export const db = drizzle(pool, { schema, mode: 'default' })
export type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>
export { pool, schema }
