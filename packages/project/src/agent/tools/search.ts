import type { FileContextSnapshot } from '@velaros-ai/agent/tool-contract'
import { isNotUndefined, Log } from '@velaros-ai/core'

import { ProjectToolNames } from '../../project-tool-names.js'
import { type ProjectSearchInput,ProjectSearchInputSchema } from '../contracts/search.js'
import { presentProjectRead, ProjectSourceInstructions, type ProjectSourceWindow } from '../presentation/source-window.js'
import { ProjectReadCapability } from '../ProjectCapabilities.js'
import { registerProjectFileContext, snapshotFromRead } from '../ProjectFileContext.js'
import { executeAgentProjectRead, executeAgentProjectSearch } from '../ProjectKernelPort.js'
import type { ProjectToolContext } from '../Types.js'

import { defineProjectTool } from './shared.js'

/** 窗口总量上限；加上最多 100 条命中的定位记录后仍留在模型档预算以内。 */
const SearchWindowBudgetChars = 12_000

export async function executeProjectSearch(input: ProjectSearchInput, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  const kernel = await context.project.kernel()
  const coordinator = registerProjectFileContext(context)
  const sequence = coordinator?.beginObservation()
  const result = await executeAgentProjectSearch(kernel, input)
  const contextLines = input.contextLines ?? 1
  const windows = new Map<string, { path: string; revision: string; startLine: number; endLine: number }>()
  for (const hit of result.hits) {
    if (!hit.range || !hit.revision) continue
    const key = `${hit.path}\u0000${hit.revision}\u0000${hit.range.startLine}`
    windows.set(key, { path: hit.path, revision: hit.revision, startLine: Math.max(1, hit.range.startLine - contextLines), endLine: hit.range.endLine + contextLines })
  }
  const files: ProjectSourceWindow[] = []
  // 预算按呈现给模型的窗口 JSON 计算：每个窗口自带路径、版本、引用等固定元数据，只数正文会让
  // 上百个命中把结果撑过页出阈值，最终整份被裁成残片。装不下的命中保留定位信息，需要时再 read。
  let remaining = SearchWindowBudgetChars
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

export const projectSearch = defineProjectTool<ProjectSearchInput>({
  name: ProjectToolNames.search, category: 'project-files', role: 'inspect',
  summary: 'Search literal text or regex and return versioned source windows for edits.',
  usage: [ProjectSourceInstructions, 'regex=false matches literal text; | has no special meaning. Only displayed source windows carry editable fileRef; location-only hits require read.', '符号定义、引用、调用者与依赖影响优先使用当前可用的 project:code；需要查找该能力时，按本轮已提供的工具发现入口操作。仅有文本搜索时，将命中作为候选证据。'],
  examples: [{ query: 'loadSettings', path: 'src' }],
  schema: ProjectSearchInputSchema, permissions: ['fs:read'], capabilities: ProjectReadCapability,
  exposure: { tier: 'common', rank: 30 }, isConcurrencySafe: () => true,
  execute: executeProjectSearch,
})
