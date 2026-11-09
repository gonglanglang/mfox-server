import express from "express";
import { patchStoryboardScene } from '../tools/storyboard-patch';
import { resolveCharacterIds } from '../tools/asset-extraction';
import { db, schema } from "../mysqlDb";
import { eq, and, count, desc, isNull, or } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { success, error } from "../tools/response";
import { chapters, volumes } from "../mysqlDb/schema";
import { createImageTask, finishImageTask } from '../tools/image-task';
import { loadStoryboardAssets, validatePanelAssets } from '../tools/storyboard-assets';
import { hydrateFrameUrls } from '../tools/frame-pool';
import { LLMJSON } from '../tools/index';
import { normalizeAspectRatio } from '../config/aspect-ratios';
import { RequestContext } from '@mastra/core/request-context';

const app = express();

/** 身高（厘米）：只接受 30~300 的整数，空串 / 小数 / 越界一律视为未填（null）。 */
function normalizeHeight(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null
    const height = Number(value)
    return Number.isInteger(height) && height >= 30 && height <= 300 ? height : null
}

type ImageStyle = { name: string; description: string; effectImage: string };
type ImageGeneration = { model?: string; quality?: string; resolution?: string };

// 素材字段作为数据传给 Agent；构图和提示词规则由各自的 Agent 管理。
function buildAssetImagePayload(row: any, style: ImageStyle, generation: ImageGeneration) {
    return {
        assetType: row.source_type === 'scene' || row.source_type === 'prop' ? row.source_type : 'persona',
        asset: {
            id: row.id,
            name: row.name || '',
            gender: row.gender || 'unknown',
            age: row.age || '',
            height: row.height ?? null, // 身高（cm）：形象图生成时的体型比例依据
            description: row.description || '',
            detail: row.detail && typeof row.detail === 'object' ? row.detail : {},
            refImages: Array.isArray(row.ref_images) ? row.ref_images : [],
        },
        style,
        generation,
    };
}

// 获取我的作品章节视频列表（聚合：作品 → 卷 → 章节 → 分镜视频状态）
app.get("/videos", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const rows = await db.select()
        .from(schema.works)
        .where(and(eq(schema.works.user_id, userId), isNull(schema.works.deleted_at)))
        .orderBy(desc(schema.works.createdAt));

    const result = await Promise.all(rows.map(async (w) => {
        const vols = await db.select()
            .from(schema.volumes)
            .where(and(eq(schema.volumes.work_id, w.id), isNull(schema.volumes.deleted_at)))
            .orderBy(schema.volumes.volume_no);
        const chs = await db.select()
            .from(schema.chapters)
            .where(and(eq(schema.chapters.work_id, w.id), isNull(schema.chapters.deleted_at)))
            .orderBy(schema.chapters.chapter_no);

        const chapterList = chs.map((ch) => {
            const configs: any[] = Array.isArray(ch.content_configs) ? ch.content_configs : [];
            const total = configs.length;
            const done = configs.filter((c: any) => c.panelStatus === 'done' && c.finalVideoUrl).length;
            // 尚未生成完成（含未开始/生成中/部分完成）一律视为"制作中"
            const videoStatus = total > 0 && done === total ? 'done' : 'making';
            const vol = vols.find(v => v.id === ch.volume_id);
            return {
                id: ch.id,
                title: ch.title,
                volumeTitle: vol?.title || '',
                chapter_no: ch.chapter_no,
                videoStatus, // done=已生成完成, making=制作中
                doneCount: done,
                totalCount: total,
            };
        });

        return {
            workId: w.id,
            workTitle: w.title,
            cover_url: w.cover_url,
            type: w.type,
            chapters: chapterList,
        };
    }));

    return success(res, result);
});

// 获取作品信息（分页，按创建时间倒序）
app.get("/", authMiddleware, async (req, res) => {
    const userId = req.user?.id as number;
    const page = Math.min(100000, Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1));
    const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20));
    const type = typeof req.query.type === "string" ? req.query.type : undefined;

    const conditions: any[] = [eq(schema.works.user_id, userId), isNull(schema.works.deleted_at)];
    if (type && ["长篇", "短篇", "视频", "剧本"].includes(type)) {
        conditions.push(eq(schema.works.type, type as any));
    }
    const where = and(...conditions);

    const [totalRow] = await db.select({ total: count() }).from(schema.works).where(where);
    const rows = await db.select()
        .from(schema.works)
        .where(where)
        .orderBy(desc(schema.works.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

    return success(res, { list: rows, total: totalRow?.total ?? 0 });
})

// ============================================
// 配音管理 (voices)  —  必须在 /:workId 之前，避免被通配路由捕获
// ============================================
app.get("/voices", authMiddleware, async (_req, res) => {
    const rows = await db.select().from(schema.voices).where(isNull(schema.voices.deleted_at)).orderBy(schema.voices.id);
    return success(res, rows);
});

