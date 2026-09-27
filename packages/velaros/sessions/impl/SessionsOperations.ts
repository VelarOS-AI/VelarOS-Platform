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
 * 同一个对话里的几个会话互相交活、传话。每个会话有自己的工作区与能力：
 * 浏览器会话（browser）有内置浏览器，要在网页上动手的事（登录、填表、下单、到处点）交给它；
 * 项目会话（project）在自己的项目里干活，别的项目里的事交给那个项目的会话；系统会话（system）在本机上干活。
 * list 看这个对话里有哪些会话；ask 交一件事给一个会话、等它这一轮跑完，拿回它说的话；tell 只传话、不等。
 * 对方看不到你们的对话：task、message 里把要做什么、做到哪一步、交回什么写清楚。
 * 互不相干的几件事可以同时 ask（Promise.all）；不要让两个会话互相等对方的回答，宿主会拒绝。
 * 入参不对抛 SESSIONS_ 开头的码（message 写明哪里不对、怎么改）；对方不在这个对话里、互相等待这类情况宿主会拒绝，错误原样抛给你。
 */
export interface SessionsOperationsApi {
  /** @AgentView 列出这个对话里的会话（self 为真的是你自己）：交活之前先看有没有合适的。
   * @OperationEffect none
   */
  list(ctx: SessionsOperationContext): Promise<SessionPeer[]>
  /** @AgentView 交一件事给这个对话里的一个会话，等它这一轮跑完，交回它说的话。
   * 用 to 交给已有的会话；没有合适的就给 workspace 开一个新的，它加进这个对话、在后台跑，用户可以切过去看。对方正在跑时，等它这一轮跑完再交给它。
   * @OperationEffect none
   * @OperationModes execute
   */
  ask(input: SessionAskInput, ctx: SessionsOperationContext): Promise<SessionAnswer>
  /** @AgentView 给这个对话里的一个会话传一句话，不等它：它闲着就马上收到、为这句话跑一轮；正在跑就等这一轮跑完再收到。
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
