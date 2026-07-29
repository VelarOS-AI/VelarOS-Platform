import { lstat, open } from 'node:fs/promises'
import { basename } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

import { chatSearchText } from './search/Text'
import {
  type ArtifactManifestSnippet,
  contextRetrievalReferences,
  type LogReadSnippet,
  type ReferencedArtifactPath,
  type ReferencedLogPath,
} from './References'

/**
 * 将 {@link contextRetrievalReferences} 扫描到的磁盘路径**读入内存** `snippet`。
 *
 * ## 调用方
 * - {@link ContextRetrievalPayloadReader.retrieveToolPayload}：展开工具结果时附带日志/`artifact` 正文
 * - {@link ChatContextRetrievalService.searchTerminalOutput}：对每条 `logReference` 读盘后打分
 *
 * ## 安全与降级
 * - 再次校验 `isInternalCommandLogPath` / `isInternalArtifactPath`，拒绝外部路径
 * - 文件不存在、非普通文件、二进制（含 `NUL` 字节）、打开失败 → `content`/`preview=null` + 告警
 * - 大日志不整文件读入：`head+tail` 采样，见 {@link readHeadAndTail}
 *
 * 每 {@link ChatContextRetrievalService} 实例持有一个 `Reader`（无全局单例）。
 */
class ContextRetrievalReferenceReader {
  /** 单个文本 artifact preview 的最大字符数（读盘时按 ×4 估算字节上限）。 */
  private readonly artifactPreviewChars = 1_500
  /** 大日志 head+tail 采样时，head 占 maxBytes 的比例（余下给 tail）。 */
  private readonly logReadHeadRatio = 0.35

  /**
   * 批量读取日志引用，均分 `totalBudgetChars`。
   *
   * @param references 来自 `collectReferencedLogPaths` 或 `index.toolPayloads[].logReferences`
   * @param totalBudgetChars 本次读盘总字符预算（调用方按 `maxChars` 比例分配）
   * @returns 最多 `maxReferencedLogs` 条；空输入返回 `[]`
   *
   * `perLogBudget = max(800, totalBudgetChars / min(refs.length, maxReferencedLogs))`
   */
  public async readReferencedLogs(
    references: ReferencedLogPath[],
    totalBudgetChars: number
  ): Promise<LogReadSnippet[]> {
    if (isEmpty(references)) return []

    const perLogBudget = Math.max(
      800,
      Math.floor(totalBudgetChars / Math.min(references.length, contextRetrievalReferences.maxReferencedLogs))
    )
    const snippets: LogReadSnippet[] = []

    for (const reference of references.slice(0, contextRetrievalReferences.maxReferencedLogs)) {
      snippets.push(await this.readReferencedLog(reference, perLogBudget))
    }

    return snippets
  }

  /**
   * 批量读取 artifact manifest（metadata + 可选 preview）。
   *
   * @param references 来自 collectReferencedArtifactPaths
   * @returns 最多 maxReferencedArtifacts 条
   */
  public async readReferencedArtifactManifests(
    references: ReferencedArtifactPath[]
  ): Promise<ArtifactManifestSnippet[]> {
    const snippets: ArtifactManifestSnippet[] = []

    for (const reference of references.slice(0, contextRetrievalReferences.maxReferencedArtifacts)) {
      snippets.push(await this.readReferencedArtifactManifest(reference))
    }

    return snippets
  }