app.post("/voices", authMiddleware, async (_req, res) => {
    const { voice_name, description, example_url, tags, voice_id } = _req.body;
    if (!voice_name) return error(res, "缺少配音名称");
    if (voice_id !== undefined && (typeof voice_id !== 'string' || voice_id.length > 200))
        return error(res, "供应商音色 ID 无效");
    const now = new Date();
    const result = await db.insert(schema.voices).values({
        voice_name, description: description || '', example_url: example_url || '',
        // 供应商音色 ID：TTS 合成时真正传给 MiniMax 的 voice_id；留空则该配音无法用于合成
        voice_id: typeof voice_id === 'string' ? voice_id.trim() : '',
        tags: tags || [], createdAt: now, updatedAt: now,
    } as any);
    return success(res, { id: (result as any).insertId }, "创建成功");
});

app.put("/voices/:id", authMiddleware, async (_req, res) => {
    const id = Number(_req.params.id);
    if (!id) return error(res, "缺少配音ID");
    const { voice_name, description, example_url, tags, voice_id } = _req.body;
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (voice_name !== undefined) updateData.voice_name = voice_name;
    if (description !== undefined) updateData.description = description;
    if (example_url !== undefined) updateData.example_url = example_url;
    if (tags !== undefined) updateData.tags = tags;
    if (voice_id !== undefined) {
        if (typeof voice_id !== 'string' || voice_id.length > 200) return error(res, "供应商音色 ID 无效");
        updateData.voice_id = voice_id.trim();
    }
    await db.update(schema.voices).set(updateData).where(eq(schema.voices.id, id));
    return success(res, null, "更新成功");
});

app.delete("/voices/:id", authMiddleware, async (_req, res) => {
    const id = Number(_req.params.id);
    if (!id) return error(res, "缺少配音ID");
    await db.update(schema.voices).set({ deleted_at: new Date() }).where(eq(schema.voices.id, id));
    return success(res, "删除成功");
});

// 更新作品信息
app.put("/:workId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    // 先检查作品是否存在且属于当前用户
    const existing = await db.select()
        .from(schema.works)
        .where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return error(res, "作品不存在");

    const { title, description, content, type, genre, audience, pov, word_count, read_time, style_id, narration_voice_id, aspect_ratio, use_prev_video, frame_mode } = _req.body;

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (content !== undefined) updateData.content = content;
    if (type !== undefined) updateData.type = type;
    if (genre !== undefined) updateData.genre = genre;
    if (audience !== undefined) updateData.audience = audience;
    if (pov !== undefined) updateData.pov = pov;
    if (word_count !== undefined) updateData.word_count = word_count;
    if (read_time !== undefined) updateData.read_time = read_time;
    if (style_id !== undefined) {
        // 画风只能选官方内置或本人自定义，避免引用他人画风
        if (style_id === null) {
            updateData.style_id = null;
        } else {
            const styleValue = Number(style_id);
            if (!Number.isSafeInteger(styleValue) || styleValue <= 0) return error(res, "无效的画风 ID");
            const [style] = await db.select({ id: schema.visualStyles.id }).from(schema.visualStyles)
                .where(and(eq(schema.visualStyles.style_id, styleValue),
                    or(isNull(schema.visualStyles.user_id), eq(schema.visualStyles.user_id, userId))))
                .limit(1);
            if (!style) return error(res, "画风不存在");
            updateData.style_id = styleValue;
        }
    }
    if (narration_voice_id !== undefined) updateData.narration_voice_id = narration_voice_id;
    if (use_prev_video !== undefined) updateData.use_prev_video = Number(use_prev_video) ? 1 : 0;
    if (frame_mode !== undefined && ['single', 'dual', 'video_tail'].includes(String(frame_mode))) {
        updateData.frame_mode = String(frame_mode);
    }
    if (aspect_ratio !== undefined) {
        // 视口宽高比：只接受白名单取值（分辨率由所选模型决定，不在这里设置）
        const ratio = normalizeAspectRatio(aspect_ratio);
        if (!ratio) return error(res, "无效的视口宽高比");
        updateData.aspect_ratio = ratio;
    }

    await db.update(schema.works)
        .set(updateData)
        .where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)));

    return success(res, "更新成功");
});

// 设置封面
app.patch("/:workId/cover", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    const { cover_url } = _req.body;
    if (!cover_url) return error(res, "缺少封面URL");

    const existing = await db.select()
        .from(schema.works)
        .where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return error(res, "作品不存在");

    await db.update(schema.works)
        .set({ cover_url, updatedAt: new Date() })
        .where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)));

    return success(res, "封面设置成功");
});

// 删除作品
app.delete("/:workId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID")
    await db.update(schema.works).set({ deleted_at: new Date() }).where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)));
    return success(res, "删除成功");
})

