import type { ReminderScope, RuntimeReminderInput } from '../../types/session.js'

/**
 * 把提醒的生效范围换算成「已发」去重键。
 *
 * `one-shot` 整会话共用一个固定键（发过就不再发）；`per-edit-version` 用当前编辑版本做键，模型一改代码就
 * 自动解锁下一条，不需要谁去 reset。返回 `null` 表示**本条不参与去重**（`always`：每次匹配都重新渲染）——
 * 别再把「不去重」编码成某个特殊字符串前缀，控制流要留在类型里。
 */
export function resolveReminderScopeKey(
  scope: ReminderScope,
  input: RuntimeReminderInput
): Nullable<string> {
  switch (scope) {
    case 'one-shot':
      return 'one-shot'
    case 'per-edit-version':
      return `edit-version:${input.editVersion}`
    case 'always':
    default:
      return null
  }
}
