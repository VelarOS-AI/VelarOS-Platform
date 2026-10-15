import type { ContextDeliveryRequirement, ContextRef } from '@velaros-ai/context'

import type { CompletionExecutionEntry } from './completion-evidence.js'

/** 独立核查读取的完整用户原文。 */
export interface CompletionOriginal {
  readonly ref: ContextRef
  readonly text: string
}

/** 当前根任务及所属执行分支的完整存档源码、回执对；回执内的截断或失败状态仍须核对。 */
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
  /** 所有已登记的源码/回执对；超出目录上限的数量单独保留。目录不视为已读证据。 */
  readonly catalog?: readonly CompletionExecutionEntry[]
  readonly catalogOmitted?: number
}

/** 需求提取先固定判据和原文锚点，产物是否通过由后续请求判断。 */
export interface CompletionReviewRequirement extends ContextDeliveryRequirement {
  /** artifact 核验产物功能及状态；constraint 仅检查代理执行行为，明确审计要求仍须提供证明。 */
  readonly evidenceKind: 'artifact' | 'execution' | 'constraint' | 'audit'
  readonly anchors: ReadonlyArray<{ readonly sourceId: string; readonly quote: string }>
}

/** 同一任务原文版本上经独立复核确认完整的清单；文件绑定在下一次尝试重新定位。 */
export interface CompletionReviewChecklist {
  readonly key: string
  readonly requirements: readonly CompletionReviewRequirement[]
  readonly request: ContextRef
}

/** 模型只能报告已提供材料中的事实和缺口。 */
export interface CompletionReviewVerdict {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'unknown'
  readonly reason: string
  readonly evidence: ReadonlyArray<{ readonly identity: string; readonly quote: string }>
  /** 代理执行行为约束的裁定范围是本任务实际记录；不能替代产物功能证据。 */
  readonly observation?: 'none-observed' | 'violation' | 'inconclusive'
}

/** 同一冻结材料上的逐项协议校验；未通过项继续纠正，已校验裁定保持原文。 */
export interface CompletionReviewProgress {
  readonly verdicts: readonly CompletionReviewVerdict[]
  readonly failures: ReadonlyArray<{ readonly id: string; readonly message: string }>
}

/** 裁定前的有界调查意见；只有实际原文和宿主执行回执可作为最终裁定证据。 */
export interface CompletionReviewInvestigation {
  readonly requirementIds: readonly string[]
  readonly hypothesis: string
  readonly outcome: 'reproduced' | 'not-reproduced' | 'unresolved'
  readonly evidence: ReadonlyArray<{ readonly identity: string; readonly quote: string }>
}
