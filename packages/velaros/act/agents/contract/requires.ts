import type { AgentSupervisorApi } from '@velaros-ai/agent'

import type { AgentProfileInfo } from '../types/agents.js'

/** 同一 Act 运行时上的有界子任务；能力由宿主配置，writes 按模块占用所需的窄宿主端口。 */
export interface AgentsHost {
  /** 宿主开放的配置说明，模型据此选择名称、能力和预算。 */
  agentProfiles(): readonly AgentProfileInfo[]
  /** 共享子任务调度器。 */
  readonly agents: AgentSupervisorApi
  /** 父运行取消范围。 */
  programs(sessionId: string): AgentsSession
}
/** 父运行访问口。 */
export interface AgentsSession {
  /** 父运行取消信号。 */
  runSignal(): AbortSignal
}
/** `velaros:agents` 每次调用的宿主上下文：共享调度器、调用所在的父会话与它的运行取消信号。 */
export interface AgentsOperationContext {
  /** 共享子任务调度器；每次都以 sessionId 作为父会话调用。 */
  readonly agents: AgentSupervisorApi
  /** 调用所在的父会话。 */
  readonly sessionId: string
  /** 宿主开放的配置目录。 */
  profiles(): readonly AgentProfileInfo[]
  /** 父运行的取消信号：子任务跟着父运行一起取消。 */
  runSignal(): AbortSignal
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}

/** 请求用户提供信息或确认，答案绑定当前运行与请求身份所需的窄宿主端口。 */
export interface InteractionHost {
  /** 取得当前会话交互端口。 */
  programs(sessionId: string): InteractionSession
}
/** 绑定运行身份的用户交互。 */
export interface InteractionSession {
  /** 请求并等待当前交互答案。 */
  interact(
    kind: 'input' | 'confirmation' | 'capability',
    message: string,
    signal: AbortSignal,
    detail?: unknown
  ): Promise<unknown>
}
/** `velaros:interaction` 每次调用的宿主上下文：本会话的交互端口与取消信号。 */
export interface InteractionOperationContext {
  /** 本会话的交互端口，回答绑定当前运行与请求身份。 */
  readonly interaction: InteractionSession
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}
