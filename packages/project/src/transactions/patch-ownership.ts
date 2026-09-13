import { isString, isTrue } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { PreparedPatch } from '../types/edit.js'
import type { FileSnapshot } from '../types/snapshot.js'
import { isProjectTextEncoding, type ProjectTextEncoding } from '../utils/text.js'

import { isCreatePatch, isDeletePatch } from './transaction-overlay.js'

/**
 * 补丁写入前该路径不存在，撤销它就是删除文件。覆盖既有文件的 `create_file` 同样整文件写入，
 * 但它的 `oldContent` 是原文——回滚写回原文；把它当新建处理会删掉原文件，永久丢失原文。
 */
export function createsMissingFile(patchValue: PreparedPatch): boolean {
  return isCreatePatch(patchValue) && !isTrue(patchValue.metadata?.replacesExisting)
}

/**
 * 补丁写下后能否被 rollback 完整撤销：写入前不存在的新建补丁撤销即删除，永远可恢复；其余补丁
 * （编辑、覆盖、删除、重命名的删除侧）撤销要写回 `oldContent`，只有补丁捕获到原文才可恢复。
 * 取不到原文的是二进制、超出读取上限的文件与符号链接本身：整文件覆盖和删除这类文件时策略把
 * `oldContent` 留空；在它们上面做局部编辑则在 prepare 就被拒绝（`assertEditsReadOriginal`），
 * 所以字符串 `oldContent` 一定是真原文。
 *
 * 回滚前置预检、`resolveTransactionRisk` 与 Desktop PreviewCache 的 `canRevertToOriginal`
 * 是同一条判据：预检据此拒绝会把文件截空的回滚，风险分级据此只把恢复不了的写入交给人审。
 */
export function canRevertToOriginal(patchValue: PreparedPatch): boolean {
  return createsMissingFile(patchValue) || isString(patchValue.oldContent)
}

/**
 * `canRevertToOriginal` 把「补丁带着字符串 `oldContent`」当作「捕获到了真原文」，这条前提在内核边界
 * 统一兜住，不指望每个策略、adapter、插件都自觉：快照里没有正文（二进制或超出读取上限）的既有文件，
 * 编辑补丁（非新建、非删除）只能凭空假设原文，apply 会把文件截成只剩新文本，`oldContent: ""` 又让
 * 回滚判为可恢复、写出空文件。整文件覆盖与删除不依赖原文，照常放行，由风险分级按不可恢复处理。
 */
export function assertEditsReadOriginal(
  patches: readonly PreparedPatch[],
  snapshot: FileSnapshot,
): void {
  if (!snapshot.exists || snapshot.isDirectory || isString(snapshot.content)) return
  const blind = patches.find(
    (patchValue) =>
      patchValue.path === snapshot.path && !isCreatePatch(patchValue) && !isDeletePatch(patchValue),
  )
  if (!blind) return
  throw new ProjectError(
    'NOT_SUPPORTED',
    `无法读取 ${snapshot.path} 的完整正文（二进制或超出读取上限），不能在它上面做局部编辑。`,
    { path: snapshot.path, op: blind.metadata?.op, strategyId: blind.strategyId },
    '整文件替换请用 overwrite；其余修改请用项目命令处理该文件。',
  )
}

/**
 * 补丁在空路径上重建文件时沿用的原编码（删除/重命名补丁从原文件快照记下）；缺席按 UTF-8。
 * 路径上已有文本文件时写入始终沿用该文件自己的编码，这个值不起作用。
 */
export function patchTextEncoding(patchValue: PreparedPatch): Optional<ProjectTextEncoding> {
  const encoding = patchValue.metadata?.textEncoding
  return isProjectTextEncoding(encoding) ? encoding : undefined
}
