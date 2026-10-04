/** 真实能力产生的图像附件；正文不进入脚本输出的文字截断路径。 */
export interface ModelImage {
  readonly type: 'image-data'
  /** 图像的直接来源，默认能力输出。 */
  readonly origin?: 'user' | 'capability'
  readonly mediaType: string
  readonly data: string
  readonly label: string
}
/** 中立发送消息，文本与图像由同一编码器封装。 */
export interface ModelUserMessage {
  role: 'user'
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>
  /** 供应商缓存到这条消息为止的前缀；需要显式断点的供应商使用，其余忽略。 */
  cacheBreakpoint?: boolean
  /** 本文是前一条 assistant 原生调用的结果展示；驱动将原样正文放入对应工具回包。 */
  readonly toolResult?: { readonly callId: string; readonly toolName: string }
}
/** 供应商响应的不可解释延续状态；只能随原始完整响应回传给匹配的驱动。 */
export interface ModelContinuation {
  readonly model: string
  readonly format: string
  readonly data: string
  /** 供应商用量给出的保守输入容量预留；密文字符数不是 token 数。 */
  readonly tokens: number
}
/** 供应商中立的可调用入口；业务入参来自正式合同生成的 schema。 */
export interface ModelToolDefinition {
  readonly name: string
  readonly description: string
  readonly schema: Readonly<Record<string, unknown>>
}
/** 完整接收的调用，尚未授权执行。 */
export interface ModelToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}
/** 宿主执行记录交回的结果；必须与被接受的调用身份逐一配对。 */
export interface ModelToolResult {
  readonly id: string
  readonly name: string
  readonly output: unknown
}
/** 已落盘的完整调用往返；正文保持原样，编译器可原子退回文本历史。 */
export interface ModelToolExchange {
  readonly text: string
  readonly calls: readonly ModelToolCall[]
  readonly results: readonly ModelToolResult[]
}
/** 有序历史消息；脚本响应正文与供应商延续状态分开保存。 */
export type ModelHistoryMessage =
  | ModelUserMessage
  | {
      role: 'assistant'
      content: string
      readonly continuation?: ModelContinuation
      readonly toolExchange?: ModelToolExchange
      /** 供应商缓存到这条消息为止的前缀；需要显式断点的供应商使用，其余忽略。 */
      cacheBreakpoint?: boolean
    }
/** Runtime 生成的容量报告，正文来源不能覆盖。 */
export interface ModelContextStatus {
  readonly mode: 'partitioned' | 'runtime-view' | 'incremental-history'
  readonly phase: 'work' | 'maintenance' | 'finalizing'
  readonly frameId: string
  readonly pressure: 'normal' | 'warning' | 'critical'
  readonly inputTokens: number
  readonly precision: 'exact' | 'estimate'
  readonly basis: string
  readonly inputLimit: number
  readonly outputReserve: number
  readonly safetyReserve: number
  readonly remainingTokens: number
  readonly advice: string
  /** 按每轮增长估计还能再跑几轮；不足时主循环封段。 */
  readonly runway?: { readonly turns: number; readonly growthPerTurn: number }
  /** 当前段：段号、段内响应数、底座里的卷数。 */
  readonly segment?: { readonly index: number; readonly turns: number; readonly volumes: number }
  /** 上一次请求供应商报告的缓存读取与写入 token。 */
  readonly cache?: { readonly readTokens: number; readonly writeTokens: number }
  /** 工作集本身快装不下时的说明；由模型下一轮用代码收紧。 */
  readonly overload?: string
  /** 本次运行连续没有进展的步数与建议；达到暂停阈值时运行暂停等用户。 */
  readonly stall?: { readonly repeatedSteps: number; readonly advice: string }
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
export type ModelResponseFormat =
  | {
      /** 标准工具调用与普通文本答复；完整响应的接收门负责执行。 */
      readonly type: 'tools'
      readonly tools: readonly ModelToolDefinition[]
    }
  | {
      /** 原生 JSON 响应模式。 */
      readonly type: 'json'
      /** 稳定的协议名称，不代表可调用工具。 */
      readonly name: string
      /** 模型生成这份响应的用途。 */
      readonly description: string
      /** 完整响应必须通过的 JSON Schema。 */
      readonly schema: Readonly<Record<string, unknown>>
    }
  | {
      /** 原始文本流；业务协议由调用方解析，供应商不做结构化输出。 */
      readonly type: 'text'
    }
/** 一次已经冻结的中立请求。 */
export interface ModelTurnRequest {
  /** ProviderRequestCompiler 封存的实际 prompt；驱动不能重新选择或压缩材料。 */
  readonly compiledPrompt?: string
  /** 历史与当前材料分开编码，不能伪造 tool 消息。 */
  readonly history?: readonly ModelHistoryMessage[]
  /** 当前发送帧的宿主容量状态。 */
  readonly contextStatus?: ModelContextStatus
  /** 当前发布视图引用的真实附件，按能力产生的顺序发送。 */
  readonly images?: readonly ModelImage[]
  readonly instructions: string
  readonly materials: readonly ModelMaterial[]
  /** 模型本轮的文本或结构化响应模式。 */
  readonly response: ModelResponseFormat
  readonly mode: 'work' | 'maintenance'
  readonly outputTokens: number
  /** 会话级的前缀缓存键；驱动按供应商翻译，不支持的供应商忽略。 */
  readonly cacheKey?: string
}
/** 编码后预算；估算必须说明口径。 */
export interface ModelInputEstimate {
  /** 可相加的发送结构文本字节，不冒充供应商 token；图像和密文容量单列。 */
  readonly composition?: {
    readonly unit: 'utf8-bytes'
    readonly system: number
    readonly tools: number
    readonly assistantHistory: number
    readonly userHistory: number
    readonly toolResults: number
    readonly current: number
    readonly framing: number
    readonly total: number
  }
  readonly tokens: number
  readonly precision: 'exact' | 'estimate'
  readonly basis: string
  /** tokens 中按每张固定数计入的图片部分；按实测用量校准时只校准其余的文本部分。 */
  readonly images?: { readonly count: number; readonly tokens: number }
  /** 已计入 tokens 的不透明延续状态容量，不能用文本密度缩小。 */
  readonly opaqueTokens?: number
}
/** 流式响应仅传递模型事实；控制状态由 Agent 决定。 */
export type ModelTurnDelta =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly value: ModelToolCall }
  /** 供应商给的思考摘要增量：只供宿主展示，不进上下文，也不参与协议解码。 */
  | { readonly type: 'reasoning'; readonly text: string }
  /** 完整响应的供应商状态；Agent 只在响应被接受后持久化，不作为宿主展示事件。 */
  | { readonly type: 'continuation'; readonly value: ModelContinuation }
  | { readonly type: 'output'; readonly value: unknown }
  | {
      readonly type: 'usage'
      readonly inputTokens: number
      readonly outputTokens: number
      /** 输入里读自供应商前缀缓存的 token；供应商不报告时缺省。 */
      readonly cacheReadTokens?: number
      /** 输入里本次写进供应商前缀缓存的 token；供应商不报告时缺省。 */
      readonly cacheWriteTokens?: number
    }
  | {
      readonly type: 'error'
      readonly code: 'context-limit' | 'provider'
      readonly message: string
      /** 驱动确认是瞬时传输故障时给出的退避毫秒；宿主仅可重试尚未接受的响应。 */ readonly retryAfterMs?: number
    }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'length' }
