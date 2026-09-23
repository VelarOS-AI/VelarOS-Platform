/**
 * 向用户或父任务要信息、确认与能力（`velaros:interaction`）的操作：`InteractionOperations` 与整个进程唯一的 `interactionOperations`。
 * 接口 `InteractionOperationsApi` 在本文件的类上方。先核对说明长度，等待与回答绑定交给调用上下文里本会话的交互端口。
 */

import type { InteractionOperationContext } from '../contract/requires.js'
import type { CapabilityRequest, InteractionRequest } from '../types/interaction.js'
import { checkInteractionMessage } from '../utils/requests.js'

/**
 * @AgentView
 * 向用户要信息、确认或能力；在子任务里是向父任务要。调用一直等到对方回答，返回的就是回答。
 * 回答本身不授予任何权限：写操作照样过各自的检查，要换能力得等父任务更新环境后续跑。
 */
export interface InteractionOperationsApi {
  /** @AgentView 要信息，返回对方的回答。
   * @OperationEffect none
   * @OperationModes execute
   */
  ask(input: InteractionRequest, ctx: InteractionOperationContext): Promise<unknown>
  /** @AgentView 说明缺少的能力；可以先交付当前进度，由父任务更新环境后续跑。
   * @OperationEffect none
   * @OperationModes execute
   */
  capability(input: CapabilityRequest, ctx: InteractionOperationContext): Promise<unknown>
  /** @AgentView 要确认，返回对方的答复；它不代替具体操作的权限校验。
   * @OperationEffect none
   * @OperationModes execute
   */
  confirm(input: InteractionRequest, ctx: InteractionOperationContext): Promise<unknown>
}

export class InteractionOperations implements InteractionOperationsApi {
  public async ask(input: InteractionRequest, ctx: InteractionOperationContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    checkInteractionMessage(input.message)
    return ctx.interaction.interact('input', input.message, ctx.abortSignal)
  }

  public async capability(input: CapabilityRequest, ctx: InteractionOperationContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    checkInteractionMessage(input.message)
    return ctx.interaction.interact('capability', input.message, ctx.abortSignal, input.detail)
  }

  public async confirm(input: InteractionRequest, ctx: InteractionOperationContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    checkInteractionMessage(input.message)
    return ctx.interaction.interact('confirmation', input.message, ctx.abortSignal)
  }
}

/** 整个进程只有一份的交互操作；装配时把本会话的交互端口塞进每次调用的上下文。 */
export const interactionOperations: InteractionOperationsApi = new InteractionOperations()
