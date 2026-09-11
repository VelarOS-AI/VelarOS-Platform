import { isEmpty, isNull, isPresent, isString, isTrue, isUndefined, toOptional } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'

/**
 * 项目空间拥有的 Agent 能力面。宿主注入实现，参数结构与校验留在项目领域内；
 * 返回契约只包含 Agent 编排读取和事务编辑时真正观察的字段。
 */

export interface AgentProjectCommandToolRequirement {
  kind: string
  command: string
  reason?: string
}

export interface AgentProjectDiagnostic {
  severity: 'info' | 'warning' | 'error'
  message: string
  path?: string
  line?: number
  column?: number
  source?: string
  data?: unknown
}

export interface AgentProjectPreparedPatch {
  path: string
  diff: string
  changedLines: number
  /** 策略写入的补丁说明；Agent 边界只读取其中给模型看的 matchNote。 */
  metadata?: Readonly<Record<string, unknown>>
}

export interface AgentProjectPreparedTransaction {
  transactionId: string
  patches: AgentProjectPreparedPatch[]
  changedFiles: string[]
  diff: string
  changedLines: number
  risk: 'low' | 'medium' | 'high'
  createdAt: number
}

export interface AgentProjectApplyResult {
  transactionId: string
  changedFiles: string[]
  oldRevisions: Record<string, string>
  newRevisions: Record<string, string>
  rebasedFiles?: string[]
  gitTrackedFiles?: string[]
}

export interface AgentProjectValidationResult {
  ok: boolean
  diagnostics: AgentProjectDiagnostic[]
  checks: Array<{
    id: string
    ok: boolean
    diagnostics?: AgentProjectDiagnostic[]
    metadata?: unknown
  }>
  toolRequirements?: AgentProjectCommandToolRequirement[]
}

export interface AgentProjectFixResult {
  ok: boolean
  changed: boolean
  transactionId: string
  changedFiles: string[]
  fixes: Array<{
    path: string
    content: string
    source: string
  }>
  diagnostics: AgentProjectDiagnostic[]
  toolRequirements?: AgentProjectCommandToolRequirement[]
}

export interface AgentProjectFileSnapshot {
  path: string
  exists: boolean
  isDirectory: boolean
  isBinary: boolean
  revision?: string
}

export interface AgentProjectReadResult {
  snapshot: AgentProjectFileSnapshot
  content?: string
  range?: {
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
    startOffset?: number
    endOffset?: number
  }
  totalLines?: number
  truncated?: boolean
  nextStartLine?: number
  remainingLines?: number
  hasMore?: boolean
  continuation?: AgentProjectReadContinuation
  /** 范围被钳制或起始行越界时的说明；此时读取仍算成功。 */
  note?: string
}

export interface AgentProjectReadContinuation {
  path: string
  range: {
    startLine: number
    startColumn?: number
    endLine?: number
    endColumn?: number
  }
  maxChars?: number
  baseRevisions?: Record<string, string>
}

interface AgentProjectKernelReadResult extends Omit<AgentProjectReadResult, 'continuation'> {
  continuation?: {
    path: string
    range?: {
      startLine?: number
      endLine?: number
      startColumn?: number
      endColumn?: number
    }
    maxChars?: number
    baseRevision?: string
  }
}

export interface AgentProjectReadIssue {
  path: string
  reason: 'directory' | 'not_found' | 'binary' | 'failed'
  message: string
  /** reason=failed 时的 Project 错误码。 */
  code?: string
}

export interface AgentProjectSearchResult {
  query: string
  hits: AgentProjectSearchHit[]
  truncated?: boolean
  toolRequirements?: AgentProjectCommandToolRequirement[]
  nextAction?: string
}

export interface AgentProjectSearchHit {
  path: string
  range?: {
    startLine: number
    startColumn?: number
    endLine: number
    endColumn?: number
  }
  snippet?: string
}

export interface AgentProjectDiffResult {
  diff: string
  changedFiles: string[]
  changedLines: number
}

export type AgentProjectResolveTargetResult =
  | {
      status: 'resolved'
      target: {
        range?: { startLine?: number; endLine?: number }
      }
    }
  | {
      status: 'ambiguous' | 'not_found'
    }

