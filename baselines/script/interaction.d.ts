declare module 'velaros:interaction' {
  /**
   * 向用户要信息、确认或能力；在子任务里是向父任务要。调用一直等到对方回答，返回的就是回答。
   * 回答本身不授予任何权限：写操作照样过各自的检查，要换能力得等父任务更新环境后续跑。
   */

  /** 要对方回答的话：message 1 到 8000 个字符，写清楚要补什么、为什么需要。 */
  interface InteractionRequest {
    readonly message: string
  }

  /** 说明缺少的能力：message 1 到 8000 个字符；detail 放任意 JSON 补充，比如为什么需要、要哪个模块或写入范围。 */
  interface CapabilityRequest {
    readonly message: string
    readonly detail?: unknown
  }

  /** 要信息，返回对方的回答。
   */
  export function ask(input: InteractionRequest): Promise<unknown>

  /** 说明缺少的能力；可以先交付当前进度，由父任务更新环境后续跑。
   */
  export function capability(input: CapabilityRequest): Promise<unknown>

  /** 要确认，返回对方的答复；它不代替具体操作的权限校验。
   */
  export function confirm(input: InteractionRequest): Promise<unknown>
}
