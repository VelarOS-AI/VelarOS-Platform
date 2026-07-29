/**
 * 工作区级重构工具：跨文件搜索替换、符号重命名和文件移动。
 *
 * 所有文件变更都使用工作区内核事务模型：
 * 先在内存中收集全部文件改动，再统一准备编辑并统一应用编辑。
 * 这样整次操作只有一次用户审批和一个回滚点。
 */
import nodePath from 'node:path'

import type { WorkspaceToolCapabilitySchema } from './KernelToolShared'


export const RefactorWorkspaceTransactionCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      requiresWorkspaceSwitchForExternalCwd: true,
      mutation: 'transaction-batch',
      arbitraryRead: true,
    },
  },
  concurrency: 'unsafe',
  reason: 'workspace refactor transaction',
} satisfies WorkspaceToolCapabilitySchema


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function toRelativeImportPath(targetAbs: string, fromDir: string): string {
  const rel = nodePath.relative(fromDir, targetAbs)
  return rel.startsWith('.') ? rel : `./${rel}`
}
