import type { TurnContextDelta,TurnContextLedgerAppendInput,TurnContextLedgerPeekResult,TurnContextSourcePeekInput } from '../contract/activity.js'
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
  apply(current: Optional<ContextTaskState>): ContextTaskState
}

/** 会话活动记录的唯一访问接口。 */
export interface TurnContextLedgerApi {
  /** 本账本的代次，建的时候定死不再变。消费方拿它判断自己的 cursor 还算不算数：对不上就整段换掉，不做增量回放。 */
  readonly generation: string
  /** 记一条新的环境变化，分配下一个 seq 并返回落好的 delta；超出容量时淘汰最旧的几条，并把缺口边界记到 `droppedBeforeSeq`，下次 peek 会如实报给消费方。 */
  append(input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 状态型 source 专用：先清空整本账，再记这一条，永远只留最新的一份事实。刻意不动 `droppedBeforeSeq`——容量淘汰是「你漏看了」要报缺口，取代是「那条已经不成立」，消费方本来就不该再看到它。 */
  replaceLatest(input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 取消费方还没看过的那批 delta：`afterSeq` 是它上次消费到的位置，`generation` 是它手里的代次。代次对不上时不回放任何旧 delta，只交出当前基底让它重新对齐。纯读，不改账本状态。 */
  peek(input: Pick<TurnContextSourcePeekInput, 'afterSeq' | 'generation'>): TurnContextLedgerPeekResult
}
