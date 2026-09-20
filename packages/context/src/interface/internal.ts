import type { ContextTaskState, ModelView } from '../contract/context.js'

import type { ContextBuildOptions } from './requires.js'

/** 物化器只读取固定任务快照，提交权由会话服务持有。 */
export interface ContextEvidenceBuilderApi {
  /** 解析需求、选择候选并从真实源生成证据。 */
  build(task: ContextTaskState, options: ContextBuildOptions, signal: AbortSignal): Promise<ModelView>
  /** 发送前验证源授权和版本。 */
  validate(view: ModelView, signal: AbortSignal): Promise<boolean>
}

/** 内部任务提交函数；只作用于既有 ContextStorage 的 CAS。 */
export interface ContextTaskMutation {
  /** 返回下一份任务状态，抛错表示拒绝提交。 */
  apply(current: ContextTaskState | undefined): ContextTaskState
}
