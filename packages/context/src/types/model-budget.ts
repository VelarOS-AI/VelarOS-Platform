/** 宿主生成的单次模型派发身份；任务身份隔离迟到回执。 */
export interface ContextModelRequestIdentity {
  readonly taskId: string
  readonly requestId: string
}

/** 持久请求的预算与结算事实；明确零用量同样属于 settled。 */
export interface ContextModelBudgetRequest {
  readonly role: 'main' | 'context'
  readonly tokens: number
  readonly hourStart: number
  readonly status: 'reserved' | 'dispatched' | 'settled' | 'released' | 'transferred'
  /** 收尾占位原子转交给实际请求，原身份仍可用于取消清理。 */
  readonly transferredTo?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** 旧聚合记录无法恢复单次身份，继续按保守总量占位。 */
export interface ContextLegacyModelUsage {
  readonly mainCalls: number
  readonly contextCalls: number
  readonly reservedTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly unmeasuredCalls: number
}

/** 同任务 CAS 中的请求账本；不作为模型提示材料。 */
export interface ContextModelBudgetState {
  readonly legacy: ContextLegacyModelUsage
  readonly requests: Readonly<Record<string, ContextModelBudgetRequest>>
}

/** 预算更新只接受宿主生命周期事件，不由模型直接写入。 */
export type ContextModelBudgetUpdate =
  | {
      readonly type: 'reserve'
      readonly role: 'main' | 'context'
      readonly tokens: number
      readonly request?: ContextModelRequestIdentity
    }
  | {
      readonly type: 'release'
      readonly role: 'main' | 'context'
      readonly tokens: number
      readonly request?: ContextModelRequestIdentity
      /** 派发登记链失败，宿主确认实际驱动尚未开始；用于回收部分祖先登记。 */
      readonly confirmedNotDispatched?: boolean
    }
  | { readonly type: 'dispatch'; readonly request: ContextModelRequestIdentity }
  | {
      readonly type: 'transfer'
      readonly request: ContextModelRequestIdentity
      readonly requestId: string
    }
  | {
      readonly type: 'usage'
      readonly inputTokens: number
      readonly outputTokens: number
      readonly request?: ContextModelRequestIdentity
    }
