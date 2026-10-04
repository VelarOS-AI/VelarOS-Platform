/**
 * 子任务的稳定身份与真实生命周期，结果通过原文引用返回。
 * @AgentView
 * 一个子任务：status 为 waiting 时 pending 里有它在等的请求，用 reply 回答；结束后 result 是结果原文的引用，delivery 是交付清单，失败时 error 说明原因。
 */
export interface AgentJob {
  /** 已落盘且仍待处理的子运行请求，答案通过 reply 绑定原运行。 */
  readonly pending?: ReadonlyArray<{
    readonly id: string
    readonly runId: string
    readonly kind: 'input' | 'confirmation' | 'capability'
    readonly message: string
    readonly detail?: unknown
  }>
  readonly id: string
  readonly parentSessionId: string
  /** 父逻辑任务身份，防止新任务隐式恢复旧子运行。 */
  readonly parentTaskId?: string
  readonly sessionId: string
  readonly profile: string
  readonly status: 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  readonly result?: { readonly sessionId: string; readonly id: string }
  /** 宿主发布的统一交付清单。 */
  readonly delivery?: ModelToolDelivery
  readonly error?: string
}
/**
 * 子任务只选择宿主配置，不接受模型自行注入能力或驱动；能做的事与父任务一样。
 * @AgentView
 * 派发子任务：task 写清楚要它完成什么；它直接继承你的能力与权限（模块、写入、共享空间），不用另外声明。
 * task 写清分工、约束和交付要求，并行编辑时明确负责的文件。Node 子任务自动收到有界的父任务原始输入，环境中的 parentTask 文件提供全文与附件，摘录有缺口时按需补读。
 * profile 可省，省略就用宿主给的第一个配置（profiles() 里能看到）；materials 把已有原文引用复制给它（最多 32 条）。
 */
export interface AgentStart {
  readonly task: string
  readonly profile?: string
  readonly materials?: ReadonlyArray<{ readonly sessionId: string; readonly id: string }>
}

/**
 * 所有模型工具的宿主交付清单；领域正文、证据和代码仍按原始引用读取。
 * @AgentView
 * 交付清单：payload 是交付正文的引用，artifacts 是随附的证据、脚本与结果；status 为 completed 也只表示交付了，不等于验收通过。continuation 给出接着做的入口。
 */
export interface ModelToolDelivery {
  /** 清单自身的持久引用。 */
  readonly ref: { readonly sessionId: string; readonly id: string }
  /** 清单协议版本。 */
  readonly schemaVersion: 1
  /** 工具种类，由实际宿主配置决定。 */
  readonly kind: string
  /** 实际生产者会话。 */
  readonly sessionId: string
  /** 交付所属的父逻辑任务。 */
  readonly parentTaskId?: string
  /** 完成状态，交付不等于领域验收通过。 */
  readonly status: 'completed' | 'partial' | 'failed'
  /** 领域原始报告或补丁的引用。 */
  readonly payload: { readonly sessionId: string; readonly id: string }
  /** 发布时固定的证据与产物位置及原始对象指纹。 */
  readonly artifacts: ReadonlyArray<{
    readonly kind: 'evidence' | 'script' | 'result'
    readonly ref: { readonly sessionId: string; readonly id: string }
    readonly objectId: string
  }>
  /** 本次清单没有附带的较早脚本数量。 */
  readonly omittedScripts: number
  /** 宿主签发的继续入口；参数仍须经过原能力验证。 */
  readonly continuation?: {
    readonly operation: string
    readonly input: Readonly<Record<string, unknown>>
  }
}

/**
 * 在同一子会话里继续；已使用预算保持，能力与权限按父任务此刻的重新继承。
 * @AgentView
 * 续跑的内容：input 是新一阶段的目标与说明；给了 profile 就换成那个配置，materials 追加新的原文引用；Node 子任务的父输入摘录与 parentTask 文件刷新到本次派发时的输入。
 */
export interface AgentResume {
  /** 新一阶段的目标与说明。 */
  readonly input: string
  /** 可选替换为另一个宿主已配置的能力档案。 */
  readonly profile?: string
  /** 本次继续附加的父会话材料。 */
  readonly materials?: ReadonlyArray<{ readonly sessionId: string; readonly id: string }>
}
