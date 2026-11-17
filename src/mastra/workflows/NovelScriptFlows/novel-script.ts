import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { RequestContext } from '@mastra/core/request-context'
import { db, schema } from '../../../mysqlDb'
import { eq, and } from 'drizzle-orm'
import { normalizeShotLink } from '../../../tools/storyboard-text'
import { enrichChapterContinuity } from '../../../tools/shot-continuity'
import { decideShotTransitions, syncContinuityAndTransitionsToDb } from '../../../tools/transition-decision'
import { saveQcRecordsToDb } from '../../../tools/video-qc'
import { loadWorkStyleProfile } from '../../../tools/storyboard-assets'
import { retryWithValidation, safeJsonParse } from '../../../tools/animahub-json'
import {
    estimateChapterStoryboardPlan,
    parseAnimaHubStoryboardOutput,
    synthesizeChapterContextualPrompts,
} from '../../../tools/animahub-storyboard'
import { enums } from '../../../routes/settings'
import { loadStoryboardEvidence } from '../../../tools/storyboard-evidence'

// 拆分剧本输入输出格式
const narrationTs = z.object({
    configs: z.array(z.any()).describe('分镜配置数组'),
    chapterId: z.number().describe('章节 ID'),
    workId: z.number().describe('作品 ID'),
    userId: z.number().describe('用户 ID'),
    roles: z.array(z.any()).optional().describe('当前分镜引用的角色对象，无角色时省略'),
    scene: z.array(z.any()).optional().describe('当前分镜引用的场景对象，含描述与图片 URL'),
    props: z.array(z.any()).optional().describe('当前分镜引用的道具对象，含描述与图片 URL'),
    assets: z.array(z.any()).optional().describe('分镜资产数组'),
    styleProfile: z.object({ prompt: z.string(), referenceUrl: z.string() }).optional().describe('章节级全局风格锚（StyleProfile）'),
    requestContext: z.instanceof(RequestContext).describe('请求上下文')
})

// 章节剧本化：先把小说原文改写成台词完整、动作可拍的漫剧剧本，再交给分镜拆解。
// 注入 AnimaHub 节奏控制指令（黄金钩子 + 推进节拍 + 悬念收束）与校验反馈重试。
const writeChapterScriptStep = createStep({
    id: 'write-chapter-script-step',
    inputSchema: z.object({
        text: z.string().describe('章节原文'),
        chapterId: z.number().describe('章节 ID'),
        workId: z.number().describe('作品 ID'),
        userId: z.number().describe('用户 ID'),
        requestContext: z.instanceof(RequestContext).describe('请求上下文')
    }),
    outputSchema: z.object({
        text: z.string().describe('剧本化后的文本（供分镜拆解使用）'),
        originalText: z.string().describe('章节原文，便于对照排查'),
        chapterId: z.number().describe('章节 ID'),
        workId: z.number().describe('作品 ID'),
        userId: z.number().describe('用户 ID'),
        requestContext: z.instanceof(RequestContext).describe('请求上下文')
    }),
    execute: async ({ inputData, mastra }) => {
        const ChapterScriptWriterAgent = mastra.getAgent("ChapterScriptWriterAgent")
        if (!ChapterScriptWriterAgent) throw new Error('Agent ChapterScriptWriterAgent 未注册')

        const rhythmPlan = estimateChapterStoryboardPlan(inputData.text)
        console.log(
            `开始章节剧本化，原文长度: ${inputData.text.length}，AnimaHub 节奏规划目标镜头数: ${rhythmPlan.targetShots}（${rhythmPlan.minShots}~${rhythmPlan.maxShots}）`,
        )

        const script = await retryWithValidation(
            async (attempt, lastError) => {
                const promptInput = [
                    inputData.text,
                    '',
                    rhythmPlan.rhythmDirective,
                    ...(lastError ? [`【第 ${attempt} 次重试修正要求】：上一轮输出未通过校验（${lastError}），请输出完整、可拍摄的章节剧本正文。`] : []),
                ].join('\n')

                const stream = await ChapterScriptWriterAgent.stream(promptInput, {
                    maxSteps: 1,
                    requestContext: inputData.requestContext,
                    onFinish: () => console.log(`章节剧本化完成（第 ${attempt} 次）`),
                })

                let acc = ''
                for await (const chunk of stream.textStream) {
                    process.stdout.write(chunk)
                    acc += chunk
                }
                return acc.trim()
            },
            (raw) => {
                if (!raw || raw.length < 20) {
                    return { ok: false, error: '章节剧本化输出为空或过短' }
                }
                return { ok: true, value: raw }
            },
            { maxAttempts: 2, baseDelayMs: 400 },
        )

        console.log(`\n剧本化完成：${inputData.text.length} 字 → ${script.length} 字`)
        return { ...inputData, text: script, originalText: inputData.text }
    },
})

