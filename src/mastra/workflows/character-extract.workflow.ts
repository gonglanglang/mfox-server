import { createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { coreInputSchema, extractCharacters, saveCharacters, extractScene, saveScenes,
  extractProps, saveProps, loadAssetContext } from './asset-extraction/steps'

// 共用提取和保存步骤；完整链保持角色先入库，再供场景关联数据库 ID。
export const characterExtractWorkflow: any = createWorkflow({
  id: 'character-extract', inputSchema: coreInputSchema, outputSchema: z.object({ saved: z.number() }),
}).then(extractCharacters).then(saveCharacters).then(extractScene).then(saveScenes)
  .then(extractProps).then(saveProps).commit()

export const personaExtractWorkflow: any = createWorkflow({
  id: 'persona-extract', inputSchema: coreInputSchema, outputSchema: coreInputSchema.extend({ saved: z.number() }),
}).then(extractCharacters).then(saveCharacters).commit()

export const sceneExtractWorkflow: any = createWorkflow({
  id: 'scene-extract', inputSchema: coreInputSchema, outputSchema: coreInputSchema.extend({ saved: z.number() }),
}).then(loadAssetContext).then(extractScene).then(saveScenes).commit()

export const propExtractWorkflow: any = createWorkflow({
  id: 'prop-extract', inputSchema: coreInputSchema, outputSchema: z.object({ saved: z.number() }),
}).then(loadAssetContext).then(extractProps).then(saveProps).commit()
