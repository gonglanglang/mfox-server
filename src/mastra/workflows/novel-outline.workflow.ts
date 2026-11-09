import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod'
import { createWorks } from '../../routes/users'
import { createVolumes } from "../../routes/works"
import { db, schema } from '../../mysqlDb'
import { eq, and, count } from 'drizzle-orm'
import { NovelGenAgent } from '../agents/novel-gen-agent'
import { RequestContext } from "@mastra/core/request-context";
import { publishTaskStream, updateTask } from "../../tools/taskManager";

// 剥离模型违规包裹的 Markdown 代码块（例如 ```markdown ... ```），避免正文被渲染成代码块样式
function stripMarkdownCodeFence(text: string): string {
    const trimmed = text.trim()
    const m = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/)
    return m?.[1] ?? text
}

// 共享输入 schema
const novelInputSchema = z.object({
    userId: z.int(),
    description: z.string().describe("获取的小说内容"),
    length: z.enum(['长篇', '短篇', '剧本', '视频']),
    audience: z.enum(['男频', '女频', '全频']),
    pov: z.enum(['第三人称', '第一人称']),
    genre: z.string().describe('题材风格'),
    tags: z.string().optional().describe('题材标签'),
    workId: z.int().optional().describe('已有作品ID（续写/新卷章时传入，跳过创建作品）'),
    volumeId: z.int().optional().describe('已有卷ID（生成下一章时传入，跳过创建卷）'),
    previousChapterContent: z.string().optional().describe('上一章内容'),
    previousChapterId: z.int().optional().describe('上一章章节ID（内部查询其正文作为上一章内容）'),
    previousVolumeId: z.int().optional().describe('上一章所在卷ID（配合 previousChapterId 校验）'),
    requestContext: z.instanceof(RequestContext).describe('请求上下文'),
    taskId: z.string().describe('任务ID（用于广播流式消息和落库）')
})

// 创建小说
const CreateNovel = createStep({
    id: "create-novel",
    description: "创建小说",
    inputSchema: novelInputSchema,
    outputSchema: novelInputSchema.extend({ workId: z.int() }),
    execute: async ({ inputData }) => {
        const params = Object.assign(inputData, { title: inputData.description.slice(0, 50) })
        const result = await createWorks(params, inputData.userId) // 创建小说作品
        return {
            ...params,
            workId: result.workId
        }
    }
})

// 已有作品（续写/新卷章）：跳过创建作品，仅透传（与 CreateNovel 保持相同 schema，供 branch 分支使用）
const SkipCreateNovel = createStep({
    id: "skip-create-novel",
    description: "已有作品，跳过创建",
    inputSchema: novelInputSchema,
    outputSchema: novelInputSchema.extend({ workId: z.int() }),
    execute: async ({ inputData }) => {
        return { ...inputData, workId: inputData.workId as number }
    }
})

// 卷&章节注册成功
const createVolumesAndChapter = createStep({
    id: "create-volumes-chapter",
    description: "创建小说卷章",
    inputSchema: novelInputSchema.extend({ workId: z.int() }),
    outputSchema: novelInputSchema.extend({
        volumeId: z.int(),
        chaptersId: z.int(),
        workId: z.int()
    }),
    execute: async ({ inputData }) => {
        const { workId, userId } = inputData
        const result = await createVolumes(workId, userId)
        return { ...inputData, volumeId: result.volumeId, chaptersId: result.chaptersId, userId: inputData.userId }
    }
})

