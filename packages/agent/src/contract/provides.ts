/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口直接声明在这里。这里的每个接口都必须从根入口导出。
 */

import type { PromptRegistryApi } from '../types/guidance.js'
import type { ExecuteQueryLoopArgs, ExecuteSoloModeStreamLoopArgs, SoloModeStreamLoopResult } from '../types/loop.js'
import type { ExecutionEventBusApi } from '../types/records.js'
import type { ContextGovernanceSessionRegistryApi } from '../types/residency.js'
import type { AgentExecutionStackRunnerOptions, AgentExecutionStackToolContext, AgentRunnerApi } from '../types/runner.js'

// ── 执行栈：类实现在 impl/assembly/AgentExecutionStack.ts ──────────────

/**
 * 默认执行栈的 Solo 面：产品注入模型端口、工具登记处与几项策略，包内把上下文构建、回合执行与
 * Solo 流式循环配成一套，宿主拿到的就是这份栈。一份栈绑定一份工具面，工具面整体换掉要另建一份栈；
 * 状态只有各会话在 Solo 循环与治理登记处里的驻留，栈本身不持有业务数据。
 */
export interface AgentExecutionStackApi<TContext extends AgentExecutionStackToolContext> {
  /**
   * 本栈实际使用的提示词目录：建栈时没给就是包内置的那一份。
   * 宿主要读或扩提示词段一律从这里取；另建一份会让栈里跑的和宿主看到的系统提示对不上。
   */
  readonly promptRegistry: PromptRegistryApi
  /**
   * 上下文治理的会话登记处：每个会话的驻留账本、压缩进度与 epoch 状态都挂在它身上。
   * 缺省是本栈独占的一份；宿主想让多份栈共享同一批会话生命周期，就在建栈时注入同一个实例。
   */
  readonly governanceSessions: ContextGovernanceSessionRegistryApi
  /**
   * 跑一轮 Solo（主 Agent 流式）执行：入参带本轮历史、运行配置与事件总线，
   * 返回这轮的收敛结果（结束原因、最终历史等）。模型或工具层的失败按 AppError 往外抛，栈不吞。
   */
  executeSolo(
    args: ExecuteSoloModeStreamLoopArgs<TContext, ExecutionEventBusApi>
  ): Promise<SoloModeStreamLoopResult>
  /**
   * 释放一个会话在本栈里的全部驻留：Solo 循环的会话状态与治理账本一起作废。
   * 删除或整体替换宿主会话时调用；对没见过的 `sessionId` 是无操作，不报错。
   */
  clearSession(sessionId: string): void
}

/**
 * 建栈时给了 `query` 配置（角色引擎 + 工具类别解析）的执行栈：Solo 面之外多出子 Agent 查询面与 Runner 装配。
 * 只跑 Solo 的宿主拿到的是 {@link AgentExecutionStackApi}，那种栈上这两个成员一调就抛 `INVALID_STATE`。
 */
export interface AgentExecutionStackWithQueryApi<
  TContext extends AgentExecutionStackToolContext,
> extends AgentExecutionStackApi<TContext> {
  /**
   * 跑一轮 Query（子 Agent / 委派）执行，返回子 Agent 收敛后的最终文本答复。
   * 由派发器与工作流派发点调用；建栈时没配 `query` 的栈调用它会抛 `INVALID_STATE`。
   */
  executeQuery(args: ExecuteQueryLoopArgs<TContext, ExecutionEventBusApi>): Promise<string>
  /**
   * 装配一个 AgentRunner：栈里已经配好的工具登记处、执行上限与提示词特性策略，
   * 与宿主给的上下文构建器、主 Agent 画像、子 Agent 派发器合成一台 Runner，并把它回绑到
   * `options.subAgentDispatcher`（派发子 Agent 要用 Runner 的 query）。一般每个宿主会话建一台。
   */
  createRunner(options: AgentExecutionStackRunnerOptions<TContext>): AgentRunnerApi<TContext>
}

/** @deprecated 旧名，改用 {@link AgentExecutionStackApi}；下一个大版本移除。 */
export type AgentExecutionStack<TContext extends AgentExecutionStackToolContext> =
  AgentExecutionStackApi<TContext>

/** @deprecated 旧名，改用 {@link AgentExecutionStackWithQueryApi}；下一个大版本移除。 */
export type AgentExecutionStackWithQuery<TContext extends AgentExecutionStackToolContext> =
  AgentExecutionStackWithQueryApi<TContext>