// 获取作品详情（含卷章嵌套结构）
app.get("/:workId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    // 1. 查作品
    const works = await db.select()
        .from(schema.works)
        .where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)))
        .limit(1);

    if (works.length === 0) return error(res, "作品不存在");

    const work = works[0];

    // 2. 查该作品的所有卷（按 volume_no 排序）
    const volumes = await db.select()
        .from(schema.volumes)
        .where(and(eq(schema.volumes.work_id, workId), isNull(schema.volumes.deleted_at)))
        .orderBy(schema.volumes.volume_no);

    // 3. 查每卷的章节（按 chapter_no 排序）
    const chapters = true
        ? await db.select()
            .from(schema.chapters)
            .where(and(eq(schema.chapters.work_id, workId), isNull(schema.chapters.deleted_at)))
            .orderBy(schema.chapters.chapter_no)
        : [];

    // 4. 组装嵌套结构；素材引用历史仅供服务端追溯，不下发到编辑器。
    //    关键帧以帧池引用（start_frame_id / end_frame_id）落库，下发前解析成 firstFrameUrl / lastFrameUrl。
    const toClientChapter = (chapter: typeof chapters[number]) => ({
        ...chapter,
        content_configs: Array.isArray(chapter.content_configs)
            ? hydrateFrameUrls(chapter.content_configs as any[])
                .map(({ assetReferenceHistory: _history, ...panel }) => panel)
            : chapter.content_configs,
    });
    const result = {
        ...work,
        volumes: volumes.map(vol => ({
            ...vol,
            chapters: chapters.filter(ch => ch.volume_id === vol.id).map(toClientChapter),
        })),
        // 没挂卷的章节也带上
        unlinkedChapters: chapters.filter(ch => ch.volume_id === null).map(toClientChapter),
    };

    return success(res, result);
});

