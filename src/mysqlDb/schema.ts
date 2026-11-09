import { mysqlTable, int, bigint, double, varchar, json, tinyint, timestamp, mysqlEnum, datetime, text, mediumtext, longtext, uniqueIndex, index, foreignKey } from 'drizzle-orm/mysql-core'

// ============================================
// ai服务商表（存储供应商与密钥）
// ============================================
export const ai_service_configs = mysqlTable('ai_service_configs', {
  id: int().autoincrement().primaryKey(), // 数字类型.自动生成叠加数字.唯一标识
  provider: varchar('provider', { length: 50 }).notNull(), // 服务商标识（如 openai / longcat / seedance）
  protocol: varchar('protocol', { length: 50 }).notNull().default(''), // 调用协议（dashscope-async / openai-images / openai-chat），决定代码用哪个适配器
  name: varchar('name', { length: 255 }).notNull(), // 服务商名称
  api_url: varchar('api_url', { length: 500 }).notNull(), // baseUrl地址
  api_key: varchar('api_key', { length: 255 }).notNull(), // 密钥
  sort_order: int('sort_order'), // 权重
  created_at: timestamp('created_at'),
  updated_at: timestamp('updated_at')
})

// ============================================
// ai模型表（存储具体模型，归属某个服务商）
// ============================================
export const ai_models = mysqlTable('ai_models', {
  id: int().autoincrement().primaryKey(), // 数字类型.自动生成叠加数字.唯一标识
  provider_id: int('provider_id').notNull(), // 关联 ai_service_configs.id（所属服务商）
  content_type: varchar('content_type', { length: 50 }).notNull(), // 模型类型 text/video/image/audio
  name: varchar('name', { length: 255 }).notNull(), // 模型名称（用户可见）
  model: varchar('model', { length: 255 }).notNull(), // 模型ID（程序调用标识，如 doubao-seedance-2-0-mini-260615）
  endpoint: varchar('endpoint', { length: 255 }).notNull().default(''), // 相对 api_url 的接口路径，留空用协议默认
  status: tinyint('status').notNull().default(0), // 模型状态 0停用 1启用
  sort_order: int('sort_order').notNull().default(0), // 同类型内展示顺序
  price_config: json('price_config'), // 价格档位：[{label, value, price}] —— label 显示、value 请求与匹配、price 积分
  params: json('params'), // 请求固定参数（如 {prompt_extend:true,ratio:'adaptive'}），与用户选择项合并
  size_map: json('size_map'), // 尺寸映射：{档位: {宽高比: "宽x高"}}；档位 + 作品宽高比 → 供应商要的像素值
  capabilities: json('capabilities'), // 模型能力 schema：{modes: VideoMode[], modeInputLimits: {...}, params: {...}}
  created_at: timestamp('created_at'),
  updated_at: timestamp('updated_at')
}, (table) => ({
  providerIdx: index('idx_provider_id').on(table.provider_id),
  modelUk: uniqueIndex('uk_ai_models_model').on(table.model),
  providerTypeIdx: index('idx_models_provider_type').on(table.provider_id, table.content_type),
}))

// ============================================
// 用户信息表
// ============================================
export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  nickname: varchar('nickname', { length: 50 }).notNull().default(''),
  penName: varchar('pen_name', { length: 50 }),
  gender: mysqlEnum('gender', ['male', 'female', 'secret']).notNull().default('secret'),
  avatar: varchar('avatar', { length: 255 }),
  bio: text('bio'),
  email: varchar('email', { length: 100 }),
  phone: varchar('phone', { length: 20 }),
  wechatOpenid: varchar('wechat_openid', { length: 64 }).notNull().default(''),
  wechatUnionid: varchar('wechat_unionid', { length: 64 }),
  appId: varchar('app_id', { length: 32 }).notNull().default(''),
  loginType: mysqlEnum('login_type', ['account', 'phone', 'wechat']).notNull().default('account'),
  points: int('points').notNull().default(0), // 积分（默认 0，生成任务消耗）
  status: tinyint('status').notNull().default(0), // 0正常/1禁用
  lastLoginAt: datetime('last_login_at'), // 登录审计
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, (table) => ({
  emailIdx: uniqueIndex('uk_email').on(table.email),
  phoneIdx: uniqueIndex('uk_phone').on(table.phone),
  openidIdx: uniqueIndex('uk_wechat_openid').on(table.wechatOpenid),
  unionidIdx: uniqueIndex('uk_wechat_unionid').on(table.wechatUnionid),
}))

