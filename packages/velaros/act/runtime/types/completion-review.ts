import type { ContextDeliveryRequirement, ContextRef } from '@velaros-ai/context'

/** 独立核查读取的完整用户原文。 */
export interface CompletionOriginal {
  readonly ref: ContextRef
  readonly text: string
}

/** 当前执行的存档源码与回执；截断标记不能作为完整执行证明。 */
export interface CompletionExecutionEvidence {
  /** 实际记录由 ref 定位，共同组成同一执行快照产物。 */
  readonly records: ReadonlyArray<{
    readonly identity: 'execution:recent'
    readonly ref: ContextRef
    readonly sequence: number
    readonly createdAt: string
    readonly title: string
    readonly text: string
    readonly truncated: boolean
  }>
  /** 尚未进入有界材料的执行结果数量。 */
  readonly omitted: number
}

/** 需求提取先固定判据和原文锚点，产物是否通过由后续请求判断。 */
export interface CompletionReviewRequirement extends ContextDeliveryRequirement {
  readonly anchors: ReadonlyArray<{ readonly sourceId: string; readonly quote: string }>
}

/** 模型只能报告已提供材料中的事实和缺口。 */
export interface CompletionReviewVerdict {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'unknown'
  readonly reason: string
  readonly evidence: ReadonlyArray<{ readonly identity: string; readonly quote: string }>
}
