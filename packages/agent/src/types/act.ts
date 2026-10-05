import type { ContextProjection, ContextVerificationReport } from '@velaros-ai/context'
import type { ModelHistoryMessage } from '@velaros-ai/kernel'
import type { CompiledModelRequest } from '@velaros-ai/model'

/** 用户文件的不可变归档引用。 */
export interface ActInputFile {
  readonly ref: { readonly sessionId: string; readonly id: string }
  readonly name: string
  readonly mediaType: string
  readonly bytes?: number
}
/** 原生图像附件，与脚本结果文字分开编码。 */
export interface ActImage {
  readonly type: 'image-data'
  readonly origin?: 'user' | 'capability'
  readonly mediaType: string
  readonly data: string
  readonly label: string
}
/** 用户输入，文字、文件引用与真实多模态图片至少提供一项。 */
export interface ActInput {
  /** 宿主输入身份，回执原样带回；不代表重复提交去重键。 */
  readonly inputId?: string
  /** continue（默认）沿用任务状态与总预算；new 显式开始新任务并保留旧任务归档。 */
  readonly task?: 'continue' | 'new'
  /** 用户正文；允许仅文件或图片输入。 */
  readonly text?: string
  /** 已保存到当前会话的文件引用。 */
  readonly files?: readonly ActInputFile[]
  /** 原始图片数据，与正文独立编码。 */
  readonly images?: readonly ActImage[]
}
/** 核心循环的状态，由真实生命周期变化驱动。 */
export type ActRunStatus =
  'thinking' | 'executing' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'context_blocked'
/** 协议解码器分流的展示增量，不代表程序已经执行。 */
export type ActPreview =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'program'
      readonly index: number
      readonly kind: string
      readonly phase: 'start' | 'delta' | 'end'
      readonly text: string
    }
/** 完整文本响应经过协议验证后的控制意图。 */
export interface ActDecodedTurn {
  readonly message: string
  readonly done: boolean
  /** done 声明附带的完成依据；有进行中的目标时，宿主据此在完成检查里结束目标。 */
  readonly completion?: string
  readonly submission?: unknown
  readonly events: readonly ActPreview[]
}
/** 主干向宿主报告的事件。 */
export type ActRunEvent =
  | { readonly type: 'turn'; readonly runId: string; readonly turnId: string }
  | {
      readonly type: 'accepted'
      readonly runId: string
      readonly turnId: string
      readonly text: string
      readonly ref: { readonly sessionId: string; readonly id: string }
    }
  | {
      readonly type: 'rejected'
      readonly runId: string
      readonly turnId: string
      readonly message: string
    }
  | { readonly type: 'interaction'; readonly runId: string; readonly request: ActInteraction }
  | {
      readonly type: 'input'
      readonly runId: string
      readonly ref: { readonly sessionId: string; readonly id: string }
      readonly inputId?: string
      readonly source?: 'submit' | 'steer'
    }
  /** 已归入具体模型请求；turnId 指向落盘的请求事实。 */
  | {
      readonly type: 'input-applied'
      readonly runId: string
      readonly ref: { readonly sessionId: string; readonly id: string }
      readonly inputId?: string
      readonly turnId: string
    }
  /** 本轮结束时仍未进入模型请求；后续运行可继续消费。 */
  | {
      readonly type: 'input-retained'
      readonly runId: string
      readonly ref: { readonly sessionId: string; readonly id: string }
      readonly inputId?: string
    }
  | { readonly type: 'answer'; readonly runId: string; readonly id: string }
  | { readonly type: 'state'; readonly runId: string; readonly status: ActRunStatus }
  | { readonly type: 'text'; readonly runId: string; readonly text: string }
  /** 模型这一轮的思考摘要增量，只作展示：不进上下文、不落事件账，属于最近一个 turn 事件。 */
  | { readonly type: 'reasoning'; readonly runId: string; readonly text: string }
  | {
      readonly type: 'program'
      readonly runId: string
      readonly index: number
      readonly kind: string
      readonly phase: 'start' | 'delta' | 'end'
      readonly text: string
    }
  | {
      readonly type: 'usage'
      readonly runId: string
      /** 这一次请求的输入 token，含读自与写进前缀缓存的部分。 */
      readonly inputTokens: number
      readonly outputTokens: number
      /** 输入里读自供应商前缀缓存的 token；供应商不报告时缺省。 */
      readonly cacheReadTokens?: number
      /** 输入里本次写进供应商前缀缓存的 token；供应商不报告时缺省。 */
      readonly cacheWriteTokens?: number
    }
  | {
      readonly type: 'verification'
      readonly runId: string
      readonly completed: boolean
      readonly verified: boolean
      readonly reason: string
      readonly recovery?: 'repair' | 'refresh' | 'input' | 'capacity'
      /** 领域实际核查的范围与依据；成功、失败和未知项均按真实检查记录。 */
      readonly report?: ContextVerificationReport
    }
  | { readonly type: 'error'; readonly runId: string; readonly message: string }
  /** 任务到了每小时的模型用量上限：等 retryAfterMs 后自动继续。 */
  | { readonly type: 'throttled'; readonly runId: string; readonly retryAfterMs: number }
  /** 主线到达回合或墙钟上限：已封段并延长截止时间，运行继续。 */
  | { readonly type: 'renewed'; readonly runId: string; readonly cause: 'turns' | 'clock' }
  /** 本次运行连续多步没有进展，已暂停；任务保留，用户的下一条输入继续同一个任务。 */
  | {
      readonly type: 'stalled'
      readonly runId: string
      readonly repeatedSteps: number
      readonly message: string
    }