// ============================================
// 用户认证表
// ============================================
export const userAuth = mysqlTable('user_auth', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull().default(''),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_user_id').on(table.userId),
}))

// ============================================
// 作品表
// ============================================
export const works = mysqlTable('works', {
  id: int('id').autoincrement().primaryKey(),
  user_id: int('user_id').notNull(),
  title: varchar('title', { length: 50 }).notNull().default(''),
  description: text('description'),// 作品简介
  content: text('content'),// 作品内容
  type: mysqlEnum('type', ['长篇', '短篇', '视频', '剧本']).notNull().default('长篇'),// 作品类型
  audience: mysqlEnum('audience', ['女频', '男频', '全频']).notNull().default('全频'), // 目标受众
  pov: mysqlEnum('pov', ['第一人称', '第三人称']).notNull().default('第三人称'), // 人称与视角
  genre: varchar('genre', { length: 50 }).notNull().default(''), // 题材风格
  word_count: int('word_count').notNull().default(0),
  read_time: int('read_time').notNull().default(0),
  cover_url: varchar('cover_url', { length: 255 }).notNull().default(''),
  style_id: int('style_id'),
  aspect_ratio: varchar('aspect_ratio', { length: 20 }).notNull().default('16:9'), // 视口宽高比（分辨率由所选模型决定）
  narration_voice_id: int('narration_voice_id'),
  use_prev_video: tinyint('use_prev_video').notNull().default(0), // 分镜视频是否参考上一镜成片（0=否 1=是）
  frame_mode: varchar('frame_mode', { length: 20 }).notNull().default('single'), // 关键帧模式：single=主流单帧驱动（默认）/ dual=首尾双帧 / video_tail=视频末帧续接
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
  deleted_at: datetime('deleted_at'),
}, (table) => ({
  user_id_index: index('user_id_index').on(table.user_id), // 创建索引

  // 外键约束
  fk_works_user: foreignKey({
    columns: [table.user_id],
    foreignColumns: [users.id],
    name: 'fk_works_user',
  }).onDelete('cascade').onUpdate('cascade')
}))

// ============================================
// 作品卷表（第一卷、第二卷...）
// ============================================
export const volumes = mysqlTable('volumes', {
  id: int('id').autoincrement().primaryKey(),                        // 数字类型.自动生成叠加数字.唯一标识
  work_id: int('work_id').notNull(),                                 // 外键 → 作品表
  user_id: int('user_id').notNull(),                                 // 外键 → 用户表
  title: varchar('title', { length: 100 }).notNull().default(''),   // 卷标题，如"第一卷·初入江湖"
  description: text('description'),                                  // 卷简介/导语
  volume_no: int('volume_no').notNull().default(1),                  // 卷序号，如第1卷、第2卷
  createdAt: datetime('created_at').notNull(),                       // 创建时间
  updatedAt: datetime('updated_at').notNull(),                       // 更新时间
  deleted_at: datetime('deleted_at'),                                // 软删除时间
}, (table) => ({
  workIdIdx: index('idx_volumes_work_id').on(table.work_id),         // 按作品查卷
  userIdIdx: index('idx_volumes_user_id').on(table.user_id),         // 按用户查卷

  fk_volumes_work: foreignKey({
    columns: [table.work_id],
    foreignColumns: [works.id],
    name: 'fk_volumes_work',
  }).onDelete('cascade').onUpdate('cascade'),                        // 删作品→级联删卷

  fk_volumes_user: foreignKey({
    columns: [table.user_id],
    foreignColumns: [users.id],
    name: 'fk_volumes_user',
  }).onDelete('cascade').onUpdate('cascade'),                        // 删用户→级联删卷
}))

