declare module 'velaros:agents' {
  /**
   * 在同一个运行时上派发有界的子任务：能力范围与预算由宿主配置（profiles 列出），writes 按模块独占写入。
   * 派发、等待、回答、续跑、引导、取消都只能在 execute 里做；wait 不额外调用模型，遇到子任务提问或结束就返回。
   */

  /** 一个可选的子任务配置：name 传给 start/resume 的 profile；modules 是子任务能用的模块，stores 表示能否接受共享空间授权，其余是单次运行与累计的预算。 */
  interface AgentProfileInfo {
    readonly name: string
    readonly description: string
    readonly modules: readonly string[]
    readonly stores: boolean
    readonly turns: number
    readonly timeoutMs: number
    readonly modelCalls: number
    readonly modelTokens: number
  }

  /**
   * 派发子任务：task 写清楚要它完成什么；profile 取 profiles() 里的 name；materials 把已有原文引用复制给它（最多 32 条）；
   * writes 是它要独占的外部模块写入范围；stores 显式共享空间，每项的 write 前缀都必须落在同一项的 read 前缀里，并且不超出自己的授权。
   */
  interface AgentStart {
   /** 显式共享的空间与范围；省略则不共享。 */
   readonly stores?:readonly AgentStoreGrant[]
   readonly task:string
   readonly profile:string
   readonly writes?:readonly string[]
   readonly materials?:ReadonlyArray<{readonly sessionId:string;readonly id:string}>
  }

  /**
   * 一个子任务：status 为 waiting 时 pending 里有它在等的请求，用 reply 回答；结束后 result 是结果原文的引用，delivery 是交付清单，失败时 error 说明原因。
   * writes 是它占着的外部模块写入范围，stores 是派给它的共享空间授权。
   */
  interface AgentJob {
   /** 已落盘且仍待处理的子运行请求，答案通过 reply 绑定原运行。 */
   readonly pending?:ReadonlyArray<{readonly id:string;readonly runId:string;readonly kind:'input'|'confirmation'|'capability';readonly message:string;readonly detail?:unknown}>
   /** 派发时固定的空间授权，续跑时重新校验。 */
   readonly stores?:readonly AgentStoreGrant[]
   readonly id:string
   readonly parentSessionId:string
   /** 父逻辑任务身份，防止新任务隐式恢复旧子运行。 */
   readonly parentTaskId?:string
   readonly sessionId:string
   readonly profile:string
   readonly status:'running'|'waiting'|'completed'|'cancelled'|'failed'|'interrupted'|'needs_reconcile'
   readonly writes:readonly string[]
   readonly result?:{readonly sessionId:string;readonly id:string}
   /** 宿主发布的统一交付清单。 */
   readonly delivery?:ModelToolDelivery
   readonly error?:string
  }

  /** 在子任务收束后续跑：id 是子任务，其余同 AgentResume；materials 最多 32 条。 */
  interface AgentResumeRequest extends AgentResume {
    readonly id: string
  }

  /** 回答子任务的一条请求：requestId 取 job.pending 里那一项的 id，value 是任意 JSON 回答。 */
  interface AgentReplyInput {
    readonly id: string
    readonly requestId: string
    readonly value: unknown
  }

  /** 指定一个子任务：id 是 start 返回的 job.id。 */
  interface AgentJobTarget {
    readonly id: string
  }

  /** 给正在跑的子任务发引导：input 不能为空，它会抢占子任务还没采纳的那次模型回复。 */
  interface AgentSendInput {
    readonly id: string
    readonly input: string
  }

  /**
   * 共享给子任务的一个空间：read 是它能读和订阅的键前缀，write 是能写的前缀，必须落在 read 里。
   */
  interface AgentStoreGrant {
   /** 已存在的空间标识。 */
   readonly store:string
   /** 可读和订阅的键前缀。 */
   readonly read:readonly string[]
   /** 可写前缀，必须属于可读范围。 */
   readonly write:readonly string[]
  }

  /**
   * 交付清单：payload 是交付正文的引用，artifacts 是随附的证据、脚本与结果；status 为 completed 也只表示交付了，不等于验收通过。continuation 给出接着做的入口。
   */
  interface ModelToolDelivery {
    /** 清单自身的持久引用。 */
    readonly ref:{readonly sessionId:string;readonly id:string}
    /** 清单协议版本。 */
    readonly schemaVersion:1
    /** 工具种类，由实际宿主配置决定。 */
    readonly kind:string
    /** 实际生产者会话。 */
    readonly sessionId:string
    /** 交付所属的父逻辑任务。 */
    readonly parentTaskId?:string
    /** 完成状态，交付不等于领域验收通过。 */
    readonly status:'completed'|'partial'|'failed'|'needs-reconcile'
    /** 领域原始报告或补丁的引用。 */
    readonly payload:{readonly sessionId:string;readonly id:string}
    /** 发布时固定的证据与产物位置及原始对象指纹。 */
    readonly artifacts:ReadonlyArray<{readonly kind:'evidence'|'script'|'result';readonly ref:{readonly sessionId:string;readonly id:string};readonly objectId:string}>
    /** 本次清单没有附带的较早脚本数量。 */
    readonly omittedScripts:number
    /** 宿主签发的继续入口；参数仍须经过原能力验证。 */
    readonly continuation?:{readonly operation:string;readonly input:Readonly<Record<string,unknown>>}
  }

  /**
   * 续跑的内容：input 是新一阶段的目标与说明；给了 profile、writes、stores 就整份替换原来的（空数组表示全部收回），materials 追加新的原文引用。
   */
  interface AgentResume {
   /** 新一阶段的目标与说明。 */
   readonly input:string
   /** 可选替换为另一个宿主已配置的能力档案。 */
   readonly profile?:string
   /** 可选替换外部模块写入范围，空数组释放全部写入。 */
   readonly writes?:readonly string[]
   /** 可选替换共享空间授权，空数组撤回共享。 */
   readonly stores?:readonly AgentStoreGrant[]
   /** 本次继续附加的父会话材料。 */
   readonly materials?:ReadonlyArray<{readonly sessionId:string;readonly id:string}>
  }

  /** 列出能选的配置：名称、能力范围与预算；start/resume 用 name。
   */
  export function profiles(): Promise<AgentProfileInfo[]>

  /** 派发子任务，返回它的 job。
   */
  export function start(input: AgentStart): Promise<AgentJob>

  /** 子任务收束后接着跑同一个会话，已用预算保留；可以换配置、写入范围与共享空间，追加材料。
   */
  export function resume(input: AgentResumeRequest): Promise<AgentJob>

  /** 回答子任务在 job.pending 里的请求；回答不改变它的权限，要换环境得等它收束后 resume。
   */
  export function reply(input: AgentReplyInput): Promise<null>

  /** 读子任务的状态与结果引用。
   */
  export function status(input: AgentJobTarget): Promise<AgentJob>

  /** 等到子任务提问或结束；status 为 waiting 时 pending 里的请求要 reply。
   */
  export function wait(input: AgentJobTarget): Promise<AgentJob>

  /** 取消子任务并等它收束。
   */
  export function cancel(input: AgentJobTarget): Promise<AgentJob>

  /** 给正在跑的子任务发引导。
   */
  export function send(input: AgentSendInput): Promise<null>
}
