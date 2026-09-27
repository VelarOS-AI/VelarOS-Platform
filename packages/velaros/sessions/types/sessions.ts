/**
 * 可移植数据：`velaros:sessions` 的入参与结果，以及宿主报给本单元的会话。
 * 不 import 任何东西、不带函数、不用 Node 类型，浏览器和渲染进程都能用；从 `@velaros-ai/velaros/sessions/contracts` 取。
 */

/** @AgentView 会话的工作区：project 在一个项目里干活，system 在本机上干活，browser 有内置浏览器。 */
export type SessionWorkspace = 'project' | 'system' | 'browser'

/**
 * @AgentView
 * 这个对话里的一个会话。id 交给 ask、tell 的 to；title 是会话的标题（还没有标题是 null）。
 * root 是项目会话的项目目录，site 是浏览器会话在看的网站，别的会话是 null。
 * running 为真是它正在跑（交给它的事要等这一轮跑完）；self 为真的是你自己。
 */
export interface SessionPeer {
  id: string
  workspace: SessionWorkspace
  title: Nullable<string>
  root: Nullable<string>
  site: Nullable<string>
  running: boolean
  self: boolean
}

/**
 * @AgentView
 * 交给谁、交什么。to 与 workspace 只给一个：to 是 list 里的会话 id；没有合适的会话就给 workspace 开一个新的——
 * project 要给 root（项目目录的绝对路径），browser 可以给 site（先打开的 http 或 https 网址），system 两个都不给。
 * task 写清楚：对方看不到你们的对话，要做什么、做到哪一步、交回什么都写进去。
 */
export interface SessionAskInput {
  to?: string
  workspace?: SessionWorkspace
  root?: string
  site?: string
  task: string
}

/**
 * @AgentView
 * 对方这一轮的结果。session 是接活的会话 id（新开的也在这里，之后接着交活就用它）。
 * status：completed 做完了；failed 没做成；cancelled 被取消了；waiting 是对方停下来等一个回答，answer 就是它的问题——
 * 答得上来就把答案写进 task、用 to 再 ask 它一次。answer 是它这一轮说的话，太长的只留结尾；reason 说明为什么没做完，没有就是 null。
 */
export interface SessionAnswer {
  session: string
  status: 'completed' | 'failed' | 'cancelled' | 'waiting'
  answer: string
  reason: Nullable<string>
}

/** @AgentView 传话给谁、传什么：to 是 list 里的会话 id；message 同样要写清楚，对方看不到你们的对话。 */
export interface SessionTellInput {
  to: string
  message: string
}

/** @AgentView 传到了没有：delivered 是对方闲着，已经收到、开始为它跑一轮；queued 是对方正在跑，这一轮跑完再收到。 */
export interface SessionTold {
  session: string
  status: 'delivered' | 'queued'
}