  /**
   * 将 LogReadSnippet 列表格式化为 agent 可读的多段文本（`---` 分隔）。
   * 用于拼入 retrieveToolPayload 的 content.referencedLogs 段。
   */
  public formatLogSnippets(snippets: LogReadSnippet[]): string {
    return snippets
      .map((snippet, index) => {
        const header = [
          `#${index + 1}`,
          `path: ${snippet.path}`,
          `source: ${snippet.source}`,
          `size: ${snippet.size ?? 'unknown'}`,
          `truncated: ${snippet.truncated}`,
          snippet.warning ? `警告: ${snippet.warning}` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join('\n')
        const body = snippet.content ? `content:\n${snippet.content}` : 'content: <unavailable>'
        return `${header}\n${body}`
      })
      .join('\n---\n')
  }

  /**
   * 将 ArtifactManifestSnippet 列表格式化为多段文本。
   * 用于 content.referencedArtifacts 段。
   */
  public formatArtifactManifests(snippets: ArtifactManifestSnippet[]): string {
    return snippets
      .map((snippet, index) => {
        const header = [
          `#${index + 1}`,
          `path: ${snippet.path}`,
          `source: ${snippet.source}`,
          `type: ${snippet.type}`,
          `filename: ${snippet.filename}`,
          `size: ${snippet.size ?? 'unknown'}`,
          snippet.warning ? `警告: ${snippet.warning}` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join('\n')
        const preview = snippet.preview ? `preview:\n${snippet.preview}` : 'preview: <not included>'
        return `${header}\n${preview}`
      })
      .join('\n---\n')
  }

  /**
   * 读取单条日志引用。
   *
   * @param reference path + source
   * @param maxChars 该条日志 content 字符上限（UTF-8 读盘时 maxBytes ≈ maxChars×4）
   */
  private async readReferencedLog(
    reference: ReferencedLogPath,
    maxChars: number
  ): Promise<LogReadSnippet> {
    if (!contextRetrievalReferences.isInternalCommandLogPath(reference.path)) return {
        ...reference,
        content: null,
        size: null,
        truncated: false,
        warning: '已跳过非内部日志路径。',
      }

    const stats = await lstat(reference.path).catch(() => null)
    if (!stats) return {
        ...reference,
        content: null,
        size: null,
        truncated: false,
        warning: '引用的日志文件已不存在。',
      }

    if (!stats.isFile() || stats.isSymbolicLink()) return {
        ...reference,
        content: null,
        size: stats.size,
        truncated: false,
        warning: '引用的日志不是普通文件。',
      }

    const handle = await open(reference.path, 'r').catch(() => null)
    if (!handle) return {
        ...reference,
        content: null,
        size: stats.size,
        truncated: false,
        warning: '无法打开引用的日志。',
      }

    try {
      const maxBytes = Math.max(maxChars * 4, 1)
      const truncated = stats.size > maxBytes
      const buffer = truncated
        ? await this.readHeadAndTail(handle, stats.size, maxBytes)
        : await this.readBytes(handle, stats.size, 0)

      if (this.isBinaryBuffer(buffer)) return {
          ...reference,
          content: null,
          size: stats.size,
          truncated,
          warning: '引用的日志疑似二进制文件。',
        }

      return {
        ...reference,
        content: chatSearchText.truncate(buffer.toString('utf-8'), maxChars),
        size: stats.size,
        truncated,
        warning: null,
      }
    } finally {
      await handle.close().catch(() => null)
    }
  }

  /**
   * 读取单条 artifact：始终返回 filename/type/size；
   * 仅 text 扩展名且非二进制时填充 preview。
   */
  private async readReferencedArtifactManifest(
    reference: ReferencedArtifactPath
  ): Promise<ArtifactManifestSnippet> {
    const filename = basename(reference.path)
    const type = contextRetrievalReferences.inferArtifactType(reference.path)

    if (!contextRetrievalReferences.isInternalArtifactPath(reference.path)) return {
        ...reference,
        filename,
        type,
        size: null,
        preview: null,
        warning: '已跳过非内部 artifact 路径。',
      }

    const stats = await lstat(reference.path).catch(() => null)
    if (!stats) return {
        ...reference,
        filename,
        type,
        size: null,
        preview: null,
        warning: '引用的 artifact 已不存在。',
      }

    if (!stats.isFile() || stats.isSymbolicLink()) return {
        ...reference,
        filename,
        type,
        size: stats.size,
        preview: null,
        warning: '引用的 artifact 不是普通文件。',
      }

    if (!contextRetrievalReferences.isTextArtifactPath(reference.path)) return {
        ...reference,
        filename,
        type,
        size: stats.size,
        preview: null,
        warning: null,
      }

    const handle = await open(reference.path, 'r').catch(() => null)
    if (!handle) return {
        ...reference,
        filename,
        type,
        size: stats.size,
        preview: null,
        warning: '无法打开引用的 artifact。',
      }

    try {
      const buffer = await this.readBytes(
        handle,
        Math.min(stats.size, this.artifactPreviewChars * 4),
        0
      )

      if (this.isBinaryBuffer(buffer)) return {
          ...reference,
          filename,
          type,
          size: stats.size,
          preview: null,
          warning: '引用的 artifact 疑似二进制文件。',
        }

      return {
        ...reference,
        filename,
        type,
        size: stats.size,
        preview: chatSearchText.truncate(
          buffer.toString('utf-8'),
          this.artifactPreviewChars
        ),
        warning: null,
      }
    } finally {
      await handle.close().catch(() => null)
    }
  }

  /**
   * 大文件采样：读文件头 logReadHeadRatio 比例 + 尾部补齐 maxBytes，
   * 中间插入 `... omitted N bytes ...` 标记。
   */
  private async readHeadAndTail(
    handle: Awaited<ReturnType<typeof open>>,
    fileSize: number,
    maxBytes: number
  ): Promise<Buffer> {
    const headBytes = Math.max(1, Math.floor(maxBytes * this.logReadHeadRatio))
    const tailBytes = Math.max(1, maxBytes - headBytes)
    const head = await this.readBytes(handle, headBytes, 0)
    const tailStart = Math.max(fileSize - tailBytes, headBytes)
    const tail = await this.readBytes(handle, Math.max(fileSize - tailStart, 0), tailStart)
    const marker = Buffer.from(
      `\n... omitted ${Math.max(fileSize - head.length - tail.length, 0)} bytes ...\n`
    )
    return Buffer.concat([head, marker, tail])
  }

  /**
   * 启发式二进制检测：前 8KB 内出现 NUL 字节则视为二进制。
   */
  private isBinaryBuffer(buffer: Buffer): boolean {
    const checkLength = Math.min(buffer.length, 8192)
    for (let index = 0; index < checkLength; index += 1) {
      if (buffer[index] === 0) return true
    }
    return false
  }

  /**
   * 从已打开文件句柄读取指定区间字节。
   *
   * @param handle fs open 句柄
   * @param bytesToRead 期望读取字节数
   * @param position 文件内起始偏移
   */
  private async readBytes(
    handle: Awaited<ReturnType<typeof open>>,
    bytesToRead: number,
    position: number
  ): Promise<Buffer> {
    if (bytesToRead <= 0) return Buffer.alloc(0)

    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position)
    return buffer.subarray(0, bytesRead)
  }
}

export { ContextRetrievalReferenceReader }
