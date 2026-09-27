/**
 * 注入面：`velaros:sessions` 要宿主塞进来的东西。会话的一切都在宿主那里（这个对话里有谁、开新会话、排队、谁在等谁），
 * 本单元只有模型面与入参核对，经这个口子把核对、规范过的入参交给宿主，别处不留钩子。
 *
 * - 空间端口 `SessionsSpacePort`：宿主已经把它绑在发问的那个会话上。
 * - 调用上下文 `SessionsOperationContext`：宿主分发每一次调用时装好。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type {
  SessionAnswer,
  SessionAskInput,
  SessionPeer,
  SessionTellInput,
  SessionTold,
} from '../types/sessions.js'

/**
 * `velaros:sessions` 的空间端口：宿主已经绑在发问的会话上。对方是不是这个对话里的会话、两个会话互相等对方回答、
 * 对方正在跑要排队，都由宿主判断与处理；拒绝时抛带码的错误，本单元原样抛给模型。
 */
export interface SessionsSpacePort {
  /** 这个对话里的会话，发问的这一个也在里面（self 为真）。 */
  list(): Promise<SessionPeer[]>
  /**
   * 交一件事给一个会话，等它这一轮跑完再交回它说的话。入参已经核对并规范过：to 与 workspace 恰好有一个，
   * 字符串去掉了首尾空白，project 一定带着绝对路径的 root，site 只跟着 browser 出现、已经规范成网址的写法，没给的字段不在对象上。
   * signal 触发时尽快放弃（本单元同时不再等）。
   */
  ask(input: SessionAskInput, signal: AbortSignal): Promise<SessionAnswer>
  /** 传一句话，不等对方：闲着的马上收到并为它跑一轮，正在跑的这一轮跑完再收到。入参已经核对，to 去掉了首尾空白。 */
  tell(input: SessionTellInput, signal: AbortSignal): Promise<SessionTold>
}

/** 每次调用 `velaros:sessions` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时装好，生成声明时整个丢掉。 */
export interface SessionsOperationContext {
  /** 本次调用的取消信号：交给宿主，一触发本单元就不再等，以取消原因失败。 */
  abortSignal: AbortSignal
  /** 已经绑在发问会话上的宿主端口。 */
  sessions: SessionsSpacePort
}
