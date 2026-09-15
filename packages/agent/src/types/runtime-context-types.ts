/** 本次 Agent 执行使用的模型运行时快照。 */
export interface ToolRuntimeApi {
  /**
   * Product-owned, provider-specific runtime metadata.
   *
   * The Agent Runtime treats this value as opaque and only forwards it to
   * explicitly registered tools that need the host's model runtime context.
   */
  metadata?: unknown
}
