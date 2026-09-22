/** 用户文件的不可变归档引用。 */
export interface ActInputFile {readonly ref:{readonly sessionId:string;readonly id:string};readonly name:string;readonly mediaType:string;readonly bytes?:number}
/** 原生图像附件，与脚本结果文字分开编码。 */
export interface ActImage {readonly type:'image-data';readonly origin?:'user'|'capability';readonly mediaType:string;readonly data:string;readonly label:string}
/** 用户输入，文字、文件引用与真实多模态图片至少提供一项。 */
export interface ActInput {
  /** 宿主输入身份，回执原样带回；不代表重复提交去重键。 */
  readonly inputId?:string
  /** continue（默认）沿用任务状态与总预算；new 显式开始新任务并保留旧任务归档。 */
  readonly task?:'continue'|'new'
  /** 用户正文；允许仅文件或图片输入。 */
  readonly text?:string
  /** 已保存到当前会话的文件引用。 */
  readonly files?:readonly ActInputFile[]
  /** 原始图片数据，与正文独立编码。 */
  readonly images?:readonly ActImage[]
}
/** 核心循环的状态，由真实生命周期变化驱动。 */
export type ActRunStatus = 'thinking' | 'executing' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'context_blocked' | 'needs_reconcile'
/** 协议解码器分流的展示增量，不代表程序已经执行。 */
export type ActPreview =
  | { readonly type:'text'; readonly text:string }
  | { readonly type:'program'; readonly index:number; readonly kind:string; readonly phase:'start'|'delta'|'end'; readonly text:string }
/** 完整文本响应经过协议验证后的控制意图。 */
export interface ActDecodedTurn {
  readonly message:string
  readonly done:boolean
  readonly submission?:unknown
  readonly events:readonly ActPreview[]
}
/** 主干向宿主报告的事件。 */
export type ActRunEvent =
  | {readonly type:'turn';readonly runId:string;readonly turnId:string}
  | {readonly type:'accepted';readonly runId:string;readonly turnId:string;readonly text:string;readonly ref:{readonly sessionId:string;readonly id:string}}
  | {readonly type:'rejected';readonly runId:string;readonly turnId:string;readonly message:string}
  | { readonly type:'interaction'; readonly runId:string; readonly request:ActInteraction }
  | { readonly type:'input'; readonly runId:string; readonly ref:{readonly sessionId:string;readonly id:string}; readonly inputId?:string; readonly source?:'submit'|'steer' }
  /** 已归入具体模型请求；turnId 指向落盘的请求事实。 */
  | { readonly type:'input-applied'; readonly runId:string; readonly ref:{readonly sessionId:string;readonly id:string}; readonly inputId?:string; readonly turnId:string }
  /** 本轮结束时仍未进入模型请求；后续运行可继续消费。 */
  | { readonly type:'input-retained'; readonly runId:string; readonly ref:{readonly sessionId:string;readonly id:string}; readonly inputId?:string }
  | { readonly type:'answer'; readonly runId:string; readonly id:string }
  | { readonly type: 'state'; readonly runId: string; readonly status: ActRunStatus }
  | { readonly type: 'text'; readonly runId: string; readonly text: string }
  | { readonly type: 'program'; readonly runId:string; readonly index:number; readonly kind:string; readonly phase:'start'|'delta'|'end'; readonly text:string }
  | { readonly type: 'usage'; readonly runId: string; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'verification'; readonly runId: string; readonly completed: boolean; readonly verified: boolean; readonly reason: string; readonly recovery?:'repair'|'refresh'|'reconcile'|'input'|'capacity' }
  | { readonly type: 'error'; readonly runId: string; readonly message: string }
/** 明确而有界的运行预算。 */
export interface ActRunLimits {
  readonly turns: number
  readonly outputTokens: number
  readonly safetyTokens: number
  readonly projectionChars: number
  readonly recoveryChars: number
  readonly timeoutMs: number
}

/** 按上下文模式配置的预警和有界恢复策略。 */
export interface ActContextPolicy {
  readonly warningRatio?:number
  readonly maintenanceRatio?:number
  readonly maxMaintenanceTurns?:number
  readonly recoveryAttempts?:number
}

/** 可恢复运行快照；waiting 的原因通过 pending 交互或后续输入判定。 */
export interface ActRunSnapshot {readonly id:string;readonly sessionId:string;readonly status:ActRunStatus|'idle'|'interrupted';readonly pending:readonly ActInteraction[]}
/** 等待用户提供信息或确认的持久化请求。 */
export interface ActInteraction {readonly id:string;readonly runId:string;readonly kind:'input'|'confirmation'|'capability';readonly message:string;readonly detail?:unknown}
/** 宿主对指定交互的回答，不能复用到另一运行。 */
export interface ActAnswer {readonly id:string;readonly runId:string;readonly value:unknown}
/** 可按单调游标重放的运行事件。 */
export interface ActEvent {readonly sequence:number;readonly sessionId:string;readonly runId:string;readonly event:ActRunEvent}
