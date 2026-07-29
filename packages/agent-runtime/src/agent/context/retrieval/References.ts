import { basename, extname, isAbsolute, normalize } from 'node:path'

import { isArray, isNotNull, isPresent,isString, Log } from '@velaros-ai/core'
import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

/**
 * 扫描阶段发现的内部命令日志绝对路径。
 * `source` 记录该 path 在工具结果 JSON 中的逻辑位置，便于 debug。
 */
interface ReferencedLogPath {
  /** 绝对路径，须通过 {@link ContextRetrievalReferences.isInternalCommandLogPath}。 */
  path: string
  /** 如 `serializedResult`、`displayResult.foo.logPath`。 */
  source: string
}

/**
 * 扫描阶段发现的内部 artifact 绝对路径。
 */
interface ReferencedArtifactPath {
  /** 绝对路径，须含 `/.velaros/artifacts/`。 */
  path: string
  source: string
}

/**
 * {@link ContextRetrievalReferenceReader.readReferencedLog} 的读盘结果。
 * content 为 null 时表示未读到有效文本（不存在、二进制、非内部路径等）。
 */
interface LogReadSnippet {
  path: string
  source: string
  /** UTF-8 文本内容，经 truncate；null 表示不可用。 */
  content: LooseOptional<string>
  /** 文件字节大小；未知时为 null。 */
  size: LooseOptional<number>
  /** 是否因文件过大而 head+tail 采样。 */
  truncated: boolean
  /** 非致命问题说明（文件消失、二进制等）；null 表示正常。 */
  warning: LooseOptional<string>
}

/**
 * {@link ContextRetrievalReferenceReader.readReferencedArtifactManifest} 的结果。
 * 非文本 artifact 仅有 metadata，preview 为 null。
 */
interface ArtifactManifestSnippet {
  path: string
  source: string
  filename: string
  /** 由 {@link ContextRetrievalReferences.inferArtifactType} 推断。 */
  type: string
  size: LooseOptional<number>
  /** 文本类 artifact 的文件头 preview；二进制为 null。 */
  preview: LooseOptional<string>
  warning: LooseOptional<string>
}

/**
 * 从工具结果的 `serializedResult` / `displayResult` 中**扫描**内部日志与 `artifact` 路径引用。
 *
 * ## 在链路中的位置
 * ```
 * IndexBuilder.build → collectReferenced* → 写入 index.toolPayloads[].log/artifactReferences
 * PayloadReader.retrieveToolPayload → collectReferenced* → ReferenceReader 读盘展开
 * searchTerminalOutput → 用 index 内已缓存的 logReferences → ReferenceReader 读盘打分
 * ```
 *
 * ## 路径安全
 * 只认「内部」路径，避免 `agent` 通过工具结果 `JSON` 诱导读取任意文件：
 * - 日志：绝对路径 + 文件名前缀 `vela-command-` / `vela-bg-` 等 + `.log`
 * - `Artifact`：绝对路径 + 路径段 `/.velaros/artifacts/`
 *
 * 导出单例 {@link contextRetrievalReferences}。
 */
class ContextRetrievalReferences {
  /** 单次 collect / readReferencedLogs 最多跟进的日志条数。 */
  readonly maxReferencedLogs = 4
  /** 单次 collect / readReferencedArtifactManifests 最多跟进的 artifact 条数。 */
  readonly maxReferencedArtifacts = 4

  /**
   * 内部命令日志文件名前缀（basename 匹配）。
   * 对应 VelarOS 写入的 vela-command-*.log、vela-bg-*.log 等。
   */
  private readonly internalCommandLogPrefixes = [
    'vela-command-',
    'vela-bg-',
    'vela-system-command-',
    'vela-system-bg-',
  ]

  /** artifact 绝对路径必须包含的目录标记（POSIX 斜杠语义）。 */
  private readonly internalArtifactPathMarker = '/.velaros/artifacts/'

  /**
   * 允许读 preview 的 artifact 扩展名（小写比较）。
   * 不在列表内的二进制文件只返回 size/type，不读内容。
   */
  private readonly textArtifactExtensions = [
    '.csv',
    '.html',
    '.json',
    '.log',
    '.md',
    '.svg',
    '.text',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
  ]

