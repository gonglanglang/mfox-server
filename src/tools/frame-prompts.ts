export const FRAME_PROMPT_SECTIONS = ['镜头', '画面构图', '人物状态与动作', '道具状态', '场景环境', '光线氛围', '连续性约束', '画风'] as const
export const OPTIONAL_FRAME_PROMPT_SECTIONS: readonly string[] = ['道具状态']

export function assertFramePromptPair(_start: string, _end: string) {
  // 已移除首尾帧提示词身份与格式硬约束
}

export function isFixedFramePrompt(value: string) {
  return typeof value === 'string' && value.trim().length > 0
}

export function assetFrameReferences(assets: { image?: string; type?: string; name?: string; id?: number | string; height?: number | null }[]) {
  return assets.flatMap(asset => asset.image?.trim() ? [{
    // 身高写进参考图标签：模型据此锚定人物尺度，避免同一人物在不同镜头里高低不一
    label: `${asset.type === 'scene' ? '场景' : asset.type === 'persona' ? '角色' : '道具'}：【${asset.name || asset.id}】（ID:${asset.id}${asset.type === 'persona' && Number.isFinite(asset.height) ? `，身高${asset.height}cm` : ''}）`,
    url: asset.image,
  }] : [])
}

export function numberFrameReferences(references: { label: string; url: string }[]) {
  return references.filter(ref => ref.url.trim()).map((ref, index) => ({ ...ref, label: `图${index + 1} ${ref.label}` }))
}
