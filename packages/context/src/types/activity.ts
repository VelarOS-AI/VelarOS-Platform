export type TurnContextSourceId = string

/** 摘要不足时可用哪个现有工具核实当前事实；argsHint 只能由事件自身字段构造。 */
export interface TurnContextInspectHint {
  tool: string
  argsHint?: Record<string, unknown>
}

export interface TurnContextDelta {
  /** 全局唯一：`${sourceId}#${seq}`。 */
  id: string
  sourceId: TurnContextSourceId
  /** source 内单调递增；source 内排序只信 seq。 */
  seq: number
  occurredAt: number
  /** composer/气泡 chip 短标签。 */
  label: string
  /** 冻结进 textBlocks 的最终文本；main 侧一次性格式化，冻结后不得重排版。 */
  summaryText: string
  inspect?: TurnContextInspectHint
}


export interface TurnContextSourcePeekInput {
  sessionId: string
  /** 上次已消费到的 seq；generation 不匹配时忽略此值。 */
  afterSeq: number
  /** 上次 cursor 的 generation；null 表示首次。 */
  generation: Nullable<string>
}


/** 往账本里记一条环境变化要填的东西：正文在这一刻就定稿，之后谁都不许重排版。 */
export interface TurnContextLedgerAppendInput {
  /** 这件事发生的时刻（毫秒时间戳）；不填就取写入时刻。事后补记时才需要显式传。 */
  occurredAt?: number
  /** 这条 delta 的短标签，投给模型时当这一行的抬头，例如来源名或操作名。 */
  label: string
  /** 投给模型的正文，`append` 时就得是最终形态：消费方原样投递，不再截断、不再拼接、不再改格式。 */
  summaryText: string
  /** 可选的细看线索：告诉模型想看全貌该调哪个工具、带什么参数。不填表示这条看完就够了。 */
  inspect?: TurnContextInspectHint
}

/** `peek` 的结果：既给这次要投的 delta，也给回下次 peek 该带的游标基底。 */
export interface TurnContextLedgerPeekResult {
  /** 本账本的代次；和消费方手里的对不上，说明账本换过一茬，消费方要整段替换自己的 cursor 而不是接着往下读。 */
  generation: string
  /** 当前还留着的最旧那条的 seq；账本空时等于下一个要发的 seq。 */
  headSeq: number
  /** 至今发出过的最大 seq；消费方消费完这批后把 cursor 记到这里。 */
  tailSeq: number
  /** 有 delta 因容量被淘汰、而且正好落在这次请求的区间里时，给出最旧保留项的 seq，表示「这条之前的你没看到」。没缺口时不带这个字段。 */
  droppedBeforeSeq?: number
  /** 这次该投的 delta，按 seq 从小到大；`afterSeq` 之后的全部，可能为空数组。 */
  deltas: TurnContextDelta[]
}
