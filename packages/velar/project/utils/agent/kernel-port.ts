/**
 * 内核端口在 Agent 边界上的投影：读一个文件、搜一次源码，把内核的结果裁成这边要看的字段，把错误整理成 JSON 安全的对象。
 * 这里不设预算、不截断：没读全、没搜全都如实交出去或直接失败，由调用方决定怎么办。参数结构与校验留在项目领域内。
 */

import { isEmpty, isNull, isPresent, isString, isTrue, isUndefined, mapDefined, toOptional } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { AgentProjectKernelPort } from '../../contract/requires.js'
import type { AgentProjectErrorLike, AgentProjectKernelReadResult, AgentProjectReadRequest, AgentProjectReadResult, AgentProjectSearchHit, AgentProjectSearchRequest } from '../../types/agent-port.js'
import { ProjectError } from '../errors.js'

/**
 * Project Kernel 的读取结果还带着绝对路径、内容哈希、适配器元数据与续读位置。Agent 边界必须显式投影，
 * 免得结构类型允许的额外字段在运行时穿透。
 */
export function projectAgentReadResult(filePath: string, result: AgentProjectKernelReadResult): AgentProjectReadResult {
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
    note: result.note,
  }
}

/** 读到的不是可读文本（不存在、是目录、是二进制）时的错误，带码和下一步；读到了正文返回 undefined。 */
function unreadable(file: AgentProjectReadResult): Optional<ProjectError> {
  const path = file.snapshot.path
  if (!file.snapshot.exists) return new ProjectError('TARGET_NOT_FOUND', `${path}：这个路径不存在，什么都没读到。`, { path }, '先 list 出准确的路径再读，别接着猜文件名。')
  if (file.snapshot.isDirectory) return new ProjectError('NOT_SUPPORTED', `${path}：这个路径是目录，read 不列目录。`, { path }, '用 list 列这个目录，再读里面的文件。')
  if (file.snapshot.isBinary) return new ProjectError('NOT_SUPPORTED', `${path}：这个路径是二进制文件，read 只读文本。`, { path }, '图片用 `velar:images` 的 view 看；别的格式用命令处理。')
  return undefined
}

/**
 * 经内核读一个文件，投影成 Agent 边界上的结果。读不到可读文本时抛带码与下一步的项目错误；
 * 读到了但字符上限装不下要的那一段时不抛，由结果的 truncated 说。
 */
export async function readAgentFile(project: AgentProjectKernelPort, input: AgentProjectReadRequest): Promise<AgentProjectReadResult> {
  const file = projectAgentReadResult(input.path, await project.read(input))
  const failure = unreadable(file)
  if (failure) throw failure
  return file
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
 * 搜一次源码，交回全部命中（只留定位要的路径、版本、范围、片段）。内核没收全时——命中超过上限、搜索超时、输出超过缓冲——
 * 整个调用失败，不交回一部分：一部分命中会被当成全部。字面搜索 0 命中而 query 像正则时，nextAction 点破字面语义。
 */
export async function executeAgentProjectSearch(
  project: AgentProjectKernelPort,
  input: AgentProjectSearchRequest
): Promise<{ hits: AgentProjectSearchHit[]; nextAction?: string }> {
  const result = await project.search({
    query: input.query,
    root: input.path,
    include: input.include,
    exclude: input.exclude,
    regex: input.regex,
    caseSensitive: input.caseSensitive,
    // 多要一处：拿到上限加一处，就知道命中超了。
    maxResults: ProjectFileLimits.searchHits + 1,
  })
  if (isTrue(result.truncated) || result.hits.length > ProjectFileLimits.searchHits) {
    const why = isEmpty(result.diagnostics ?? []) ? `命中超过 ${ProjectFileLimits.searchHits} 处（这个上限只为守住内存）` : result.diagnostics!.join(' ')
    throw new ProjectError('SCOPE_VIOLATION', `搜索没能收全命中，这次什么都没交回：${why}。`, { query: input.query }, '收窄 query、path 或 include 再搜。')
  }
  const hits = result.hits.map(projectAgentSearchHit)
  const nextAction = isEmpty(hits) && !isTrue(input.regex) ? literalQueryRegexHint(input.query) : undefined
  return isUndefined(nextAction) ? { hits } : { hits, nextAction }
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
