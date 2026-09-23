/**
 * `velaros:project` 的三个读操作的主体：read 读带行号的源码窗口，list 列目录，search 搜源码并把命中合成可编辑的窗口。
 * 什么都不折叠：read 交回要的整段，list 交回全部条目，search 交回全部命中与它们所在的行；看多少由程序定。
 * 只有守住内存的上限（ProjectFileLimits 里标明的那几个），超了就明说，不交回一部分冒充全部。
 * 路径都相对项目根、钳在项目内；数据都经项目内核取。排队用的项目资源门在执行类里套，这里不管。
 */

import { isAbsolute, relative, resolve } from 'node:path'

import { isEmpty, isString, isUndefined, Log } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { LineSpan } from '../../types/agent.js'
import type {
  ProjectListResult,
  ProjectReadIssue,
  ProjectReadItem,
  ProjectReadResult,
  ProjectSearchHit,
  ProjectSearchResult,
} from '../../types/files.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { readLineRange } from '../editing/line-range.js'
import { ProjectError } from '../errors.js'

import { listInput, readInput, searchInput } from './file-input.js'
import { executeAgentProjectSearch, isAgentProjectError, readAgentFile } from './kernel-port.js'
import { projectRelativePath } from './ports.js'
import {
  finalizeFileWindows,
  presentFileRead,
  presentFileSpans,
  toProjectWindow,
} from './source-window.js'

const log = Log.tag('ProjectFileReads')

/** 读失败的那一项写成 issue：带码与下一步的项目错误原样搬过去，空间抛的越界按 PERMISSION_DENIED 记，别的按 INVALID_INPUT。 */
function issueOf(path: string, error: unknown): ProjectReadIssue {
  if (isAgentProjectError(error)) {
    const issue: ProjectReadIssue = { path, code: error.reason, message: error.message }
    if (isString(error.suggestedNextAction)) issue.next = error.suggestedNextAction
    return issue
  }
  const failure = error as { code?: unknown; message?: unknown }
  return {
    path,
    code: failure.code === 'PERMISSION' ? 'PERMISSION_DENIED' : 'INVALID_INPUT',
    message: String(failure.message ?? error),
  }
}

/** 一个文件要的那段装不下这次 read 还能交回的量：说清是哪个上限、怎么办。 */
function beyondReadLimit(file: ProjectReadItem, remaining: number): ProjectError {
  const what = isUndefined(file.range) ? '整个文件' : '要的这几行'
  const shared = remaining < ProjectFileLimits.readChars
  return new ProjectError(
    'SCOPE_VIOLATION',
    `${file.path}：${what}超过这次 read 还能交回的 ${remaining} 个字符（一次 read 总共交回 ${ProjectFileLimits.readChars} 个字符，只为守住内存），没有读它。`,
    { path: file.path, remaining },
    shared ? '单独读它，或者用 range 分几段读。' : '用 range 分几段读。'
  )
}

/**
 * read：逐个读要的整段（没给 range 就是整个文件），排成带行号的窗口并签发 fileRef。一次交回的正文总量有守内存的上限，装不下的文件不读。
 * 批量里单个文件读不到（不存在、是目录或二进制、不许读、在项目外、装不下）只进 issues；只读一个文件时直接失败。
 */
export async function readFiles(
  input: unknown,
  ctx: ProjectOperationContext
): Promise<ProjectReadResult> {
  ctx.abortSignal.throwIfAborted()
  const files = readInput(input)
  const kernel = await ctx.project.kernel()
  let remaining: number = ProjectFileLimits.readChars
  const windows: ProjectSourceWindow[] = []
  const issues: ProjectReadIssue[] = []
  for (const file of files) {
    ctx.abortSignal.throwIfAborted()
    try {
      const path = await projectRelativePath(ctx, file.path)
      const range = readLineRange(file.range)
      const read = await readAgentFile(kernel, { path, range, maxChars: remaining })
      if (read.truncated) throw beyondReadLimit(file, remaining)
      windows.push(await presentFileRead(ctx, read, range))
      remaining -= [...(read.content ?? '')].length
    } catch (error) {
      if (files.length === 1) throw error
      issues.push(issueOf(file.path, error))
    }
  }
  const read: ProjectReadResult = {
    files: (await finalizeFileWindows(ctx, windows)).map(toProjectWindow),
  }
  if (!isEmpty(issues)) read.issues = issues
  return read
}

/**
 * 把 include、exclude 规整成内核要的写法（按项目根相对路径匹配）。模型照 rg -g、.gitignore 的习惯写，这里照那个意思翻：
 * 不带 / 的按文件名匹配、path 之下任意深度都算（`*.ts` 是 path 下所有 .ts）；带 / 的从 path 起算（`lib/*.ts`）；
 * 已经写成从项目根起的（以 path 开头）原样用；写成绝对路径的，落在项目里就换成相对写法。
 * 否则 path='scripts/build'、include=['*.mjs'] 或整个项目里 include=['*.ts'] 都会静默得到空结果。
 */
export function scopeListPatterns(
  root: string,
  base: string,
  patterns: Optional<readonly string[]>
): Optional<string[]> {
  if (!patterns) return undefined
  const prefix = base.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const scoped = !isEmpty(prefix) && prefix !== '.'
  return patterns.map((pattern) => {
    const portable = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (isAbsolute(pattern)) {
      const inside = relative(root, pattern).replaceAll('\\', '/')
      return !inside.startsWith('..') && !isAbsolute(inside) ? inside : portable
    }
    if (!portable || (scoped && (portable === prefix || portable.startsWith(`${prefix}/`))))
      return portable
    const anywhere = portable.includes('/') ? portable : `**/${portable}`
    return scoped ? `${prefix}/${anywhere}` : anywhere
  })
}

