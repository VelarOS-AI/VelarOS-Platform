/** 分块：文档按标题与空行切段，代码优先按符号切段，每段都带路径、标题与来源类型前缀。 */

import { first, isBlank, isEmpty, toNullable, truncate } from '@velaros-ai/core'

import { KnowledgeIndexConfig } from '../contract/constants.js'
import type { KnowledgeCodeSymbol } from '../types/code.js'
import type { KnowledgeRecord } from '../types/knowledge.js'
import type { CodeChunkSection } from '../types/storage.js'

import { extractSymbols } from './code.js'
import { KnowledgeTuning } from './tuning.js'

/** 每个 chunk 前面的统一上下文前缀：标题、路径、来源类型、摘要、区块名。 */
export function buildChunkPrefix(knowledge: KnowledgeRecord, label?: string): string {
  return [
    `文档标题: ${knowledge.title.trim()}`,
    `文档路径: ${knowledge.path}`,
    `来源类型: ${knowledge.sourceKind}`,
    isBlank(knowledge.summary)
      ? ''
      : `摘要: ${truncate(knowledge.summary.trim(), KnowledgeTuning.chunking.prefixSummaryChars)}`,
    label ? `区块: ${label}` : '',
  ]
    .filter((line) => !isBlank(line))
    .join('\n')
}

/** 从标签里读出代码智能给的行范围与区块名，没有就返回 null。 */
export function readProviderLineRange(
  tags: string[]
): Nullable<{ startLine: number; endLine: number; label: string }> {
  const lineTag = tags.find((tag) => tag.startsWith('lines:'))
  if (!lineTag) return null
  const match = /^lines:(\d+)-(\d+)$/.exec(lineTag)
  if (!match) return null
  const startLine = Number(match[1])
  const endLine = Number(match[2])
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null
  const nodeTag = tags.find((tag) => tag.startsWith('codegraph-node:'))
  const symbolTag = tags.find((tag) => tag.startsWith('symbol:'))
  return {
    startLine,
    endLine,
    label: symbolTag ?? nodeTag ?? lineTag,
  }
}

/** 按固定行数切代码，作为符号分块的兜底。 */
export function buildFallbackCodeSections(lines: string[]): CodeChunkSection[] {
  const sections: CodeChunkSection[] = []
  const maxLines = KnowledgeTuning.chunking.codeChunkMaxLines
  for (let start = 0; start < lines.length; start += maxLines) {
    const end = Math.min(lines.length, start + maxLines)
    const content = lines.slice(start, end).join('\n').trim()
    if (isBlank(content)) {
      continue
    }

    sections.push({
      label: `代码片段 ${start + 1}-${end}`,
      content,
    })
  }

  return sections
}

/** 按代码符号切出区块；符号解析不出来时退回固定行数切分。 */
export function buildCodeSections(
  lines: string[],
  symbols: KnowledgeCodeSymbol[]
): CodeChunkSection[] {
  if (isEmpty(lines)) return []

  const sections: CodeChunkSection[] = []
  const uniqueSymbols = symbols
    // 同名同起始行只保留一次，避免解析器重复上报导致重复 chunk。
    .filter(
      (symbol, index, list) =>
        list.findIndex((entry) => entry.name === symbol.name && entry.line === symbol.line) ===
        index
    )
    .slice(0, KnowledgeTuning.chunking.codeChunkMaxSymbols)

  const firstSymbolLine = (toNullable(first(uniqueSymbols)?.line))
  if (firstSymbolLine && firstSymbolLine > 1) {
    // 文件头部通常是 imports、常量和模块注释，作为独立区块保留。
    const headerContent = lines
      .slice(0, Math.min(firstSymbolLine - 1, KnowledgeTuning.chunking.codeHeaderMaxLines))
      .join('\n')
      .trim()
    if (!isBlank(headerContent)) {
      sections.push({
        label: '模块头部',
        content: headerContent,
      })
    }
  }

  if (isEmpty(uniqueSymbols)) {
    // 解析不到符号时退回固定行数切分。
    return buildFallbackCodeSections(lines)
  }

  for (let index = 0; index < uniqueSymbols.length; index += 1) {
    const symbol = uniqueSymbols[index]
    const nextSymbol = uniqueSymbols[index + 1]
    const startLine = Math.max(0, symbol.line - 1)
    const endLine = Math.min(
      lines.length,
      nextSymbol
        ? nextSymbol.line - 1
        : symbol.line - 1 + KnowledgeTuning.chunking.codeChunkMaxLines
    )
    const content = lines
      .slice(startLine, Math.max(startLine + 1, endLine))
      .join('\n')
      .trim()

    if (isBlank(content)) {
      continue
    }

    sections.push({
      label: `符号 ${symbol.name} (${symbol.kind})`,
      content,
    })
  }

  return !isEmpty(sections) ? sections : buildFallbackCodeSections(lines)
}