// ============================================
// 作品章节表
// ============================================
export const chapters = mysqlTable('chapters', {
  id: int('id').autoincrement().primaryKey(),                        // 数字类型.自动生成叠加数字.唯一标识
  work_id: int('work_id').notNull(),                                 // 外键 → 作品表
  volume_id: int('volume_id'),                                       // 外键 → 卷表（可空，不分卷时直接挂作品下）
  user_id: int('user_id').notNull(),                                 // 外键 → 用户表
  title: varchar('title', { length: 100 }).notNull().default(''),   // 章节标题，如"第一章·下山"
  content: mediumtext('content'),                                    // 章节正文（长文防截断）
  chapter_no: int('chapter_no').notNull().default(0),                // 章节序号（卷内排序）
  word_count: int('word_count').notNull().default(0),                // 本章字数
  content_configs: json('content_configs'),                           // 分镜拆分配置（对齐 LibTV 分镜表 11 字段：plot_description/image_prompt/motion_prompt/scene_tags/lighting/emotion/character_action/character_refs/reference_frame_url/gen_mode/model_params）
  bgm_url: varchar('bgm_url', { length: 500 }).notNull().default(''), // 章节背景音乐 URL
  composed_video_url: varchar('composed_video_url', { length: 500 }).notNull().default(''), // 章节成品视频 URL（分镜合成）
  status: mysqlEnum('status', ['draft', 'published']).notNull().default('draft'),  // 草稿/已发布
  compose_status: varchar('compose_status', { length: 20 }).notNull().default('none'), // none/composing/done/failed（视频合成状态）
  createdAt: datetime('created_at').notNull(),                       // 创建时间
  updatedAt: datetime('updated_at').notNull(),                       // 更新时间
  deleted_at: datetime('deleted_at'),                                // 软删除时间
}, (table) => ({
  workIdIdx: index('idx_chapters_work_id').on(table.work_id),        // 按作品查章节
  volumeIdIdx: index('idx_chapters_volume_id').on(table.volume_id),  // 按卷查章节
  userIdIdx: index('idx_chapters_user_id').on(table.user_id),        // 按用户查章节

  fk_chapters_work: foreignKey({
    columns: [table.work_id],
    foreignColumns: [works.id],
    name: 'fk_chapters_work',
  }).onDelete('cascade').onUpdate('cascade'),                        // 删作品→级联删章节

  fk_chapters_volume: foreignKey({
    columns: [table.volume_id],
    foreignColumns: [volumes.id],
    name: 'fk_chapters_volume',
  }).onDelete('cascade').onUpdate('cascade'),                       // onDelete('set null').onUpdate('cascade'), 删卷→章节volume_id置空，不删章节

  fk_chapters_user: foreignKey({
    columns: [table.user_id],
    foreignColumns: [users.id],
    name: 'fk_chapters_user',
  }).onDelete('cascade').onUpdate('cascade'),
}))

// ============================================
// 人物/场景/道具素材表
// ============================================
export const personas = mysqlTable('personas', {
  id: int('id').autoincrement().primaryKey(),
  work_id: int('work_id').notNull(),
  chapters_id: int('chapters_id'), // 可空：作品级素材不强制绑定单章节（形象一致性）
  user_id: int('user_id').notNull(),
  voice_id: int('voice_id'),
  ref_images: json('ref_images').notNull().default([]),
  description: text('description'),
  detail: json('detail'), // 结构化扩展信息（scene 素材：time/location/interior/mood/key_events/characters 等）
  name: varchar('name', { length: 100 }).notNull().default(''),
  source_type: mysqlEnum('source_type', ['persona', 'scene', 'prop']).notNull().default('persona'),
  gender: mysqlEnum('gender', ['male', 'female', 'unknown']).notNull().default('unknown'),
  age: varchar('age', { length: 20 }).notNull().default(''),
  height: int('height'), // 身高（厘米）：人物尺度锚点，未填为 null
  images: json('images').notNull().default([]),
  images_history: json('images_history').notNull().default([]),
  cur_image_id: varchar('cur_image_id', { length: 200 }).default(''),
  locked: tinyint('locked').notNull().default(0), // 形象是否锁定（锁定后生成强制引用）
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
  deleted_at: datetime('deleted_at'),
}, (table) => ({
  workIdIdx: index('idx_personas_work_id').on(table.work_id),
  chaptersIdIdx: index('idx_personas_chapters_id').on(table.chapters_id),
  userIdIdx: index('idx_personas_user_id').on(table.user_id),
  typeIdx: index('idx_personas_source_type').on(table.source_type),

  fk_personas_work: foreignKey({
    columns: [table.work_id],
    foreignColumns: [works.id],
    name: 'fk_personas_work',
  }).onDelete('cascade').onUpdate('cascade'),

  fk_personas_chapter: foreignKey({
    columns: [table.chapters_id],
    foreignColumns: [chapters.id],
    name: 'fk_personas_chapter',
  }).onDelete('cascade').onUpdate('cascade'),

  fk_personas_user: foreignKey({
    columns: [table.user_id],
    foreignColumns: [users.id],
    name: 'fk_personas_user',
  }).onDelete('cascade').onUpdate('cascade'),
}))

