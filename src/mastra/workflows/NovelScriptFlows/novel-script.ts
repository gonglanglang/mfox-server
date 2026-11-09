import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { RequestContext } from '@mastra/core/request-context'
import { db, schema } from '../../../mysqlDb'
import { eq, and } from 'drizzle-orm'
import { parseStoryboardText, normalizeShotLink } from '../../../tools/storyboard-text'
import { enrichChapterContinuity } from '../../../tools/shot-continuity'
import { decideShotTransitions, syncContinuityAndTransitionsToDb } from '../../../tools/transition-decision'
import { saveQcRecordsToDb } from '../../../tools/video-qc'
import { loadWorkStyleProfile, buildCharacterReferences, buildSceneCard, DEFAULT_STYLE_PROMPT } from '../../../tools/storyboard-assets'
import { LLMJSON } from '../../../tools/index'
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
// 放在拆分之前，是为了让下游能拆出"有台词、有动作"的镜头，而不是把抽象描写拆成静立镜头。
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

        console.log('开始章节剧本化，原文长度:', inputData.text.length)
        const stream = await ChapterScriptWriterAgent.stream(inputData.text, {
            maxSteps: 1,
            requestContext: inputData.requestContext,
            onFinish: () => console.log('章节剧本化完成'),
        })

        let script = ''
        for await (const chunk of stream.textStream) {
            process.stdout.write(chunk)
            script += chunk
        }

        script = script.trim()
        if (!script) throw new Error('章节剧本化为空，请重试')

        console.log(`\n剧本化完成：${inputData.text.length} 字 → ${script.length} 字`)
        return { ...inputData, text: script, originalText: inputData.text }
    },
})

