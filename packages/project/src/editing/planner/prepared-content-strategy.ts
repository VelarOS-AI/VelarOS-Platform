import { isString } from '@velaros-ai/core'

import { createTextPatch } from '../../edits/strategies/prepared-patch.js'
import { ProjectError } from '../../errors.js'
import type { PatchStrategy } from '../../types/patch.js'
import { isProjectTextEncoding } from '../../utils/text.js'

/** Only accepts internally compiled content. The ordinary transaction engine still owns every write. */
export function preparedContentStrategy(): PatchStrategy {
  return {
    id: 'core.prepared-content',
    priority: 100,
    canHandle: ({ intent }) => intent.operation.type === 'replace_content',
    prepare({ intent, snapshot }) {
      if (intent.operation.type !== 'replace_content') throw new ProjectError('NOT_SUPPORTED', '该策略仅接受已编译的正文。')
      const operation = intent.operation
      if (operation.mode === 'guard' && operation.content !== operation.expectedContent) {
        throw new ProjectError('INVALID_INPUT', '只读内容守卫不能携带正文修改。', { path: operation.path })
      }
      if (operation.mode === 'recode' && !isProjectTextEncoding(operation.targetEncoding)) {
        throw new ProjectError('INVALID_INPUT', '编码转换缺少目标编码。', { path: operation.path })
      }
      if (!snapshot?.exists || snapshot.isDirectory || snapshot.isBinary || !isString(snapshot.content)) {
        throw new ProjectError('NOT_SUPPORTED', '编辑需要完整可读的现有文本文件。', { path: operation.path })
      }
      if (snapshot.content !== operation.expectedContent) {
        throw new ProjectError('BASE_REVISION_MISMATCH', '文件内容已在定位后变化，拒绝应用旧计划。', {
          path: operation.path, actual: snapshot.revision,
        }, '请读取当前目标范围，使用新 fileRef 确认后重试。')
      }
      const metadata: Record<string, unknown> = { op: 'replace_content', mode: operation.mode ?? 'edit' }
      if (operation.mode === 'recode') metadata.targetEncoding = operation.targetEncoding
      return [createTextPatch(snapshot.path, snapshot.revision, snapshot.content, operation.content, 'core.prepared-content', metadata)]
    },
  }
}