/** 长文本切片兜底：优先在换行或空格处断开，并留出 overlap。 */
export function sliceLongText(value: string, maxLength: number): string[] {
  if (value.length <= maxLength) return [value]

  const chunks: string[] = []
  let start = 0

  while (start < value.length) {
    const targetEnd = Math.min(start + maxLength, value.length)
    let end = value.lastIndexOf('\n', targetEnd)
    if (end <= start + Math.floor(maxLength / 2)) {
      // 找不到合适换行时再试空格，尽量不截断单词。
      end = value.lastIndexOf(' ', targetEnd)
    }
    if (end <= start) {
      end = targetEnd
    }

    const slice = value.slice(start, end).trim()
    if (!isBlank(slice)) {
      chunks.push(slice)
    }

    if (end >= value.length) {
      break
    }

    // 下一个切片回退少量字符，减少边界处的语义丢失。
    start = Math.max(start + 1, end - KnowledgeIndexConfig.CHUNK_OVERLAP)
  }

  return chunks
}

/** 提取 markdown/文本的自然区块；代码围栏内部不按标题或空行切开。 */
export function extractRawSections(content: string): string[] {
  const sections: string[] = []
  const currentLines: string[] = []
  let inCodeFence = false

  const pushCurrent = (): void => {
    const normalized = currentLines.join('\n').trim()
    if (!isBlank(normalized)) {
      sections.push(normalized)
    }
    currentLines.splice(0, currentLines.length)
  }

  const lines = content.replace(/\r\n/g, '\n').trim().split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (!inCodeFence && trimmed.startsWith('#') && !isEmpty(currentLines)) {
      // 新标题开始时结束上一段，保留章节边界。
      pushCurrent()
    }

    if (!inCodeFence && isBlank(trimmed)) {
      pushCurrent()
      continue
    }

    currentLines.push(line)
    if (trimmed.startsWith('```')) {
      // 代码围栏内的空行和 # 开头文本都属于正文。
      inCodeFence = !inCodeFence
    }
  }

  pushCurrent()
  return sections
}

/** 普通文档先按自然区块切分，过长的区块再切片。 */
export function splitSections(content: string, maxBodyLength: number): string[] {
  const rawSections = extractRawSections(content)
  if (isEmpty(rawSections)) return sliceLongText(content, maxBodyLength)

  const chunks: string[] = []
  for (const section of rawSections) {
    const normalized = section.trim()
    if (isBlank(normalized)) continue

    if (normalized.length <= maxBodyLength) {
      chunks.push(normalized)
      continue
    }

    // 大段文档继续切片，避免单个 chunk 过长。
    chunks.push(...sliceLongText(normalized, maxBodyLength))
  }

  return chunks
}

/** 一段正文最多占多少字符：整块预算减去前缀和固定标记。 */
function resolveMaxBodyLength(prefix: string): number {
  return Math.max(
    KnowledgeIndexConfig.MIN_CHUNK_LENGTH,
    KnowledgeIndexConfig.CHUNK_SIZE - prefix.length - '\n内容:\n'.length
  )
}

/** 构建普通文档的 chunk 正文列表。 */
export function buildDocumentChunks(knowledge: KnowledgeRecord): string[] {
  const prefix = buildChunkPrefix(knowledge)
  const sections = splitSections(knowledge.content, resolveMaxBodyLength(prefix))

  return sections.map((section) => `${prefix}\n内容:\n${section}`.trim())
}

/** 构建代码文档的 chunk 正文列表：有代码智能给的行范围就只取那一段。 */
export function buildCodeChunks(knowledge: KnowledgeRecord): string[] {
  const lines = knowledge.content.replace(/\r\n/g, '\n').split('\n')
  const providerRange = readProviderLineRange(knowledge.tags)
  if (providerRange) {
    const sectionContent = lines
      .slice(providerRange.startLine - 1, providerRange.endLine)
      .join('\n')
      .trim()
    if (!isBlank(sectionContent)) {
      const prefix = buildChunkPrefix(knowledge, providerRange.label)
      return [`${prefix}\n内容:\n${sectionContent}`.trim()]
    }
  }
  // 没有 provider 元数据时只保留固定行窗口兜底，不把正则符号解析当主路径。
  const symbols = extractSymbols(knowledge.path, knowledge.content)
    .sort((left, right) => left.line - right.line || left.column - right.column)
  const sections =
    !isEmpty(symbols)
      ? buildCodeSections(lines, symbols)
      : buildFallbackCodeSections(lines)

  const chunks: string[] = []
  for (const section of sections) {
    const prefix = buildChunkPrefix(knowledge, section.label)

    for (const slice of sliceLongText(section.content, resolveMaxBodyLength(prefix))) {
      // 即使一个符号区块过长，也按长度继续切分，避免超过 embedding 的输入上限。
      chunks.push(`${prefix}\n内容:\n${slice}`.trim())
    }
  }

  return chunks
}
