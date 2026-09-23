/**
 * 事务结果的判定：一次提交到底有没有改动、哪些路径是新建出来的。
 */

import { isString, isTrue } from '@velaros-ai/core'

import type { PathEffect } from '../../types/agent.js'
import type { AgentProjectPreparedPatch } from '../../types/agent-port.js'

/** 这个补丁是不是删掉文件（删除，或重命名留下的旧路径）。 */
function deletes(patch: AgentProjectPreparedPatch): boolean {
  return patch.metadata?.op === 'delete_file' || patch.metadata?.op === 'rename_file_delete'
}

/** 事务有没有真改动：按每个文件的最终状态比，不看中间补丁和差量文字（空文件也算存在）；存在与否、正文、权限、编码有一样变了就算改动，编码转换一律算。 */
export function projectTransactionHasChanges(
  patches: readonly AgentProjectPreparedPatch[]
): boolean {
  const paths = new Map<string, PathEffect>()
  for (const patch of patches) {
    const previous = paths.get(patch.path)
    if (previous) {
      previous.last = patch
      previous.existsAfter = !deletes(patch)
    } else {
      const newlyCreated =
        patch.metadata?.op === 'rename_file_create' ||
        (patch.metadata?.op === 'create_file' && !isTrue(patch.metadata?.replacesExisting))
      paths.set(patch.path, {
        first: patch,
        last: patch,
        existedBefore: !newlyCreated,
        existsAfter: !deletes(patch),
      })
    }
  }
  return [...paths.values()].some(({ first, last, existedBefore, existsAfter }) => {
    if (existedBefore !== existsAfter) return true
    if (!existsAfter) return false
    if (!isString(first.oldContent) || !isString(last.newContent)) return true
    // 编码转换补丁只在需要重写字节的文件上生成，正文相同也算改动。
    return (
      first.oldContent !== last.newContent ||
      first.metadata?.fileMode !== last.metadata?.fileMode ||
      (first.metadata?.textEncoding ?? 'utf8') !== (last.metadata?.textEncoding ?? 'utf8') ||
      last.metadata?.mode === 'recode'
    )
  })
}

/**
 * 这次事务新建出来的路径（含重命名落地的新路径）：回执里的 oldRevisions 不放它们——
 * 界面就是按「不在 oldRevisions 里」认出新建的文件，内核对不存在的路径也会给一个 revision，放进去这条判断就永远为假。
 */
export function projectCreatedPaths(patches: readonly AgentProjectPreparedPatch[]): Set<string> {
  const created = new Set<string>()
  const seen = new Set<string>()
  for (const patch of patches) {
    if (seen.has(patch.path)) continue
    seen.add(patch.path)
    if (
      patch.metadata?.op === 'rename_file_create' ||
      (patch.metadata?.op === 'create_file' && !isTrue(patch.metadata?.replacesExisting))
    )
      created.add(patch.path)
  }
  return created
}
