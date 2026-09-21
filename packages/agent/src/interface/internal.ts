import type { ActInteraction } from '../contract/act.js'
/** 在途交互的 Promise 只存于活动运行，重启后以中断事实恢复。 */
export interface ActPendingInteraction {
 /** 已持久化的问题身份。 */
 readonly request:ActInteraction
 /** 完成当前交互。 */
 resolve(value:unknown):void
 /** 取消或记录持久化失败。 */
 reject(reason:unknown):void
}

import type { AgentJob } from '../contract/delegation.js'

import type { ActChildSession } from './requires.js'
/** 调度器持有活动权；持久状态不包含这些进程对象。 */
export interface ActiveAgentJob {
 /** 当前不可变状态。 */
 job:AgentJob
 /** 父取消及宿主取消共用的信号。 */
 controller:AbortController
 /** 工厂打开后用于引导与收束的会话。 */
 session?:ActChildSession
 /** 包含终态持久化的运行承诺。 */
 promise:Promise<void>
}