// 已有卷下创建新章节（AI 生成下一章模式）
const CreateChapter = createStep({
    id: "create-chapter",
    description: "在指定卷下创建新章节",
    inputSchema: novelInputSchema.extend({ workId: z.int(), volumeId: z.int() }),
    outputSchema: novelInputSchema.extend({
        workId: z.int(),
        volumeId: z.int(),
        chaptersId: z.int(),
    }),
    execute: async ({ inputData }) => {
        const { workId, userId, volumeId } = inputData
        const [vol] = await db.select({ id: schema.volumes.id })
            .from(schema.volumes)
            .where(and(eq(schema.volumes.id, volumeId), eq(schema.volumes.work_id, workId)))
            .limit(1)
        if (!vol) throw new Error('卷不存在或不属于该作品')
        const [cnt] = await db.select({ total: count() })
            .from(schema.chapters)
            .where(and(eq(schema.chapters.work_id, workId), eq(schema.chapters.volume_id, volumeId)))
        const chapterNo = (cnt?.total || 0) + 1
        const [row] = await db.insert(schema.chapters).values({
            work_id: workId,
            volume_id: volumeId,
            user_id: userId,
            title: `第${chapterNo}章`,
            chapter_no: chapterNo,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as any)
        return { ...inputData, chaptersId: (row as any).insertId }
    }
})

// 生成第一章内容
const GenerateChapterContent = createStep({
    id: "generate-chapter-content",
    description: "AI 生成第一章内容",
    inputSchema: novelInputSchema.extend({ workId: z.int(), volumeId: z.int(), chaptersId: z.int() }),
    outputSchema: novelInputSchema.extend({ workId: z.int(), chaptersId: z.int(), content: z.string() }),
    execute: async ({ inputData }) => {
        const { requestContext, taskId, workId, volumeId, chaptersId, description, length, audience, pov, genre, previousChapterContent, previousChapterId, previousVolumeId } = inputData

        // 上一章内容：优先用前端直接传入的内容；否则按上一章章节ID（+卷ID）内部查询
        let prevContent = previousChapterContent || ''
        if (!prevContent && previousChapterId) {
            const conds: any[] = [eq(schema.chapters.id, previousChapterId), eq(schema.chapters.work_id, workId)]
            if (previousVolumeId) conds.push(eq(schema.chapters.volume_id, previousVolumeId))
            const [row] = await db.select({ content: schema.chapters.content })
                .from(schema.chapters)
                .where(and(...conds))
                .limit(1)
            prevContent = row?.content || ''
        }

        // 当前卷的卷序号（用于生成“第X卷”卷名）
        const [vol] = await db.select({ volume_no: schema.volumes.volume_no })
            .from(schema.volumes)
            .where(eq(schema.volumes.id, volumeId))
            .limit(1)
        const volumeNumber = vol?.volume_no || 1

        // 当前章节序号（新章节已创建，按“本卷内章节数”计算，用于生成“第X章”章节名）
        const [cnt] = await db.select({ total: count() })
            .from(schema.chapters)
            .where(and(eq(schema.chapters.work_id, workId), eq(schema.chapters.volume_id, volumeId)))
        const chapterNumber = (cnt?.total || 0) || 1

        const prompt = JSON.stringify({
            workId, // 小说作品ID
            volumeId, // 卷ID
            chaptersId, // 章节ID
            chapterNumber, // 当前章节序号（本卷内）
            volumeNumber, // 当前卷序号（第几卷）
            previousChapterContent: prevContent, // 上一章内容
            audience, // 题材风格
            length, // 小说长度
            pov, // 视角
            description, // 小说描述
            genre // 题材风格
        })
        console.log('开始生成第一章内容', prompt)
        // 逐 token 输出：广播给当前连接（路由侧 subscribeTaskStream 转写）和重连订阅者
        const { textStream } = await NovelGenAgent.stream(prompt, {
            maxSteps: 10, // 最大生成步骤数
            requestContext // 传递请求上下文，用于关联任务ID
        })
        let fullText = ''
        // 落库串行链（非阻塞）：不 await 在 textStream 迭代内，避免 DB 写拖垮/中断生成流；
        // 链式保序保证 result 单调递增（后写覆盖前写）
        let saveChain: Promise<unknown> = Promise.resolve()
        let lastWrite = 0 // 落库节流时间戳（200ms，避免每 token 全量 UPDATE）
        for await (const chunk of textStream) {
            fullText += chunk
            console.log('生成第一章内容', chunk)
            const msg = JSON.stringify({ chunk })
            try { publishTaskStream(taskId, msg) } catch { /* 广播失败不影响生成 */ }
            const now = Date.now()
            if (now - lastWrite >= 200) {
                lastWrite = now
                const snapshot = fullText
                saveChain = saveChain.then(() => updateTask(taskId, { result: snapshot })).catch(() => { /* 落库失败不影响流 */ })
            }
        }
        // 循环结束：清洗可能违规包裹的代码块，最终全文落库（路由 finally 不再写空串覆盖，result 以本值为准）
        const finalText = stripMarkdownCodeFence(fullText)
        await saveChain.then(() => updateTask(taskId, { result: finalText })).catch(() => { /* 落库失败不影响流 */ })

        // 直接存储 AI 生成的正文（工具已更新章节标题，这里只回写正文和字数，避免覆盖标题）
        await db.update(schema.chapters)
            .set({ content: finalText, word_count: finalText.length, updatedAt: new Date() })
            .where(eq(schema.chapters.id, chaptersId))

        return { ...inputData, content: finalText }
    }
})

// 小说大纲工作流
// - 未传 workId（新创作）：先创建作品 → 创建卷章 → 生成内容
// - 已传 workId（续写/新卷章）：跳过创建作品 → 直接创建卷章 → 生成内容
const NovelOutLineWorkFlow = createWorkflow({
    id: 'novel-outline',
    inputSchema: novelInputSchema,
    outputSchema: z.object()
})
    .branch([
        [async ({ inputData }: any) => !inputData.workId, CreateNovel],
        [async ({ inputData }: any) => !!inputData.workId, SkipCreateNovel],
    ])
    .map(async ({ inputData, getStepResult }: any) => {
        return getStepResult('create-novel') || getStepResult('skip-create-novel')
    })
    .then(createVolumesAndChapter)
    .then(GenerateChapterContent)

// 已有卷下续写下一章工作流：创建章节 → 生成内容（不新建卷）
const NovelChapterWorkFlow = createWorkflow({
    id: 'novel-chapter',
    inputSchema: novelInputSchema.extend({ workId: z.int(), volumeId: z.int() }),
    outputSchema: z.object()
})
    .then(CreateChapter)
    .then(GenerateChapterContent)

NovelOutLineWorkFlow.commit()
NovelChapterWorkFlow.commit()

export { NovelOutLineWorkFlow, NovelChapterWorkFlow }
