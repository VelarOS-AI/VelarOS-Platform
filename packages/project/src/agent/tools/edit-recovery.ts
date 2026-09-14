import { isNumber, isString } from '@velaros-ai/core'

import { loadProjectFileView, saveProjectFileSource } from '../../context/file-refs'
import { suggestProjectEditLocations } from '../../editing/recovery/stale-location'
import type { ProjectEditInput } from '../../editing/types'
import { ProjectError } from '../../errors'
import type { PrepareEditInput } from '../../types/edit'
import { projectSourceLines, type ProjectSourceWindow } from '../presentation/source-window'
import type { ProjectToolContext } from '../Types'

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
    try {
      const previous = await loadProjectFileView(context, file.fileRef)
      const kernel = await context.project.kernel()
      const current = await kernel.read({ path: previous.path, maxChars: 16_000_000 })
      if (!current.snapshot.exists || current.redacted || current.hasMore || current.truncated || !isString(current.content) || !current.snapshot.revision) throw error
      const candidates = suggestProjectEditLocations(previous, file.edits, current.content)
      if (!candidates?.length) throw error
      const currentLines = projectSourceLines(current.content)
      const needed = new Set<number>()
      for (const candidate of candidates) {
        const start = isNumber(candidate.range) ? candidate.range : candidate.range[0]
        const end = isNumber(candidate.range) ? candidate.range : candidate.range[1]
        for (let line = Math.max(1, start - 1); line <= Math.min(currentLines.length, end + 1); line++) {
          needed.add(line)
          if (needed.size > 80) throw error
        }
      }
      const lines: Array<[number, string]> = [...needed].sort((a, b) => a - b).map((line) => [line, currentLines[line - 1].text])
      if (JSON.stringify(lines).length > 10_000) throw error
      const window: ProjectSourceWindow = {
        kind: 'project-source-window', path: previous.path, revision: current.snapshot.revision,
        viewSource: await saveProjectFileSource(context, { path: previous.path, revision: current.snapshot.revision, content: current.content }),
        lines,
      }
      throw new ProjectError(error.reason, '文件版本已变化；原目标及相邻原文仍可唯一定位，请确认当前上下文。', {
        ...error.details,
        recovery: { kind: 'project-edit-candidates', requiresConfirmation: true, fileIndex, candidates, window },
      }, '检查 recovery.window 后，用 reuse + changes 更新该 files 项的 fileRef；有 range 的编辑同步确认新行号，at 边界插入保持 at。text 保持原样；新引用仍需通过提交版本检查。')
    } catch (recoveryError) {
      if (recoveryError instanceof ProjectError && recoveryError.details?.recovery) throw recoveryError
      throw error
    }
  }
}