// 添加卷
export const createVolumes = async (workId: number, userId: number) => {
    // 先检查作品是否存在且属于当前用户
    const existing = await db.select()
        .from(schema.works)
        .where(and(eq(schema.works.id, workId), eq(schema.works.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return { volumeId: -1, chaptersId: -1 };

    // 获取作品卷数量
    const volumeCount = await db.select({ value: count() })
        .from(schema.volumes)
        .where(and(eq(schema.volumes.work_id, workId), isNull(schema.volumes.deleted_at)));

    const nextVolumeNo = (volumeCount[0]?.value || 0) + 1;

    console.log('作品卷数量:', volumeCount[0]?.value, '下一卷序号:', nextVolumeNo);

    const [row_volumes] = await db.insert(schema.volumes).values({
        work_id: workId,
        user_id: userId,
        title: `第${nextVolumeNo}卷`,
        description: "",
        volume_no: nextVolumeNo,
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    const [row_chapters] = await db.insert(schema.chapters).values({
        work_id: workId,
        volume_id: row_volumes.insertId,
        user_id: userId,
        title: "第一章",
        chapter_no: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    return { volumeId: row_volumes.insertId, chaptersId: row_chapters.insertId }
}
app.post("/:workId/volumes", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    const row = await createVolumes(workId, userId)

    if (!row) {
        return error(res, "作品不存在")
    }

    return success(res, row);
});

// 修改卷信息
app.put("/:workId/volumes/:volumeId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const volumeId = Number(_req.params.volumeId);
    if (!workId || !volumeId) return error(res, "缺少作品ID或卷ID");

    // 先检查卷是否存在且属于当前用户
    const existing = await db.select()
        .from(schema.volumes)
        .where(and(eq(schema.volumes.id, volumeId), eq(schema.volumes.work_id, workId), eq(schema.volumes.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return error(res, "卷不存在");

    const { title, description, volume_no } = _req.body;

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (volume_no !== undefined) updateData.volume_no = volume_no;

    await db.update(schema.volumes)
        .set(updateData)
        .where(and(eq(schema.volumes.id, volumeId), eq(schema.volumes.work_id, workId), eq(schema.volumes.user_id, userId)));

    return success(res, "更新成功");
});

// 删除卷
app.delete("/:workId/volumes/:volumeId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const volumeId = Number(_req.params.volumeId);
    if (!workId || !volumeId) return error(res, "缺少作品ID或卷ID");

    // 先检查卷是否存在且属于当前用户
    const existing = await db.select()
        .from(schema.volumes)
        .where(and(eq(schema.volumes.id, volumeId), eq(schema.volumes.work_id, workId), eq(schema.volumes.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return error(res, "卷不存在");

    await db.update(schema.volumes)
        .set({ deleted_at: new Date() })
        .where(and(eq(schema.volumes.id, volumeId), eq(schema.volumes.work_id, workId), eq(schema.volumes.user_id, userId)));

    return success(res, "删除成功");
});

// 修改章节信息
app.put("/:workId/chapters/:chapterId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const chapterId = Number(_req.params.chapterId);
    if (!workId || !chapterId) return error(res, "缺少作品ID或章节ID");

    // 先检查章节是否存在且属于当前用户
    const existing = await db.select()
        .from(schema.chapters)
        .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return error(res, "章节不存在");

    const { title, content, chapter_no, word_count, status, content_configs } = _req.body;

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;
    if (chapter_no !== undefined) updateData.chapter_no = chapter_no;
    if (word_count !== undefined) updateData.word_count = word_count;
    if (status !== undefined) updateData.status = status;
    try {
      await db.transaction(async tx => {
        const [latest] = await tx.select().from(schema.chapters)
          .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId)))
          .for('update');
        if (!latest) throw new Error('章节不存在');
    if (content_configs !== undefined) {
        if (!Array.isArray(content_configs)) throw new Error('分镜配置必须为数组');
            const assets = await loadStoryboardAssets(workId, chapterId, userId);
            // 旧标签页可能尚未传新字段，保留关联；生成历史只以服务端为准。
            const previous = Array.isArray(latest.content_configs) ? latest.content_configs as any[] : [];
            updateData.content_configs = content_configs.map((panel: any) => {
                const prior = previous.find(item => item.panelIdx === panel.panelIdx);
                // 活跃任务（视频 / 重绘）由后台管理，其他分镜的整表保存不能回滚它
                if (prior?.panelStatus === 'generating' && (prior._task === 'video' || prior._task === 'redraw')) return prior;
                const merged = { ...prior, ...panel,
                    videoTaskId: prior?.videoTaskId,
                    scene_id: panel.scene_id === undefined ? prior?.scene_id ?? null : panel.scene_id,
                    prop_ids: panel.prop_ids === undefined ? prior?.prop_ids || [] : panel.prop_ids,
                    assetReferenceHistory: prior?.assetReferenceHistory || [],
                };
                validatePanelAssets(merged, assets);
                return merged;
            });
    }

    await tx.update(schema.chapters)
        .set(updateData)
        .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId)));
      });
    } catch (err: any) { return error(res, err.message || '保存章节失败'); }

    return success(res, "更新成功");
});

// 生成状态（panelStatus）由服务端与后台任务维护，不接受客户端写入，避免覆盖进行中的任务
const editablePanelFields = [
    'scene_id', 'prop_ids', 'environment', 'roles', 'durShort', 'shot_size',
    'camera_angle', 'camera_movement',
    'videoPrompt', 'frame_mode', 'world_state', 'start_prompt', 'end_prompt', 'negative_prompt', 'sound_effect'
] as const;

// 场景与镜头分别增量保存，以数组位置定位；scene_id 是素材 ID，可重复。
app.patch([
    '/:workId/chapters/:chapterId/scenes/:sceneIdx',
    '/:workId/chapters/:chapterId/scenes/:sceneIdx/shots/:shotIdx',
], authMiddleware, async (req, res) => {
    const userId = req.user?.id as number;
    const workId = Number(req.params.workId);
    const chapterId = Number(req.params.chapterId);
    const sceneIdx = Number(req.params.sceneIdx);
    const shotIdx = req.params.shotIdx === undefined ? undefined : Number(req.params.shotIdx);
    if (![workId, chapterId].every(id => Number.isSafeInteger(id) && id > 0) ||
        !Number.isSafeInteger(sceneIdx) || sceneIdx < 0 ||
        (shotIdx !== undefined && (!Number.isSafeInteger(shotIdx) || shotIdx < 0))) {
        return error(res, '无效的作品、章节或镜头索引');
    }
    try {
        const assets = await loadStoryboardAssets(workId, chapterId, userId);
        const updated = await db.transaction(async tx => {
            const [chapter] = await tx.select().from(schema.chapters).where(and(
                eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId),
                eq(schema.chapters.user_id, userId),
            )).for('update');
            if (!chapter) throw new Error('章节不存在');
            const result = patchStoryboardScene(Array.isArray(chapter.content_configs) ? chapter.content_configs : [], sceneIdx, shotIdx, req.body);
            validatePanelAssets(result.scene, assets);
            if (shotIdx !== undefined && Object.prototype.hasOwnProperty.call(req.body, 'roles')) {
                const roles = { roles: result.updated.roles };
                validatePanelAssets(roles, assets);
                result.updated.roles = roles.roles;
            }
            if (shotIdx !== undefined && Object.prototype.hasOwnProperty.call(req.body, 'dialogue')) {
                for (const line of result.updated.dialogue) {
                    if (line.id !== '' && !assets.some(a => a.source_type === 'persona' && a.id === Number(line.id))) {
                        throw new Error('对白引用了无效角色');
                    }
                }
            }
            await tx.update(schema.chapters).set({ content_configs: result.configs, updatedAt: new Date() }).where(and(
                eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId),
            ));
            return result.updated;
        });
        return success(res, updated, '保存成功');
    } catch (err: any) { return error(res, err.message || '保存失败'); }
});

// 增量保存单个分镜，避免每次编辑都回传整章及服务端生成数据。
app.patch("/:workId/chapters/:chapterId/panels/:panelIdx", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const chapterId = Number(_req.params.chapterId);
    const panelIdx = Number(_req.params.panelIdx);
    if (!workId || !chapterId || !Number.isInteger(panelIdx) || panelIdx < 0) {
        return error(res, "缺少有效的作品ID、章节ID或分镜索引");
    }

    const patch: Record<string, unknown> = {};
    for (const field of editablePanelFields) {
        if (Object.prototype.hasOwnProperty.call(_req.body, field)) patch[field] = _req.body[field];
    }
    if (Object.keys(patch).length === 0) return error(res, "没有可更新的分镜字段");

    try {
        const assets = await loadStoryboardAssets(workId, chapterId, userId);
        const updatedPanel = await db.transaction(async tx => {
            const [chapter] = await tx.select().from(schema.chapters)
                .where(and(
                    eq(schema.chapters.id, chapterId),
                    eq(schema.chapters.work_id, workId),
                    eq(schema.chapters.user_id, userId),
                ))
                .for('update');
            if (!chapter) throw new Error('章节不存在');

            const panels = Array.isArray(chapter.content_configs)
                ? [...chapter.content_configs as any[]]
                : [];
            const position = panels.findIndex((panel, index) => (panel?.panelIdx ?? index) === panelIdx);
            if (position < 0) throw new Error('分镜不存在');

            const panel = { ...panels[position], ...patch };
            validatePanelAssets(panel, assets);
            panels[position] = panel;

            await tx.update(schema.chapters)
                .set({ content_configs: panels, updatedAt: new Date() })
                .where(and(
                    eq(schema.chapters.id, chapterId),
                    eq(schema.chapters.work_id, workId),
                    eq(schema.chapters.user_id, userId),
                ));
            return panel;
        });
        return success(res, updatedPanel, "分镜保存成功");
    } catch (err: any) {
        return error(res, err.message || '保存分镜失败');
    }
});

