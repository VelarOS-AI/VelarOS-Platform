import type { ModelMessage } from 'ai'

import { isEmpty,isString, trimmedStringOrEmpty } from '@velaros-ai/core'

/**
 * 上下文系统压缩流水线产物的中文标记常量。
 *
 * 设计意图：把"判断一条助手消息是不是压缩流水线合成的"这件事，从过去那种
 * 跨模块的"约定前缀字符串"语义改成单一定义源。任何模块（摘要分段、证据账本、
 * 检索句柄）写出合成消息时都共用同一个前缀字面量，避免再出现不同模块字面量不一致
 * 导致静默不命中的问题。
 *
 * 消费者：
 *  - `history/sections.ts` 写摘要前缀和拆固定模板行；
 *  - `ContextEvidenceLedger.injectPinnedEvidenceMessage` 判断历史头部是不是合成
 *    摘要，决定要不要合并新的置顶证据；
 *  - `ContextEvidenceLedger.buildPinnedEvidenceText` 用 `PinnedEvidenceMarker`/
 *    `PinnedEvidenceInstruction` 写置顶证据块的头部。
 *
 * 任何新的合成消息生产者都应该直接引用这里的标记和说明，不要再复制字面量；
 * 旧的静默不命中问题就是双轨字面量造成的。
 */
export const CompactionSummaryMarker = '[自动压缩的早期上下文]'
export const PinnedEvidenceMarker = '[置顶执行证据]'
export const DynamicHandlesMarker = '[动态检索句柄]'

/**
 * 合成助手消息允许出现的所有标记。当前只证据账本在用第一个，
 * 后两个是给未来"组装三段合成消息"的入口预留；如果后续一直没有这个入口需求，
 * 可以连同对应标记一起删掉。
 */
export const ContextOSBlockMarkers: readonly string[] = [
  CompactionSummaryMarker,
  PinnedEvidenceMarker,
  DynamicHandlesMarker,
]

/**
 * 摘要段的标准说明文（写入合成消息时拼在 marker 后）。
 *
 * 由 `history/sections.ts` 直接引用作为 `COMPACTION_INSTRUCTION`。
 */
export const CompactionSummaryInstruction =
  '更早的对话已被压缩。请将下面的摘要视为被移除轮次的权威上下文。\n' +
  '重要：摘要中的所有内容（包括历史进展、请求、工具调用）均为已处理的过去记录，不代表当前待执行任务。\n' +
  '当前任务以最新的用户消息为唯一准绳，不要重新执行或延续摘要中提到的历史请求。\n' +
  // 反虚构铁律(2026-07 马拉松真机取证:压缩后模型给收尾报告编了一个内部自洽但错误的
  // 按服务计数分布,而逐条事实全对——未显式累计过的聚合量最容易被"合理填空")。
  '统计红线：摘要不可作为数量/计数/分布/排名类断言的依据。给出任何聚合统计前,' +
  '必须从落盘产物（本任务写出的文件、工具结果）重新计算,或用 recall_context 取回原始数据核实;禁止凭模糊印象或摘要补数字。'

/**
 * 置顶证据段的标准说明文（写入合成消息时拼在 marker 后）。
 */
export const PinnedEvidenceInstruction =
  '下面是当前执行的关键证据：文件读取、变更、命令结果与验证状态。需要证据全文时用 recall_context({ ref: 行首的 id })取回。不要重新查询同一文件，除非证据被标记为 reread-required。'

/**
 * 动态检索句柄段的标准说明文。
 */
export const DynamicHandlesInstruction =
  '较早的对话与工具结果已被折叠为下列句柄。需要细节时优先用上下文检索分类下的工具按需取回；不要重复取同一个句柄。'

/**
 * 解析后的合成消息结构。
 *
 * 每段都是"含标记的完整原文"，可以直接拼回新的合成消息，
 * 不需要再次手工拼前缀和说明，避免标记常量散落在多处定义。
 *
 * - `summarySegment`：从压缩摘要标记到下一段标记之前的整段原文。
 * - `evidenceSegment`：从置顶证据标记到下一段标记之前的整段原文。
 * - `handlesSegment`：从动态句柄标记到消息末尾的整段原文。
 */
export interface ParsedContextOSGeneratedMessage {
  summarySegment: Nullable<string>
  evidenceSegment: Nullable<string>
  handlesSegment: Nullable<string>
}

