import { isNumber, isString } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires'
import type { PrepareEditInput } from '../../types/edit'
import type { ProjectEditInput } from '../../types/editing'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { loadProjectFileView, saveProjectFileSource } from '../../utils/agent/file-refs'
import { projectSourceLines } from '../../utils/agent/source-window'
import { suggestProjectEditLocations } from '../../utils/editing/stale-location'
import { ProjectError } from '../../utils/errors'

/**
 * 失败回执的 details 在 Agent 边界每个数组最多保留 10 项。候选与窗口行超过就会被截断：
 * 候选只剩一部分会误导，窗口签发的 fileRef 会覆盖不全，所以都按这个上限整体取舍。
 */
const MaxRecoveryItems = 10

/** Retains the failed intent and supplies one bounded, version-bound confirmation window. */
export async function withProjectEditRecovery(
  input: ProjectEditInput,
  context: ProjectToolContext,
  prepare: () => Promise<PrepareEditInput>,
): Promise<PrepareEditInput> {
  try {
    return await prepare()
  } catch (error) {
    if (!(error instanceof ProjectError) || error.reason !== 'BASE_REVISION_MISMATCH') throw error
    const fileIndex = error.details?.fileIndex
    const file = Number.isInteger(fileIndex) ? input.files[fileIndex] : undefined
    if (!file) throw error
    // 找不到可确认的新位置时，仍按 fileRef 协议说明下一步，并点名要替换的参数路径。
    const stale = new ProjectError(error.reason, error.message, error.details,
      `用 project:read 重新读取该文件的目标范围获取新 fileRef；失败回执带 inputReuse 时，用 reuse + changes 设置 ["files",${fileIndex},"fileRef"]（有 range 的编辑同时确认新行号），正文保持原样。`)
    try {
      const previous = await loadProjectFileView(context, file.fileRef)
      const kernel = await context.project.kernel()
      const current = await kernel.read({ path: previous.path, maxChars: 16_000_000 })
      if (!current.snapshot.exists || current.redacted || current.hasMore || current.truncated || !isString(current.content) || !current.snapshot.revision) throw stale
      const candidates = suggestProjectEditLocations(previous, file.edits, current.content)
      if (!candidates?.length || candidates.length > MaxRecoveryItems) throw stale
      const currentLines = projectSourceLines(current.content)
      const needed = new Set<number>()
      for (const candidate of candidates) {
        const start = isNumber(candidate.range) ? candidate.range : candidate.range[0]
        const end = isNumber(candidate.range) ? candidate.range : candidate.range[1]
        for (let line = Math.max(1, start - 1); line <= Math.min(currentLines.length, end + 1); line++) needed.add(line)
      }
      const lines: Array<[number, string]> = [...needed].sort((a, b) => a - b).map((line) => [line, currentLines[line - 1].text])
      const recovery: Record<string, unknown> = { kind: 'project-edit-candidates', requiresConfirmation: true, fileIndex, candidates }
      const windowFits = lines.length <= MaxRecoveryItems && JSON.stringify(lines).length <= 10_000
      if (windowFits) recovery.window = {
        kind: 'project-source-window', path: previous.path, revision: current.snapshot.revision,
        viewSource: await saveProjectFileSource(context, { path: previous.path, revision: current.snapshot.revision, content: current.content }),
        lines,
      } satisfies ProjectSourceWindow
      throw new ProjectError(error.reason, '文件版本已变化；原目标及相邻原文仍可唯一定位，请确认当前上下文。', { ...error.details, recovery },
        windowFits
          ? `检查 recovery.window 后，用 reuse + changes 设置 ["files",${fileIndex},"fileRef"] 为窗口里的新 fileRef；有 range 的编辑按 candidates 同步新行号，at 边界插入保持 at。text 保持原样；新引用仍需通过提交版本检查。`
          : `candidates 给出了新行号，但范围太大放不进回执：先用 project:read 读取这些行获取新 fileRef，再用 reuse + changes 设置 ["files",${fileIndex},"fileRef"] 并按 candidates 同步 range。text 保持原样。`)
    } catch (recoveryError) {
      if (recoveryError instanceof ProjectError && recoveryError.details?.recovery) throw recoveryError
      throw stale
    }
  }
}
