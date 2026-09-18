/**
 * `velar:project` 的三个读操作的主体：read 读带行号的源码窗口，list 列目录，search 搜源码并把命中合成可编辑的窗口。
 * 路径都相对项目根、钳在项目内；数据都经项目内核取（过读取授权与脱敏）。排队用的项目资源门在执行类里套，这里不管。
 */

import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

import { isEmpty, isString, Log } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectCallContext } from '../../contract/requires.js'
import type { ListCursor, ReadRequest } from '../../types/agent.js'
import type { ProjectListResult, ProjectReadIssue, ProjectReadResult, ProjectSearchHit, ProjectSearchResult } from '../../types/files.js'
import type { ObserveInput } from '../../types/io.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { readLineRange } from '../editing/line-range.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { listInput, readInput, searchInput } from './file-input.js'
import { readReceipt, resolveReadPage, saveReceipt } from './file-refs.js'
import { executeAgentProjectRead, executeAgentProjectSearch, isAgentProjectError } from './kernel-port.js'
import { projectRelativePath } from './ports.js'
import { finalizeFileWindows, presentFileRead, toProjectWindow } from './source-window.js'

const log = Log.tag('ProjectFileReads')

/** 读失败的那一项写成 issue：带码与下一步的项目错误原样搬过去，空间抛的越界按 PERMISSION_DENIED 记，别的按 INVALID_INPUT。 */
function issueOf(path: string, error: unknown): ProjectReadIssue {
  if (isAgentProjectError(error)) {
    const issue: ProjectReadIssue = { path, code: error.reason, message: error.message }
    if (isString(error.suggestedNextAction)) issue.next = error.suggestedNextAction
    return issue
  }
  const failure = error as { code?: unknown; message?: unknown }
  return { path, code: failure.code === 'PERMISSION' ? 'PERMISSION_DENIED' : 'INVALID_INPUT', message: String(failure.message ?? error) }
}

/**
 * read：files 或 continuation 二选一，按共用的字符预算逐个读，排成带行号的窗口并签发 fileRef。
 * 批量里单个文件读不到（不存在、是目录或二进制、不许读、在项目外）只进 issues；只读一个文件时直接失败。
 */
export async function readFiles(input: unknown, ctx: ProjectCallContext): Promise<ProjectReadResult> {
  ctx.abortSignal.throwIfAborted()
  const parsed = readInput(input)
  const kernel = await ctx.project.kernel()
  const page = parsed.continuation ? await resolveReadPage(ctx, parsed.continuation) : undefined
  if (page) {
    const current = await kernel.read({ path: page.path, baseRevision: page.revision, maxChars: Math.max(1, page.content.length + 1) })
    if (current.redacted || current.truncated || current.hasMore || current.content !== page.content) {
      throw new ProjectError('BASE_REVISION_MISMATCH', `${page.path} 在上一页之后改过，续读页作废了。`, { path: page.path }, '去掉 continuation，按路径重新 read。')
    }
  }
  const requests: ReadRequest[] = page
    ? [{ requested: page.path, path: page.path, range: page.range, baseRevision: page.revision }]
    : (parsed.files ?? []).map((file) => ({ requested: file.path, range: readLineRange(file.range) }))
  let remaining = parsed.maxChars ?? ProjectFileLimits.readCharsDefault
  const windows: ProjectSourceWindow[] = []
  const issues: ProjectReadIssue[] = []
  for (const [index, request] of requests.entries()) {
    ctx.abortSignal.throwIfAborted()
    try {
      const path = request.path ?? await projectRelativePath(ctx, request.requested)
      const result = await executeAgentProjectRead(kernel, {
        path, range: request.range,
        baseRevisions: request.baseRevision ? { [path]: request.baseRevision } : undefined,
        maxChars: Math.max(1, Math.floor(remaining / (requests.length - index))),
      }, { rootPath: ctx.project.getRootPath() })
      const unreadable = result.issues?.[0]
      if (unreadable) throw new ProjectError(unreadable.code as ConstructorParameters<typeof ProjectError>[0], `${request.requested}：${unreadable.message}`, { path }, unreadable.next)
      for (const file of result.files) {
        windows.push(await presentFileRead(ctx, file, request.range, page?.source))
        remaining = Math.max(0, remaining - [...(file.content ?? '')].length)
      }
    } catch (error) {
      if (requests.length === 1) throw error
      issues.push(issueOf(request.requested, error))
    }
  }
  const read: ProjectReadResult = { files: (await finalizeFileWindows(ctx, windows)).map(toProjectWindow) }
  if (!isEmpty(issues)) read.issues = issues
  return read
}

/**
 * 把 include、exclude 规整成内核要的写法（按项目根相对路径匹配）。模型照 rg -g、.gitignore 的习惯写，这里照那个意思翻：
 * 不带 / 的按文件名匹配、path 之下任意深度都算（`*.ts` 是 path 下所有 .ts）；带 / 的从 path 起算（`lib/*.ts`）；
 * 已经写成从项目根起的（以 path 开头）原样用；写成绝对路径的，落在项目里就换成相对写法。
 * 否则 path='scripts/build'、include=['*.mjs'] 或整个项目里 include=['*.ts'] 都会静默得到空结果。
 */
export function scopeListPatterns(root: string, base: string, patterns: Optional<readonly string[]>): Optional<string[]> {
  if (!patterns) return undefined
  const prefix = base.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const scoped = !isEmpty(prefix) && prefix !== '.'
  return patterns.map((pattern) => {
    const portable = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (isAbsolute(pattern)) {
      const inside = relative(root, pattern).replaceAll('\\', '/')
      return !inside.startsWith('..') && !isAbsolute(inside) ? inside : portable
    }
    if (!portable || (scoped && (portable === prefix || portable.startsWith(`${prefix}/`)))) return portable
    const anywhere = portable.includes('/') ? portable : `**/${portable}`
    return scoped ? `${prefix}/${anywhere}` : anywhere
  })
}

