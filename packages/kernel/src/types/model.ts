/** 真实能力产生的图像附件；正文不进入脚本输出的文字截断路径。 */
export interface ModelImage {
  readonly type: 'image-data'
  /** 图像的直接来源，默认能力输出。 */
  readonly origin?:'user'|'capability'
  readonly mediaType: string
  readonly data: string
  readonly label: string
}
/** 中立发送消息，文本与图像由同一编码器封装。 */
export interface ModelUserMessage {
  role: 'user'
  content: string | Array<{type:'text';text:string} | {type:'image';image:string;mediaType:string}>
}
/** 有序历史消息；脚本响应仍是普通 assistant 文本。 */
export type ModelHistoryMessage = ModelUserMessage | { role:'assistant'; content:string }
/** Runtime 生成的容量报告，正文来源不能覆盖。 */
export interface ModelContextStatus {
  readonly mode:'partitioned'|'runtime-view'|'incremental-history'
  readonly phase:'work'|'maintenance'|'finalizing'
  readonly frameId:string
  readonly pressure:'normal'|'warning'|'critical'
  readonly inputTokens:number
  readonly precision:'exact'|'estimate'
  readonly basis:string
  readonly inputLimit:number
  readonly outputReserve:number
  readonly safetyReserve:number
  readonly remainingTokens:number
  readonly advice:string
}
/** 模型驱动的真实请求边界。 */
export interface ModelDriverLimits {
  readonly contextTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
}
/** 材料保持原始来源，模型笔记不能变成系统指令。 */
export interface ModelMaterial {
  readonly ref: string
  readonly origin: string
  readonly text: string
  readonly totalChars: number
}
/** 供应商中立的响应格式；业务含义由装配层定义。 */
export type ModelResponseFormat = {
  /** 原生 JSON 响应模式。 */
  readonly type: 'json'
  /** 稳定的协议名称，不代表可调用工具。 */
  readonly name: string
  /** 模型生成这份响应的用途。 */
  readonly description: string
  /** 完整响应必须通过的 JSON Schema。 */
  readonly schema: Readonly<Record<string, unknown>>
} | {
  /** 原始文本流；业务协议由调用方解析，供应商不做结构化输出。 */
  readonly type: 'text'
}
/** 一次已经冻结的中立请求。 */
export interface ModelTurnRequest {
  /** ProviderRequestCompiler 封存的实际 prompt；驱动不能重新选择或压缩材料。 */
  readonly compiledPrompt?: string
  /** 历史与当前材料分开编码，不能伪造 tool 消息。 */
  readonly history?:readonly ModelHistoryMessage[]
  /** 当前发送帧的宿主容量状态。 */
  readonly contextStatus?:ModelContextStatus
  /** 当前发布视图引用的真实附件，按能力产生的顺序发送。 */
  readonly images?: readonly ModelImage[]
  readonly instructions: string
  readonly materials: readonly ModelMaterial[]
  /** 模型本轮的文本或结构化响应模式。 */
  readonly response: ModelResponseFormat
  readonly mode: 'work' | 'maintenance'
  readonly outputTokens: number
}
/** 编码后预算；估算必须说明口径。 */
export interface ModelInputEstimate { readonly tokens: number; readonly precision: 'exact' | 'estimate'; readonly basis: string }
/** 流式响应仅传递模型事实；控制状态由 Agent 决定。 */
export type ModelTurnDelta =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'output'; readonly value: unknown }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'error'; readonly code: 'context-limit' | 'provider'; readonly message: string; /** 驱动确认是瞬时传输故障时给出的退避毫秒；宿主仅可重试尚未接受的响应。 */ readonly retryAfterMs?: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'length' }
