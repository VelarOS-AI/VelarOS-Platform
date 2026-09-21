import type { ActAnswer,ActEvent,ActInput,ActInteraction,ActRunEvent,ActRunSnapshot } from '../contract/act.js'
/** 唯一模型回合推进器，由运行服务持有。 */
export interface ActLoopApi {
 /** 推进一次输入，暂停或终止时返回。 */
 submit(input:string|ActInput,signal?:AbortSignal):AsyncIterable<ActRunEvent>
 /** 取消当前运行。 */
 cancel():void
}
/** 持久运行管理，宿主不再自行维护平行状态机。 */
export interface ActRunServiceApi {
 /** 领运行权并推进输入；消费方关闭迭代时收束执行。 */
 submit(input:string|ActInput,signal?:AbortSignal):AsyncIterable<ActRunEvent>
 /** 归档并在下一轮递交运行中补充，抢占尚未派发的模型响应。 */
 steer(input:string|ActInput):Promise<void>
 /** 创建可由宿主回答的交互，取消会拒绝等待。 */
 request(kind:ActInteraction['kind'],message:string,signal:AbortSignal,detail?:unknown):Promise<unknown>
 /** 只回答当前运行的一次交互，重复或陈旧回答拒绝。 */
 answer(answer:ActAnswer):Promise<void>
 /** 获取当前或重启恢复的运行状态。 */
 inspect():Promise<ActRunSnapshot>
 /** 按持久序号分页读取事件。 */
 events(after?:number,limit?:number):Promise<readonly ActEvent[]>
 /** 取消当前运行及其交互。 */
 cancel():void
 /** 取消并等待所有运行收束。 */
 close():Promise<void>
}

import type { AgentJob,AgentResume,AgentStart } from '../contract/delegation.js'
/** 并发子运行的唯一调度面，父身份必须由宿主提供。 */
export interface AgentSupervisorApi {
 /** 父运行是否仍有活动子任务。 */
 pending(parent:string):boolean
 /** 等待新的子任务交互或收束，不调用模型轮询。 */
 waitAny(parent:string,signal:AbortSignal):Promise<void>
 /** 派发并立即返回句柄，输入及状态先持久化。 */
 start(parent:string,input:AgentStart,signal:AbortSignal):Promise<AgentJob>
 /** 续跑同一会话，沿用材料、授权配置和已计费预算。 */
 resume(parent:string,id:string,input:AgentResume,signal:AbortSignal):Promise<AgentJob>
 /** 读取子任务状态，重启后未完成的运行标为中断。 */
 status(parent:string,id:string):Promise<AgentJob>
 /** 等待子任务提问或真实终态；等待者取消只退出等待。 */
 wait(parent:string,id:string,signal:AbortSignal):Promise<AgentJob>
 /** 回答当前子运行的指定请求；陈旧、重复、跨父任务回答拒绝。 */
 reply(parent:string,id:string,requestId:string,value:unknown):Promise<void>
 /** 向活动子运行发送新输入。 */
 send(parent:string,id:string,input:ActInput|string):Promise<void>
 /** 取消指定子运行并等待收束。 */
 cancel(parent:string,id:string):Promise<AgentJob>
 /** 父运行取消或结束时收束其全部子运行。 */
 cancelParent(parent:string):Promise<void>
 /** 停机时收束全部运行。 */
 close():Promise<void>
}
