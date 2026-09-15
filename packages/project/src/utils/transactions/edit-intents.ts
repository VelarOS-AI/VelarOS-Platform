/**
 * 编辑意图与补丁之间的纯函数：一条编辑原语作用在哪个文件上，补丁记下哪条意图（事后重放、审计都靠它）。
 */

import type { EditIntent, EditOperation, PreparedPatch } from '../../types/edit.js'

/**
 * 取出编辑原语作用的文件路径。`rename_file` 用 `from`/`to` 而非 `path`；符号类与 `custom`
 * 原语本身不带路径，靠 `targetId` 反查——所以这里返回缺席是正常路径，不是错误。
 */
export function operationPath(operation: EditOperation): string | undefined {
  if (operation.type === 'rename_file') return operation.from
  return 'path' in operation ? operation.path : undefined
}

/** 把产生补丁的意图记进每个补丁的 metadata：操作原文（整篇替换只记类型）、约束、理由和 targetId，rebase 时据此重放。 */
export function withIntentMetadata(patches: PreparedPatch[], intent: EditIntent): PreparedPatch[] {
  return patches.map((patchValue) => ({
    ...patchValue,
    metadata: {
      ...(patchValue.metadata ?? {}),
      // 编译后的编辑固定于原版本。补丁已存储修改前后的完整源码，
      // 此处仅保留审计元数据，避免在每份持久化回执中重复正文。
      ...(intent.operation.type === 'replace_content'
        ? { intentOperationType: intent.operation.type }
        : { intentOperation: intent.operation }),
      intentConstraints: intent.constraints,
      intentReason: intent.reason,
      intentTargetId: intent.targetId,
    },
  }))
}
