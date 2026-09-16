/**
 * 项目文件的读取、列举与搜索：三个只读工具的主体。都经宿主给的内核端口取数据，把结果整理成模型看的源码窗口并登记进当前文件视图。
 * 排队用的项目资源门在执行类里套，这里不管；代码查询取目标源码时直接用 readProjectSource，不再排一次队。
 */

import { createHash } from 'node:crypto'

import type { FileContextSnapshot } from '@velaros-ai/agent/tool-contract'
import { isEmpty, isNotUndefined, Log, optionalWhen } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectToolContext } from '../../contract/requires.js'
import type { ListCursor } from '../../types/agent.js'
import type { AgentProjectReadResult } from '../../types/agent-port.js'
import type { ObserveInput } from '../../types/io.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import type { ProjectListInput, ProjectReadInput, ProjectSearchInput } from '../../types/tools.js'
import { readLineRange } from '../editing/line-range.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { registerProjectFileContext, snapshotFromRead } from './file-context.js'
import { resolveProjectReadPage } from './file-refs.js'
import { executeAgentProjectRead, executeAgentProjectSearch, toAgentProjectErrorObject } from './kernel-port.js'
import { readProjectReceipt, saveProjectReceipt } from './receipts.js'
import { presentProjectRead } from './source-window.js'

/** 读项目文件：files 或 continuation 二选一，按共用的字符预算切窗口，登记进当前文件视图；单个文件失败只进 issues，只读一个文件时直接抛。 */
export async function readProjectSource(input: ProjectReadInput, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  const parsed = input
  const kernel = await context.project.kernel()
  const coordinator = registerProjectFileContext(context)
  const sequence = coordinator?.beginObservation()
  const page = parsed.continuation ? await resolveProjectReadPage(context, parsed.continuation) : undefined
  if (page) {
    const current = await kernel.read({ path: page.path, baseRevision: page.revision, maxChars: Math.max(1, page.content.length + 1) })
    if (current.redacted || current.truncated || current.hasMore || current.content !== page.content)
      throw new ProjectError('BASE_REVISION_MISMATCH', '续读页对应的文件已经变了；重新发起一次读取。')
  }
  const requests = page ? [{ path: page.path, range: page.range, baseRevision: page.revision }]
    : (parsed.files ?? []).map((file) => ({ path: file.path, range: readLineRange(file.range), baseRevision: undefined }))
  let remaining = parsed.maxChars ?? ProjectFileLimits.readCharsDefault
  const files: ProjectSourceWindow[] = []
  const issues: unknown[] = []
  const snapshots: AgentProjectReadResult[] = []
  for (const [index, request] of requests.entries()) {
    context.abortSignal.throwIfAborted()
    try {
      const result = await executeAgentProjectRead(kernel, {
        path: request.path, range: request.range,
        baseRevisions: request.baseRevision ? { [request.path]: request.baseRevision } : undefined,
        maxChars: Math.max(1, Math.floor(remaining / (requests.length - index))),
      }, { rootPath: context.project.getRootPath() })
      issues.push(...(result.issues ?? []))
      for (const file of result.files) {
        files.push(await presentProjectRead(context, file, request.range, page?.source))
        snapshots.push(file)
        remaining = Math.max(0, remaining - [...(file.content ?? '')].length)
      }
    } catch (error) {
      if (requests.length === 1) throw error
      issues.push({ path: request.path, reason: 'failed', ...toAgentProjectErrorObject(error) })
    }
  }
  if (coordinator && isNotUndefined(sequence)) await coordinator.observe(snapshots.flatMap((file, index) => {
    const snapshot = snapshotFromRead(context.project.getRootPath(), file)
    const view = files[index]
    return snapshot ? [{ ...snapshot, viewSource: view?.viewSource, presentation: view ? {
      lines: view.lines, fragments: view.fragments,
      continuation: view.continuation, hasMore: file.hasMore,
    } : undefined }] : []
  }), sequence, context.toolCallId)
  return { rootPath: context.project.getRootPath(), count: files.length, files, issues: optionalWhen(!isEmpty(issues), issues) }
}