// ============================================
// 配音表
// ============================================
export const voices = mysqlTable('voices', {
  id: int('id').autoincrement().primaryKey(),
  voice_name: varchar('voice_name', { length: 100 }).notNull().default(''),
  description: text('description'),
  example_url: varchar('example_url', { length: 500 }).notNull().default(''),
  voice_id: varchar('voice_id', { length: 200 }).notNull().default(''),
  voice_image: varchar('voice_image', { length: 500 }).default(''),
  tags: json('tags').notNull().default([]),
  emotion_tags: json('emotion_tags').notNull().default([]), // 支持的语调标签，与 speech-tag 对齐
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
  deleted_at: datetime('deleted_at'),
})

// ============================================
// 画风表
// ============================================
export const visualStyles = mysqlTable('visual_styles', {
  id: int('id').autoincrement().primaryKey(),
  style_id: int('style_id').notNull().unique(),
  name: varchar('name', { length: 100 }).notNull().default(''),
  type: varchar('type', { length: 50 }).notNull().default('official'), // official=官方内置 / custom=用户自定义
  user_id: int('user_id'),                                            // 自定义画风归属用户；NULL 表示官方内置
  description: text('description'),
  effect_image: varchar('effect_image', { length: 500 }).notNull().default(''),
  status: varchar('status', { length: 20 }).notNull().default('online'),
  sort_order: int('sort_order').notNull().default(0),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
})

// ============================================
// 题材表
// ============================================
export const genres = mysqlTable('genres', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 50 }).notNull().default(''), // 题材名称，如"言情"
  sort_order: int('sort_order').notNull().default(0), // 排序（越小越靠前）
  status: varchar('status', { length: 20 }).notNull().default('online'), // online/offline
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
})

// ============================================
// 任务表（存储调用 AI 接口时的任务信息，替代 Redis 任务缓存）
// ============================================
export const ai_tasks = mysqlTable('ai_tasks', {
  id: int('id').autoincrement().primaryKey(),                         // 自增主键
  taskId: varchar('task_id', { length: 64 }).notNull().unique(),      // 任务 ID（UUID）
  userId: int('user_id').notNull(),                                   // 所属用户
  type: varchar('type', { length: 50 }).notNull(),                    // 任务类型 aiNovel/characterExtract/storyboard/aiImage/polish/shot_image/shot_video/shot_tts/compose...
  status: varchar('status', { length: 20 }).notNull().default('running'), // running/done/failed/timeout/cancelled
  retryCount: int('retry_count').notNull().default(0), // 失败重试次数（上限 1~2）
  router: varchar('router', { length: 255 }).notNull().default(''),   // 前端路由，用于刷新后回跳
  stepsConfig: text('steps_config'),                                  // 任务时间链（JSON 字符串）
  extra: json('extra'),                                               // 调用 AI 接口时的输入参数（content/genre/text/workId 等）
  result: longtext('result'),                                         // AI 输出结果全文
  createdAt: datetime('created_at').notNull(),                        // 创建时间
  updatedAt: datetime('updated_at').notNull(),                        // 更新时间
}, (table) => ({
  userIdIdx: index('idx_ai_tasks_user_id').on(table.userId),          // 按用户查任务
  typeIdx: index('idx_ai_tasks_type').on(table.type),                 // 按类型清理旧任务
  statusIdx: index('idx_ai_tasks_status').on(table.status),           // 按状态查询

  fk_ai_tasks_user: foreignKey({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: 'fk_ai_tasks_user',
  }).onDelete('cascade').onUpdate('cascade'),                         // 删用户→级联删任务
}))

