/**
 * 会话目标（`velaros:system` 的 goal 成员，模块身份 `velaros:system-goal`）的操作：`GoalOperations` 与整个进程唯一的 `goalOperations`。
 * 接口 `GoalOperationsApi` 在本文件的类上方。两个操作只查取消，再转发到调用上下文里本会话的目标账本；版本、状态迁移与内容上限都由账本核对。
 */

import type { GoalOperationContext } from '../contract/requires.js'
import type { GoalState, GoalUpdate } from '../types/goal.js'

/**
 * @AgentView
 * 会话目标：只在用户要求持续推进一件事时建立，objective 写用户授权的具体工作。
 * 目标跨回合保留：结束一轮回复、停止执行都不会完成它；暂停只在用户要求时做，完成或受阻要有实际验收依据。
 */
export interface GoalOperationsApi {
  /** @AgentView 读当前目标的完整正文与状态：从未建立过时是 null，用户删掉的目标以 removed 状态的墓碑返回。
   * 工作帧里的 objectiveInRecord、reasonInRecord 是原文引用，不代表正文已读；可按其中的 ref、pointer 用 memory.read 分页读取。
   * @OperationEffect none
   */
  get(ctx: GoalOperationContext): Promise<Nullable<GoalState>>
  /** @AgentView 建立、暂停、恢复或结束目标；先 get 拿到 revision，版本变了就重新读取再改。
   * @OperationEffect write
   * @OperationModes execute
   */
  update(input: GoalUpdate, ctx: GoalOperationContext): Promise<GoalState>
}

export class GoalOperations implements GoalOperationsApi {
  public async get(ctx: GoalOperationContext): Promise<Nullable<GoalState>> {
    ctx.abortSignal.throwIfAborted()
    return ctx.goal.get(ctx.abortSignal)
  }

  public async update(input: GoalUpdate, ctx: GoalOperationContext): Promise<GoalState> {
    ctx.abortSignal.throwIfAborted()
    return ctx.goal.update(input, ctx.abortSignal)
  }
}

/** 整个进程只有一份的目标操作；装配时把本会话的目标账本塞进每次调用的上下文。 */
export const goalOperations: GoalOperationsApi = new GoalOperations()