/** 明确而有界的运行预算。 */
export interface ActRunLimits {
  readonly turns: number
  readonly outputTokens: number
  readonly safetyTokens: number
  readonly projectionChars: number
  readonly recoveryChars: number
  readonly timeoutMs: number
}

/** 按剩余轮数规划上下文：什么时候封段、什么时候算结构性超载，以及有界恢复。 */
export interface ActContextPolicy {
  /** 无可延续的可发送前缀且剩余不足这么多轮时封段；同时作为严重预警阈值，默认 2。 */
  readonly foldTurns?: number
  /** 无可延续的可发送前缀、剩余不足这么多轮且处在章节边界时封段，默认 8。 */
  readonly boundaryTurns?: number
  /** 封段后剩余仍不足这么多轮，算结构性超载，默认 4。 */
  readonly minTurns?: number
  /** 工作窗口上限（token），与模型输入上限取较小值，默认 200000。 */
  readonly windowTokens?: number
  /** 供应商超窗拒绝与完成检查的修复次数，默认 2。 */
  readonly recoveryAttempts?: number
}

/** 上下文投影所在的段：主循环据此判断增长是否可比、封段是否发生。 */
export interface ActFrameSegment {
  readonly id: string
  readonly index: number
  /** 底座重建次数。 */
  readonly revision: number
  /** 底座里的卷数。 */
  readonly volumes: number
  /** 段内已有的模型响应数。 */
  readonly turns: number
  /** 本段读回上一帧因容量不够只给了引用的材料的次数；不提供时按 0。 */
  readonly faults?: number
}

/** 可恢复运行快照；waiting 的原因通过 pending 交互或后续输入判定。 */
export interface ActRunSnapshot {
  readonly id: string
  readonly sessionId: string
  readonly status: ActRunStatus | 'idle' | 'interrupted'
  readonly pending: readonly ActInteraction[]
}
/** 等待用户提供信息或确认的持久化请求。 */
export interface ActInteraction {
  readonly id: string
  readonly runId: string
  readonly kind: 'input' | 'confirmation' | 'capability'
  readonly message: string
  readonly detail?: unknown
}
/** 宿主对指定交互的回答，不能复用到另一运行。 */
export interface ActAnswer {
  readonly id: string
  readonly runId: string
  readonly value: unknown
}
/** 可按单调游标重放的运行事件。 */
export interface ActEvent {
  readonly sequence: number
  readonly sessionId: string
  readonly runId: string
  readonly event: ActRunEvent
}

/** 一帧编译好的请求，连同它的投影与段状态。 */
export type ActComposedFrame = {
  readonly projection: ContextProjection
  readonly segment?: ActFrameSegment
  /** 本次运行里连续没有进展的步数。 */
  readonly repeatedSteps: number
  /** 投影给出的逻辑历史，出线历史可能在它前面保留了此前的帧。 */
  readonly logical: readonly ModelHistoryMessage[]
  /** 本帧运行时材料正文，下一帧据此渲染变化。 */
  readonly body: string
  /** 出线历史是否保留了此前的帧；增长只在同一布局之间比较。 */
  readonly retained: boolean
} & CompiledModelRequest