export interface AgentProjectKernelPort {
  listFiles(input?: any): Promise<Array<{ path: string; type: 'file' | 'directory' }>>
  stat(input: any): Promise<unknown>
  read(input: any): Promise<AgentProjectKernelReadResult>
  search(input: any): Promise<AgentProjectSearchResult>
  listSymbols(path: string): Promise<any[]>
  resolveTarget(input: any): Promise<AgentProjectResolveTargetResult>
  prepareEdit(input: any): Promise<AgentProjectPreparedTransaction>
  discardTransaction(transactionId: string): { discarded: boolean }
  getTransaction(
    transactionId: string
  ): AgentProjectPreparedTransaction | undefined
  fixTransaction(input: any): Promise<AgentProjectFixResult>
  applyEdit(input: any): Promise<AgentProjectApplyResult>
  validate(input: any): Promise<AgentProjectValidationResult>
  rollback(input: any): Promise<unknown>
  diff(input?: any): Promise<AgentProjectDiffResult>
  status(): Promise<{ root: string; validators: string[] }>
}

export interface AgentProjectReadRequest {
  path: string | string[]
  range?: {
    startLine?: number
    endLine?: number
    startColumn?: number
    endColumn?: number
    startOffset?: number
    endOffset?: number
  }
  maxBytes?: number
  maxChars?: number
  allowUnbounded?: boolean
  baseRevisions?: Record<string, string>
  trust?: {
    source: 'system' | 'user' | 'project' | 'tool' | 'external'
    trust: 'trusted' | 'untrusted'
  }
}

const DefaultAgentReadMaxChars = 500_000
const DefaultAgentSearchLimit = 30
const MaxAgentSearchLimit = 100
const MaxAgentSearchResultChars = 24_000

/**
 * Project Kernel 的 FileSnapshot 还包含正文、绝对路径、内容哈希和适配器元数据。
 * Agent 边界必须显式投影，避免结构类型允许的额外字段在运行时穿透，并防止正文
 * 同时出现在 snapshot.content 与顶层 content 中占用两份模型上下文。
 */
function projectAgentReadResult(
  filePath: string,
  result: AgentProjectKernelReadResult
): AgentProjectReadResult {
  const continuationRange = result.continuation?.range
  const continuation = continuationRange?.startLine
    ? {
        path: result.continuation?.path || filePath,
        range: {
          startLine: continuationRange.startLine,
          ...(isUndefined(continuationRange.startColumn)
            ? {}
            : { startColumn: continuationRange.startColumn }),
          ...(isUndefined(continuationRange.endLine) ? {} : { endLine: continuationRange.endLine }),
          ...(isUndefined(continuationRange.endColumn)
            ? {}
            : { endColumn: continuationRange.endColumn }),
        },
        ...(!isUndefined(result.continuation?.maxChars) && result.continuation.maxChars > 0
          ? { maxChars: result.continuation.maxChars }
          : {}),
        ...(result.continuation?.baseRevision
          ? {
              baseRevisions: {
                [result.continuation.path || filePath]: result.continuation.baseRevision,
              },
            }
          : {}),
      }
    : undefined
  return {
    snapshot: {
      path: result.snapshot.path || filePath,
      exists: result.snapshot.exists,
      isDirectory: result.snapshot.isDirectory,
      isBinary: result.snapshot.isBinary,
      revision: toOptional(result.snapshot.revision),
    },
    ...(isUndefined(result.content) ? {} : { content: result.content }),
    ...(isUndefined(result.range) ? {} : { range: result.range }),
    ...(isUndefined(result.totalLines) ? {} : { totalLines: result.totalLines }),
    ...(isUndefined(result.truncated) ? {} : { truncated: result.truncated }),
    ...(isUndefined(result.nextStartLine) ? {} : { nextStartLine: result.nextStartLine }),
    ...(isUndefined(result.remainingLines) ? {} : { remainingLines: result.remainingLines }),
    ...(isUndefined(result.hasMore) ? {} : { hasMore: result.hasMore }),
    ...(isUndefined(continuation) ? {} : { continuation }),
    ...(isUndefined(result.note) ? {} : { note: result.note }),
  }
}

function unreadableIssue(file: AgentProjectReadResult): Optional<AgentProjectReadIssue> {
  if (!file.snapshot.exists) return {
    path: file.snapshot.path,
    reason: 'not_found',
    message: '路径不存在，未读取任何内容。',
  }
  if (file.snapshot.isDirectory) return {
    path: file.snapshot.path,
    reason: 'directory',
    message: '该路径是目录；project:read 不会枚举目录内容。',
  }
  if (file.snapshot.isBinary) return {
    path: file.snapshot.path,
    reason: 'binary',
    message: '该路径是二进制文件；project:read 只读取文本。',
  }
  return undefined
}