// 删除单个镜头（树形形态：以场景内数组位置定位，删除后数组自然重排）
app.delete('/:workId/chapters/:chapterId/scenes/:sceneIdx/shots/:shotIdx', authMiddleware, async (req, res) => {
    const userId = req.user?.id as number;
    const workId = Number(req.params.workId);
    const chapterId = Number(req.params.chapterId);
    const sceneIdx = Number(req.params.sceneIdx);
    const shotIdx = Number(req.params.shotIdx);
    if (![workId, chapterId].every(id => Number.isSafeInteger(id) && id > 0)
        || !Number.isSafeInteger(sceneIdx) || sceneIdx < 0
        || !Number.isSafeInteger(shotIdx) || shotIdx < 0) {
        return error(res, '无效的作品、章节或镜头索引');
    }
    try {
        const remaining = await db.transaction(async tx => {
            const [chapter] = await tx.select().from(schema.chapters).where(and(
                eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId),
                eq(schema.chapters.user_id, userId),
            )).for('update');
            if (!chapter) throw new Error('章节不存在');
            const configs = Array.isArray(chapter.content_configs) ? [...chapter.content_configs as any[]] : [];
            const scene = configs[sceneIdx];
            if (!scene || !Array.isArray(scene.shots)) throw new Error('分镜数据格式无效');
            if (shotIdx >= scene.shots.length) throw new Error('镜头不存在');
            scene.shots = scene.shots.filter((_shot: any, index: number) => index !== shotIdx);
            await tx.update(schema.chapters).set({ content_configs: configs, updatedAt: new Date() }).where(and(
                eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId),
            ));
            return scene.shots.length;
        });
        return success(res, { remaining }, '已删除该镜头');
    } catch (err: any) {
        return error(res, err.message || '删除镜头失败');
    }
});

// 删除单个分镜（扁平形态：寻找 panelIdx 对应项后移除，并重排索引）
app.delete('/:workId/chapters/:chapterId/panels/:panelIdx', authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const chapterId = Number(_req.params.chapterId);
    const panelIdx = Number(_req.params.panelIdx);
    if (!workId || !chapterId || !Number.isInteger(panelIdx) || panelIdx < 0) {
        return error(res, "缺少有效的作品ID、章节ID或分镜索引");
    }
    try {
        const remaining = await db.transaction(async tx => {
            const [chapter] = await tx.select().from(schema.chapters).where(and(
                eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId),
                eq(schema.chapters.user_id, userId),
            )).for('update');
            if (!chapter) throw new Error('章节不存在');
            const panels = Array.isArray(chapter.content_configs) ? [...chapter.content_configs as any[]] : [];
            const position = panels.findIndex((panel, index) => (panel?.panelIdx ?? index) === panelIdx);
            if (position < 0) throw new Error('分镜不存在');
            panels.splice(position, 1);
            // 扁平形态的 panelIdx 是持久字段：删除后必须重排，否则后续按索引定位会整体错位
            panels.forEach((panel, index) => { if (panel && typeof panel === 'object') panel.panelIdx = index });
            await tx.update(schema.chapters).set({ content_configs: panels, updatedAt: new Date() }).where(and(
                eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId),
            ));
            return panels.length;
        });
        return success(res, { remaining }, '已删除该分镜');
    } catch (err: any) {
        return error(res, err.message || '删除分镜失败');
    }
});

