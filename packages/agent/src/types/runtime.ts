import type { ModelHistoryMessage } from '@velaros-ai/kernel'

import type { ActChildSession } from '../contract/requires.js'

import type { ActImage, ActInteraction } from './act.js'

/** 已接受出线的快照；图片只在当前投影仍授权展示时复用。 */
export interface ActRequestTranscript {
  readonly logical: readonly ModelHistoryMessage[]
  readonly sent: readonly ModelHistoryMessage[]
  readonly positions: readonly number[]
  readonly body: string
  readonly images: readonly ActImage[]
}
import type { AgentJob } from './delegation.js'

/** 打开的会话持有已接受请求的实际前缀，跨次提交仍逐条核对逻辑历史后复用。 */
export interface ActRequestPrefix {
  /** 容量重建时清除；关闭或重建会话时自然释放，不跨会话共享。 */
  transcript?: ActRequestTranscript
  /** 与纯文本基线分开保存；图片过期后可以退回文本基线，不保留失效图像。 */
  visualTranscript?: ActRequestTranscript
}

/** 调度器持有活动权；持久状态不包含这些进程对象。 */
export interface ActiveAgentJob {
  /** 当前不可变状态。 */
  job: AgentJob
  /** 父取消及宿主取消共用的信号。 */
  controller: AbortController
  /** 工厂打开后用于引导与收束的会话。 */
  session?: ActChildSession
  /** 首个运行事件或启动失败后结算；等待者分别绑定自己的取消范围。 */
  ready: Promise<void>
  /** 当前运行已经接纳且仍可接收引导，收束阶段为 false。 */
  accepting: boolean
  /** 包含终态持久化的运行承诺。 */
  promise: Promise<void>
}

/** 在途交互的 Promise 只存于活动运行，重启后以中断事实恢复。 */
export interface ActPendingInteraction {
  /** 已持久化的问题身份。 */
  readonly request: ActInteraction
  /** 完成当前交互。 */
  resolve(value: unknown): void
  /** 取消或记录持久化失败。 */
  reject(reason: unknown): void
}
