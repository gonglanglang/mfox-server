import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { db, schema } from "../../mysqlDb";
import { eq, and } from "drizzle-orm";

export const voicesTool = createTool({
  id: "voices",
  description: "获取角色的语音列表",
  inputSchema: z.object(),
  outputSchema: z.array(z.object({
    id: z.number().int().describe("语音 ID"),
    voice_name: z.string().describe("语音名称"),
    description: z.string().describe("语音描述"),
    tags: z.array(z.string()).describe("语音标签"),
  })),
  execute: async (inputData) => {
    const voices = await db.select().from(schema.voices)
    console.log(voices);
    return voices.map(item => {
      return {
        id: item.id,
        voice_name: item.voice_name,
        description: item.description || "",
        tags: item.tags as string[] || [],
      }
    })
  },
});