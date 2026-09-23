/** @AgentView 要对方回答的话：message 1 到 8000 个字符，写清楚要补什么、为什么需要。 */
export interface InteractionRequest {
  readonly message: string
}

/** @AgentView 说明缺少的能力：message 1 到 8000 个字符；detail 放任意 JSON 补充，比如为什么需要、要哪个模块或写入范围。 */
export interface CapabilityRequest {
  readonly message: string
  readonly detail?: unknown
}