  /**
   * 从工具结果两路字段合并扫描 logPath，按 path 去重。
   *
   * @param serializedResult 工具原始序列化字符串（常为 JSON 字符串）
   * @param displayResult 工具 UI 展示结构（对象/数组/字符串）
   */
  public collectReferencedLogPaths(
    serializedResult: string,
    displayResult: any
  ): ReferencedLogPath[] {
    const seen = new Set<string>()
    return [
      ...this.collectLogPathsFromValue(serializedResult, 'serializedResult'),
      ...this.collectLogPathsFromValue(displayResult, 'displayResult'),
    ].filter((entry) => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
  }

  /**
   * 从工具结果两路字段合并扫描 artifact 路径，按 path 去重。
   */
  public collectReferencedArtifactPaths(
    serializedResult: string,
    displayResult: any
  ): ReferencedArtifactPath[] {
    const seen = new Set<string>()
    return [
      ...this.collectArtifactPathsFromValue(serializedResult, 'serializedResult'),
      ...this.collectArtifactPathsFromValue(displayResult, 'displayResult'),
    ].filter((entry) => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
  }

  /**
   * 判断是否为允许跟进的内部命令日志路径。
   * 必须：绝对路径 + basename 以 internalCommandLogPrefixes 之一开头 + 以 `.log` 结尾。
   */
  public isInternalCommandLogPath(path: string): boolean {
    if (!isAbsolute(path)) return false

    const fileName = basename(path)
    return this.internalCommandLogPrefixes.some((prefix) => fileName.startsWith(prefix)) &&
      fileName.endsWith('.log')
  }

  /**
   * 判断是否为内部 artifact 存储路径（含 internalArtifactPathMarker）。
   */
  public isInternalArtifactPath(path: string): boolean {
    if (!isAbsolute(path)) return false

    return this.normalizePathForMarker(path).includes(this.internalArtifactPathMarker)
  }

  /**
   * 是否应对该 artifact 尝试读取文本 preview（扩展名在白名单内）。
   */
  public isTextArtifactPath(path: string): boolean {
    return this.textArtifactExtensions.includes(extname(path).toLowerCase())
  }

  /**
   * 推断 artifact 类型字符串。
   * 内部路径：取 marker 后第一段目录名（如 `plans`、`screenshots`）；
   * 否则退回文件扩展名或 `unknown`。
   */
  public inferArtifactType(path: string): string {
    const normalized = this.normalizePathForMarker(path)
    const marker = this.internalArtifactPathMarker
    const markerIndex = normalized.indexOf(marker)
    if (markerIndex < 0) return extname(path).replace(/^\./, '') || 'unknown'

    const tail = normalized.slice(markerIndex + marker.length)
    return tail.split('/')[0] || extname(path).replace(/^\./, '') || 'unknown'
  }

  private normalizePathForMarker(path: string): string {
    return normalize(path.replaceAll('\\', '/')).replaceAll('\\', '/')
  }

  /**
   * 递归遍历任意 `JSON` 值，收集 `logPath`。
   *
   * ### 字符串分支
   * 1. 若整段像 `{...}` / `[...]`，尝试 `JSON.parse` 后递归
   * 2. `parse` 失败或不是 `JSON`：对**截断 `preview`** 用 `"logPath":"..."` 正则扫描（不抛 `debug` 噪音）
   *
   * ### 对象分支
   * `key===logPath` 且值为内部日志路径时直接收录；否则递归 `nested`。
   *
   * @param value 当前节点
   * @param source 逻辑路径前缀，用于 `ReferencedLogPath.source`
   * @param paths 累积数组（可变，达 `maxReferencedLogs` 即停）
   */
  private collectLogPathsFromValue(
    value: any,
    source: string,
    paths: ReferencedLogPath[] = []
  ): ReferencedLogPath[] {
    if (paths.length >= this.maxReferencedLogs) return paths

    if (isString(value)) {
      const parsed = this.maybeParseJson(value)
      if (isNotNull(parsed)) {
        this.collectLogPathsFromValue(parsed, source, paths)
        return paths
      }

      for (const match of value.matchAll(/"logPath"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
        const path = this.decodeJsonStringContent(match[1] ?? '')
        if (path && this.isInternalCommandLogPath(path)) {
          paths.push({ path, source })
        }
        if (paths.length >= this.maxReferencedLogs) {
          break
        }
      }
      return paths
    }

    if (isArray(value)) {
      for (const item of value) {
        this.collectLogPathsFromValue(item, source, paths)
        if (paths.length >= this.maxReferencedLogs) {
          break
        }
      }
      return paths
    }

    const record = asRecord(value)
    if (!record) return paths

    for (const [key, nestedValue] of Object.entries(record)) {
      if (key === 'logPath' && isString(nestedValue) && this.isInternalCommandLogPath(nestedValue)) {
        paths.push({ path: nestedValue, source: `${source}.${key}` })
        if (paths.length >= this.maxReferencedLogs) {
          break
        }
        continue
      }

      this.collectLogPathsFromValue(nestedValue, `${source}.${key}`, paths)
      if (paths.length >= this.maxReferencedLogs) {
        break
      }
    }

    return paths
  }

  /**
   * 递归收集 artifact 路径。
   *
   * - 字符串：parse JSON 或整串若 isInternalArtifactPath 则收录
   * - 对象：key 为 path / artifactPath 且值为内部 artifact 路径时收录
   */
  private collectArtifactPathsFromValue(
    value: any,
    source: string,
    paths: ReferencedArtifactPath[] = []
  ): ReferencedArtifactPath[] {
    if (paths.length >= this.maxReferencedArtifacts) return paths

    if (isString(value)) {
      const parsed = this.maybeParseJson(value)
      if (isNotNull(parsed)) {
        this.collectArtifactPathsFromValue(parsed, source, paths)
        return paths
      }

      for (const match of value.matchAll(/"(?:path|artifactPath)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
        const path = this.decodeJsonStringContent(match[1] ?? '')
        if (path && this.isInternalArtifactPath(path)) {
          paths.push({ path, source })
        }
        if (paths.length >= this.maxReferencedArtifacts) {
          break
        }
      }
      if (paths.length >= this.maxReferencedArtifacts) return paths

      if (this.isInternalArtifactPath(value)) {
        paths.push({ path: value, source })
      }
      return paths
    }

    if (isArray(value)) {
      for (const item of value) {
        this.collectArtifactPathsFromValue(item, source, paths)
        if (paths.length >= this.maxReferencedArtifacts) {
          break
        }
      }
      return paths
    }

    const record = asRecord(value)
    if (!record) return paths

    for (const [key, nestedValue] of Object.entries(record)) {
      if (
        (key === 'path' || key === 'artifactPath') && isString(nestedValue) &&
        this.isInternalArtifactPath(nestedValue)
      ) {
        paths.push({ path: nestedValue, source: `${source}.${key}` })
        if (paths.length >= this.maxReferencedArtifacts) {
          break
        }
        continue
      }

      this.collectArtifactPathsFromValue(nestedValue, `${source}.${key}`, paths)
      if (paths.length >= this.maxReferencedArtifacts) {
        break
      }
    }

    return paths
  }

  /**
   * 保守 JSON 解析：仅当 trim 后以 `{}`/`[]` 包裹时才 parse。
   * 失败返回 null（截断 preview 走正则分支，不打 warn 刷屏）。
   */
  private maybeParseJson(value: string): any {
    const trimmed = value.trim()
    if (!this.looksLikeJsonContainer(trimmed)) return null

    try {
      return JSON.parse(trimmed)
    } catch (error) {
      if (!this.isExpectedPreviewJsonParseFailure(trimmed, error)) {
        Log.tag('ContextRetrievalReferences').debug('解析上下文检索引用 JSON 失败', { error })
      }
      return null
    }
  }

  private decodeJsonStringContent(value: string): string {
    try {
      return JSON.parse(`"${value}"`)
    } catch {
      return value
    }
  }

  private isExpectedPreviewJsonParseFailure(trimmed: string, error: unknown): boolean {
    if (!(error instanceof SyntaxError)) return false

    const looksConcatenated = /[\]}]\s*[[{]/.test(trimmed)
    if (!looksConcatenated) return false

    return (
      error.message.includes('Unexpected non-whitespace character after JSON') ||
      error.message.includes('Unable to parse JSON string')
    )
  }

  private looksLikeJsonContainer(trimmed: string): boolean {
    if (!trimmed) return false

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const firstPayloadChar = trimmed.slice(1).trimStart()[0]
      return firstPayloadChar === '"' || firstPayloadChar === '}'
    }

    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false

    const firstPayloadChar = trimmed.slice(1).trimStart()[0]
    return (
      firstPayloadChar === '[' ||
      firstPayloadChar === ']' ||
      firstPayloadChar === '"' ||
      firstPayloadChar === '-' ||
      firstPayloadChar === '{' ||
      firstPayloadChar === 'f' ||
      firstPayloadChar === 'n' ||
      firstPayloadChar === 't' ||
      (isPresent(firstPayloadChar) && firstPayloadChar >= '0' && firstPayloadChar <= '9')
    )
  }
}

/** 全进程唯一的路径扫描实例。 */
const contextRetrievalReferences = new ContextRetrievalReferences()

export { type ArtifactManifestSnippet, ContextRetrievalReferences, contextRetrievalReferences, type LogReadSnippet, type ReferencedArtifactPath, type ReferencedLogPath }