/** Project-owned Agent adapter for multi-file aggregation over the injected read port. */
export async function executeAgentProjectRead(
  project: AgentProjectKernelPort,
  input: AgentProjectReadRequest,
  options: { rootPath?: string } = {}
): Promise<{
  rootPath: string
  count: number
  files: AgentProjectReadResult[]
  issues?: AgentProjectReadIssue[]
  nextAction?: string
  appliedDefaultBound?: { maxChars: number }
}> {
  const {
    path,
    baseRevisions,
    allowUnbounded: _allowUnbounded,
    maxChars,
    ...rest
  } = input
  const paths = isString(path) ? [path] : path
  const appliedDefaultBound = isUndefined(input.maxBytes) && isUndefined(maxChars)
  const totalMaxChars = appliedDefaultBound ? DefaultAgentReadMaxChars : maxChars
  if (!isUndefined(totalMaxChars) && totalMaxChars < paths.length) {
    throw new ProjectError(
      'INVALID_INPUT',
      `批量读取 ${paths.length} 个文件时 maxChars 至少为 ${paths.length}。`,
      { maxChars: totalMaxChars, pathCount: paths.length },
      '请提高 maxChars，或减少本次读取的文件数量。'
    )
  }
  let remainingChars = totalMaxChars
  const files: AgentProjectReadResult[] = []
  const issues: AgentProjectReadIssue[] = []
  for (const [index, filePath] of paths.entries()) {
    const remainingFiles = paths.length - index
    const fileMaxChars = isUndefined(remainingChars)
      ? undefined
      : Math.floor(remainingChars / remainingFiles)
    // 批量读取是 N 次独立读取：单个文件的领域错误记为带路径的 issue，不连累其它文件；
    // 单文件调用仍直接抛出，让失败保持为工具失败。
    const result = await project.read({
      ...rest,
      ...(!isUndefined(fileMaxChars) ? { maxChars: fileMaxChars } : {}),
      path: filePath,
      baseRevision: baseRevisions?.[filePath],
    }).catch((error: unknown) => {
      if (paths.length === 1 || !isAgentProjectError(error)) throw error
      issues.push({
        path: filePath,
        reason: 'failed',
        code: error.reason,
        message: [error.message, error.suggestedNextAction].filter(isString).join(' '),
      })
      return undefined
    })
    if (isUndefined(result)) continue
    const file = projectAgentReadResult(filePath, result)
    files.push(file)
    const issue = unreadableIssue(file)
    if (isPresent(issue)) issues.push(issue)
    if (!isUndefined(remainingChars)) {
      remainingChars = Math.max(0, remainingChars - [...(result.content ?? '')].length)
    }
  }
  const needsPathDiscovery = issues.some(
    (issue) => issue.reason === 'directory' || issue.reason === 'not_found'
  )
  const needsBinaryCapability = issues.some((issue) => issue.reason === 'binary')
  const rootPath = options.rootPath ?? (await project.status()).root
  return {
    rootPath,
    count: files.length,
    files,
    ...(isEmpty(issues) ? {} : { issues }),
    ...(needsPathDiscovery
      ? {
          nextAction: '先用 project:list 枚举精确路径，再调用 project:read；不要继续猜测文件名。',
        }
      : needsBinaryCapability
        ? { nextAction: '请改用能处理该二进制格式的专用能力，不要继续调用 project:read。' }
        : {}),
    ...(appliedDefaultBound
      ? { appliedDefaultBound: { maxChars: DefaultAgentReadMaxChars } }
      : {}),
  }
}

export interface AgentProjectSearchRequest {
  query: string
  path?: string
  include?: string[]
  exclude?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
}

function projectAgentSearchHit(hit: AgentProjectSearchHit): AgentProjectSearchHit {
  return {
    path: hit.path,
    ...(isUndefined(hit.range) ? {} : {
      range: {
        startLine: hit.range.startLine,
        ...(isUndefined(hit.range.startColumn) ? {} : { startColumn: hit.range.startColumn }),
        endLine: hit.range.endLine,
        ...(isUndefined(hit.range.endColumn) ? {} : { endColumn: hit.range.endColumn }),
      },
    }),
    ...(isUndefined(hit.snippet) ? {} : { snippet: hit.snippet }),
  }
}