// 初始化拆分剧本步骤（AnimaHub 节奏引导 + JSON/标签双模自愈解析 + 错误反馈重试 + 受控并发单场拆解）
const extractNovelScriptStep = createStep({
    id: 'extract-novel-script-step',
    inputSchema: z.object({
        text: z.string().describe('待拆分的分镜文本'),
        chapterId: z.number().describe('章节 ID'),
        workId: z.number().describe('作品 ID'),
        userId: z.number().describe('用户 ID'),
        requestContext: z.instanceof(RequestContext).describe('请求上下文')
    }),
    outputSchema: narrationTs,
    execute: async ({ inputData, mastra }) => {
        const scope = { workId: inputData.workId, chapterId: inputData.chapterId, userId: inputData.userId }
        const { roles, props, scene } = await loadStoryboardEvidence(scope)
        const styleProfile = await loadWorkStyleProfile({ workId: inputData.workId, userId: inputData.userId })

        const NovelScriptAgent = mastra.getAgent("NovelScriptAgent")
        if (!NovelScriptAgent) throw new Error('Agent NovelScriptAgent 未注册')
        const ScenePlannerAgent = (() => {
            try { return mastra.getAgent("ScenePlannerAgent") } catch { return null }
        })()
        const ShotBreakerAgent = (() => {
            try { return mastra.getAgent("ShotBreakerAgent") } catch { return null }
        })()

        const rhythmPlan = estimateChapterStoryboardPlan(inputData.text)
        const basePayload = {
            story_text: inputData.text,
            rhythm_plan: {
                target_shots: rhythmPlan.targetShots,
                min_shots: rhythmPlan.minShots,
                max_shots: rhythmPlan.maxShots,
                estimated_duration_sec: rhythmPlan.estimatedDurationSec,
                split_rules: rhythmPlan.splitRules,
                directive: rhythmPlan.rhythmDirective,
            },
            vocab: {
                shot_size: enums.shot_size,
                camera_angle: enums.camera_angle,
                camera_movement: enums.camera_movement,
            },
            characters: roles,
            props,
            scenes: scene,
        }

        const validSceneIds = new Set(((scene || []) as any[]).map(s => String(s.id)))
        const validRoleIds = new Set(((roles || []) as any[]).map(r => String(r.id)))
        const validPropIds = new Set(((props || []) as any[]).map(p => String(p.id)))
        const fallbackSceneId = ((scene || []) as any[])[0]?.id != null ? String(((scene || []) as any[])[0].id) : ''

        /** 流式调用指定 Agent 并拼接完整文本输出 */
        const streamAgentText = async (agent: any, payload: string, label: string, maxSteps = 5) => {
            const stream = await agent.stream(payload, {
                maxSteps,
                requestContext: inputData.requestContext,
                onFinish: () => console.log(`${label}完成`),
            })
            let raw = ''
            let chunkCount = 0
            for await (const chunk of stream.textStream) {
                process.stdout.write(chunk)
                raw += chunk
                chunkCount++
            }
            return { raw: raw.trim(), chunkCount }
        }

        /**
         * 清洗单个场景的素材 ID 与枚举值，并为缺失 anchor 的 cut 镜头补齐安全兜底值。
         */
        const sanitizeScene = (sc: any): void => {
            if (validSceneIds.size > 0 && !validSceneIds.has(String(sc.scene_id))) {
                console.warn(`[分镜拆分] 场景引用了无效 scene_id=${sc.scene_id}，回退为 ${fallbackSceneId}`)
                sc.scene_id = fallbackSceneId
            }
            if (Array.isArray(sc.prop_ids)) {
                sc.prop_ids = sc.prop_ids.filter((id: any) => validPropIds.has(String(id)))
            }
            if (Array.isArray(sc.roles)) {
                sc.roles = sc.roles.filter((r: any) => validRoleIds.has(String(r?.id)))
            }
            if (!enums.transition?.includes(sc.transition)) sc.transition = '硬切'
            if (Array.isArray(sc.shots)) {
                for (let shIdx = 0; shIdx < sc.shots.length; shIdx++) {
                    const sh = sc.shots[shIdx]
                    if (Array.isArray(sh.roles)) {
                        sh.roles = sh.roles.filter((r: any) => validRoleIds.has(String(r?.id)))
                    }
                    if (!enums.shot_size?.includes(sh.shot_size)) sh.shot_size = '中景'
                    if (!enums.camera_angle?.includes(sh.camera_angle)) sh.camera_angle = '正面机位'
                    if (!enums.camera_movement?.includes(sh.camera_movement)) sh.camera_movement = '固定镜头'
                    if (sh.transition_out && !enums.transition?.includes(sh.transition_out)) {
                        sh.transition_out = '硬切'
                        sh.transition = '硬切'
                    }
                    if (shIdx === 0 && sh.link && sh.link.type !== 'continuous') {
                        sh.link = normalizeShotLink({ link: { type: 'continuous' } })
                    }
                    if (sh.link?.type === 'cut' && !String(sh.link?.anchor || '').trim()) {
                        sh.link.anchor = sh.eyeline || sh.content?.slice(0, 30) || '承接上一镜视线与空间位置'
                    }
                }
            }
        }

        console.log("开始NovelScriptPrompt（含节奏规划）:", JSON.stringify({
            targetShots: rhythmPlan.targetShots,
            sceneCount: (scene || []).length,
            roleCount: (roles || []).length,
        }))

        let configs: any[] = []

        // 优先尝试两阶段拆解（ScenePlannerAgent 场次规划 → ShotBreakerAgent 受控并发单场分镜拆解 + 错误反馈重试）
        const useTwoStage = Boolean(ScenePlannerAgent && ShotBreakerAgent && process.env.STORYBOARD_SPLIT_MODE !== 'legacy')
        if (useTwoStage) {
            try {
                const plannedScenes = await retryWithValidation(
                    async (attempt, lastError) => {
                        const planPayload = JSON.stringify({
                            story_text: inputData.text,
                            rhythm_plan: basePayload.rhythm_plan,
                            characters: roles,
                            scenes: scene,
                            props,
                            ...(lastError ? { validation_feedback: `上一轮场次规划输出未通过校验：${lastError}。请严格输出合法 JSON 对象 {"scenes":[...]}` } : {}),
                        })
                        const { raw } = await streamAgentText(
                            ScenePlannerAgent,
                            planPayload,
                            `场次规划（ScenePlanner，第 ${attempt} 次）`,
                            2,
                        )
                        return raw
                    },
                    (raw) => {
                        const parsed = safeJsonParse<any>(raw, 'object')
                        if (!parsed.ok) return { ok: false, error: parsed.error }
                        const list = Array.isArray(parsed.value?.scenes)
                            ? parsed.value.scenes
                            : Array.isArray(parsed.value)
                                ? parsed.value
                                : []
                        if (!list.length) {
                            return { ok: false, error: 'scenes 数组为空，至少需规划 1 个场次' }
                        }
                        return { ok: true, value: list }
                    },
                    { maxAttempts: 2, baseDelayMs: 400 },
                )

                if (plannedScenes.length > 0) {
                    const stagedConfigs: any[] = new Array(plannedScenes.length)
                    const concurrency = Math.max(1, Math.min(2, Number(process.env.SHOT_BREAKER_CONCURRENCY || 2)))
                    let cursor = 0

                    const breakSingleScene = async (scIdx: number) => {
                        const scenePlan = plannedScenes[scIdx]
                        const prevPlan = scIdx > 0 ? plannedScenes[scIdx - 1] : null
                        const prevCompleted = scIdx > 0 ? stagedConfigs[scIdx - 1] : null
                        const prevLastShot = prevCompleted && Array.isArray(prevCompleted.shots) && prevCompleted.shots.length > 0
                            ? prevCompleted.shots[prevCompleted.shots.length - 1]
                            : null
                        const prevSceneSummary = prevCompleted
                            ? {
                                scene_id: prevCompleted.scene_id,
                                environment: prevCompleted.environment,
                                last_shot_size: prevLastShot?.shot_size || '',
                                last_camera_angle: prevLastShot?.camera_angle || '',
                                last_axis_side: prevLastShot?.axis_side || '',
                                last_end_state: String(prevLastShot?.motion?.out || prevLastShot?.content || '').slice(0, 120),
                            }
                            : prevPlan
                                ? {
                                    scene_id: prevPlan.scene_id || '',
                                    environment: prevPlan.environment || prevPlan.location || '',
                                    summary: String(prevPlan.summary || prevPlan.plot || '').slice(0, 120),
                                }
                                : null

                        const finalScene = await retryWithValidation(
                            async (sceneAttempt, lastError) => {
                                const breakerPayload = JSON.stringify({
                                    story_text: inputData.text,
                                    scene_plan: scenePlan,
                                    rhythm_plan: basePayload.rhythm_plan,
                                    style_anchor: styleProfile,
                                    ...(prevSceneSummary ? { prev_scene_summary: prevSceneSummary } : {}),
                                    vocab: basePayload.vocab,
                                    characters: roles,
                                    props,
                                    scenes: scene,
                                    ...(lastError
                                        ? {
                                            validation_feedback: `上一轮输出解析失败（${lastError}）。请确保每个镜头完整包含【景别】【机位】【运镜】【画面】等必填标签！`,
                                        }
                                        : {}),
                                })
                                const { raw: sceneRaw } = await streamAgentText(
                                    ShotBreakerAgent,
                                    breakerPayload,
                                    `单场分镜拆解（场景 ${scIdx + 1}/${plannedScenes.length}，第 ${sceneAttempt} 次）`,
                                    5,
                                )
                                return sceneRaw
                            },
                            (sceneRaw) => {
                                const parsed = parseAnimaHubStoryboardOutput(sceneRaw, roles as any)
                                if (!parsed.ok) return parsed
                                const sc = parsed.value[0]!
                                if (!sc.scene_id && scenePlan.scene_id) sc.scene_id = String(scenePlan.scene_id)
                                if (!sc.environment && scenePlan.environment) sc.environment = String(scenePlan.environment)
                                if (!sc.transition && scenePlan.transition) sc.transition = String(scenePlan.transition)
                                if (!sc.bgm && scenePlan.bgm) sc.bgm = String(scenePlan.bgm)
                                sanitizeScene(sc)
                                return { ok: true, value: sc }
                            },
                            { maxAttempts: 2, baseDelayMs: 400 },
                        )

                        stagedConfigs[scIdx] = finalScene
                    }

                    const workers = Array.from({ length: Math.min(concurrency, plannedScenes.length) }, async () => {
                        while (cursor < plannedScenes.length) {
                            const idx = cursor++
                            await breakSingleScene(idx)
                        }
                    })
                    await Promise.all(workers)

                    if (stagedConfigs.every(Boolean)) {
                        configs = stagedConfigs
                    }
                }
            } catch (twoStageErr: any) {
                console.warn(`[分镜拆分] 两阶段拆解未完成（${twoStageErr?.message || twoStageErr}），自动回退整章 NovelScriptAgent 拆解`)
                configs = []
            }
        }

        // 回退或默认单阶段拆解（NovelScriptAgent + 错误反馈自愈重试）
        if (configs.length === 0) {
            try {
                configs = await retryWithValidation(
                    async (attempt, lastError) => {
                        const payloadObj = lastError
                            ? {
                                ...basePayload,
                                validation_feedback: `上一轮输出未通过分镜解析校验（${lastError}）。请严格输出完整的【场景序号】与【分镜序号】块，确保每个分镜都包含【景别】【机位】【运镜】【画面】！`,
                            }
                            : basePayload
                        const { raw, chunkCount } = await streamAgentText(
                            NovelScriptAgent,
                            JSON.stringify(payloadObj),
                            `整章分镜拆分（第 ${attempt} 次）`,
                            10,
                        )
                        console.log(`\n[分镜拆分] 收到 ${chunkCount} 个文本块，累计 ${raw.length} 字`)
                        return raw
                    },
                    (raw) => {
                        const parsed = parseAnimaHubStoryboardOutput(raw, roles as any)
                        if (!parsed.ok) return parsed
                        for (const sc of parsed.value) {
                            sanitizeScene(sc)
                        }
                        return { ok: true, value: parsed.value }
                    },
                    { maxAttempts: 2, baseDelayMs: 500 },
                )
            } catch (err: any) {
                throw new Error(`${err?.message || err}（已自动带反馈重试，请重跑提取分镜）`)
            }
        }

        // 生成后按 configs 引用筛选素材，统一带上描述、图片 URL 与版本 ID。
        console.log('初始化拆分：', configs)
        const params = {
            configs,
            requestContext: inputData.requestContext,
            ...scope,
            ...await loadStoryboardEvidence(scope, configs),
            styleProfile,
        }

        return params
    },
})

