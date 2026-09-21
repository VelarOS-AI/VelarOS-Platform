/** 子任务的稳定身份与真实生命周期，结果通过原文引用返回。 */
export interface AgentJob {
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
/** 子任务只选择宿主配置，不接受模型自行注入能力或驱动。 */
export interface AgentStart {
 /** 显式共享的空间与范围；省略则不共享。 */
 readonly stores?:readonly AgentStoreGrant[]
 readonly task:string
 readonly profile:string
 readonly writes?:readonly string[]
 readonly materials?:ReadonlyArray<{readonly sessionId:string;readonly id:string}>
}

/** 所有模型工具的宿主交付清单；领域正文、证据和代码仍按原始引用读取。 */
export interface ModelToolDelivery {
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

/** 随子任务持久化的共享空间授权；实际范围由父运行时核验。 */
export interface AgentStoreGrant {
 /** 已存在的空间标识。 */
 readonly store:string
 /** 可读和订阅的键前缀。 */
 readonly read:readonly string[]
 /** 可写前缀，必须属于可读范围。 */
 readonly write:readonly string[]
}

/** 在同一子会话的安全边界更新环境并继续；已使用预算保持。 */
export interface AgentResume {
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