/** list：按 path、glob、深度扫描，交回全部条目；条目超过守内存的上限时整个调用失败。 */
export async function listEntries(
  input: unknown,
  ctx: ProjectOperationContext
): Promise<ProjectListResult> {
  ctx.abortSignal.throwIfAborted()
  const parsed = listInput(input)
  const root = resolve(ctx.project.getRootPath())
  const base = isString(parsed.path) ? await projectRelativePath(ctx, parsed.path) : ''
  const kernel = await ctx.project.kernel()
  const scanned = await kernel.listFiles({
    path: base || undefined,
    include: scopeListPatterns(root, base, parsed.include),
    exclude: scopeListPatterns(root, base, parsed.exclude),
    recursive: true,
    // 列举按层推进，第 1 层就是 path 这一层；不给 depth 就是整棵树。
    maxDepth: parsed.depth ?? Number.MAX_SAFE_INTEGER,
    // 多要一条：拿到上限加一条，就知道超了。
    maxFiles: ProjectFileLimits.listEntries + 1,
  })
  ctx.abortSignal.throwIfAborted()
  if (scanned.length > ProjectFileLimits.listEntries) {
    throw new ProjectError(
      'SCOPE_VIOLATION',
      `${base || '项目根'} 下的条目超过 ${ProjectFileLimits.listEntries} 条（这个上限只为守住内存），这次什么都没交回。`,
      { path: base },
      '收窄 path、include 或 depth 再列。'
    )
  }
  // 一条都没列出来时核对 path：不存在、是文件的直说，别让程序把它当成一个空目录。
  if (base && isEmpty(scanned)) {
    const target = await kernel.stat({ path: base })
    if (!target.exists)
      throw new ProjectError(
        'TARGET_NOT_FOUND',
        `${base} 不存在。`,
        { path: base },
        '去掉 path 从项目根列，或者列它的上级目录看看名字。'
      )
    if (target.kind !== 'directory')
      throw new ProjectError(
        'INVALID_INPUT',
        `${base} 不是目录。`,
        { path: base },
        '要看文件内容用 read。'
      )
  }
  return { entries: scanned.map((entry) => ({ path: entry.path, type: entry.type })) }
}

/** 命中按文件与版本归到一起，每处前后带 contextLines 行；相交或相邻的段并起来。 */
function hitSpans(
  hits: ReadonlyArray<{
    path: string
    revision?: string
    range?: { startLine: number; endLine: number }
  }>,
  contextLines: number
) {
  const files = new Map<string, { path: string; revision: string; spans: LineSpan[] }>()
  for (const hit of hits) {
    if (!hit.range || !hit.revision) continue
    const key = `${hit.path}\u0000${hit.revision}`
    const file = files.get(key) ?? { path: hit.path, revision: hit.revision, spans: [] }
    file.spans.push({
      startLine: Math.max(1, hit.range.startLine - contextLines),
      endLine: hit.range.endLine + contextLines,
    })
    files.set(key, file)
  }
  for (const file of files.values()) {
    const merged: LineSpan[] = []
    for (const span of file.spans.sort((a, b) => a.startLine - b.startLine)) {
      const last = merged.at(-1)
      if (last && span.startLine <= last.endLine + 1)
        last.endLine = Math.max(last.endLine, span.endLine)
      else merged.push({ ...span })
    }
    file.spans = merged
  }
  return [...files.values()]
}

/**
 * search：字面文本或正则，交回全部命中；每个命中的文件整份读一次，命中所在的行（连同前后 contextLines 行）合成一个带 fileRef 的窗口。
 * 命中超过守内存的上限时整个调用失败。搜完之后文件又被改了的，命中照样给位置，只是没有窗口（editable 为 false）。
 */
export async function searchFiles(
  raw: unknown,
  ctx: ProjectOperationContext
): Promise<ProjectSearchResult> {
  ctx.abortSignal.throwIfAborted()
  const input = searchInput(raw)
  const root = resolve(ctx.project.getRootPath())
  const path = isString(input.path) ? await projectRelativePath(ctx, input.path) : ''
  const kernel = await ctx.project.kernel()
  const result = await executeAgentProjectSearch(kernel, {
    query: input.query,
    path: path || undefined,
    include: scopeListPatterns(root, path, input.include),
    exclude: scopeListPatterns(root, path, input.exclude),
    regex: input.regex,
    caseSensitive: input.caseSensitive,
  })
  const windows: ProjectSourceWindow[] = []
  for (const file of hitSpans(
    result.hits,
    input.contextLines ?? ProjectFileLimits.searchContextLinesDefault
  )) {
    ctx.abortSignal.throwIfAborted()
    try {
      windows.push(await presentFileSpans(ctx, file.path, file.revision, file.spans))
    } catch (error) {
      // 搜完之后文件又被改了：命中的位置照样给，可编辑的窗口要重读。
      log.debug('命中处的窗口读不到', { path: file.path, error: String(error) })
    }
  }
  const files = (await finalizeFileWindows(ctx, windows)).map(toProjectWindow)
  const inWindow = (hit: { path: string; revision?: string }) =>
    windows.some((window) => window.path === hit.path && window.revision === hit.revision)
  const searched: ProjectSearchResult = {
    hits: result.hits.map((hit) => {
      const shaped: ProjectSearchHit = { path: hit.path }
      if (hit.revision) shaped.revision = hit.revision
      if (hit.range) shaped.range = hit.range
      if (!inWindow(hit)) {
        shaped.editable = false
        if (isString(hit.snippet)) shaped.snippet = hit.snippet
      }
      return shaped
    }),
    files,
  }
  if (isString(result.nextAction)) searched.note = result.nextAction
  return searched
}
