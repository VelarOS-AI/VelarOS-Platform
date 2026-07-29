import { first,isBlank, isEmpty, toNullable, truncate } from '@velaros-ai/core'

import { KnowledgeIndexConfig } from '../../Constants'
import type { KnowledgeCodeSymbol } from '../../Types'

import { extractSymbols } from './CodeHelper'
import type { KnowledgeRecord } from './Types'

/** 可被知识索引写入的一段文本。 */
export interface KnowledgeChunk {
  index: number
  content: string
}

/** 代码文件按符号或行段切出的内容区块。 */
interface CodeChunkSection {
  label: string
  content: string
}

/** 索引输入版本；分块策略变化时更新它，旧文件会被判定为过期。 */
const INDEX_SOURCE_VERSION = 'knowledge-chunk-builder:v2'
/** 单个代码 chunk 最多包含的行数，避免大文件整段进入一个向量。 */
const CODE_CHUNK_MAX_LINES = 80
/** 代码符号分块最多参考的符号数量，限制超大文件索引成本。 */
const CODE_CHUNK_MAX_SYMBOLS = 18

/**
 * 知识分块构建器。
 *
 * 文档类内容按标题/空行切段，代码类内容优先按符号切段；
 * 每个 chunk 都带路径、标题和来源类型前缀，便于向量搜索保留上下文。
 */
class KnowledgeChunks {

  /** 文件快照只跟踪分块策略；embedding profile 切换不属于内容过期。 */
  public getIndexRuntimeKey(): string {
    return INDEX_SOURCE_VERSION
  }

  /** 根据知识来源类型选择文档分块或代码分块。 */
  public build(knowledge: KnowledgeRecord): KnowledgeChunk[] {
    const rawChunks =
      knowledge.sourceKind === 'code'
        ? this.buildCodeChunks(knowledge)
        : this.buildDocumentChunks(knowledge)

    return rawChunks
      .filter((chunk) => chunk.length >= KnowledgeIndexConfig.MIN_CHUNK_LENGTH)
      .map((content, index) => ({ index, content }))
  }

  /** 构建参与 hash 的索引文本。 */
  public buildIndexSource(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunk[] = this.build(knowledge)
  ): string {
    const serializedChunks = chunks
      .map((chunk) => `# chunk ${chunk.index}\n${chunk.content}`)
      .join('\n\n---\n\n')

    return [INDEX_SOURCE_VERSION, `knowledge:${knowledge.id}`, serializedChunks]
      .filter((part) => !isBlank(part))
      .join('\n\n')
  }

  /** 构建普通文档 chunk。 */
  private buildDocumentChunks(knowledge: KnowledgeRecord): string[] {
    const prefix = this.buildChunkPrefix(knowledge)
    const maxBodyLength = Math.max(
      KnowledgeIndexConfig.MIN_CHUNK_LENGTH,
      KnowledgeIndexConfig.CHUNK_SIZE - prefix.length - '\n内容:\n'.length
    )
    const sections = this.splitSections(knowledge.content, maxBodyLength)

    return sections.map((section) => `${prefix}\n内容:\n${section}`.trim())
  }

  /** 构建代码文档 chunk。 */
  private buildCodeChunks(knowledge: KnowledgeRecord): string[] {
    const lines = knowledge.content.replace(/\r\n/g, '\n').split('\n')
    const providerRange = this.readProviderLineRange(knowledge.tags)
    if (providerRange) {
      const sectionContent = lines
        .slice(providerRange.startLine - 1, providerRange.endLine)
        .join('\n')
        .trim()
      if (!isBlank(sectionContent)) {
        const prefix = this.buildChunkPrefix(knowledge, providerRange.label)
        return [`${prefix}\n内容:\n${sectionContent}`.trim()]
      }
    }
    // 无 provider 元数据时仅保留固定行窗口 fallback，不再维护正则符号解析为主路径。
    const symbols = extractSymbols(knowledge.path, knowledge.content)
      .sort((left, right) => left.line - right.line || left.column - right.column)
    const sections =
      !isEmpty(symbols)
        ? this.buildCodeSections(lines, symbols)
        : this.buildFallbackCodeSections(lines)

    const sectionsResolved = sections
    const chunks: string[] = []

    for (const section of sectionsResolved) {
      const prefix = this.buildChunkPrefix(knowledge, section.label)
      const maxBodyLength = Math.max(
        KnowledgeIndexConfig.MIN_CHUNK_LENGTH,
        KnowledgeIndexConfig.CHUNK_SIZE - prefix.length - '\n内容:\n'.length
      )

      for (const slice of this.sliceLongText(section.content, maxBodyLength)) {
        // 即使一个符号区块过长，也按长度继续切分，避免超过 embedding 输入限制。
        chunks.push(`${prefix}\n内容:\n${slice}`.trim())
      }
    }

    return chunks
  }

