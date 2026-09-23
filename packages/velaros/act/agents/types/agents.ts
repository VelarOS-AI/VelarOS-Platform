import type { AgentResume } from '@velaros-ai/agent'

/** @AgentView 一个可选的子任务配置：name 传给 start/resume 的 profile；modules 是子任务能用的模块，stores 表示能否接受共享空间授权，其余是单次运行与累计的预算。 */
export interface AgentProfileInfo {
  readonly name: string
  readonly description: string
  readonly modules: readonly string[]
  readonly stores: boolean
  readonly turns: number
  readonly timeoutMs: number
  readonly modelCalls: number
  readonly modelTokens: number
}

/** @AgentView 指定一个子任务：id 是 start 返回的 job.id。 */
export interface AgentJobTarget {
  readonly id: string
}

/** @AgentView 在子任务收束后续跑：id 是子任务，其余同 AgentResume；materials 最多 32 条。 */
export interface AgentResumeRequest extends AgentResume {
  readonly id: string
}

/** @AgentView 回答子任务的一条请求：requestId 取 job.pending 里那一项的 id，value 是任意 JSON 回答。 */
export interface AgentReplyInput {
  readonly id: string
  readonly requestId: string
  readonly value: unknown
}

/** @AgentView 给正在跑的子任务发引导：input 不能为空，它会抢占子任务还没采纳的那次模型回复。 */
export interface AgentSendInput {
  readonly id: string
  readonly input: string
}
