import type { ModelMessage } from 'ai'

import { isEmpty, isString } from '@velaros-ai/core'

import {
  CompactionSummaryInstruction,
  CompactionSummaryMarker,
} from './contextOSMessage'
import { SummaryHighlights } from './highlights'
import { HistoryMessages } from './messages'

const COMPACTION_PREFIX = CompactionSummaryMarker
const COMPACTION_INSTRUCTION = CompactionSummaryInstruction
const COMPACTION_INSTRUCTION_LINES = COMPACTION_INSTRUCTION
  .split('\n')
  .map((line) => line.trim())

type SummarySectionKey =
  | 'goal'
  | 'constraints'
  | 'decisions'
  | 'files'
  | 'openIssues'
  | 'verification'
  | 'progress'

type SummarySections = Record<SummarySectionKey, string[]>

const SummarySectionOrder: SummarySectionKey[] = [
  'goal',
  'constraints',
  'decisions',
  'files',
  'openIssues',
  'verification',
  'progress',
]

const SummarySectionLabels: Record<SummarySectionKey, string> = {
  goal: '目标',
  constraints: '用户约束',
  decisions: '决策',
  files: '文件 / 模块',
  openIssues: '未决问题',
  verification: '验证',
  progress: '历史进展',
}

const SummarySectionMaxItems: Record<SummarySectionKey, number> = {
  goal: 2,
  constraints: 3,
  decisions: 3,
  files: 4,
  openIssues: 3,
  verification: 3,
  progress: 2,
}

const SummarySectionLineLengths: Record<SummarySectionKey, number> = {
  goal: 320,
  constraints: 360,
  decisions: 320,
  files: 280,
  openIssues: 300,
  verification: 300,
  progress: 320,
}

const SummarySectionItemLengths: Record<SummarySectionKey, number> = {
  goal: 220,
  constraints: 260,
  decisions: 180,
  files: 120,
  openIssues: 180,
  verification: 180,
  progress: 220,
}

/** 上下文压缩摘要分段工具，负责创建、合并、解析和渲染摘要各栏目。 */
class SummarySectionsHelper {
  private readonly maxSummaryLines = 12
  private readonly maxSummaryCharacters = 3_200

  constructor(
    private readonly messageHelper = new HistoryMessages(),
    private readonly highlightHelper = new SummaryHighlights(messageHelper),
  ) {}

  /** 创建一个空的摘要分段结构。 */
  public createEmptySummarySections(): SummarySections {
    return {
      goal: [],
      constraints: [],
      decisions: [],
      files: [],
      openIssues: [],
      verification: [],
      progress: [],
    }
  }

  /** 深拷贝摘要分段，避免跨轮合并时修改原始对象。 */
  public cloneSummarySections(sections: SummarySections): SummarySections {
    return {
      goal: [...sections.goal],
      constraints: [...sections.constraints],
      decisions: [...sections.decisions],
      files: [...sections.files],
      openIssues: [...sections.openIssues],
      verification: [...sections.verification],
      progress: [...sections.progress],
    }
  }

  /** 把新的摘要分段合并到目标分段中，并自动去重。 */
  public mergeSummarySections(target: SummarySections, incoming: SummarySections): void {
    SummarySectionOrder.forEach((key) => {
      incoming[key].forEach((item) => {
        this.addSummaryItem(target, key, item)
      })
    })
  }

  /** 向指定摘要栏目追加一条规范化后的内容。 */
  public addSummaryItem(
    sections: SummarySections,
    key: SummarySectionKey,
    item: string,
  ): void {
    const sanitized = this.sanitizeSummaryItem(item, key)
    if (!sanitized || sections[key].includes(sanitized)) return

    sections[key].push(sanitized)
  }

  /** 判断摘要分段中是否至少包含一条有效内容。 */
  public hasSummarySections(sections: SummarySections): boolean {
    return SummarySectionOrder.some((key) => !isEmpty(sections[key]))
  }

  /** 把摘要分段渲染成可注入模型历史的压缩摘要文本。 */
  public buildCompactionSummaryText(sections: SummarySections): LooseOptional<string> {
    const lines = this.renderSummarySections(sections)
    if (isEmpty(lines)) return null

    return [COMPACTION_PREFIX, COMPACTION_INSTRUCTION, ...lines].join('\n')
  }

  /** 解析已生成的压缩摘要文本，恢复为结构化摘要分段。 */
  public parseCompactionSummary(summary: string): SummarySections {
    const sections = this.createEmptySummarySections()

    summary
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && !this.isCompactionBoilerplateLine(line))
      .forEach((line) => {
        this.consumeCompactionSummaryLine(sections, line)
      })