  private readProviderLineRange(
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

  /** 构建每个 chunk 的统一上下文前缀。 */
  private buildChunkPrefix(knowledge: KnowledgeRecord, label?: string): string {
    return [
      `文档标题: ${knowledge.title.trim()}`,
      `文档路径: ${knowledge.path}`,
      `来源类型: ${knowledge.sourceKind}`,
      isBlank(knowledge.summary) ? '' : `摘要: ${truncate(knowledge.summary.trim(), 180)}`,
      label ? `区块: ${label}` : '',
    ]
      .filter((line) => !isBlank(line))
      .join('\n')
  }

  /** 根据代码符号构建代码区块。 */
  private buildCodeSections(lines: string[], symbols: KnowledgeCodeSymbol[]): CodeChunkSection[] {
    if (isEmpty(lines)) return []

    const sections: CodeChunkSection[] = []
    const uniqueSymbols = symbols
      // 同名同起始行只保留一次，避免解析器重复上报导致重复 chunk。
      .filter(
        (symbol, index, list) =>
          list.findIndex((entry) => entry.name === symbol.name && entry.line === symbol.line) ===
          index
      )
      .slice(0, CODE_CHUNK_MAX_SYMBOLS)

    const firstSymbolLine = (toNullable(first(uniqueSymbols)?.line))
    if (firstSymbolLine && firstSymbolLine > 1) {
      // 文件头部通常包含 imports、常量和模块注释，作为独立区块保留。
      const headerContent = lines
        .slice(0, Math.min(firstSymbolLine - 1, 40))
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
      return this.buildFallbackCodeSections(lines)
    }

    for (let index = 0; index < uniqueSymbols.length; index += 1) {
      const symbol = uniqueSymbols[index]
      const nextSymbol = uniqueSymbols[index + 1]
      const startLine = Math.max(0, symbol.line - 1)
      const endLine = Math.min(
        lines.length,
        nextSymbol ? nextSymbol.line - 1 : symbol.line - 1 + CODE_CHUNK_MAX_LINES
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

    return !isEmpty(sections) ? sections : this.buildFallbackCodeSections(lines)
  }

  /** 固定行数切分代码，作为符号分块的兜底。 */
  private buildFallbackCodeSections(lines: string[]): CodeChunkSection[] {
    const sections: CodeChunkSection[] = []
    for (let start = 0; start < lines.length; start += CODE_CHUNK_MAX_LINES) {
      const end = Math.min(lines.length, start + CODE_CHUNK_MAX_LINES)
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

  /** 普通文档先按自然区块切分，过长区块再切片。 */
  private splitSections(content: string, maxBodyLength: number): string[] {
    const rawSections = this.extractRawSections(content)
    if (isEmpty(rawSections)) return this.sliceLongText(content, maxBodyLength)

    const chunks: string[] = []
    for (const section of rawSections) {
      const normalized = section.trim()
      if (isBlank(normalized)) continue

      if (normalized.length <= maxBodyLength) {
        chunks.push(normalized)
        continue
      }

      // 大段文档继续切片，避免单个 chunk 过长。
      chunks.push(...this.sliceLongText(normalized, maxBodyLength))
    }

    return chunks
  }

  /** 提取 markdown/文本自然区块，代码围栏内部不按标题或空行切开。 */
  private extractRawSections(content: string): string[] {
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

  /** 长文本切片兜底，优先在换行或空格处断开，并保留 overlap。 */
  private sliceLongText(value: string, maxLength: number): string[] {
    if (value.length <= maxLength) return [value]

    const chunks: string[] = []
    let start = 0

    while (start < value.length) {
      const targetEnd = Math.min(start + maxLength, value.length)
      let end = value.lastIndexOf('\n', targetEnd)
      if (end <= start + Math.floor(maxLength / 2)) {
        // 找不到合适换行时再尝试空格，尽量不截断单词。
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

      // 下一个切片回退少量字符，减少边界处语义丢失。
      start = Math.max(start + 1, end - KnowledgeIndexConfig.CHUNK_OVERLAP)
    }

    return chunks
  }
}

export { KnowledgeChunks as KnowledgeChunkBuilder }
