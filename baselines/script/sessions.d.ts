declare module 'velaros:sessions' {
  /**
   * 同一个对话里的几个会话互相交活、传话。每个会话有自己的工作区与能力：
   * 浏览器会话（browser）有内置浏览器，要在网页上动手的事（登录、填表、下单、到处点）交给它；
   * 项目会话（project）在自己的项目里干活，别的项目里的事交给那个项目的会话；系统会话（system）在本机上干活。
   * list 看这个对话里有哪些会话；ask 交一件事给一个会话、等它这一轮跑完，拿回它说的话；tell 只传话、不等。
   * 对方看不到你们的对话：task、message 里把要做什么、做到哪一步、交回什么写清楚。
   * 互不相干的几件事可以同时 ask（Promise.all）；不要让两个会话互相等对方的回答，宿主会拒绝。
   * 入参不对抛 SESSIONS_ 开头的码（message 写明哪里不对、怎么改）；对方不在这个对话里、互相等待这类情况宿主会拒绝，错误原样抛给你。
   */

  /** 列出这个对话里的会话（self 为真的是你自己）：交活之前先看有没有合适的。
   */
  export function list(): Promise<SessionPeer[]>

  /** 交一件事给这个对话里的一个会话，等它这一轮跑完，交回它说的话。
   * 用 to 交给已有的会话；没有合适的就给 workspace 开一个新的，它加进这个对话、在后台跑，用户可以切过去看。对方正在跑时，等它这一轮跑完再交给它。
   */
  export function ask(input: SessionAskInput): Promise<SessionAnswer>

  /** 给这个对话里的一个会话传一句话，不等它：它闲着就马上收到、为这句话跑一轮；正在跑就等这一轮跑完再收到。
   */
  export function tell(input: SessionTellInput): Promise<SessionTold>

  /**
   * 这个对话里的一个会话。id 交给 ask、tell 的 to；title 是会话的标题（还没有标题是 null）。
   * root 是项目会话的项目目录，site 是浏览器会话在看的网站，别的会话是 null。
   * running 为真是它正在跑（交给它的事要等这一轮跑完）；self 为真的是你自己。
   */
  interface SessionPeer {
    id: string
    workspace: SessionWorkspace
    title: string | null
    root: string | null
    site: string | null
    running: boolean
    self: boolean
  }

  /**
   * 交给谁、交什么。to 与 workspace 只给一个：to 是 list 里的会话 id；没有合适的会话就给 workspace 开一个新的——
   * project 要给 root（项目目录的绝对路径），browser 可以给 site（先打开的 http 或 https 网址），system 两个都不给。
   * task 写清楚：对方看不到你们的对话，要做什么、做到哪一步、交回什么都写进去。
   */
  interface SessionAskInput {
    to?: string
    workspace?: SessionWorkspace
    root?: string
    site?: string
    task: string
  }

  /**
   * 对方这一轮的结果。session 是接活的会话 id（新开的也在这里，之后接着交活就用它）。
   * status：completed 做完了；failed 没做成；cancelled 被取消了；waiting 是对方停下来等一个回答，answer 就是它的问题——
   * 答得上来就把答案写进 task、用 to 再 ask 它一次。answer 是它这一轮说的话，太长的只留结尾；reason 说明为什么没做完，没有就是 null。
   */
  interface SessionAnswer {
    session: string
    status: 'completed' | 'failed' | 'cancelled' | 'waiting'
    answer: string
    reason: string | null
  }

  /** 传话给谁、传什么：to 是 list 里的会话 id；message 同样要写清楚，对方看不到你们的对话。 */
  interface SessionTellInput {
    to: string
    message: string
  }

  /** 传到了没有：delivered 是对方闲着，已经收到、开始为它跑一轮；queued 是对方正在跑，这一轮跑完再收到。 */
  interface SessionTold {
    session: string
    status: 'delivered' | 'queued'
  }

  /** 会话的工作区：project 在一个项目里干活，system 在本机上干活，browser 有内置浏览器。 */
  type SessionWorkspace = 'project' | 'system' | 'browser'
}