    return sections
  }

  /** 从压缩摘要消息中剥离系统前缀，返回真正的摘要正文。 */
  public extractCompactionSummaryText(message: ModelMessage): LooseOptional<string> {
    if (message.role !== 'assistant' ||!isString(message.content)) return null

    if (message.content.startsWith(COMPACTION_PREFIX)) return message.content.slice(COMPACTION_PREFIX.length).trim()

    return null
  }

  private sanitizeSummaryItem(item: string, key: SummarySectionKey): LooseOptional<string> {
    const normalized = item
      .trim()
      .replace(/\s+\|\s+/g, ' / ')
      .replace(/\s+/g, ' ')
    if (!normalized) return null

    return this.messageHelper.previewText(normalized, SummarySectionItemLengths[key])
  }

  private isCompactionBoilerplateLine(line: string): boolean {
    return line === COMPACTION_PREFIX || COMPACTION_INSTRUCTION_LINES.includes(line)
  }

  private renderSummarySections(sections: SummarySections): string[] {
    const lines: string[] = []

    SummarySectionOrder.forEach((key) => {
      const selectedItems = this.selectSummarySectionItems(key, sections[key])
      if (isEmpty(selectedItems)) return

      const value = this.buildSummarySectionValue(key, selectedItems)
      if (!value) return

      this.appendSummaryLine(lines, `- ${SummarySectionLabels[key]}：${value}`)
    })

    return lines
  }

  private buildSummarySectionValue(
    key: SummarySectionKey,
    items: string[],
  ): LooseOptional<string> {
    let currentItems = [...items]

    while (!isEmpty(currentItems)) {
      const joined = currentItems.join(' | ')
      if (joined.length <= SummarySectionLineLengths[key]) return joined

      if (currentItems.length === 1) return this.messageHelper.previewText(currentItems[0], SummarySectionLineLengths[key])

      currentItems = this.dropLessImportantSummaryItems(key, currentItems)
    }

    return null
  }

  private dropLessImportantSummaryItems(
    key: SummarySectionKey,
    items: string[],
  ): string[] {
    switch (key) {
      case 'goal':
        return [items[0]]
      case 'decisions':
        return items.length > 2
          ? [items[0], ...items.slice(2)]
          : [items[0]]
      case 'progress':
        return [items[items.length - 1]]
      default:
        return items.slice(1)
    }
  }

  private selectSummarySectionItems(
    key: SummarySectionKey,
    items: string[],
  ): string[] {
    if (items.length <= SummarySectionMaxItems[key]) return items

    switch (key) {
      case 'goal': {
        const first = items[0]
        const last = items[items.length - 1]
        return first === last ? [first] : [first, last]
      }
      case 'decisions': {
        return [items[0], ...items.slice(-(SummarySectionMaxItems[key] - 1))]
      }
      case 'constraints':
      case 'progress': {
        const first = items[0]
        const last = items[items.length - 1]
        return first === last ? [first] : [first, last]
      }
      case 'files':
        return this.selectFileSummaryItems(items, SummarySectionMaxItems[key])
      default:
        return items.slice(-SummarySectionMaxItems[key])
    }
  }

  private selectFileSummaryItems(items: string[], maxItems: number): string[] {
    const looksLikeExplicitFile = (item: string): boolean =>
      item.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(item)
    const explicitFiles = items.filter(looksLikeExplicitFile)
    const moduleNames = items.filter((item) => !looksLikeExplicitFile(item))
    const selected = !isEmpty(explicitFiles)
      ? explicitFiles.slice(0, maxItems)
      : []

    if (selected.length < maxItems) {
      selected.push(...moduleNames.slice(0, maxItems - selected.length))
    }

    return selected
  }

  private consumeCompactionSummaryLine(sections: SummarySections, line: string): void {
    const normalized = line.replace(/^-+\s*/, '').trim()
    if (!normalized) return

    if (normalized.startsWith('承接信息：')) {
      this.consumeCompactionSummaryLine(sections, normalized.slice('承接信息：'.length).trim())
      return
    }

    const structuredMatch = this.matchStructuredSummaryLine(normalized)
    if (structuredMatch) {
      structuredMatch.items.forEach((item) => {
        this.addSummaryItem(sections, structuredMatch.key, item)
      })
      return
    }

    if (normalized.startsWith('初始目标：')) {
      this.addSummaryItem(sections, 'goal', normalized.slice('初始目标：'.length).trim())
      return
    }

    if (normalized.startsWith('进展：')) {
      const value = normalized.slice('进展：'.length).trim()
      this.addSummaryItem(sections, 'progress', value)
      this.enrichSummarySectionsFromLine(sections, value)
      return
    }

    this.addSummaryItem(sections, 'progress', normalized)
    this.enrichSummarySectionsFromLine(sections, normalized)
  }

  private matchStructuredSummaryLine(
    line: string,
  ): LooseOptional<{ key: SummarySectionKey; items: string[] }> {
    for (const key of SummarySectionOrder) {
      const labels = [`${SummarySectionLabels[key]}：`, `${SummarySectionLabels[key]}:`]
      const matchedLabel = labels.find((label) => line.startsWith(label))
      if (matchedLabel) return {
          key,
          items: this.splitSummaryItems(line.slice(matchedLabel.length).trim()),
        }
    }

    return null
  }

  private splitSummaryItems(value: string): string[] {
    return value
      .split(/\s+\|\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  private enrichSummarySectionsFromLine(
    sections: SummarySections,
    line: string,
  ): void {
    this.highlightHelper.extractDecisionHighlights([line]).forEach((item) => {
      this.addSummaryItem(sections, 'decisions', item)
    })
    this.highlightHelper.extractFileHighlights([line]).forEach((item) => {
      this.addSummaryItem(sections, 'files', item)
    })
    this.highlightHelper.extractOpenIssueHighlights([line]).forEach((item) => {
      this.addSummaryItem(sections, 'openIssues', item)
    })
    this.highlightHelper.extractVerificationHighlights([line]).forEach((item) => {
      this.addSummaryItem(sections, 'verification', item)
    })
  }

  private appendSummaryLine(lines: string[], line: string): void {
    const normalizedLine = line.trim()
    if (!normalizedLine || lines.length >= this.maxSummaryLines) return

    const nextLines = [...lines, normalizedLine]
    const nextLength = [COMPACTION_PREFIX, COMPACTION_INSTRUCTION, ...nextLines].join('\n').length
    if (nextLength > this.maxSummaryCharacters) return

    lines.push(normalizedLine)
  }
}

export { SummarySectionsHelper }
export type { SummarySectionKey, SummarySections }
export { SummarySectionsHelper as AgentHistorySummarySections }
