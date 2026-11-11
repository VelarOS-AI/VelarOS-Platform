/**
 * 会话之间交活、传话（`velaros:sessions`）的操作：`SessionsOperations` 与整个进程唯一的 `sessionsOperations`。接口 `SessionsOperationsApi` 在本文件的类上方。
 * 会话的一切都在宿主那里：这里查取消、核对并规范入参，再经调用上下文里已经绑在发问会话上的端口 `SessionsSpacePort` 交给宿主，
 * 宿主交回什么就原样交回什么；宿主拒绝时的错误原样抛出。取消信号交给宿主，同时本单元一触发就不再等。
 */

import type { SessionsOperationContext } from '../contract/requires.js'
import type {
  SessionAnswer,
  SessionAskInput,
  SessionPeer,
  SessionTellInput,
  SessionTold,
} from '../types/sessions.js'
import { untilAborted } from '../utils/abort.js'
import { askRequest, tellRequest } from '../utils/input.js'

/**
 * @AgentView
 * 现有会话之间交活、传话。list 查看宿主目录中可寻址的会话；ask 启动一件事并等它这一轮的结果；
 * tell 只向正在跑的会话追加引导，不另开一轮、不等回答。本模块不创建会话，也不根据工作区分类限制能力。
 * 对方看不到你们的对话：task、message 里把要做什么、做到哪一步、交回什么写清楚。
 * 互不相干的几件事可以同时 ask（Promise.all）；不要让两个会话互相等对方的回答，宿主会拒绝。
 * 入参不对抛 SESSIONS_ 开头的码（message 写明哪里不对、怎么改）；目标不存在、互相等待这类情况宿主会拒绝，错误原样抛给你。
 */
export interface SessionsOperationsApi {
  /** @AgentView 列出现有会话（self 为真的是你自己）：交活之前先查看标题与运行状态。
   * @OperationEffect none
   */
  list(ctx: SessionsOperationContext): Promise<SessionPeer[]>
  /** @AgentView 用 to 交一件事给现有会话，等它这一轮跑完，交回它说的话。
   * 对方正在跑时，等它这一轮跑完再交给它。不创建新会话。
   * @OperationEffect none
   * @OperationModes execute
   */
  ask(input: SessionAskInput, ctx: SessionsOperationContext): Promise<SessionAnswer>
  /** @AgentView 给正在跑的现有会话追加一句引导，进入当前运行的引导队列，不等回答、不另开一轮。
   * 空闲目标会拒绝；要启动任务并等结果，用 ask。list 的 running 只是查询时的状态，投递时仍以宿主实际准入为准。
   * @OperationEffect none
   * @OperationModes execute
   */
  tell(input: SessionTellInput, ctx: SessionsOperationContext): Promise<SessionTold>
}

/** 顺序是固定的：先查取消、再核对入参、最后交给宿主——入参错了宿主一次都不调。整个进程共用一份，无状态。 */
export class SessionsOperations implements SessionsOperationsApi {
  public async list(ctx: SessionsOperationContext): Promise<SessionPeer[]> {
    ctx.abortSignal.throwIfAborted()
    return untilAborted(ctx.sessions.list(), ctx.abortSignal)
  }

  public async ask(input: SessionAskInput, ctx: SessionsOperationContext): Promise<SessionAnswer> {
    ctx.abortSignal.throwIfAborted()
    const request = askRequest(input)
    return untilAborted(ctx.sessions.ask(request, ctx.abortSignal), ctx.abortSignal)
  }

  public async tell(input: SessionTellInput, ctx: SessionsOperationContext): Promise<SessionTold> {
    ctx.abortSignal.throwIfAborted()
    const request = tellRequest(input)
    return untilAborted(ctx.sessions.tell(request, ctx.abortSignal), ctx.abortSignal)
  }
}

/** 整个进程只有一份的会话操作；宿主把它挂在代码面的 `sessions` 命名空间上，每次调用时把绑在发问会话上的端口塞进 ctx。 */
export const sessionsOperations: SessionsOperationsApi = new SessionsOperations()