/**
 * 字面量搜索 0 命中时，query 里的正则语法往往说明模型本想做正则/多选一搜索；
 * 「没搜到」会被误读成「代码里没有」，所以显式点破 regex=false 的字面语义。
 */
function literalQueryRegexHint(query: string): Optional<string> {
  if (query.includes('|'))
    return 'query 含 |，但 regex=false 按字面匹配（| 不表示「或」）；如需多选一请设 regex: true 后重试。'
  const token = /\\[bBdDsSwW(){}[\].+*?^$]|\.[*+]/.exec(query)?.[0]
  if (isPresent(token))
    return `query 含正则语法 ${token}，但 regex=false 按字面匹配；如需正则匹配请设 regex: true 后重试。`
  return undefined
}

/**
 * Project Kernel 搜索结果含 revision/score/backend/adapter/trust 等诊断元数据。
 * Agent 搜索边界只投影定位所需的 path/range/snippet，并同时受条数和序列化字符双重约束；
 * 命中很多时让模型缩小 query/path，而不是把整批内部结果塞进后续每一轮上下文。
 */
export async function executeAgentProjectSearch(
  project: AgentProjectKernelPort,
  input: AgentProjectSearchRequest
): Promise<AgentProjectSearchResult> {
  const requestedLimit = input.limit ?? DefaultAgentSearchLimit
  const effectiveLimit = Math.min(MaxAgentSearchLimit, Math.max(1, requestedLimit))
  const result = await project.search({
    query: input.query,
    root: input.path,
    include: input.include,
    exclude: input.exclude,
    regex: input.regex,
    caseSensitive: input.caseSensitive,
    maxResults: effectiveLimit,
  })
  const hits: AgentProjectSearchHit[] = []
  let serializedChars = 2
  let responseTruncated = isTrue(result.truncated) || result.hits.length > effectiveLimit

  for (const richHit of result.hits.slice(0, effectiveLimit)) {
    const hit = projectAgentSearchHit(richHit)
    const hitChars = JSON.stringify(hit).length + (!isEmpty(hits) ? 1 : 0)
    if (serializedChars + hitChars > MaxAgentSearchResultChars) {
      responseTruncated = true
      break
    }
    hits.push(hit)
    serializedChars += hitChars
  }

  const literalHint = isEmpty(hits) && !isTrue(input.regex) ? literalQueryRegexHint(input.query) : undefined
  return {
    query: result.query,
    hits,
    ...(responseTruncated ? {
      truncated: true,
      nextAction: '结果已达到 Agent 搜索输出上限；请收窄 query、path 或 include 后继续，不要改搜父目录。',
    } : {}),
    ...(isUndefined(literalHint) ? {} : { nextAction: literalHint }),
    ...(isUndefined(result.toolRequirements) ? {} : {
      toolRequirements: result.toolRequirements.map((requirement) => ({
        kind: requirement.kind,
        command: requirement.command,
        ...(isUndefined(requirement.reason) ? {} : { reason: requirement.reason }),
      })),
    }),
  }
}

export interface AgentProjectErrorLike extends Error {
  reason: string
  details?: unknown
  suggestedNextAction?: string
}

export function isAgentProjectError(
  error: unknown,
  reason?: string
): error is AgentProjectErrorLike {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & {
    reason?: unknown
    suggestedNextAction?: unknown
  }
  if (!isString(candidate.reason)) return false
  return isUndefined(reason) || candidate.reason === reason
}

/** JSON-safe error projection exported by the Project Agent adapter. */
export function toAgentProjectErrorObject(
  error: unknown
): Record<string, unknown> {
  if (isAgentProjectError(error)) return {
      name: error.name,
      reason: error.reason,
      message: error.message,
      details: error.details,
      suggestedNextAction: error.suggestedNextAction,
    }
  if (error instanceof Error) return {
      name: error.name,
      message: error.message,
    }
  if (isNull(error)) return {
      name: 'NullError',
      message: '预期错误对象，但收到或抛出了 null。',
    }
  if (isUndefined(error)) return {
      name: 'UndefinedError',
      message: '预期错误对象，但收到或抛出了 undefined。',
    }
  return { message: String(error) }
}
