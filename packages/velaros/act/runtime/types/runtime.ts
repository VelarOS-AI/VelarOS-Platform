import type { ScriptRetention } from './results.js'

/** 按当前会话的自动保存记录再次执行代码，调用会获得新的执行身份。 */
export interface ScriptReferenceProgram {
  readonly sourceRef: string
  /** 在引用的同一底稿上定位，整组提交。 */
  readonly edits?: ReadonlyArray<{
    readonly oldText: string
    readonly newText: string
    readonly module?: string
  }>
  readonly input?: unknown
  readonly blobs?: Readonly<Record<string, string>>
}

/** 对本轮已展示的观察底稿作精确修改，版本前提由宿主补齐。 */
export interface ScriptObservationEdit {
  readonly edits: ReadonlyArray<{
    readonly oldText: string
    readonly newText: string
    readonly module?: string
  }>
  readonly input?: unknown
  readonly blobs?: Readonly<Record<string, string>>
}

/** 稳定观察版本登记回执，登记本身不运行程序。 */
export interface ObservationRegistration extends ScriptControlReceipt {
  readonly status: 'updated' | 'unchanged'
  readonly parentRef?: string
  readonly changes: ReadonlyArray<{ readonly module?: string; readonly edits: number }>
  readonly sourceRef: string
  readonly effective: 'next-model-turn'
  readonly executed: false
}

/** 宿主固定的控制声明名称与流接收限额。 */
export interface ScriptProtocolOptions {
  /** 当前运行配置允许的控制声明。 */
  readonly allowed?: ReadonlyArray<'blobs' | 'observe' | 'execute' | 'done'>
  /** 一次执行的缺省可见期限。 */
  readonly defaultRetain?: ScriptRetention
  /** 每帧随机标记的前缀，只接受 @@ 后的字母数字下划线。 */
  readonly markerPrefix?: string
  /** 声明名称可配置，必须唯一且符合 JavaScript 标识符格式。 */
  readonly names?: Readonly<Partial<Record<'blobs' | 'observe' | 'execute' | 'done', string>>>
  /** 最大完整响应字符数。 */
  readonly maxChars?: number
  /** 单个控制头最大字符数。 */
  readonly maxHeaderChars?: number
  /** 一份响应允许的有载荷声明数量。 */
  readonly maxBlocks?: number
  /** 会话后台执行并发上限，所有任务共享。 */
  readonly concurrency?: number
}

/** 控制头在纯语法解析后的字面量数据。 */
export interface ScriptDeclaration {
  readonly name: string
  readonly args: readonly unknown[]
}

/** 会话记录里的程序与结果引用，不保存第二份正文。 */
export interface ProgramLeaseState {
  readonly completedTurns: number
  /** 新进入租约集合的结果代次，区分新到达材料与容量省略。 */
  readonly resultsRevision?: number
  readonly observation?: string
  /** 持久观察健康记录；旧结果只按原采集时间展示。 */
  readonly health?: {
    readonly sourceRef: string
    readonly status: 'healthy' | 'degraded' | 'paused'
    readonly failures: number
    readonly lastResult: string
    readonly lastSuccess?: string
    readonly reason?: string
  }
  readonly previousObservation?: string
  /** 上轮实际送达的源码版本，与采集版本分别记录。 */
  readonly previousObservationSource?: string
  /** 当前帧展示的源码版本。 */
  readonly pendingObservationSource?: string
  /** 上一次实际送达的逐块展示基线。 */
  readonly previousOutputPresentation?: ReadonlyArray<{
    readonly key: string
    readonly representation: string
    readonly policyHash: string
    readonly contentHash: string
  }>
  /** 当前待确认帧的逐块展示状态。 */
  readonly pendingOutputPresentation?: ReadonlyArray<{
    readonly key: string
    readonly representation: string
    readonly policyHash: string
    readonly contentHash: string
  }>
  readonly pendingFrame?: string
  readonly pendingVisible?: readonly string[]
  readonly previousVisible?: readonly string[]
  readonly pendingObservation?: string
  readonly pendingDelivered?: ReadonlyArray<{ readonly ref: string; readonly leaseId: string }>
  readonly jobs?: readonly ScriptJob[]
  readonly leases: ReadonlyArray<{
    readonly ref: string
    readonly sourceRef: string
    readonly executionId: string
    readonly expiresAfter: number
    readonly task?: boolean
    readonly leaseId?: string
  }>
}

/** 在现有会话记录中保存的后台任务事实。 */
export interface ScriptJob {
  readonly executionId: string
  readonly sourceRef: string
  readonly batchId: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly resultRef?: string
}

/** 一次提交的宿主选项。 */
export interface RuntimeSubmitOptions {
  /**
   * 按这段话建立目标（目标模式）：在本次运行第一次读取目标之前写入，首帧就能看到。
   * 当前目标还在推进、暂停或受阻时保持原目标；超出目标长度上限的部分截掉，全文照常作为本次输入。
   */
  readonly goal?: string
}

/** 宿主重试同一请求时保留此身份，新执行必须使用新身份；不暴露到模型 schema。 */
export interface ScriptControlOptions {
  readonly callId: string
}

/** 不可变程序版本的谱系，草稿保留观察发布前提。 */
export interface ScriptProgramVersion {
  readonly sourceRef: string
  readonly parentRef?: string
  readonly baseObservation: Nullable<string>
  readonly kind: 'observation' | 'execution' | 'draft'
  /** 本版本只更新展示规则，没有重跑采集。 */
  readonly presentationOnly?: boolean
  /** 自动整理的可见理由。 */
  readonly reason?: string
}

/** 控制层检查与提交的可召回回执，执行结果仍使用 ScriptAct 原有结果。 */
export interface ScriptControlReceipt {
  readonly status: 'updated' | 'unchanged' | 'cleared' | 'rejected' | 'prepared' | 'completed'
  readonly sourceRef?: string
  readonly parentRef?: string
  readonly draftRef?: string
  readonly currentRef?: LooseOptional<string>
  readonly executionId?: string
  readonly resultRef?: string
  readonly effective?: 'next-model-turn'
  readonly executed: boolean
  readonly code?: string
  readonly message?: string
  readonly editIndex?: number
  readonly diagnostics?: ReadonlyArray<{
    readonly code: number
    readonly line: number
    readonly column: number
    readonly message: string
    readonly file?: string
    readonly frame?: string
  }>
  readonly changes?: ReadonlyArray<{ readonly module?: string; readonly edits: number }>
}

/** 受信控制请求的稳定身份及活动观察前提，由宿主签发。 */
export interface ScriptControlIdentity {
  readonly id: string
  readonly fingerprint: string
  readonly expectedObservation: Nullable<string>
}

/** 实际投递帧里收尾要看的缺口：required 输出没完整可见的那几项。读到的资源版本不再记在这里（ADR 0025）。 */
export interface ScriptDecisionBasis {
  readonly frameId: string
  /** 必须完整可见的输出缺口；引用、摘要不满足 required。 */
  readonly missing?: ReadonlyArray<{
    readonly key: string
    readonly ref: Nullable<string>
    readonly reason: string
  }>
}
