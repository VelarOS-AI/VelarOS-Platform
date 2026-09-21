import type {ModelToolBinding} from './model-tools.js'


/** 会话内的原始记录，正文只按总字符预算截取，完整内容可经 context.read 召回。 */
export interface ActTraceRecord {
  readonly ref:{readonly sessionId:string;readonly id:string}
  readonly sequence:number
  readonly title:string
  readonly chars:number
  readonly body:Nullable<string>
  readonly truncated:boolean
  readonly sources:ReadonlyArray<{readonly sessionId:string;readonly id:string}>
}

/** 一次实际模型请求及其执行证据；缺失部分明确列入 gaps。 */
export interface ActTurnTrace {
  readonly sessionId:string
  readonly turnId:string
  readonly runId:string
  readonly turn:number
  readonly repair:number
  /** 请求审计包含 ProviderRequestCompiler 封存的消息与指纹。 */
  readonly request:ActTraceRecord
  /** 已接受或部分收到的模型原文。 */
  readonly response:Nullable<ActTraceRecord>
  /** 完整协议判定、解析结果或拒绝原因。 */
  readonly decision:Nullable<ActTraceRecord>
  /** 调度身份及对应源码、控制回执、结果、租约变化。 */
  readonly records:readonly ActTraceRecord[]
  /** Kernel 权威调用记录的有界 JSON；空数组不证明世界没有发生效果。 */
  readonly invocations:ReadonlyArray<{readonly id:string;readonly executionId:string;readonly chars:number;readonly body:string;readonly truncated:boolean}>
  /** 同一 run 的下一请求，可继续查询其真实视图和差量。 */
  readonly nextTurnId:Nullable<string>
  /** 元数据快照版本；追踪期间执行可能仍在推进。 */
  readonly snapshotVersion:number
  readonly gaps:readonly string[]
}


/** 宿主分页读取某个根任务及其支线，正文预算为本页共用。 */
export interface ActTraceQuery {
 /** 省略时读取根会话；支线必须有该根的持久归属记录。 */
 readonly sessionId?:string
 /** 仅列出此记录序号之后的模型请求。 */
 readonly after?:number
 /** 一页最多请求数，默认 8，上限 32。 */
 readonly limit?:number
 /** 一页正文字符上限，默认一百万，上限八百万。 */
 readonly maxChars?:number
}
/** 持久追踪可在支线关闭后读取，活动回合需重读以取得后续回执。 */
export interface ActTracePage {
 /** 宿主请求的根会话。 */
 readonly rootSessionId:string
 /** 本页实际读取的会话。 */
 readonly sessionId:string
 /** 根当前任务的已登记支线，用于后续按 sessionId 读取。 */
 readonly branches:readonly ModelToolBinding[]
 /** 按请求记录顺序返回。 */
 readonly turns:readonly ActTurnTrace[]
 /** 有后续请求时的分页游标，否则为 null。 */
 readonly nextAfter:Nullable<number>
 /** 读取开始时的会话快照代次。 */
 readonly snapshotVersion:Nullable<number>
}
