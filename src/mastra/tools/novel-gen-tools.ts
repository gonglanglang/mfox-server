import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { db, schema } from "../../mysqlDb";
import { eq, and } from "drizzle-orm";

/**
 * AI 生成小说第一章时，保存作品/卷/章节的元信息。
 * - title        → works.title
 * - description  → works.content（按产品要求，简介写入作品 content 字段）
 * - volumesTitle → volumes.title
 * - chaptersTitle / chaptersTile → chapters.title
 */
export const updateNovelMetaTool = createTool({
  id: "update-novel-meta",
  description: "保存 AI 生成的小说元信息：作品标题、作品简介（写入 content 字段）、卷名、章节名",
  inputSchema: z.object({
    workId: z.number().describe("作品 ID"),
    volumeId: z.number().describe("卷 ID"),
    chaptersId: z.number().describe("章节 ID"),
    title: z.string().describe("小说书名，3-8 字为佳"),
    description: z.string().describe("小说简介文案，将保存到作品 content 字段"),
    volumesTitle: z.string().describe("当前卷卷名（卷号以用户输入 volumeNumber 字段为准，不得写死为第一卷），例如：第二卷：暗流涌动"),
    chaptersTitle: z.string().optional().describe("本章章节名，例如：第一章：重生归来"),
    chaptersTile: z.string().optional().describe("本章章节名（兼容旧字段名），例如：第一章：重生归来"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
  }),
  execute: async ({ workId, volumeId, chaptersId, title, description, volumesTitle, chaptersTitle, chaptersTile }) => {
    const now = new Date();
    const resolvedChapterTitle = String(chaptersTitle || chaptersTile || "").trim();

    // 作品：标题 + 简介写入 content 字段
    await db.update(schema.works)
      .set({ title, content: description, updatedAt: now })
      .where(eq(schema.works.id, workId));

    // 卷：更新卷名
    await db.update(schema.volumes)
      .set({ title: volumesTitle, updatedAt: now })
      .where(and(eq(schema.volumes.id, volumeId), eq(schema.volumes.work_id, workId)));

    // 章节：更新章节名
    if (resolvedChapterTitle) {
      await db.update(schema.chapters)
        .set({ title: resolvedChapterTitle, updatedAt: now })
        .where(and(eq(schema.chapters.id, chaptersId), eq(schema.chapters.work_id, workId)));
    }

    return { ok: true };
  },
});