// 独立连贯性校验、{ prev, curr, next } 上下文提示词合成与智能转场决策节点：
// 1. 删除无叙事意义的冗余切镜；
// 2. 为所有分镜注入 subject_id / color_tone / motion_direction / prev_shot_id / next_shot_id / style_anchor_id / continuity_status 与一致性 Seed；
// 3. 运行 AnimaHub { prev, curr, next } 滑动窗口上下文提示词合成器（自动剥离重复画风前缀、合成动态运动提示词、由首帧+运动推导差异化尾帧提示词）；
// 4. 运行智能转场决策器并同步 storyboard、transition_decision、qc_record 三张连贯性核心表。
export const continuityCheckStep = createStep({
    id: 'continuity-check-step',
    inputSchema: narrationTs,
    outputSchema: narrationTs,
    execute: async ({ inputData, writer }) => {
        const { configs, chapterId, workId, styleProfile, assets = [] } = inputData
        await writer?.write({
            type: 'continuity-check-progress',
            stepName: 'continuity-check-step',
            status: 'continuity_checking',
            label: '正在执行分镜连贯性校验与上下文提示词推理…',
        })

        const enriched = enrichChapterContinuity(configs, {
            chapterId,
            workId,
            styleAnchorId: (styleProfile as any)?.styleId ?? null,
        })
        const transitions = decideShotTransitions(enriched.configs, { chapterId })

        // AnimaHub { prev, curr, next } 滑动窗口上下文提示词合成与尾帧差异化推导
        synthesizeChapterContextualPrompts(enriched.configs, {
            assets: assets as any[],
            styleProfile,
        })

        try {
            await syncContinuityAndTransitionsToDb(chapterId, enriched.storyboardRows, transitions)
            await saveQcRecordsToDb([{
                render_id: `script-continuity-${chapterId}-${Date.now()}`,
                chapter_id: chapterId,
                panel_idx: null,
                check_item: 'continuity_norm',
                result: enriched.overallScore >= 80 ? 'pass' : enriched.overallScore >= 60 ? 'warn' : 'fail',
                score: enriched.overallScore,
                regenerate_flag: 0,
                detail: `全章 ${enriched.storyboardRows.length} 个分镜连贯性校验与上下文提示词合成完成（得分 ${enriched.overallScore}，生成 ${transitions.length} 条转场决策）`,
            }])
        } catch (dbErr: any) {
            console.warn(`[continuity-check-step] 同步连贯性表失败（不影响主流程）：${dbErr?.message || dbErr}`)
        }

        return { ...inputData, configs: enriched.configs }
    },
})

