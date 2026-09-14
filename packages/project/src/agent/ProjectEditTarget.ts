import { createHash } from 'node:crypto'

import { isNotUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentProjectReadResult } from './ProjectKernelPort'
import type { ProjectToolContext } from './Types'

interface EditTarget {
  kind: 'project-edit-target'
  root: string
  path: string
  revision: string
  startLine: number
  endLine: number
}
const ToolName = '__project_edit_target__'

/** 仅完整行窗口提供定位引用；正文与 revision 仍由内核读取结果绑定。 */
export async function saveProjectEditTarget(
  context: ProjectToolContext,
  file: AgentProjectReadResult,
  requestedRange?: { startColumn?: number; endColumn?: number }
): Promise<string | undefined> {
  if (
    !context.contextPayloadStore ||
    !context.sessionId ||
    !file.snapshot.revision ||
    file.redacted ||
    !file.range ||
    (file.range.startColumn ?? 1) !== 1 ||
    file.range.startLine > (file.totalLines ?? 0) ||
    file.range.endLine < file.range.startLine ||
    isNotUndefined(requestedRange?.endColumn) ||
    (file.truncated &&
      (!file.continuation || file.continuation.range.startLine <= file.range.endLine)) ||
    file.snapshot.isBinary ||
    file.snapshot.isDirectory
  )
    return undefined
  const target: EditTarget = {
    kind: 'project-edit-target',
    root: context.project.getRootPath(),
    path: file.snapshot.path,
    revision: file.snapshot.revision,
    startLine: file.range.startLine,
    endLine: file.range.endLine,
  }
  const serializedResult = JSON.stringify(target)
  const hash = createHash('sha256').update(serializedResult).digest('hex')
  const ref = `selection:${hash}`
  await context.contextPayloadStore.put({
    sessionId: context.sessionId,
    hash,
    payloadRef: `ctx-payload:${encodeURIComponent(context.sessionId)}:${hash}`,
    toolCallId: ref,
    toolName: ToolName,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
  return ref
}

export async function resolveProjectEditTarget(
  context: ProjectToolContext,
  input: { selectionRef: string; newLines: string[] }
) {
  if (
    !input.selectionRef.startsWith('selection:') ||
    !context.contextPayloadStore ||
    !context.sessionId
  )
    throw new AppError('VALIDATION', 'Use an editTarget returned by project:read')
  const record = await context.contextPayloadStore.findByHash(
    context.sessionId,
    input.selectionRef.slice('selection:'.length)
  )
  if (!record || record.toolName !== ToolName)
    throw new AppError('VALIDATION', 'Edit target is unavailable; read the intended lines again')
  const target = JSON.parse(record.serializedResult) as EditTarget
  if (target.kind !== 'project-edit-target' || target.root !== context.project.getRootPath())
    throw new AppError('PERMISSION', 'Edit target belongs to another workspace')
  return {
    type: 'replace_lines' as const,
    path: target.path,
    baseRevision: target.revision,
    startLine: target.startLine,
    endLine: target.endLine,
    newLines: input.newLines,
  }
}