// 删除章节
app.delete("/:workId/chapters/:chapterId", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const chapterId = Number(_req.params.chapterId);
    if (!workId || !chapterId) return error(res, "缺少作品ID或章节ID");

    // 先检查章节是否存在且属于当前用户
    const existing = await db.select()
        .from(schema.chapters)
        .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId)))
        .limit(1);

    if (existing.length === 0) return error(res, "章节不存在");

    await db.update(schema.chapters)
        .set({ deleted_at: new Date() })
        .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId)));

    return success(res, "删除成功");
});

// 添加章节（可指定 volume_id）
app.post("/:workId/chapters", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    const { title, volume_id } = _req.body;
    if (!title) return error(res, "缺少章节标题");

    const now = new Date();
    const result = await db.insert(schema.chapters).values({
        work_id: workId,
        user_id: userId,
        volume_id: volume_id || null,
        title,
        content: "",
        chapter_no: 0,
        word_count: 0,
        createdAt: now,
        updatedAt: now,
    } as any);

    return success(res, { id: (result as any).insertId }, "创建成功");
})

// ============================================
// 人物/场景/道具素材 (personas)
// ============================================

// 获取素材列表（按作品，可选按章节/类型过滤）
app.get("/:workId/personas", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    const { chapters_id, source_type } = _req.query;
    const where: any[] = [eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId), isNull(schema.personas.deleted_at)];

    if (chapters_id) where.push(source_type === 'scene' ? eq(schema.personas.chapters_id, Number(chapters_id)) : or(eq(schema.personas.chapters_id, Number(chapters_id)), isNull(schema.personas.chapters_id)));
    if (source_type && ['persona', 'scene', 'prop'].includes(source_type as string)) {
      where.push(eq(schema.personas.source_type, source_type as 'persona' | 'scene' | 'prop'));
    }

    const rows = await db.select()
        .from(schema.personas)
        .where(and(...where))
        .orderBy(schema.personas.id);
    const roles = await db.select({ id: schema.personas.id, name: schema.personas.name })
        .from(schema.personas).where(and(eq(schema.personas.work_id, workId),
            eq(schema.personas.user_id, userId), eq(schema.personas.source_type, 'persona'), isNull(schema.personas.deleted_at)));
    for (const row of rows) {
        if (row.source_type !== 'scene' || !row.detail || typeof row.detail !== 'object') continue;
        const detail = row.detail as Record<string, unknown>;
        if (!Array.isArray(detail.characters)) continue;
        const { ids, unresolved } = resolveCharacterIds(detail.characters, roles);
        row.detail = { ...detail, characters: ids, unresolved_characters: unresolved };
    }
    return success(res, rows);
});

// 创建素材
app.post("/:workId/personas", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    if (!workId) return error(res, "缺少作品ID");

    const { chapters_id, name, source_type, gender, age, height, images, images_history, voice_id, description, ref_images, detail } = _req.body;
    if (source_type === 'scene' && !chapters_id) return error(res, "缺少关联章节ID");
    if (!name) return error(res, "缺少名称");

    const now = new Date();
    const result = await db.insert(schema.personas).values({
        work_id: workId,
        user_id: userId,
        chapters_id: chapters_id || null,
        name: name || '',
        source_type: source_type || 'persona',
        gender: gender || 'unknown',
        age: age || '',
        height: normalizeHeight(height),
        images: images || [],
        images_history: images_history || [],
        cur_image_id: '',
        voice_id: voice_id || null,
        description: description || '',
        detail: detail || null,
        ref_images: ref_images || [],
        createdAt: now,
        updatedAt: now,
    } as any);

    return success(res, { id: (result as any).insertId }, "创建成功");
});

// 更新素材
app.put("/:workId/personas/:id", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const id = Number(_req.params.id);
    if (!workId || !id) return error(res, "缺少参数");

    const existing = await db.select()
        .from(schema.personas)
        .where(and(eq(schema.personas.id, id), eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId)))
        .limit(1);
    if (existing.length === 0) return error(res, "素材不存在");

    const { name, source_type, gender, age, height, images, images_history, chapters_id, voice_id, description, ref_images, cur_image_id, detail } = _req.body;
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (source_type !== undefined) updateData.source_type = source_type;
    if (gender !== undefined) updateData.gender = gender;
    if (age !== undefined) updateData.age = age;
    if (height !== undefined) updateData.height = normalizeHeight(height);
    if (images !== undefined) updateData.images = images;
    if (images_history !== undefined) updateData.images_history = images_history;
    if (chapters_id !== undefined) updateData.chapters_id = chapters_id;
    if (voice_id !== undefined) updateData.voice_id = voice_id;
    if (description !== undefined) updateData.description = description;
    if (detail !== undefined) updateData.detail = detail;
    if (ref_images !== undefined) updateData.ref_images = ref_images;
    if (cur_image_id !== undefined) updateData.cur_image_id = cur_image_id;

    await db.update(schema.personas)
        .set(updateData)
        .where(and(eq(schema.personas.id, id), eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId)));

    return success(res, null, "更新成功");
});

