/**
 * 编辑的版本过期恢复：fileRef 背后的文件在读取之后被改过时，按原来的编辑意图在当前内容里重新找位置，
 * 找得到就在失败说明里给出新行号和一个签了新 fileRef 的确认窗口，程序换上新 fileRef、按新行号改就能重提。
 */

import { isNumber, isString, Log } from '@velaros-ai/core'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { ProjectEditStep } from '../../types/files.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { suggestProjectEditLocations } from '../editing/stale-location.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { loadFileView, saveFileSource } from './file-refs.js'
import { finalizeFileWindows, projectSourceLines } from './source-window.js'

const log = Log.tag('FileEditRecovery')

/** 行号或区间写成「第 a 行」「第 a–b 行」。 */
function lineLabel(range: number | [number, number]): string {
  return isNumber(range) ? `第 ${range} 行` : `第 ${range[0]}–${range[1]} 行`
}

/**
 * 按原意图在当前内容里给一步 edit 重新定位：找得到就交回一条带新行号（放得下时再带签了新 fileRef 的确认窗口）的过期错误，
 * 找不到能确认的新位置（文件没了、读不全、原文不再唯一、候选太多）就交回 undefined。
 */
async function relocate(
  error: ProjectError,
  step: Extract<ProjectEditStep, { action: 'edit'; fileRef: string }>,
  stepIndex: number,
  ctx: ProjectOperationContext,
): Promise<Optional<ProjectError>> {
  const previous = await loadFileView(ctx, step.fileRef)
  const kernel = await ctx.project.kernel()
  const current = await kernel.read({ path: previous.path, maxChars: ProjectTuning.agent.fullReadChars })
  if (!current.snapshot.exists || current.hasMore || current.truncated || !isString(current.content) || !current.snapshot.revision) return undefined
  const candidates = suggestProjectEditLocations(previous, step.edits, current.content)
  if (!candidates?.length || candidates.length > ProjectTuning.agent.recoveryItems) return undefined
  const currentLines = projectSourceLines(current.content)
  const needed = new Set<number>()
  for (const candidate of candidates) {
    const start = isNumber(candidate.range) ? candidate.range : candidate.range[0]
    const end = isNumber(candidate.range) ? candidate.range : candidate.range[1]
    for (let line = Math.max(1, start - 1); line <= Math.min(currentLines.length, end + 1); line++) needed.add(line)
  }
  const lines: Array<[number, string]> = [...needed].sort((a, b) => a - b).map((line) => [line, currentLines[line - 1]!.text])
  const moved = candidates.map((candidate) => `第 ${candidate.editIndex + 1} 处编辑现在在${lineLabel(candidate.range)}`).join('；')
  const windowFits = lines.length <= ProjectTuning.agent.recoveryItems && JSON.stringify(lines).length <= ProjectTuning.agent.recoveryWindowChars
  if (!windowFits) return new ProjectError(error.reason, `${error.message} 原来要改的地方还能唯一找到：${moved}。`, error.details,
      `这些行太多，放不进这条说明：先 read 这些行拿新 fileRef，再把 steps[${stepIndex}] 的 fileRef 换成它、有 range 的按新行号改。text 不用动。`)
  const window: ProjectSourceWindow = {
    kind: 'project-source-window', path: previous.path, revision: current.snapshot.revision,
    viewSource: saveFileSource(ctx, { path: previous.path, revision: current.snapshot.revision, content: current.content }),
    lines,
  }
  const [signed] = await finalizeFileWindows(ctx, [window])
  if (!isString(signed?.fileRef)) return undefined
  const shown = lines.map(([line, text]) => `${line}: ${text}`).join('\n')
  return new ProjectError(error.reason, `${error.message} 原来要改的地方还能唯一找到：${moved}。现在这几行是：\n${shown}`, error.details,
    `核对这几行没问题后，把 steps[${stepIndex}] 的 fileRef 换成 ${signed.fileRef}，有 range 的按上面的新行号改，at 插入不用动，text 不用动；提交时还会再核一次版本。`)
}

/**
 * 跑编辑规划；规划因版本过期（BASE_REVISION_MISMATCH）失败时，按原意图在当前内容里重新定位。
 * 候选与窗口行数都受 ProjectTuning.agent.recoveryItems 约束：只给一部分候选会误导，覆盖不全的窗口签不出能用的 fileRef，所以超出就整个不给。
 * 找不到能确认的新位置时照常报过期，并说明怎么重读。
 */
export async function withEditRecovery(
  steps: readonly ProjectEditStep[],
  ctx: ProjectOperationContext,
  prepare: () => Promise<PrepareEditInput>,
): Promise<PrepareEditInput> {
  try {
    return await prepare()
  } catch (error) {
    if (!(error instanceof ProjectError) || error.reason !== 'BASE_REVISION_MISMATCH') throw error
    const stepIndex = Number(error.details?.stepIndex)
    const step = Number.isInteger(stepIndex) ? steps[stepIndex] : undefined
    const stale = new ProjectError(error.reason, error.message, error.details,
      `这个文件在 fileRef 之后改过（可能就是你上一次改的）：用上一次 edit 回执里这个文件的新 fileRef 按新行号重做${Number.isInteger(stepIndex) ? ` steps[${stepIndex}]` : ''}；回执里没有的，重新 read 要改的那几行。text 不用动。`)
    // 只有「凭 fileRef 定位的 edit 步」谈得上按原意图重新定位：文件动作不带编辑，sourceRef、path 指的是本次计划里的文件。
    if (step?.action !== 'edit' || !('fileRef' in step)) throw stale
    const recovered = await relocate(error, step, stepIndex, ctx).catch((recoveryError: unknown) => {
      log.debug('按原意图重新定位失败，照常报过期', { error: String(recoveryError) })
      return undefined
    })
    throw recovered ?? stale
  }
}
