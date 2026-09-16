// PromptStateBuilder 用到的纯函数（不碰实例状态）。
import type { HtmlArtifactPromptTurnInput } from '../../types/runner.js'
import { readLatestUserTurnText } from '../../utils/runner/prompt-state'

/** 判断这一轮要不要注入 HTML 制品提示词段：要开关打开且用户这轮真的在要视觉产物。 */
export function shouldInjectHtmlArtifactPromptForTurn({
  selectedPromptFeatureSet,
  messages,
}: HtmlArtifactPromptTurnInput): boolean {
  if (!selectedPromptFeatureSet.has('html-artifact')) return false
  const latest = readLatestUserTurnText(messages)
  const visualSignal =
    /(?:可视化|图表|架构图|流程图|原型|看板|仪表盘|页面|网页|卡片|落地页|实时预览|复杂说明|复杂展示|交互|互动|讲解|演示|动态效果|实时效果|chart|diagram|dashboard|prototype|preview|artifact|html|svg|canvas|page|card|landing page|real-time|interactive|interaction|explain|explanation|demo|visual)/iu
  return !!latest && visualSignal.test(latest)
}
