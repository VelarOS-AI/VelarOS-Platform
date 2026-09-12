/**
 * `ConversationRunUsage` — 一次执行的**供应方用量账**：主 Agent 的全部模型调用 + 这次派出的子 Agent 运行。
 * 回答末尾的约价与目标完成摘要只按它计价，不再拿可见问答文字去估。
 *
 * 分桶口径：来源（主 Agent / 子 Agent）× 服务商 × 模型 × 计价方式（网关回报成本 / 按价格目录）。
 * 同桶只做加法、不留逐轮明细，上百轮的执行随运行标记持久化也只是几行。
 *
 * token 口径与 ai@6 `LanguageModelUsage` 一致：`inputTokens` 是全部输入（含缓存读 / 写），
 * `outputTokens` 是全部输出（含推理）；细分类只是其中的份额，计价时从总量里扣出来按各自单价算。
 */
export type ConversationRunUsageOrigin = 'agent' | 'sub-agent'

/** `reported`：网关直接回报了这批调用的成本，按回报值计；`catalog`：按公开价格目录估。 */
export type ConversationRunUsagePricing = 'reported' | 'catalog'

export interface ConversationRunUsageBucket {
  origin: ConversationRunUsageOrigin
  /** 服务商 id；供应方没回报时为 null，计价时回落到会话的计费服务商。 */
  provider: Nullable<string>
  /** 模型 id；空串表示没回报（子 Agent 默认沿用主模型），计价时回落到会话的计费模型。 */
  model: string
  pricing: ConversationRunUsagePricing
  /** 计入本桶的次数：主 Agent 桶是模型调用数，子 Agent 桶是运行数（一次运行内含多轮）。 */
  calls: number
  inputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningTokens: number
  /** 网关回报的成本合计（USD）；只有 `pricing === 'reported'` 的桶非零。 */
  reportedCostUsd: number
}

export interface ConversationRunUsage {
  buckets: ConversationRunUsageBucket[]
  /**
   * 确实跑过、却没有回报用量的子 Agent 运行数（后台派发的结果还没被读回、或跑完没带用量）；
   * 大于 0 时约价只是下限。
   */
  unreportedSubAgentRuns: number
}

/**
 * 子 Agent 一次运行的用量汇总：派发结果信封 / worker 线程终态事件里的 `result.usage`
 * （镜像 agent 协议的 `SubAgentUsage`，缓存与推理细分是可选的前向字段）。
 */
export interface ConversationSubAgentRunUsage {
  inputTokens?: LooseOptional<number>
  outputTokens?: LooseOptional<number>
  totalTokens?: LooseOptional<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  reasoningTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
}
