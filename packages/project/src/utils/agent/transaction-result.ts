import { isString, isTrue } from '@velaros-ai/core'

import type { ProjectAuthorizationDecision } from '../../contract/requires.js'
import type { PathEffect } from '../../types/agent.js'
import type { AgentProjectPreparedPatch } from '../../types/agent-port.js'
import { ProjectError } from '../errors.js'


function deletes(patch: AgentProjectPreparedPatch): boolean {
  return patch.metadata?.op === 'delete_file' || patch.metadata?.op === 'rename_file_delete'
}

/** Compare final file state, not intermediate patches or diff text (an empty file still has existence). */
export function projectTransactionHasChanges(patches: readonly AgentProjectPreparedPatch[]): boolean {
  const paths = new Map<string, PathEffect>()
  for (const patch of patches) {
    const previous = paths.get(patch.path)
    if (previous) {
      previous.last = patch
      previous.existsAfter = !deletes(patch)
    } else {
      const newlyCreated = patch.metadata?.op === 'rename_file_create' ||
        (patch.metadata?.op === 'create_file' && !isTrue(patch.metadata?.replacesExisting))
      paths.set(patch.path, { first: patch, last: patch, existedBefore: !newlyCreated, existsAfter: !deletes(patch) })
    }
  }
  return [...paths.values()].some(({ first, last, existedBefore, existsAfter }) => {
    if (existedBefore !== existsAfter) return true
    if (!existsAfter) return false
    if (!isString(first.oldContent) || !isString(last.newContent)) return true
    // 编码转换补丁只在需要重写字节的文件上生成，正文相同也算改动。
    return first.oldContent !== last.newContent ||
      first.metadata?.fileMode !== last.metadata?.fileMode ||
      (first.metadata?.textEncoding ?? 'utf8') !== (last.metadata?.textEncoding ?? 'utf8') ||
      last.metadata?.mode === 'recode'
  })
}

/** 宿主或用户拒绝写入：一个文件都没写，按拒绝失败回执；用户改主意后模型可用 inputReuse 原样重提。 */
export function projectMutationDenied(authorization: ProjectAuthorizationDecision): ProjectError {
  return new ProjectError('PERMISSION_DENIED', authorization.rejectionMessage ?? authorization.message, { executionOutcome: 'not-applied' },
    '没有写入任何文件。除非用户明确改变主意，不要自行重试；用户同意后用回执的 inputReuse 原样重提。')
}
