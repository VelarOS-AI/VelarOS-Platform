/** 装配层稳定身份。 */
export const VelarosRuntimeContract = Object.freeze({
  /** 标准模块契约代际。 */
  schemaRevision: '5',
  /** 标准模块实例代际。 */
  generation: 1,
})
/** 按当前会话的自动保存记录再次执行代码，调用会获得新的执行身份。 */
export interface ScriptReferenceProgram {
  readonly sourceRef: string
  /** 在引用的同一底稿上定位，整组提交。 */
  readonly edits?:ReadonlyArray<{ readonly oldText:string; readonly newText:string; readonly module?:string }>
  readonly input?: unknown
  readonly blobs?: Readonly<Record<string,string>>
}
/** 对本轮已展示的观察底稿作精确修改，版本前提由宿主补齐。 */
export interface ScriptObservationEdit {
  readonly edits:ReadonlyArray<{ readonly oldText:string; readonly newText:string; readonly module?:string }>
  readonly input?:unknown
  readonly blobs?:Readonly<Record<string,string>>
}
/** 稳定观察版本登记回执，登记本身不运行程序。 */
export interface ObservationRegistration extends ScriptControlReceipt {
  readonly status:'updated'|'unchanged'
  readonly parentRef?:string
  readonly changes:ReadonlyArray<{readonly module?:string;readonly edits:number}>
  readonly sourceRef:string
  readonly effective:'next-model-turn'
  readonly executed:false
}
/** 结果在成功业务回合中的可见租约；续租不会执行代码。 */
export const ScriptLeaseLimits = Object.freeze({ defaultTurns:2, maxTurns:32, resultChars:12_000 })
/** 会话记录里的程序与结果引用，不保存第二份正文。 */
export interface ProgramLeaseState {
  readonly completedTurns:number
  readonly observation?:string
  readonly previousObservation?:string
  readonly pendingFrame?:string
  readonly pendingObservation?:string
  readonly leases:ReadonlyArray<{ readonly ref:string; readonly sourceRef:string; readonly executionId:string; readonly expiresAfter:number }>
}
/** 主干缺省预算，覆盖模型回合、请求投影和恢复材料。 */
export const VelarosRunLimits = Object.freeze({
  /** 一次用户运行最多推进的模型回合。 */
  turns: 64,
  /** 每次请求预留输出。 */
  outputTokens: 4_096,
  /** 编码和计数的独立误差余量。 */
  safetyTokens: 1_024,
  /** 单次构造活动投影的字符硬上限。 */
  projectionChars: 1_000_000,
  /** 恢复视图的原文摘录上限。 */
  recoveryChars: 6_000,
  /** 一次运行的墙钟上限。 */
  timeoutMs: 300_000,
})

/** 宿主重试同一请求时保留此身份，新执行必须使用新身份；不暴露到模型 schema。 */
export interface ScriptControlOptions {
  readonly callId:string
}
/** 不可变程序版本的谱系，草稿保留观察发布前提。 */
export interface ScriptProgramVersion {
  readonly sourceRef:string
  readonly parentRef?:string
  readonly baseObservation:string|null
  readonly kind:'observation'|'execution'|'draft'
}
/** 控制层检查与提交的可召回回执，执行结果仍使用 ScriptAct 原有结果。 */
export interface ScriptControlReceipt {
  readonly status:'updated'|'unchanged'|'rejected'|'prepared'|'completed'
  readonly sourceRef?:string
  readonly parentRef?:string
  readonly draftRef?:string
  readonly currentRef?:string|null
  readonly executionId?:string
  readonly resultRef?:string
  readonly effective?:'next-model-turn'
  readonly executed:boolean
  readonly code?:string
  readonly message?:string
  readonly editIndex?:number
  readonly diagnostics?:ReadonlyArray<{readonly code:number;readonly line:number;readonly column:number;readonly message:string;readonly file?:string;readonly frame?:string}>
  readonly changes?:ReadonlyArray<{readonly module?:string;readonly edits:number}>
}
/** 受信控制请求的稳定身份及活动观察前提，由宿主签发。 */
export interface ScriptControlIdentity {
  readonly id:string
  readonly fingerprint:string
  readonly expectedObservation:string|null
}