// 初始化拆分剧本步骤
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
        // 生成前尚无 configs，先提供当前作品/章节可选的素材。
        const { roles, props, scene } = await loadStoryboardEvidence(scope)
        // 全局风格锚：复用作品所选画风（visual_styles）的 description + effect_image
        const styleProfile = await loadWorkStyleProfile({ workId: inputData.workId, userId: inputData.userId })

        const NovelScriptAgent = mastra.getAgent("NovelScriptAgent")
        if (!NovelScriptAgent) throw new Error('Agent NovelScriptAgent 未注册')
        const ScenePlannerAgent = (() => {
            try { return mastra.getAgent("ScenePlannerAgent") } catch { return null }
        })()
        const ShotBreakerAgent = (() => {
            try { return mastra.getAgent("ShotBreakerAgent") } catch { return null }
        })()

        const basePayload = {
            story_text: inputData.text,
            // 提示词第 34 行约定输入键为 vocab，且为三组枚举的嵌套结构；
            // enums 是扁平对象（含 transition），这里按契约拆出三组。
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

        console.log("开始NovelScriptPrompt:", JSON.stringify(basePayload))

        let configs: any[] = []
        let failure: Error | null = null

        // 优先尝试两阶段拆解（ScenePlannerAgent 场次规划 → ShotBreakerAgent 单场分镜拆解 + 单场独立重试）
        const useTwoStage = Boolean(ScenePlannerAgent && ShotBreakerAgent && process.env.STORYBOARD_SPLIT_MODE !== 'legacy')
        if (useTwoStage) {
            try {
                const planPayload = JSON.stringify({
                    story_text: inputData.text,
                    characters: roles,
                    scenes: scene,
                    props,
                })
                const { raw: planRaw } = await streamAgentText(ScenePlannerAgent, planPayload, '场次规划（ScenePlanner）', 2)
                const parsedPlan = LLMJSON(planRaw) as any
                const plannedScenes: any[] = Array.isArray(parsedPlan?.scenes) ? parsedPlan.scenes : []
                if (plannedScenes.length > 0) {
                    const stagedConfigs: any[] = []
                    for (let scIdx = 0; scIdx < plannedScenes.length; scIdx++) {
                        const scenePlan = plannedScenes[scIdx]
                        const prevScene = scIdx > 0 ? stagedConfigs[scIdx - 1] : null
                        const prevLastShot = prevScene && Array.isArray(prevScene.shots) && prevScene.shots.length > 0
                            ? prevScene.shots[prevScene.shots.length - 1]
                            : null
                        const prevSceneSummary = prevScene ? {
                            scene_id: prevScene.scene_id,
                            environment: prevScene.environment,
                            last_shot_size: prevLastShot?.shot_size || '',
                            last_camera_angle: prevLastShot?.camera_angle || '',
                            last_axis_side: prevLastShot?.axis_side || '',
                            last_end_state: String(prevLastShot?.motion?.out || prevLastShot?.content || '').slice(0, 120),
                        } : null
                        let finalScene: any = null
                        for (let sceneAttempt = 1; sceneAttempt <= 2; sceneAttempt++) {
                            const breakerPayload = JSON.stringify({
                                story_text: inputData.text,
                                scene_plan: scenePlan,
                                style_anchor: styleProfile,
                                ...(prevSceneSummary ? { prev_scene_summary: prevSceneSummary } : {}),
                                vocab: basePayload.vocab,
                                characters: roles,
                                props,
                                scenes: scene,
                            })
                            const { raw: sceneRaw } = await streamAgentText(
                                ShotBreakerAgent,
                                breakerPayload,
                                `单场分镜拆解（场景 ${scIdx + 1}/${plannedScenes.length}，第 ${sceneAttempt} 次）`,
                                5,
                            )
                            if (!sceneRaw) continue
                            const parsedScenes = parseStoryboardText(sceneRaw, roles as any)
                            if (!parsedScenes.length) continue
                            const sc = parsedScenes[0]!
                            if (!sc.scene_id && scenePlan.scene_id) sc.scene_id = String(scenePlan.scene_id)
                            if (!sc.environment && scenePlan.environment) sc.environment = String(scenePlan.environment)
                            if (!sc.transition && scenePlan.transition) sc.transition = String(scenePlan.transition)
                            if (!sc.bgm && scenePlan.bgm) sc.bgm = String(scenePlan.bgm)

                            sanitizeScene(sc)
                            finalScene = sc
                            break
                        }
                        if (!finalScene) {
                            throw new Error(`场景 ${scIdx + 1} 未产出可解析的分镜块`)
                        }
                        stagedConfigs.push(finalScene)
                    }
                    if (stagedConfigs.length > 0) {
                        configs = stagedConfigs
                    }
                }
            } catch (twoStageErr: any) {
                console.warn(`[分镜拆分] 两阶段拆解未完成（${twoStageErr?.message || twoStageErr}），自动回退整章 NovelScriptAgent 拆解`)
                configs = []
            }
        }

        // 回退或默认单阶段拆解（NovelScriptAgent）
        for (let attempt = 1; configs.length === 0 && attempt <= 2; attempt++) {
            const promptText = JSON.stringify(basePayload)
            const { raw, chunkCount } = await streamAgentText(NovelScriptAgent, promptText, '分镜拆分', 10)

            if (!raw) {
                failure = new Error('AI 返回的分镜数据为空，请重试')
                console.warn(`[分镜拆分] 第 ${attempt} 次返回为空`)
                continue
            }

            try {
                // 文本格式的核心好处：即使输出被截断，前面的场景依然完整可用，
                // 解析器只会丢弃最后那个残块，而不是让整章白跑。
                // 传入角色表：台词的角色归属按"说话人名字"解析
                const parsedConfigs = parseStoryboardText(raw, roles as any)

                for (let scIdx = 0; scIdx < parsedConfigs.length; scIdx++) {
                    const sc = parsedConfigs[scIdx]
                    sanitizeScene(sc)
                }
                console.log(`\n[分镜拆分] 收到 ${chunkCount} 个文本块，累计 ${raw.length} 字，解析出 ${parsedConfigs.length} 个场景`)
                if (!parsedConfigs.length) throw new Error(`AI 未产出可解析的分镜内容（已收到 ${raw.length} 字）`)
                configs = parsedConfigs
                failure = null
                break
            } catch (error: any) {
                failure = error
                console.warn(`[分镜拆分] 第 ${attempt} 次解析失败：${error?.message || error}`)
            }
        }

        if (failure) {
            throw new Error(`${failure.message}（已重试一次，请重跑提取分镜）`)
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

// 独立连贯性校验与智能转场决策节点（需求 3.2 / 4 / 5 / 6）：
// 1. 删除无叙事意义的冗余切镜；
// 2. 为所有分镜注入 subject_id / color_tone / motion_direction / prev_shot_id / next_shot_id / style_anchor_id / continuity_status 与一致性 Seed；
// 3. 运行智能转场决策器（同场≤0.3s 软切/硬切，跨场匹配剪辑/转场，转场总时长占比上限控制）；
// 4. 同步 storyboard、transition_decision、qc_record 三张连贯性核心表。
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
            label: '正在执行分镜连贯性校验与智能转场决策…',
        })

        const enriched = enrichChapterContinuity(configs, {
            chapterId,
            workId,
            styleAnchorId: (styleProfile as any)?.styleId ?? null,
        })
        const transitions = decideShotTransitions(enriched.configs, { chapterId })

        // 直接从提取的分镜字段填充 start_prompt / end_prompt / videoPrompt 与素材快照，无需再跑 GenerateFramePromptsStep
        const stylePrompt = String(styleProfile?.prompt || '').trim() || DEFAULT_STYLE_PROMPT
        const assetById = new Map((assets as any[]).map((a: any) => [String(a.id), a]))
        for (const sc of enriched.configs) {
            if (!sc || !Array.isArray(sc.shots)) continue
            const sceneRoleIds = (Array.isArray(sc.roles) ? sc.roles : [])
                .map((r: any) => Number(r?.id ?? r))
                .filter(Number.isSafeInteger)
            const sceneAsset = (assets as any[]).find((a: any) => a.type === 'scene' && String(a.id) === String(sc.scene_id))
            const sceneCard = sceneAsset ? buildSceneCard(sceneAsset) : null
            const sceneSnapshot = sceneCard ? {
                scene_id: Number(sceneCard.id) || null,
                text: sceneCard.text,
                image_url: sceneCard.imageUrl,
            } : null

            for (const sh of sc.shots) {
                if (!sh || typeof sh !== 'object') continue
                const imgPrompt = String(sh.image_prompt || sh.start_prompt || sh.motion?.in || sh.content || '').trim()
                const endPrompt = String(sh.end_prompt || sh.motion?.out || imgPrompt || '').trim()
                const motionPrompt = String(sh.motion_prompt || sh.videoPrompt || sh.subject_motion || '').trim()
                sh.image_prompt = imgPrompt
                sh.start_prompt = String(sh.start_prompt || imgPrompt).trim()
                sh.end_prompt = endPrompt
                if (motionPrompt) {
                    sh.motion_prompt = sh.motion_prompt || motionPrompt
                    sh.videoPrompt = sh.videoPrompt || motionPrompt
                }
                sh.style_prompt_snapshot = stylePrompt
                sh.scene_reference_snapshot = sceneSnapshot
                const shotRoleIds = (Array.isArray(sh.roles) ? sh.roles : [])
                    .map((r: any) => Number(r?.id ?? r))
                    .filter(Number.isSafeInteger)
                const charRefsSnapshot = buildCharacterReferences(
                    [...new Set([...sceneRoleIds, ...shotRoleIds])],
                    assets as any[],
                )
                sh.character_references_snapshot = charRefsSnapshot
                if (!Array.isArray(sh.character_refs) || sh.character_refs.length === 0) {
                    const derivedRefs = charRefsSnapshot.map(ref => {
                        const asset = assetById.get(String(ref.role_id))
                        return {
                            role_id: String(ref.role_id),
                            name: String(asset?.name || ref.role_id),
                            description: ref.description,
                            ...(ref.asset_url ? { image_url: ref.asset_url } : {}),
                        }
                    })
                    if (derivedRefs.length > 0) sh.character_refs = derivedRefs
                }
            }
        }

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
                detail: `全章 ${enriched.storyboardRows.length} 个分镜连贯性校验完成（得分 ${enriched.overallScore}，生成 ${transitions.length} 条转场决策）`,
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
