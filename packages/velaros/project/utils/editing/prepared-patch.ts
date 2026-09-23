// 域：补丁构造。统一的文本补丁，以及删除、重命名、覆盖这类文件级补丁能拿来回滚的原文。
import { isString, isTrue, optionalWhen } from '@velaros-ai/core'

import type { PreparedPatch } from '../../types/edit.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import { unifiedDiff } from '../diff.js'
import { ProjectError } from '../errors.js'
import { id } from '../id.js'
import { countChangedLines } from '../text.js'

/** 由新旧正文生成一个文本补丁：带统一 diff 与改动行数；oldContent 缺席表示回滚无法恢复原文。 */
export function createTextPatch(
  path: string,
  baseRevision: Optional<string>,
  oldContent: Optional<string>,
  newContent: string,
  strategyId: string,
  metadata?: Record<string, unknown>
): PreparedPatch {
  const diff = unifiedDiff(path, oldContent ?? '', newContent)
  const changedLines = countChangedLines(diff)
  return {
    patchId: id('patch'),
    strategyId,
    path,
    baseRevision,
    oldContent,
    newContent,
    diff,
    changedLines,
    risk: 'low', // 规模不代表风险,统一 low(真正危险在操作层判定)
    metadata,
  }
}

/**
 * 既有文件可供回滚写回的原文。二进制或超出读取上限的文件在快照里没有正文，返回 undefined——
 * 补丁的 oldContent 因此缺席，内核把它判为回滚无法恢复（高风险、回滚预检拒绝），
 * 而不是记成空串让回滚把文件截空。
 */
export function revertibleContent(snapshot: FileSnapshot): Optional<string> {
  return optionalWhen(isString(snapshot.content), snapshot.content)
}

/**
 * 删除或重命名后，回滚（或重命名的新路径）要在空路径上把文件重建出来的原文。除了读不到正文的
 * 二进制/超限文件，符号链接也重建不出来：快照正文来自链接目标，写回只会得到一个普通文件、链接没了。
 * 返回 undefined 时删除补丁的 oldContent 缺席（不可恢复、高风险），重命名直接拒绝。
 */
export function rebuildableContent(snapshot: FileSnapshot): Optional<string> {
  return isTrue(snapshot.isSymbolicLink) ? undefined : revertibleContent(snapshot)
}

/** 删除与重命名只针对文件：目录不能按文本补丁删除或搬运，交给命令执行并走命令危险判定。 */
export function assertFileTarget(snapshot: FileSnapshot, operationName: string): void {
  if (snapshot.isDirectory) {
    throw new ProjectError(
      'NOT_SUPPORTED',
      `${operationName} 只能作用于文件，${snapshot.path} 是目录。`,
      { path: snapshot.path, operation: operationName },
      '移动目录请用项目命令 git mv 或 mv；删除整个目录请用 rm -r，它会作为危险命令请求用户确认。'
    )
  }
}
