/** 真实能力产生的图像附件；正文不进入脚本输出的文字截断路径。 */
export interface ModelImage {
  readonly type: 'image-data'
  readonly mediaType: string
  readonly data: string
  readonly label: string
}
/** 中立发送消息，文本与图像由同一编码器封装。 */
export interface ModelUserMessage {
  role: 'user'
  content: string | Array<{type:'text';text:string} | {type:'image';image:string;mediaType:string}>
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
/** 供应商中立的结构化响应格式；业务含义由装配层定义。 */
export interface ModelResponseFormat {
  /** 原生 JSON 响应模式。 */
  readonly type: 'json'
  /** 稳定的协议名称，不代表可调用工具。 */
  readonly name: string
  /** 模型生成这份响应的用途。 */
  readonly description: string
  /** 完整响应必须通过的 JSON Schema。 */
  readonly schema: Readonly<Record<string, unknown>>
}
/** 一次已经冻结的中立请求。 */
export interface ModelTurnRequest {
  /** ProviderRequestCompiler 封存的实际 prompt；驱动不能重新选择或压缩材料。 */
  readonly compiledPrompt?: string
  /** 当前发布视图引用的真实附件，按能力产生的顺序发送。 */
  readonly images?: readonly ModelImage[]
  readonly instructions: string
  readonly materials: readonly ModelMaterial[]
  /** 模型本轮唯一的结构化响应契约。 */
  readonly response: ModelResponseFormat
  readonly mode: 'work' | 'maintenance'
  readonly outputTokens: number
}
/** 编码后预算；估算必须说明口径。 */
export interface ModelInputEstimate { readonly tokens: number; readonly precision: 'exact' | 'estimate'; readonly basis: string }
/** 流式响应仅传递模型事实；控制状态由 Agent 决定。 */
export type ModelTurnDelta =
  | { readonly type: 'output'; readonly value: unknown }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'error'; readonly code: 'context-limit' | 'provider'; readonly message: string }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'length' }
