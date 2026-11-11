/**
 * 现有会话之间交活、传话。list 查看宿主目录中可寻址的会话；ask 启动一件事并等它这一轮的结果；
 * tell 只向正在跑的会话追加引导，不另开一轮、不等回答。本模块不创建会话，也不根据工作区分类限制能力。
 * 对方看不到你们的对话：task、message 里把要做什么、做到哪一步、交回什么写清楚。
 * 互不相干的几件事可以同时 ask（Promise.all）；不要让两个会话互相等对方的回答，宿主会拒绝。
 * 入参不对抛 SESSIONS_ 开头的码（message 写明哪里不对、怎么改）；目标不存在、互相等待这类情况宿主会拒绝，错误原样抛给你。
 */
declare module 'velaros:sessions' {
  /** 列出现有会话（self 为真的是你自己）：交活之前先查看标题与运行状态。
   */
  export function list(): Promise<SessionPeer[]>

  /** 用 to 交一件事给现有会话，等它这一轮跑完，交回它说的话。
   * 对方正在跑时，等它这一轮跑完再交给它。不创建新会话。
   */
  export function ask(input: SessionAskInput): Promise<SessionAnswer>

  /** 给正在跑的现有会话追加一句引导，进入当前运行的引导队列，不等回答、不另开一轮。
   * 空闲目标会拒绝；要启动任务并等结果，用 ask。list 的 running 只是查询时的状态，投递时仍以宿主实际准入为准。
   */
  export function tell(input: SessionTellInput): Promise<SessionTold>

  /**
   * 宿主目录中的现有会话。id 交给 ask、tell 的 to；title 是会话的标题（还没有标题是 null）。
   * running 为真是它正在跑：ask 等这轮结束再交活，tell 向当前运行追加引导；self 为真的是你自己。
   */
  interface SessionPeer {
    id: string
    title: string | null
    running: boolean
    self: boolean
  }

  /**
   * 交给谁、交什么。to 是 list 里的现有会话 id，不创建新会话。
   * task 写清楚：对方看不到你们的对话，要做什么、做到哪一步、交回什么都写进去。
   */
  interface SessionAskInput {
    to: string
    task: string
  }

  /**
   * 对方这一轮的结果。session 是接活的现有会话 id。
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

  /** queued 表示引导已被目标的活动运行接纳，尚不表示已消费或已回答；空闲目标拒绝，不返回结果。 */
  interface SessionTold {
    session: string
    status: 'queued'
  }
}
