import { relative, resolve } from 'node:path'

import type { ToolInputReuseMigrationRequest } from '@velaros-ai/agent/tool-contract'
import { isArray, isEmpty, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import { ProjectChangeSchema } from '../agent/contracts/change'
import { ProjectEditSchema } from '../agent/contracts/edit'
import { ProjectFileSchema } from '../agent/contracts/file'
import { resolveProjectEditTarget } from '../agent/ProjectEditTarget'
import type { ProjectToolContext } from '../agent/Types'
import { resolveProjectFileRef } from '../context/file-refs'
import { planProjectFileEdits } from '../editing/planner/content'
import { ProjectSourceCoordinates } from '../editing/selectors/source'
import { ProjectModelEditSchema } from '../edits/schema'
import { textPatchStrategy } from '../edits/strategies/text-strategy'
import { ProjectError } from '../errors'
import { DEFAULT_CORE_POLICY } from '../policy/defaults'
import { ProjectToolNames } from '../project-tool-names'

/** 仅允许可信复用恢复链调用，模型的新请求由当前严格契约解析。 */
export const ProjectInputContractVersion = 2
export function projectInputReuseSourceTools(toolName: string): readonly string[] | undefined {
  if (toolName === ProjectToolNames.edit || toolName === ProjectToolNames.file)
    return ['project:edit', 'project:write']
  if (toolName === ProjectToolNames.change) return ['project:edit', 'project:write', 'project:rollback']
  return undefined
}

function fail(request: ToolInputReuseMigrationRequest, message: string, details?: Record<string, unknown>): never {
  throw new ProjectError('INVALID_INPUT', `Saved Project v1 input needs migration: ${message}`, {
    kind: 'project-input-migration', reuse: `attempt:${request.sourceCallId}`,
    sourceTool: request.sourceToolName, ...details,
  }, `Keep reuse="attempt:${request.sourceCallId}" and submit only the indicated changes; the saved body remains available.`)
}

/**
 * 仅转换可信恢复且确认未执行的第 1 版输入。每个已有文件都需要当前可见窗口的 fileRef，
 * 同时保留原版本与匹配数量断言；内部读取不授予编辑权限。
 */
async function migrateProjectInput(
  toolName: string,
  request: ToolInputReuseMigrationRequest,
  context: ProjectToolContext
): Promise<Record<string, unknown>> {
  if (request.sourceContractVersion !== 1 || request.targetContractVersion !== 2)
    return fail(request, 'Unsupported contract version.', { sourceVersion: request.sourceContractVersion, targetVersion: request.targetContractVersion })
  const root = context.project.getRootPath()
  const raw = request.input
  const pathInProject = (path: string, cwd = isString(raw.cwd) ? raw.cwd : '.') => {
    const absolute = resolve(root, cwd, path)
    const local = relative(root, absolute)
    if (local === '..' || local.startsWith('../') || local.startsWith('..\\'))
      fail(request, 'Path escapes the current project.')
    return local || '.'
  }
  if (request.sourceToolName === 'project:rollback') {
    const { legacyProjectTools } = await import('./agent-tools')
    const parsed = legacyProjectTools['project:rollback'].schema.parse(raw)
    if (toolName !== ProjectToolNames.change) return fail(request, 'Use project:change to restore rollback input.')
    return ProjectChangeSchema.parse({ action: 'undo', changeRef: parsed.transactionId })
  }
  let parsed: { edits: any[]; baseRevisions?: Record<string, string>; cwd?: string }
  let refs: unknown[]
  if (request.sourceToolName === 'project:write') {
    const { fileRef, ...original } = raw
    const { legacyProjectTools } = await import('./agent-tools')
    const old = legacyProjectTools['project:write'].schema.parse(original)
    refs = [fileRef]
    parsed = { cwd: old.cwd, baseRevisions: old.baseRevision ? { [old.path]: old.baseRevision } : undefined,
      edits: [old.mode === 'create' || old.mode === 'overwrite'
        ? { type: 'create_file', path: old.path, content: old.content, overwrite: old.mode === 'overwrite' }
        : { type: old.mode === 'append' ? 'append_text' : 'prepend_text', path: old.path, text: old.content, skipIfAlreadyPresent: old.skipIfAlreadyPresent }],
    }
    if ((old.mode === 'create' || old.mode === 'overwrite') && old.skipIfAlreadyPresent)
      fail(request, 'skipIfAlreadyPresent is not meaningful for create/overwrite; remove it explicitly.')
  } else if (request.sourceToolName === 'project:edit') {
    refs = isArray(raw.edits) ? raw.edits.map((edit) => isPlainObject(edit) ? edit.fileRef : undefined) : []
    // 只附加迁移所需的引用，其余字段仍由原严格契约校验。
    parsed = ProjectModelEditSchema.parse({ ...raw, edits: isArray(raw.edits)
      ? raw.edits.map((edit) => { if (!isPlainObject(edit)) return edit; const { fileRef: _fileRef, ...operation } = edit; return operation }) : raw.edits })
  } else return fail(request, 'This source tool has no Project mutation migration.')

  const files: Array<{ fileRef: string; edits: any[] }> = []
  const actions: any[] = []
  const steps: any[] = []
  const touched = new Map<string, { kind: string; file?: typeof files[number] }>()
  for (const [index, item] of parsed.edits.entries()) {
    const operation = item.type === 'replace_selection' ? await resolveProjectEditTarget(context, item) : item
    const slot = request.sourceToolName === 'project:write' ? ['fileRef'] : ['edits', index, 'fileRef']
    const path = pathInProject(operation.type === 'rename_file' ? operation.from : operation.path)
    const expectedRevisions = [operation.baseRevision, ...Object.entries(parsed.baseRevisions ?? {}).filter(([key]) => pathInProject(key) === path).map(([, revision]) => revision)].filter((value): value is string => isString(value))
    let fileRef: string | undefined
    let view: Awaited<ReturnType<typeof resolveProjectFileRef>> | undefined
    if (operation.type !== 'create_file' || operation.overwrite) {
      if (!isString(refs[index])) fail(request, 'Read the intended file window, then attach its displayed fileRef to the saved operation.', { operationIndex: index, operation: operation.type, path, correctionPath: slot })
      fileRef = refs[index] as string
      view = await resolveProjectFileRef(context, fileRef)
      if (resolve(root, view.path) !== resolve(root, path)) fail(request, 'The supplied fileRef names a different file.', { operationIndex: index, path, correctionPath: slot })
      if (expectedRevisions.some((expected) => expected !== view!.revision))
        fail(request, 'The old line/revision assertion differs from the displayed file. Confirm the intended range and update its baseRevision explicitly.', { operationIndex: index, path, expectedRevisions, displayedRevision: view.revision })
    }
    const previous = touched.get(path)
    if (previous && !(previous.kind === 'replace_lines' && operation.type === 'replace_lines'))
      fail(request, 'Multiple sequential operations on one old file cannot be silently converted to simultaneous edits. Express the sequence with project:change after reviewing it.', { operationIndex: index, path, targetTool: ProjectToolNames.change })
    if (operation.skipIfAlreadyPresent)
      fail(request, 'Idempotency semantics require review; inspect the current boundary, then remove skipIfAlreadyPresent explicitly if insertion is still intended.', { operationIndex: index, path })
    let edit: any
    let action: any
    switch (operation.type) {
      case 'replace_lines': {
        const lines = new ProjectSourceCoordinates(view!.content).lines
        const selectedEndsWithNewline = Boolean(lines[operation.endLine - 1]?.newline)
        // 转换为文本后仍保留末尾空白替换行。
        const text = operation.newLines.join('\n') + (selectedEndsWithNewline && isString(operation.newLines.at(-1)) && isEmpty(operation.newLines.at(-1)) ? '\n' : '')
        edit = { op: 'replace', range: [operation.startLine, operation.endLine], text }
        break
      }
      case 'replace_text':
      case 'insert_text_at_anchor': {
        // 全文匹配数量检查保留原断言；新计划器还会独立检查选中的字符
        // 是否处于实际展示窗口内。
        const match = operation.type === 'replace_text' ? operation.oldText : operation.anchorText
        let count = 0; let offset = 0
        while ((offset = view!.content.indexOf(match, offset)) !== -1) { count++; offset += match.length }
        if (!isUndefined(operation.expectedMatches) && operation.expectedMatches !== count)
          fail(request, 'The saved expectedMatches assertion still fails.', { operationIndex: index, expectedMatches: operation.expectedMatches, actualMatches: count })
        if (count !== 1 || (!isUndefined(operation.occurrence) && operation.occurrence !== 1))
          fail(request, 'The old text selector does not identify one unique current match. Read the intended lines and convert to replace_lines, keeping the saved replacement body.', { operationIndex: index, actualMatches: count })
        edit = operation.type === 'replace_text' ? { op: 'replace', match, text: operation.newText }
          : { op: 'insert', match, side: operation.position, text: operation.text }
        break
      }
      case 'append_text': case 'prepend_text': {
        const lines = new ProjectSourceCoordinates(view!.content).lines
        const atEnd = operation.type === 'append_text'
        const index = atEnd && lines.at(-1)!.start === view!.content.length ? Math.max(0, lines.length - 2) : atEnd ? lines.length - 1 : 0
        const line = lines[index]
        edit = !isEmpty(view!.content)
          ? { op: 'insert', range: index + 1, match: view!.content.slice(line.start, line.end), side: atEnd ? 'after' : 'before', text: operation.text }
          : { op: 'insert', at: 'start', text: operation.text }
        break
      }
      case 'create_file': action = operation.overwrite ? { op: 'overwrite', fileRef, text: operation.content } : { op: 'create', path, text: operation.content }; break
      case 'delete_file': action = { op: 'delete', fileRef }; break
      case 'rename_file': action = { op: 'move', fileRef, to: pathInProject(operation.to) }; break
      default: fail(request, 'This operation needs an explicit source selection in the new contract. Read the symbol/source window and express the intended replace or insert; the original saved body remains available.', { operationIndex: index, operation: operation.type, path, targetTool: ProjectToolNames.edit })
    }
    if (edit) {
      // 准备事务前比较新旧纯计划器输出，检查实际换行和空白行差异，
      // 同时保持当前可见范围的限制。
      const original = await textPatchStrategy().prepare({
        intent: { operation }, snapshot: {
          path, absPath: resolve(root, path), content: view!.content, revision: view!.revision,
          exists: true, isDirectory: false, isBinary: false, size: new TextEncoder().encode(view!.content).byteLength,
          sha256: view!.contentRevision, mtimeMs: 0, adapterIds: [],
        }, policy: DEFAULT_CORE_POLICY,
      })
      if (planProjectFileEdits(view!, [edit]).content !== original[0]?.newContent)
        fail(request, 'The old and new selectors produce different source bytes. Review the source boundary and convert this selection explicitly.', { operationIndex: index, path })
    }
    if (action) { actions.push(action); steps.push({ tool: 'file', actions: [action] }); touched.set(path, { kind: operation.type }) }
    if (edit) {
      if (previous?.file) {
        if (previous.file.fileRef !== fileRef) fail(request, 'All old line edits on one file must use the same displayed fileRef.', { operationIndex: index, path })
        previous.file.edits.push(edit)
      } else {
        const file = { fileRef: fileRef!, edits: [edit] }
        files.push(file); steps.push({ tool: 'edit', files: [file] }); touched.set(path, { kind: operation.type, file })
      }
    }
  }
  if (toolName === ProjectToolNames.edit && isEmpty(actions)) return ProjectEditSchema.parse({ files })
  if (toolName === ProjectToolNames.file && isEmpty(files)) return ProjectFileSchema.parse({ actions })
  if (toolName === ProjectToolNames.change) return ProjectChangeSchema.parse({ action: 'apply', steps })
  return fail(request, 'The saved operation belongs to a different tool group; reuse the same attempt through the indicated tool.', { targetTool: !isEmpty(actions) && !isEmpty(files) ? ProjectToolNames.change : !isEmpty(actions) ? ProjectToolNames.file : ProjectToolNames.edit })
}

/** 源输入校验或计划器拒绝迁移时，仍保留原重试引用。 */
export async function migrateProjectReusedInput(
  toolName: string,
  request: ToolInputReuseMigrationRequest,
  context: ProjectToolContext
): Promise<Record<string, unknown>> {
  try {
    return await migrateProjectInput(toolName, request, context)
  } catch (error) {
    if (error instanceof ProjectError && error.details?.kind === 'project-input-migration') throw error
    throw new ProjectError(error instanceof ProjectError ? error.reason : 'INVALID_INPUT',
      `Saved Project v1 input remains available at attempt:${request.sourceCallId}. ${error instanceof Error ? error.message : String(error)}`,
      { ...(error instanceof ProjectError ? error.details : {}), kind: 'project-input-migration', reuse: `attempt:${request.sourceCallId}`, sourceTool: request.sourceToolName },
      `Reuse attempt:${request.sourceCallId} with only the corrected fields. ${error instanceof ProjectError ? error.suggestedNextAction ?? 'Read the required target window and attach its fileRef.' : 'Correct the legacy input fields according to the validation details.'}`)
  }
}