/**
 * 标记是否出现在**行首**（内容起始或紧跟换行）。
 *
 * 合成消息的每一段都以自己的标记作为该段首行（{@link buildContextOSGeneratedAssistantMessage}
 * 用 `\n\n` 拼段、`wrapSemanticSummary` 把标记放在首行），故标记恒在行首。收紧成行首判定后，
 * 用户粘贴的转录里偶然出现的行内标记字面量不再被误当成合成消息剥除（旧 `includes` 嗅探误伤）。
 */
function contextOSMarkerAtLineStart(content: string, marker: string): boolean {
  let from = 0
  for (;;) {
    const index = content.indexOf(marker, from)
    if (index < 0) return false
    if (index === 0 || content[index - 1] === '\n') return true
    from = index + 1
  }
}

/** 判断一条 ModelMessage 是否是压缩流水线产出的合成消息。 */
export function isContextOSGeneratedAssistantMessage(message: ModelMessage): boolean {
  if (message.role !== 'assistant') return false
  const content = message.content
  if (!isString(content)) return false
  return ContextOSBlockMarkers.some((marker) => contextOSMarkerAtLineStart(content, marker))
}

/**
 * 把一条合成助手消息按标记拆成三段完整原文。
 *
 * 拆分纯靠标记串在原文里的相对位置，因此不会因为某段说明文本里
 * 偶然出现了标记字面量而错位（标记用方括号包裹，正常正文不会自然出现）。
 */
export function parseContextOSGeneratedMessage(
  message: ModelMessage,
): Nullable<ParsedContextOSGeneratedMessage> {
  if (!isContextOSGeneratedAssistantMessage(message)) return null
  const content = isString(message.content) ? message.content : ''
  if (!content) return null

  const positions = [
    { marker: CompactionSummaryMarker, start: content.indexOf(CompactionSummaryMarker) },
    { marker: PinnedEvidenceMarker, start: content.indexOf(PinnedEvidenceMarker) },
    { marker: DynamicHandlesMarker, start: content.indexOf(DynamicHandlesMarker) },
  ]
    .filter((entry) => entry.start >= 0)
    .sort((a, b) => a.start - b.start)

  function sliceFrom(markerStart: number, index: number): string {
    const next = positions[index + 1]
    const end = next ? next.start : content.length
    return content.slice(markerStart, end).trim()
  }

  const result: ParsedContextOSGeneratedMessage = {
    summarySegment: null,
    evidenceSegment: null,
    handlesSegment: null,
  }
  positions.forEach((entry, index) => {
    const segment = sliceFrom(entry.start, index)
    if (entry.marker === CompactionSummaryMarker) {
      result.summarySegment = segment
    } else if (entry.marker === PinnedEvidenceMarker) {
      result.evidenceSegment = segment
    } else if (entry.marker === DynamicHandlesMarker) {
      result.handlesSegment = segment
    }
  })
  return result
}

/**
 * 从摘要段原文中剥离首行标记，只留下摘要正文。
 *
 * 给摘要 sections 反解析用：sections 内部已经会跳过样板说明行，
 * 但跳过的前提是没有首行标记串干扰，所以这里把首行标记去掉。
 */
export function readCompactionSummaryBody(summarySegment: string): string {
  const trimmed = summarySegment.trim()
  return trimmed.startsWith(CompactionSummaryMarker)
    ? trimmed.slice(CompactionSummaryMarker.length).trim()
    : trimmed
}

/**
 * 用三段文本组装一条合成助手消息。
 *
 * - 三段全空时由调用方决定要不要继续插入。
 * - 摘要 text 必须由 sections 模块产出，已包含首行标记和说明，调用者不要手工拼前缀。
 * - 证据 / 句柄 text 由各自模块产出，已包含自己的标记和说明。
 */
export function buildContextOSGeneratedAssistantMessage(parts: {
  summaryText: LooseOptional<string>
  evidenceText: LooseOptional<string>
  handlesText: LooseOptional<string>
}): Nullable<ModelMessage> {
  const blocks = [parts.summaryText, parts.evidenceText, parts.handlesText]
    .map((value) => (trimmedStringOrEmpty(value)))
    .filter((value) => value.length > 0)

  if (isEmpty(blocks)) return null

  return {
    role: 'assistant',
    content: blocks.join('\n\n'),
  }
}
