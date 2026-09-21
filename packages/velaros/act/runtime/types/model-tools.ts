/** 模型工具共享的树形调度上限；所有后代都计入根任务总账。 */
export interface ModelToolPolicy {
  /** 业务调用树的最大深度，根会话为 0。 */
  readonly maxDepth?:number
  /** 一个父会话累计创建的模型工具会话数，恢复不重复占用。 */
  readonly maxChildren?:number
  /** 一个根会话累计创建的后代会话数。 */
  readonly maxSessions?:number
  /** 同时实际请求模型的最大数量，等待子结果不占用。 */
  readonly concurrency?:number
}

/** 模型工具的不可变归属与可恢复活动权。 */
export interface ModelToolBinding {
  readonly sessionId:string
  readonly parentSessionId:string
  readonly rootSessionId:string
  /** 根逻辑任务的配额代次，继续运行不能刷新。 */
  readonly rootTaskId?:string
  readonly kind:'search'|'agent'|'context'
  readonly depth:number
  readonly activationId:string
  readonly deadline:number
  readonly status:'active'|'closed'
}

/** 模型工具的调用资源档位；来源访问限额由具体工具补充。 */
export interface ModelToolModelProfile {
 readonly modelCalls:number
 readonly modelTokens:number
 readonly finalizationTokens:number
 readonly callTimeoutMs:number
 readonly finalizationMs:number
}

/** 模型工具真实调用与未测量情况。 */
export interface ModelToolModelUsage {
 readonly calls:number
 readonly reservedTokens:number
 readonly measuredCalls:number
 readonly inputTokens:number
 readonly outputTokens:number
 readonly finalUsed:boolean
 readonly reason:Nullable<string>
}

/** 整理支线的完整档位。 */
export interface ContextMaintenanceProfile extends ModelToolModelProfile {
 readonly timeoutMs:number
 readonly outputTokens:number
 readonly projectionChars:number
 readonly readChars:number
 readonly reads:number
}
