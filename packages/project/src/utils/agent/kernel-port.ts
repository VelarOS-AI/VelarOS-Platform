/**
 * 内核端口在 Agent 边界上的投影：批量读取按共用预算逐文件读，把内核的读取与搜索结果裁成模型要看的字段，把错误整理成 JSON 安全的对象。
 * 参数结构与校验留在项目领域内；返回的只有 Agent 编排读取和事务编辑时真正观察的字段。
 */

import {
  isEmpty,
  isNull,
  isPositiveNumber,
  isPresent,
  isString,
  isTrue,
  isUndefined,
  mapDefined,
  optionalWhen,
  toOptional,
} from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { AgentProjectKernelPort } from '../../contract/requires.js'
import type { AgentProjectErrorLike,AgentProjectKernelReadResult, AgentProjectReadContinuation, AgentProjectReadIssue, AgentProjectReadRequest, AgentProjectReadResult, AgentProjectSearchHit, AgentProjectSearchRequest, AgentProjectSearchResult } from '../../types/agent-port.js'
import { ProjectError } from '../errors.js'
import { validateReadBounds } from '../files/read-bounds.js'
import { ProjectTuning } from '../tuning.js'

/**
 * Project Kernel 的 FileSnapshot 还包含正文、绝对路径、内容哈希和适配器元数据。
 * Agent 边界必须显式投影，避免结构类型允许的额外字段在运行时穿透，并防止正文
 * 同时出现在 snapshot.content 与顶层 content 中占用两份模型上下文。
 */
export function projectAgentReadResult(
  filePath: string,
  result: AgentProjectKernelReadResult
): AgentProjectReadResult {
  return {
    snapshot: {
      path: result.snapshot.path || filePath,
      exists: result.snapshot.exists,
      isDirectory: result.snapshot.isDirectory,
      isBinary: result.snapshot.isBinary,
      revision: toOptional(result.snapshot.revision),
    },
    content: result.content,
    redacted: result.redacted,
    range: result.range,
    totalLines: result.totalLines,
    truncated: result.truncated,
    nextStartLine: result.nextStartLine,
    remainingLines: result.remainingLines,
    hasMore: result.hasMore,
    continuation: projectAgentReadContinuation(filePath, result.continuation),
    note: result.note,
  }
}

/** 续读位置：内核没给起始行时没有可续读的位置。 */
function projectAgentReadContinuation(
  filePath: string,
  continuation: AgentProjectKernelReadResult['continuation']
): Optional<AgentProjectReadContinuation> {
  const range = continuation?.range
  if (!continuation || !range?.startLine) return undefined
  const path = continuation.path || filePath
  const projected: AgentProjectReadContinuation = {
    path,
    range: {
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
    },
    maxChars: optionalWhen(isPositiveNumber, continuation.maxChars),
  }
  if (continuation.baseRevision) projected.baseRevisions = { [path]: continuation.baseRevision }
  return projected
}

/** 读到的不是可读文本（不存在、是目录、是二进制）时给一条带原因的 issue；读到了正文返回 undefined。 */
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

/**
 * 批量读取：一个或多个路径逐个经内核端口读，maxChars 是全部文件共用的字符预算，按剩余文件平均分；两个上限都没给时按 ProjectFileLimits.readChars 封顶并在结果里说明。
 * 单个文件的领域错误只记成带路径的 issue、不连累其他文件；只读一个文件时照常抛出。
 */
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
  // 与文件无关的参数错误属于整次调用：先整体校验，别让下面的逐文件隔离把它拆成 N 条相同的 issue。
  validateReadBounds({ range: input.range, maxBytes: input.maxBytes, maxChars })
  const appliedDefaultBound = isUndefined(input.maxBytes) && isUndefined(maxChars)
  const totalMaxChars = appliedDefaultBound ? ProjectFileLimits.readChars : maxChars
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
      maxChars: fileMaxChars,
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
  const rootPath = options.rootPath ?? (await project.status()).root
  return {
    rootPath,
    count: files.length,
    files,
    issues: optionalWhen(!isEmpty(issues), issues),
    nextAction: readIssuesNextAction(issues),
    appliedDefaultBound: optionalWhen(appliedDefaultBound, { maxChars: ProjectFileLimits.readChars }),
  }
}

/** 按读取问题给模型下一步；全部读到时没有建议。 */
function readIssuesNextAction(issues: readonly AgentProjectReadIssue[]): Optional<string> {
  if (issues.some((issue) => issue.reason === 'directory' || issue.reason === 'not_found'))
    return '先用 project:list 枚举精确路径，再调用 project:read；不要继续猜测文件名。'
  if (issues.some((issue) => issue.reason === 'binary'))
    return '请改用能处理该二进制格式的专用能力，不要继续调用 project:read。'
  if (issues.some((issue) => issue.reason === 'failed'))
    return '部分文件读取失败，原因见 issues；按各条 message 修正后只重读这些路径，已返回的文件不必重读。'
  return undefined
}

/** 把一处内核搜索命中裁成定位要用的路径、版本、范围和片段，丢掉得分、后端这些诊断字段。 */
function projectAgentSearchHit(hit: AgentProjectSearchHit): AgentProjectSearchHit {
  return {
    path: hit.path,
    revision: hit.revision,
    range: mapDefined(hit.range, (range) => ({
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
    })),
    snippet: hit.snippet,
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
  const requestedLimit = input.limit ?? ProjectTuning.search.defaultHits
  const effectiveLimit = Math.min(ProjectFileLimits.searchHits, Math.max(1, requestedLimit))
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
    if (serializedChars + hitChars > ProjectTuning.search.hitsBudgetChars) {
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
    truncated: optionalWhen(responseTruncated, true),
    nextAction:
      literalHint ??
      optionalWhen(
        responseTruncated,
        '结果已达到 Agent 搜索输出上限；请收窄 query、path 或 include 后继续，不要改搜父目录。'
      ),
    toolRequirements: result.toolRequirements?.map((requirement) => ({
      kind: requirement.kind,
      command: requirement.command,
      reason: requirement.reason,
    })),
  }
}

/** 判断一个错误是不是带 reason 的项目领域错误；给了 reason 时还要求码相同。 */
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

/** 把任意抛出的值整理成 JSON 安全的错误对象：项目领域错误带上 reason、details 与 suggestedNextAction，其余只留名字和文字。 */
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
