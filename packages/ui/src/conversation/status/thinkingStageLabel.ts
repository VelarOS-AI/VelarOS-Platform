/**
 * 从思考块文本里提取「当前阶段名」（Desktop 与 Workbench 的运行状态行共用）。
 *
 * 底部运行状态在模型思考时默认只显示一个静态「思考中」。为了让用户看到思考推进到哪一步，
 * 这里从**当前思考块**的文本里抽出首句 / 小标题当阶段名（纯文本提取，不调模型）。
 *
 * 粒度 = 一个思考块一个阶段：只有首句结束、首行结束或达到固定截断长度后才提交阶段名。
 * 流式到达的半句话继续显示已有 trace 状态，避免运行状态随每个 token 逐字抖动。
 */

/** 阶段名最长展示长度，超出截断加省略号。 */
const MaxStageLabelLength = 48

/** 句子终止符（中英文）：首句提取在此处截断。 */
const SentenceTerminators = ['。', '！', '？', '.', '!', '?', '；', ';']

/** 去掉行内 markdown 标记（标题井号、列表/引用前缀、强调、行内代码反引号）。 */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^[-*+>]\s+/u, '')
    .replace(/[*_`~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 截到第一句：遇到最靠前的句子终止符即断，末尾终止符与冒号一并去掉。 */
function firstSentenceBoundary(text: string): number {
  let cutIndex = -1
  for (const terminator of SentenceTerminators) {
    const index = text.indexOf(terminator)
    if (index > 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index
    }
  }
  return cutIndex
}

function truncateStageLabel(text: string): string {
  if (text.length <= MaxStageLabelLength) return text
  return `${text.slice(0, MaxStageLabelLength - 1).trimEnd()}…`
}

/**
 * 取思考块文本的首句 / 小标题作为阶段名。无有意义内容时返回 null（调用方回退到默认「思考中」）。
 */
export function getThinkingStageLabel(thinkingText: string): Nullable<string> {
  if (!thinkingText) return null

  let firstLine = ''
  let firstLineComplete = false
  const lines = thinkingText.split('\n')
  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed) {
      firstLine = trimmed
      firstLineComplete = lineIndex < lines.length - 1
      break
    }
  }
  if (!firstLine) return null

  const normalized = stripInlineMarkdown(firstLine)
  const sentenceBoundary = firstSentenceBoundary(normalized)
  const hasStableBoundary = sentenceBoundary >= 0 || firstLineComplete
  if (!hasStableBoundary && normalized.length < MaxStageLabelLength) return null

  const sentence = (sentenceBoundary >= 0 ? normalized.slice(0, sentenceBoundary) : normalized)
    .replace(/[:：\s]+$/u, '')
    .trim()
  if (sentence.length < 2) return null

  return truncateStageLabel(sentence)
}