// 保存拆分剧本步骤
const saveNovelScriptStep = createStep({
    id: 'save-novel-script-step',
    inputSchema: z.object({
        configs: z.array(z.any()).describe('分镜配置数组'),
        chapterId: z.number().describe('章节 ID'),
        workId: z.number().describe('作品 ID'),
        userId: z.number().describe('用户 ID'),
    }),
    outputSchema: z.object({ saved: z.boolean().describe('是否保存成功') }),
    execute: async ({ inputData }) => {
        const result: any = await db.update(schema.chapters)
            .set({ content_configs: inputData.configs, updatedAt: new Date() } as any)
            .where(and(eq(schema.chapters.id, inputData.chapterId), eq(schema.chapters.work_id, inputData.workId), eq(schema.chapters.user_id, inputData.userId)))
        // 章节被删除或不属于当前用户时 affectedRows 为 0；不能静默报告成功（路由依赖 saved 判断失败）
        const affectedRows = result?.[0]?.affectedRows ?? 0
        if (!affectedRows) throw new Error('章节不存在或不属于当前用户，分镜未保存')
        return { saved: true }
    },
})

// 初始化拆分剧本工作流
export const NovelScriptWorkflow: any = createWorkflow({
    id: 'novel-script-breakdown',
    inputSchema: z.object({
        text: z.string().describe('待拆分的分镜文本'),
        chapterId: z.number().describe('章节ID'),
        workId: z.number().describe('作品ID'),
        userId: z.number().describe('用户ID'),
        requestContext: z.instanceof(RequestContext).describe('请求上下文')
    }),
    outputSchema: z.object({ saved: z.boolean().describe('是否保存成功') }),
})
    .then(writeChapterScriptStep) // 章节剧本化：小说原文 → 含完整台词与可拍动作的剧本
    .then(extractNovelScriptStep) // 提取剧本中的 旁白/对白/场景/道具/运镜等信息
    .then(continuityCheckStep) // 独立连贯性校验节点 + 一致性锚点注入 + 智能转场决策
    .then(saveNovelScriptStep) // 保存拆分剧本
    .commit()