// ============================================
// 积分充值订单表（微信支付 Native 扫码充值）
// ============================================
export const recharge_orders = mysqlTable('recharge_orders', {
  id: int('id').autoincrement().primaryKey(),                          // 自增主键
  orderNo: varchar('order_no', { length: 32 }).notNull(),              // 商户订单号 out_trade_no
  userId: int('user_id').notNull(),                                    // 下单用户
  planId: int('plan_id').notNull(),                                    // 充值套餐 ID（后端定义 1-6）
  amount: int('amount').notNull(),                                     // 实付金额（单位：分）
  points: int('points').notNull(),                                     // 应到账积分
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending待支付/paid已支付/closed已关闭
  transactionId: varchar('transaction_id', { length: 64 }), // 微信支付单号：支付前 NULL、支付后写入；唯一索引做幂等去重
  paidAt: datetime('paid_at'),                                         // 支付成功时间
  createdAt: datetime('created_at').notNull(),                         // 创建时间
  updatedAt: datetime('updated_at').notNull(),                         // 更新时间
}, (table) => ({
  orderNoIdx: uniqueIndex('uk_recharge_orders_order_no').on(table.orderNo),
  transactionIdIdx: uniqueIndex('uk_recharge_orders_transaction_id').on(table.transactionId), // 支付回调幂等去重
  userIdx: index('idx_recharge_orders_user').on(table.userId),
  statusIdx: index('idx_recharge_orders_status').on(table.status),

  fk_recharge_orders_user: foreignKey({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: 'fk_recharge_orders_user',
  }).onDelete('cascade').onUpdate('cascade'),                         // 删用户→级联删订单
}))

// ============================================
// 积分流水表（所有积分变动：充值/消费/退款/赠送；users.points 仅作汇总缓存）
// ============================================
export const pointsLedger = mysqlTable('points_ledger', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  change: int('change').notNull(), // 变动值：正数入账 / 负数扣减
  balanceAfter: int('balance_after').notNull(), // 变动后余额
  bizType: varchar('biz_type', { length: 50 }).notNull(), // recharge/consume/refund/grant
  bizId: varchar('biz_id', { length: 64 }).notNull().default(''), // 关联业务 ID（订单号/任务ID），用于幂等
  createdAt: datetime('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_points_ledger_user').on(table.userId),
  bizIdx: index('idx_points_ledger_biz').on(table.bizType, table.bizId), // 幂等去重
}))

// ============================================
// 管理后台操作审计表
// ============================================
export const adminAuditLogs = mysqlTable('admin_audit_logs', {
  id: int('id').autoincrement().primaryKey(),
  adminUser: varchar('admin_user', { length: 50 }).notNull().default(''),
  action: varchar('action', { length: 50 }).notNull(), // create/update/delete/login
  tableName: varchar('table_name', { length: 50 }).notNull().default(''),
  recordKey: varchar('record_key', { length: 100 }).notNull().default(''),
  oldValue: json('old_value'),
  newValue: json('new_value'),
  createdAt: datetime('created_at').notNull(),
}, (table) => ({
  adminIdx: index('idx_admin_audit_admin').on(table.adminUser),
  createdAtIdx: index('idx_admin_audit_created').on(table.createdAt),
}))


// ============================================
// 分镜连贯性结构表（与 chapters.content_configs 同步，支撑连贯性校验与查询）
// ============================================
export const storyboard = mysqlTable('storyboard', {
  id: int('id').autoincrement().primaryKey(),
  chapter_id: int('chapter_id').notNull(),
  scene_idx: int('scene_idx').notNull().default(0),
  shot_idx: int('shot_idx').notNull().default(0),
  panel_idx: int('panel_idx').notNull().default(0),
  shot_key: varchar('shot_key', { length: 64 }).notNull(), // "{chapter_id}:{scene_idx}:{shot_idx}"
  subject_id: int('subject_id'), // 主体角色 ID
  color_tone: varchar('color_tone', { length: 120 }).notNull().default(''), // 色调/色温锚点
  motion_direction: varchar('motion_direction', { length: 60 }).notNull().default('static'), // 运动方向
  shot_size: varchar('shot_size', { length: 30 }).notNull().default('中景'), // 景别
  prev_shot_id: varchar('prev_shot_id', { length: 64 }), // 前序镜头标识
  next_shot_id: varchar('next_shot_id', { length: 64 }), // 后继镜头标识
  style_anchor_id: int('style_anchor_id'), // 全局风格锚点 ID（关联 works.style_id）
  continuity_status: varchar('continuity_status', { length: 30 }).notNull().default('pending'), // pending/continuity_checking/passed/warning/qc_failed/regenerating
  frame_mode: varchar('frame_mode', { length: 20 }).notNull().default('single'), // single=主流单帧驱动 / dual=首尾双帧 / video_tail=视频末帧续接
  world_state: varchar('world_state', { length: 500 }).notNull().default(''), // 前序不可逆世界状态锁（如门已敞开、人物已在地面等）
  created_at: datetime('created_at').notNull(),
  updated_at: datetime('updated_at').notNull(),
}, (table) => ({
  shotKeyUk: uniqueIndex('uk_storyboard_shot_key').on(table.shot_key),
  chapterIdx: index('idx_storyboard_chapter').on(table.chapter_id),
}))

