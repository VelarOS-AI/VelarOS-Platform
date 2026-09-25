/**
 * 子任务（`velaros:agents`）的操作：`AgentsOperations` 与整个进程唯一的 `agentsOperations`。接口 `AgentsOperationsApi` 在本文件的类上方。
 * 八个操作都以调用所在的会话为父会话转发给共享调度器；材料条数与引导内容在这里核对，没选配置时用宿主给的第一个。
 */

import type { AgentJob, AgentStart } from '@velaros-ai/agent'
import { AppError } from '@velaros-ai/core/error'

import type { AgentsOperationContext } from '../contract/requires.js'
import type {
  AgentJobTarget,
  AgentProfileInfo,
  AgentReplyInput,
  AgentResumeRequest,
  AgentSendInput,
} from '../types/agents.js'
import { checkAgentMaterials } from '../utils/requests.js'

/**
 * @AgentView
 * 在同一个运行时上派发子任务：它继承你的能力与权限，自己开一个会话去做，预算由宿主配置（profiles 列出）。
 * 派发、等待、回答、续跑、引导、取消都只能在 execute 里做；wait 不额外调用模型，遇到子任务提问或结束就返回。
 */
export interface AgentsOperationsApi {
  /** @AgentView 列出宿主给的配置：名称、能力范围与预算；start/resume 不给 profile 就用第一个。
   * @OperationEffect none
   */
  profiles(ctx: AgentsOperationContext): Promise<AgentProfileInfo[]>
  /** @AgentView 派发子任务，返回它的 job。
   * @OperationEffect none
   * @OperationModes execute
   */
  start(input: AgentStart, ctx: AgentsOperationContext): Promise<AgentJob>
  /** @AgentView 子任务收束后接着跑同一个会话，已用预算保留；可以换配置、追加材料。
   * @OperationEffect none
   * @OperationModes execute
   */
  resume(input: AgentResumeRequest, ctx: AgentsOperationContext): Promise<AgentJob>
  /** @AgentView 回答子任务在 job.pending 里的请求。
   * @OperationEffect none
   * @OperationModes execute
   */
  reply(input: AgentReplyInput, ctx: AgentsOperationContext): Promise<null>
  /** @AgentView 读子任务的状态与结果引用。
   * @OperationEffect none
   */
  status(input: AgentJobTarget, ctx: AgentsOperationContext): Promise<AgentJob>
  /** @AgentView 等到子任务提问或结束；status 为 waiting 时 pending 里的请求要 reply。
   * @OperationEffect none
   * @OperationModes execute
   */
  wait(input: AgentJobTarget, ctx: AgentsOperationContext): Promise<AgentJob>
  /** @AgentView 取消子任务并等它收束。
   * @OperationEffect none
   * @OperationModes execute
   */
  cancel(input: AgentJobTarget, ctx: AgentsOperationContext): Promise<AgentJob>
  /** @AgentView 给正在跑的子任务发引导。
   * @OperationEffect none
   * @OperationModes execute
   */
  send(input: AgentSendInput, ctx: AgentsOperationContext): Promise<null>
}

export class AgentsOperations implements AgentsOperationsApi {
  public async profiles(ctx: AgentsOperationContext): Promise<AgentProfileInfo[]> {
    ctx.abortSignal.throwIfAborted()
    return [...ctx.profiles()]
  }

  public async start(input: AgentStart, ctx: AgentsOperationContext): Promise<AgentJob> {
    ctx.abortSignal.throwIfAborted()
    checkAgentMaterials(input.materials)
    const profile = input.profile ?? ctx.profiles()[0]?.name
    return ctx.agents.start(ctx.sessionId, { ...input, profile }, ctx.runSignal())
  }

  public async resume(input: AgentResumeRequest, ctx: AgentsOperationContext): Promise<AgentJob> {
    ctx.abortSignal.throwIfAborted()
    checkAgentMaterials(input.materials)
    const { id, ...request } = input
    return ctx.agents.resume(ctx.sessionId, id, request, ctx.runSignal())
  }

  public async reply(input: AgentReplyInput, ctx: AgentsOperationContext): Promise<null> {
    ctx.abortSignal.throwIfAborted()
    await ctx.agents.reply(ctx.sessionId, input.id, input.requestId, input.value)
    return null
  }

  public async status(input: AgentJobTarget, ctx: AgentsOperationContext): Promise<AgentJob> {
    ctx.abortSignal.throwIfAborted()
    return ctx.agents.status(ctx.sessionId, input.id)
  }

  public async wait(input: AgentJobTarget, ctx: AgentsOperationContext): Promise<AgentJob> {
    ctx.abortSignal.throwIfAborted()
    return ctx.agents.wait(ctx.sessionId, input.id, ctx.abortSignal)
  }

  public async cancel(input: AgentJobTarget, ctx: AgentsOperationContext): Promise<AgentJob> {
    ctx.abortSignal.throwIfAborted()
    return ctx.agents.cancel(ctx.sessionId, input.id)
  }

  public async send(input: AgentSendInput, ctx: AgentsOperationContext): Promise<null> {
    ctx.abortSignal.throwIfAborted()
    if (!input.input.trim()) throw new AppError('VALIDATION', '引导内容不能为空')
    await ctx.agents.send(ctx.sessionId, input.id, input.input)
    return null
  }
}

/** 整个进程只有一份的子任务操作；装配时把共享调度器与父会话塞进每次调用的上下文。 */
export const agentsOperations: AgentsOperationsApi = new AgentsOperations()