// 删除素材
app.delete("/:workId/personas/:id", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const id = Number(_req.params.id);
    if (!workId || !id) return error(res, "缺少参数");

    await db.update(schema.personas)
        .set({ deleted_at: new Date() })
        .where(and(eq(schema.personas.id, id), eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId)));

    return success(res, "删除成功");
});

// 生成描述只返回草稿，用户应用表单后才保存。
app.post("/:workId/personas/:id/generate-description", authMiddleware, async (_req, res) => {
    const userId = _req.user?.id as number;
    const workId = Number(_req.params.workId);
    const id = Number(_req.params.id);
    const { textModel, name, gender, age, description, chapterId: reqChapterId } = _req.body || {};
    if (!Number.isSafeInteger(workId) || workId <= 0 || !Number.isSafeInteger(id) || id <= 0) return error(res, '无效的角色或作品ID');
    if (typeof textModel !== 'string' || !textModel.trim()) return error(res, '请选择文本模型');
    if (typeof name !== 'string' || !name.trim() || name.length > 255
        || !['male', 'female', 'unknown'].includes(gender)
        || typeof age !== 'string' || age.length > 100
        || typeof description !== 'string' || description.length > 10000) return error(res, '角色信息格式不正确');
    try {
        const [persona] = await db.select().from(schema.personas).where(and(
            eq(schema.personas.id, id), eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId),
        )).limit(1);
        if (!persona || persona.source_type !== 'persona') return error(res, '角色不存在');
        const [chapter] = await db.select().from(schema.chapters).where(and(
            ...(Number(reqChapterId || persona.chapters_id) > 0 ? [eq(schema.chapters.id, Number(reqChapterId || persona.chapters_id))] : []), eq(schema.chapters.work_id, workId), isNull(schema.chapters.deleted_at),
            eq(schema.chapters.user_id, userId),
        )).limit(1);
        if (!chapter || chapter.deleted_at || !chapter.content?.trim()) return error(res, '请先填写角色所属章节的剧本内容');
        const { mastra } = await import('../mastra/index');
        const requestContext = new RequestContext();
        requestContext.set('aiModel', textModel.trim());
        const result = await mastra.getAgent('CharacterDescriptionAgent').generate(JSON.stringify({
            character: { name: name.trim(), gender, age, description },
            script: { title: chapter.title, content: chapter.content },
        }), { requestContext, maxSteps: 1 });
        const generated = result.text?.trim();
        if (!generated) return error(res, '未生成有效角色描述，请重试');
        // 描述正文 + 结构化身高一起返回：身高自动回填表单，并作为后续人物尺度的锚点
        const parsed = LLMJSON(generated) as any
        const descriptionText = typeof parsed?.description === 'string' && parsed.description.trim()
            ? parsed.description.trim() : generated
        return success(res, { description: descriptionText, heightCm: normalizeHeight(parsed?.heightCm) }, '角色描述生成成功');
    } catch (e: any) {
        return error(res, e.message || '角色描述生成失败');
    }
});

// AI 预览生成形象图（创建表单中预览，无需已保存的 persona）
app.post("/:workId/personas/preview-image", authMiddleware, async (_req, res) => {
    const { name, gender, age, description, refImageUrl } = _req.body;
    if (!description) return error(res, "缺少描述信息");

    try {
        const { mastra: m } = await import('../mastra/index');
        const agent: any = m.getAgent('CharacterImageAgent');
        const payload = buildAssetImagePayload({
            name: name || '未知', gender, age, description,
            ref_images: refImageUrl ? [refImageUrl] : [],
        }, { name: '', description: '', effectImage: '' }, {});
        const result = await agent.generate(JSON.stringify(payload));

        console.log("工具返回图片信息:", result)

        // 优先从工具调用结果中直接提取 imageUrl 与错误信息，避免 LLM 总结漏写 URL 或吞掉底层报错
        const toolOutputs: any[] = [
          ...(Array.isArray(result?.toolResults) ? result.toolResults : []),
          ...(Array.isArray(result?.steps) ? result.steps.flatMap((s: any) => s?.toolResults || []) : []),
        ].map((tr: any) => tr?.result ?? tr?.payload?.result ?? tr);
        const toolSuccessUrl = toolOutputs
          .map((o: any) => o?.imageUrl || (Array.isArray(o?.images) ? o.images[0] : ''))
          .find((u: any) => typeof u === 'string' && u.startsWith('http'));
        const toolError = toolOutputs
          .map((o: any) => o?.error)
          .find((err: any) => typeof err === 'string' && err.trim());
        const text = result.text || '';
        const urlMatch = text.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i);
        const finalPreviewUrl = toolSuccessUrl || urlMatch?.[0] || '';
        if (!finalPreviewUrl || finalPreviewUrl.includes('dry-run.invalid')) {
          return error(res, `未能生成：${toolError || text.slice(0, 200) || '处于 DRY_RUN 模式'}`);
        }
        return success(res, { imageUrl: finalPreviewUrl }, "生成成功");

    } catch (e: any) {
        return error(res, e.message || '生成失败');
    }
});