/** 搜项目源码：命中按文件与版本合成可编辑的源码窗口（总量有上限，装不下的只留定位），窗口作为顺带观察进入当前文件视图。 */
export async function searchProjectSource(input: ProjectSearchInput, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  const kernel = await context.project.kernel()
  const coordinator = registerProjectFileContext(context)
  const sequence = coordinator?.beginObservation()
  const result = await executeAgentProjectSearch(kernel, input)
  const contextLines = input.contextLines ?? ProjectFileLimits.searchContextLinesDefault
  const windows = new Map<string, { path: string; revision: string; startLine: number; endLine: number }>()
  for (const hit of result.hits) {
    if (!hit.range || !hit.revision) continue
    const key = `${hit.path}\u0000${hit.revision}\u0000${hit.range.startLine}`
    windows.set(key, { path: hit.path, revision: hit.revision, startLine: Math.max(1, hit.range.startLine - contextLines), endLine: hit.range.endLine + contextLines })
  }
  const files: ProjectSourceWindow[] = []
  // 预算按呈现给模型的窗口 JSON 计算：每个窗口自带路径、版本、引用等固定元数据，只数正文会让
  // 上百个命中把结果撑过页出阈值，最终整份被裁成残片。装不下的命中保留定位信息，需要时再 read。
  let remaining = ProjectTuning.search.windowBudgetChars
  const snapshots: FileContextSnapshot[] = []
  for (const [index, window] of [...windows.values()].entries()) {
    context.abortSignal.throwIfAborted()
    if (remaining <= 0) break
    try {
      const read = await executeAgentProjectRead(kernel, {
        path: window.path, range: { startLine: window.startLine, endLine: window.endLine },
        baseRevisions: { [window.path]: window.revision },
        maxChars: Math.max(1, Math.floor(remaining / (windows.size - index))),
      }, { rootPath: context.project.getRootPath() })
      for (const file of read.files) {
        const projected = await presentProjectRead(context, file)
        files.push(projected)
        const snapshot = snapshotFromRead(context.project.getRootPath(), file)
        if (snapshot) snapshots.push({ ...snapshot, viewSource: projected.viewSource, presentation: {
          lines: projected.lines, fragments: projected.fragments,
          continuation: projected.continuation, hasMore: file.hasMore,
        } })
        remaining -= JSON.stringify(projected).length
      }
    } catch (error) {
      // 并发修改后保留命中的定位信息；可编辑窗口必须重新读取。
      Log.tag('ProjectSearch').debug('source_window_unavailable', { path: window.path, error: String(error) })
    }
  }
  // 搜索窗口是顺带观察：进入当前视图供编辑引用，但不能挤掉模型显式读取的文件。
  if (coordinator && isNotUndefined(sequence)) await coordinator.observe(snapshots, sequence, context.toolCallId, false, 'incidental')
  return {
    ...result, rootPath: context.project.getRootPath(), files,
    hits: result.hits.map((hit) => files.some((file) => file.path === hit.path && file.revision === hit.revision)
      ? { path: hit.path, revision: hit.revision, range: hit.range }
      : { ...hit, editable: false }),
  }
}

/** 列项目文件和目录：按 path、glob、深度扫描，按稳定指纹分页；续页只认 cursor，目录变了就让调用方重新列。 */
export async function listProjectEntries(input: ProjectListInput, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  const saved = input.cursor
    ? await readProjectReceipt(context, 'list-page', input.cursor) as ListCursor
    : undefined
  const query: ObserveInput = saved?.query ?? {
    path: input.path,
    include: scopeProjectListPatterns(input.path, input.include),
    exclude: scopeProjectListPatterns(input.path, input.exclude),
    recursive: input.recursive,
    maxDepth: input.maxDepth,
  }
  const kernel = await context.project.kernel()
  const scanned = await kernel.listFiles({ ...query, maxFiles: ProjectTuning.list.maxEntries + 1 })
  context.abortSignal.throwIfAborted()
  const fingerprint = createHash('sha256').update(JSON.stringify(scanned)).digest('hex')
  if (saved && saved.fingerprint !== fingerprint)
    throw new ProjectError('BASE_REVISION_MISMATCH', '这个目录在上一页之后变过，cursor 已经过期。', {
      restart: query,
    }, '去掉 cursor、按 restart 里的条件重新列一次，再用新回执里的 cursor 续页。')
  const offset = saved?.offset ?? 0
  const available = scanned.slice(0, ProjectTuning.list.maxEntries)
  const entries = available.slice(offset, offset + input.limit)
  const nextOffset = offset + entries.length
  const hasMore = nextOffset < available.length
  const scanTruncated = scanned.length > ProjectTuning.list.maxEntries
  const cursor = hasMore
    ? await saveProjectReceipt(context, 'list-page', { query, fingerprint, offset: nextOffset } satisfies ListCursor)
    : undefined
  return {
    rootPath: context.project.getRootPath(),
    entries,
    truncated: hasMore || scanTruncated,
    cursor,
    scanTruncated: scanTruncated || undefined,
    nextAction: hasMore && cursor
      ? '继续列举时只传 cursor 和可选 limit。'
      : (scanTruncated || hasMore) ? '请缩小 path 或 include 后继续列举。' : undefined,
  }
}

/**
 * 把 include/exclude 规整成相对项目根的写法：模型常按「相对 path 目录」写 glob，内核按项目根相对路径匹配；两种写法都接受，
 * 否则 path="scripts/build"、include=["*.mjs"] 会静默列出空结果，已经写成 scripts/build/*.mjs 的保持不变。
 */
export function scopeProjectListPatterns(
  path: LooseOptional<string>,
  patterns: LooseOptional<readonly string[]>
): Optional<string[]> {
  if (!patterns) return undefined
  const base = path?.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!base || base === '.' || base.startsWith('/') || /^[a-zA-Z]:\//.test(base))
    return [...patterns]
  return patterns.map((pattern) => {
    const portable = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (
      !portable ||
      portable.startsWith('/') ||
      portable === base ||
      portable.startsWith(`${base}/`)
    )
      return portable
    return `${base}/${portable}`
  })
}
