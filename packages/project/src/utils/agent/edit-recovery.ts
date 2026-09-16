/**
 * 编辑的版本过期恢复：fileRef 对应的文件在读取之后被改过时，按原意图在当前内容里重新找位置，给模型一个有界、绑定新版本的确认窗口。
 */

import { isNumber, isString } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires'
import type { PrepareEditInput } from '../../types/edit'
import type { ProjectEditInput } from '../../types/editing'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { suggestProjectEditLocations } from '../editing/stale-location'
import { ProjectError } from '../errors'
import { ProjectTuning } from '../tuning.js'

import { loadProjectFileView, saveProjectFileSource } from './file-refs'
import { projectSourceLines } from './source-window'

/**
 * 执行编辑计划；计划因版本过期（BASE_REVISION_MISMATCH）失败时，按原意图在当前内容里重新定位，失败回执带上候选新位置和一个有界的确认窗口
 * （窗口签发新 fileRef，编辑正文原样保留）。候选与窗口行数都受 ProjectTuning.agent.recoveryItems 约束：失败回执的 details 在 Agent 边界每个数组
 * 只留有限几项，只剩一部分的候选会误导、覆盖不全的窗口签不出可用的 fileRef，所以超出就整体不给。找不到可确认的新位置时照常报过期并说明怎么重读。
 */
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
      `这个文件在该 fileRef 之后改过（可能就是你上一次的修改）：用 [Current project files] 或上一次修改回执里这个文件的新 fileRef，按新行号重做；那里没有再 project:read。回执带 inputReuse 时，用 reuse + changes 设置 ["files",${fileIndex},"fileRef"]（有 range 的同时改行号），正文不用重写。`)
    try {
      const previous = await loadProjectFileView(context, file.fileRef)
      const kernel = await context.project.kernel()
      const current = await kernel.read({ path: previous.path, maxChars: ProjectTuning.agent.fullReadChars })
      if (!current.snapshot.exists || current.redacted || current.hasMore || current.truncated || !isString(current.content) || !current.snapshot.revision) throw stale
      const candidates = suggestProjectEditLocations(previous, file.edits, current.content)
      if (!candidates?.length || candidates.length > ProjectTuning.agent.recoveryItems) throw stale
      const currentLines = projectSourceLines(current.content)
      const needed = new Set<number>()
      for (const candidate of candidates) {
        const start = isNumber(candidate.range) ? candidate.range : candidate.range[0]
        const end = isNumber(candidate.range) ? candidate.range : candidate.range[1]
        for (let line = Math.max(1, start - 1); line <= Math.min(currentLines.length, end + 1); line++) needed.add(line)
      }
      const lines: Array<[number, string]> = [...needed].sort((a, b) => a - b).map((line) => [line, currentLines[line - 1].text])
      const recovery: Record<string, unknown> = { kind: 'project-edit-candidates', requiresConfirmation: true, fileIndex, candidates }
      const windowFits = lines.length <= ProjectTuning.agent.recoveryItems && JSON.stringify(lines).length <= ProjectTuning.agent.recoveryWindowChars
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