/** list：按 path、glob、深度扫描，按稳定指纹分页；续页只认 cursor，目录在两页之间变了就让程序重新列。 */
export async function listEntries(input: unknown, ctx: ProjectCallContext): Promise<ProjectListResult> {
  ctx.abortSignal.throwIfAborted()
  const parsed = listInput(input)
  const root = resolve(ctx.project.getRootPath())
  const saved = parsed.cursor ? readReceipt(ctx, 'list-page', parsed.cursor) as ListCursor : undefined
  let query: ObserveInput
  if (saved) query = saved.query
  else {
    const base = isString(parsed.path) ? await projectRelativePath(ctx, parsed.path) : ''
    const depth = parsed.depth ?? ProjectFileLimits.listDepthDefault
    query = {
      path: base || undefined,
      include: scopeListPatterns(root, base, parsed.include),
      exclude: scopeListPatterns(root, base, parsed.exclude),
      recursive: true,
      // 列举按层推进，第 1 层就是 path 这一层：'all' 交给列举的整体上限收着。
      maxDepth: depth === 'all' ? Number.MAX_SAFE_INTEGER : depth,
    }
  }
  const kernel = await ctx.project.kernel()
  const scanned = await kernel.listFiles({ ...query, maxFiles: ProjectTuning.list.maxEntries + 1 })
  ctx.abortSignal.throwIfAborted()
  // 一条都没列出来时核对 path：不存在、是文件的直说，别让程序把它当成一个空目录。
  if (!saved && query.path && isEmpty(scanned)) {
    const target = await kernel.stat({ path: query.path })
    if (!target.exists) throw new ProjectError('TARGET_NOT_FOUND', `${query.path} 不存在。`, { path: query.path }, '去掉 path 从项目根列，或者列它的上级目录看看名字。')
    if (target.kind !== 'directory') throw new ProjectError('INVALID_INPUT', `${query.path} 不是目录。`, { path: query.path }, '要看文件内容用 read。')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(scanned)).digest('hex')
  if (saved && saved.fingerprint !== fingerprint) {
    throw new ProjectError('BASE_REVISION_MISMATCH', '这个目录在上一页之后变过，cursor 已经过期。', { restart: query },
      '去掉 cursor，按原来的条件重新 list，再用新回执里的 cursor 续页。')
  }
  const offset = saved?.offset ?? 0
  const available = scanned.slice(0, ProjectTuning.list.maxEntries)
  const entries = available.slice(offset, offset + parsed.limit)
  const nextOffset = offset + entries.length
  const hasMore = nextOffset < available.length
  const listed: ProjectListResult = {
    entries: entries.map((entry) => ({ path: entry.path, type: entry.type })),
    truncated: hasMore || scanned.length > ProjectTuning.list.maxEntries,
  }
  if (hasMore) listed.cursor = saveReceipt(ctx, 'list-page', { query, fingerprint, offset: nextOffset } satisfies ListCursor)
  return listed
}

/** search：字面文本或正则；命中按文件与版本合成可编辑的源码窗口（总量有上限，装不下的只留位置，要改先 read）。 */
export async function searchFiles(raw: unknown, ctx: ProjectCallContext): Promise<ProjectSearchResult> {
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
    limit: input.limit,
  })
  const contextLines = input.contextLines ?? ProjectFileLimits.searchContextLinesDefault
  const ranges = new Map<string, { path: string; revision: string; startLine: number; endLine: number }>()
  for (const hit of result.hits) {
    if (!hit.range || !hit.revision) continue
    const key = `${hit.path}\u0000${hit.revision}\u0000${hit.range.startLine}`
    ranges.set(key, { path: hit.path, revision: hit.revision, startLine: Math.max(1, hit.range.startLine - contextLines), endLine: hit.range.endLine + contextLines })
  }
  const windows: ProjectSourceWindow[] = []
  // 预算按窗口的 JSON 算：每个窗口自带路径、版本、引用这些固定元数据，只数正文会让上百个命中把结果撑得很大。
  let remaining = ProjectTuning.search.windowBudgetChars
  for (const [index, range] of [...ranges.values()].entries()) {
    ctx.abortSignal.throwIfAborted()
    if (remaining <= 0) break
    try {
      const read = await executeAgentProjectRead(kernel, {
        path: range.path, range: { startLine: range.startLine, endLine: range.endLine },
        baseRevisions: { [range.path]: range.revision },
        maxChars: Math.max(1, Math.floor(remaining / (ranges.size - index))),
      }, { rootPath: ctx.project.getRootPath() })
      for (const file of read.files) {
        const window = await presentFileRead(ctx, file)
        windows.push(window)
        remaining -= JSON.stringify(window).length
      }
    } catch (error) {
      // 搜完之后文件又被改了：命中的位置照样给，可编辑的窗口要重读。
      log.debug('命中处的窗口读不到', { path: range.path, error: String(error) })
    }
  }
  const files = (await finalizeFileWindows(ctx, windows)).map(toProjectWindow)
  const inWindow = (hit: { path: string; revision?: string }) => windows.some((window) => window.path === hit.path && window.revision === hit.revision)
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
  if (result.truncated) searched.truncated = true
  if (isString(result.nextAction)) searched.note = result.nextAction
  return searched
}