// ============================================
// 转场决策表（记录相邻分镜的智能转场类型、时长与决策依据）
// ============================================
export const transition_decision = mysqlTable('transition_decision', {
  id: int('id').autoincrement().primaryKey(),
  chapter_id: int('chapter_id').notNull(),
  from_shot: varchar('from_shot', { length: 64 }).notNull(),
  to_shot: varchar('to_shot', { length: 64 }).notNull(),
  type: varchar('type', { length: 50 }).notNull().default('硬切'),
  duration: double('duration').notNull().default(0),
  reason: varchar('reason', { length: 500 }).notNull().default(''),
  created_at: datetime('created_at').notNull(),
}, (table) => ({
  chapterPairUk: uniqueIndex('uk_transition_decision_pair').on(table.chapter_id, table.from_shot, table.to_shot),
  chapterIdx: index('idx_transition_decision_chapter').on(table.chapter_id),
}))

// ============================================
// 成片与分镜自动质检记录表（黑帧/静音/音画同步/字幕溢出/连贯性达标度）
// ============================================
export const qc_record = mysqlTable('qc_record', {
  id: int('id').autoincrement().primaryKey(),
  render_id: varchar('render_id', { length: 64 }).notNull(),
  chapter_id: int('chapter_id'),
  panel_idx: int('panel_idx'),
  check_item: varchar('check_item', { length: 64 }).notNull(), // black_frame / audio_silence / av_sync / subtitle_overflow / continuity_norm
  result: varchar('result', { length: 20 }).notNull().default('pass'), // pass / warn / fail
  score: int('score').notNull().default(100),
  regenerate_flag: tinyint('regenerate_flag').notNull().default(0), // 0=不重生成 1=需自动回退重生成
  detail: varchar('detail', { length: 500 }).notNull().default(''),
  created_at: datetime('created_at').notNull(),
}, (table) => ({
  renderIdx: index('idx_qc_record_render').on(table.render_id),
  chapterPanelIdx: index('idx_qc_record_chapter_panel').on(table.chapter_id, table.panel_idx),
}))

// ============================================
// 分镜产物与多版本管理表（对齐 LibTV 节点多版本与局部重跑）
// ============================================
export const shot_assets = mysqlTable('shot_assets', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  work_id: int('work_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  scene_idx: int('scene_idx').notNull(),                             // 场景下标（合成成片为 -1）
  shot_idx: int('shot_idx').notNull(),                               // 镜头下标（合成成片为 -1）
  kind: varchar('kind', { length: 16 }).notNull(),                   // image | video | audio
  role: varchar('role', { length: 16 }).notNull(),                   // start_frame | end_frame | keyframe | clip | tts | compose
  version: int('version').notNull().default(1),
  url: varchar('url', { length: 500 }).notNull(),
  thumb_url: varchar('thumb_url', { length: 500 }).default(''),
  seed: bigint('seed', { mode: 'number' }),
  model: varchar('model', { length: 255 }).default(''),
  params: json('params'),                                            // 生成参数快照
  status: varchar('status', { length: 16 }).notNull().default('done'), // running | done | failed
  is_current: tinyint('is_current').notNull().default(1),            // 当前选用版本（1=当前，0=历史）
  parent_asset_id: bigint('parent_asset_id', { mode: 'number' }),    // 依赖（如尾帧依赖首帧、视频依赖首帧）
  cost: int('cost').notNull().default(0),
  created_at: datetime('created_at').notNull(),
}, (table) => ({
  shotIdx: index('idx_shot').on(table.chapter_id, table.scene_idx, table.shot_idx, table.kind),
  currentIdx: index('idx_current').on(table.chapter_id, table.is_current),
}))
