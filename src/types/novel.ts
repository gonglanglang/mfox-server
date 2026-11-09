// ============================================
// AI 小说工作流类型
// ============================================

/** POST /ainovel/workflows 请求体 */
export interface AiNovelWorkflowInput {
  userId: number
  prompt: string
  type: '长篇' | '短篇' | '剧本' | '视频'
  audience: '男频' | '女频' | '全频'
  pov: '第三人称' | '第一人称'
  tags?: string
}

/** 工作流 Nova 流式输出事件 */
export interface AiNovelStreamEvent {
  type: 'chunk' | 'done' | 'error'
  content?: string
  error?: string
}