// 调用 AI 生成人物形象图（异步：先创建占位图 → 立即返回 → 后台生成）
app.post("/:workId/personas/:id/generate-image", authMiddleware, async (_req, res) => {
    const personaId = Number(_req.params.id);
    const workId = Number(_req.params.workId);
    const userId = _req.user?.id as number;
    const aiModel = _req.headers.aimodel as string | undefined;
    const { textModel, quality, resolution } = _req.body || {};
    if (!personaId) return error(res, "缺少参数");
    if (typeof textModel !== 'string' || !textModel) return error(res, "请选择文本模型");
    if (!aiModel) return error(res, "请选择图片模型");
    const tier = String(resolution || quality || '').trim();
    if (!tier) return error(res, "请选择图片分辨率");

    const [row] = await db.select().from(schema.personas).where(and(
        eq(schema.personas.id, personaId),
        eq(schema.personas.work_id, workId),
        eq(schema.personas.user_id, userId),
    )).limit(1);
    if (!row) {
        return error(res, "素材不存在");
    }

    // 获取画风信息
    let effectImage = '';
    let styleName = '';
    let styleDescription = '';
    if (row.work_id) {
      const [w] = await db.select().from(schema.works).where(eq(schema.works.id, row.work_id)).limit(1);
      if (w && (w as any).style_id) {
        const [style] = await db.select().from(schema.visualStyles).where(eq(schema.visualStyles.style_id, (w as any).style_id)).limit(1);
        if (style) {
          effectImage = style.effect_image || '';
          styleName = style.name || '';
          styleDescription = style.description || '';
        }
      }
    }

    try {
      const task = await createImageTask({
        userId, workId, personaId, textModel, model: aiModel, quality: quality || tier, resolution: resolution || tier,
        router: _req.headers['x-router-path'] as string || '',
      });
      void startBackgroundGeneration(task.row, task.taskId, {
        effectImage,
        name: styleName,
        description: styleDescription,
      }, { model: aiModel, quality: quality || tier, resolution: resolution || tier }, userId, textModel)
        .catch(err => console.error('图片任务结算失败:', err.message));
      return success(res, { taskId: task.taskId, placeholderId: task.placeholderId }, "开始生成");
    } catch (err: any) {
      return error(res, err.message || '创建图片任务失败');
    }
});

async function startBackgroundGeneration(
    row: any,
    taskId: string,
    style: ImageStyle,
    generation: ImageGeneration,
    userId: number,
    textModel: string,
) {
    const payload = buildAssetImagePayload(row, style, generation);
    let imageUrl = '';
    let message = '';
    try {
        const { mastra: m } = await import('../mastra/index');
        const agentName = payload.assetType === 'scene' ? 'SceneImageAgent'
            : payload.assetType === 'prop' ? 'PropImageAgent' : 'CharacterImageAgent';

        console.log("生成角色/ 场景/ 物品图片:", payload)
        const agent: any = m.getAgent(agentName);
        const requestContext = new RequestContext();
        requestContext.set('aiModel', textModel);
        const result = await agent.generate(JSON.stringify(payload), { requestContext });
        // 优先从工具调用结果中直接提取 imageUrl 与错误信息，避免 LLM 总结漏写 URL 或吞掉底层报错
        const toolOutputs: any[] = [
          ...(Array.isArray(result?.toolResults) ? result.toolResults : []),
          ...(Array.isArray(result?.steps) ? result.steps.flatMap((s: any) => s?.toolResults || []) : []),
        ].map((tr: any) => tr?.result ?? tr?.payload?.result ?? tr);
        const toolSuccessUrl = toolOutputs
          .map((o: any) => o?.imageUrl || (Array.isArray(o?.images) ? o.images[0] : ''))
          .find((u: any) => typeof u === 'string' && u.startsWith('http'));
        const toolError = toolOutputs
          .map((o: any) => o?.error)
          .find((err: any) => typeof err === 'string' && err.trim());
        const text = result.text || '';
        const urlMatch = text.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i);
        const rawUrl = toolSuccessUrl || urlMatch?.[0] || '';
        if (rawUrl.includes('dry-run.invalid')) {
          imageUrl = '';
          message = '当前处于 DRY_RUN 调试模式（未实际请求供应商出图），已自动退还积分';
        } else {
          imageUrl = rawUrl;
          message = imageUrl ? (text || imageUrl) : (toolError || '图片生成未返回有效图片');
        }

    } catch (e: any) {
        console.error('后台生成失败:', e.message);
        message = e.message || '图片生成失败';
    }
    // 完成图片任务 生成成功，更新图片 URL
    await finishImageTask({ taskId, userId, imageUrl, message });
}

export default app;
