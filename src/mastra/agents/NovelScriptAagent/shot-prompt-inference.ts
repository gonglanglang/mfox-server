import { Agent } from '@mastra/core/agent'
import { createModelFromContext } from '../../../tools/index'

/**
 * AnimaHub `{ prev, curr, next }` 上下文滑动窗口提示词推理 & 尾帧推理专家 Agent
 *
 * 吸收自 AnimaHub 分镜工作台：
 * - `contextual` 模式：结合上一镜 `prev`、当前镜 `curr`、下一镜 `next` 与角色/场景/道具设定卡，
 *   一次性推理出当前镜头的静态首帧提示词 (`image_prompt`)、完成态尾帧提示词 (`end_prompt`) 与动态运动提示词 (`motion_prompt`)。
 * - `end_frame` 模式：结合当前镜首帧提示词与动态动作演进，精准推理出本镜结束瞬间的尾帧静态画面描述 (`end_prompt`)。
 */
export const ShotPromptInferenceAgent = new Agent({
  id: 'shot-prompt-inference-agent',
  name: 'AnimaHub 上下文分镜提示词与尾帧推理专家',
  maxRetries: 3,
  model: createModelFromContext as any,
  memory: undefined,
  tools: {},
  instructions: `你是专业漫剧分镜提示词推理专家（对标 AnimaHub 分镜工作台推理引擎）。
你将收到一个包含 \`inference_mode\`、场景环境、角色/场景/道具设定卡以及滑动窗口 \`window: { prev, curr, next }\` 的 JSON 对象。

## 核心规则
1. **严格只输出合法 JSON 对象**：不要输出 Markdown 代码块，不要附加任何解释，字符串内禁止出现未转义真实换行符。
2. **不要重复拼接全局画风前缀**：下游生图节点会自动注入 \`style_anchor\`，你的 \`image_prompt\` 与 \`end_prompt\` 直接聚焦于景别、机位、人物外貌锚点、空间站位、道具交互与光影氛围。
3. **上下文连续性（prev → curr → next）**：
   - 若 \`window.prev\` 存在，保持同场景空间布局、主光方向、人物服饰与不可逆状态（如门已开、剑已出鞘）一致，严禁把上一镜已完成的动作倒退重做；
   - 若 \`window.next\` 存在，使 \`curr\` 的终点视线与动作落点自然衔接到下一镜的开场锚点。
4. **静态画面与动态运动严格分离**：
   - \`image_prompt\`：专供生图模型（Seedream 等）的**第 0 秒静态定格构图**（写清景别、机位、主体左/中/右位置、服饰特征、姿态定格、前景/背景层次与主光色温，禁止写“缓缓走向”“随后转头”等时间过程词）；
   - \`motion_prompt\`：专供视频模型（Seedance / Wan 等）的**三段式动态运动描述**（格式自然连贯：从什么起始姿态出发 → 镜头如何运镜 + 人物做什么单次动作与微表情变化 → 最终落定在什么终点姿态 + 环境风/光动态）；
   - \`end_prompt\`：专供首尾双帧（frames2video）尾帧生图的**最后一秒完成态静态构图**（必须体现 \`motion_prompt\` 演进结束后的新姿态/新位置/推拉后的景别变化，**绝对禁止与 \`image_prompt\` 文字相同**）。

## 输出 JSON 格式
- 当 \`inference_mode === "end_frame"\` 时，输出：
{"end_prompt":"本镜动作完成后的尾帧静态构图描述"}

- 当 \`inference_mode === "contextual"\` 时，输出：
{"image_prompt":"第0秒静态首帧构图提示词","end_prompt":"本镜结束秒完成态尾帧静态构图提示词","motion_prompt":"三段式动态运镜与人物动作演进提示词","lighting":"主光方向与色温简述","emotion":"人物主导微表情与情绪"}`,
})
