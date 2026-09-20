/**
 * 补丁链的纯函数：同一路径的补丁在事务里首尾相接，这里回答补丁是新建还是删除、写下后路径的暂存正文是什么、
 * 衔接到前一补丁之后哪些策略坐标失效。事务暂存视图、规划、字节计划、恢复计划和状态文件校验共用这一套判定。
 */

import type { PreparedPatch } from '../../types/edit.js'
import type { StagedFileContent } from '../../types/transaction.js'

/** 删除类补丁写下后让路径在事务视图中变为不存在。 */
export function isDeletePatch(patch: PreparedPatch): boolean {
  const operation = patch.metadata?.op
  return operation === 'delete_file' || operation === 'rename_file_delete'
}

/** 新建类补丁整文件写入，不依赖该路径此前的暂存正文。 */
export function isCreatePatch(patch: PreparedPatch): boolean {
  const operation = patch.metadata?.op
  return operation === 'create_file' || operation === 'rename_file_create'
}

/** 补丁写下之后该路径的事务视图；null 与存在但为空的字符串必须严格区分。 */
export function stagedContentAfter(patch: PreparedPatch): StagedFileContent {
  return isDeletePatch(patch) ? null : (patch.newContent ?? '')
}

/**
 * 后继补丁的策略坐标属于事务中间态，不再对应事务前原文。移除这些坐标，使跨事务冲突检测
 * 保守地退回同文件冲突，而不是把真实重叠误判为不相交。
 */
export function withoutStagedOffsets(patch: PreparedPatch): PreparedPatch {
  if (!patch.metadata) return patch
  const { startOffset: _startOffset, endOffset: _endOffset, ...metadata } = patch.metadata
  return { ...patch, metadata }
}
