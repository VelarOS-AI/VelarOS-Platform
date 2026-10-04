import type { ProgramDescriptor } from '../../system/types/programs.js'

import type { ScriptRetention } from './results.js'

/** 领域登记的声明式纯快照计划；input 由指定提供者按固定合同核对。 */
export interface SnapshotObservationPlan {
  readonly provider: string
  readonly plan: string
  readonly input: unknown
}

/** 稳定快照观察的公开提交，不接受任意源码或额外运行参数。 */
export interface ScriptSnapshotObservation {
  readonly snapshot: SnapshotObservationPlan
}

/** 领域固定捕获操作的中立完整回执；value 是纯派生唯一可见的当前数据。 */
export interface SnapshotObservationCapture {
  readonly complete: true
  readonly providerId: string
  readonly fingerprint: string
  readonly checkedAt: string
  readonly readRequests: number
  readonly materialBytes: number
  readonly value: unknown
}

/** 纯值派生基线只在当前 RuntimeSession 内有效，重启重新捕获并派生。 */
export interface SnapshotObservationBaseline {
  readonly identity: string
  readonly sourceRef: string
  readonly fingerprint: string
  readonly providerId: string
  readonly executionId: string
  readonly resultRef: string
  readonly observedAt: string
}

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

/** 最新观察的采集决策；实际执行身份和原采集时刻保持不变。 */
export interface ObservationCollection {
  readonly status: 'collected' | 'reused' | 'paused'
  readonly reason: string
  readonly sourceRef: string
  readonly resultRef: string
  readonly executionId: string
  readonly observedAt: string
  readonly ageMs: number
  /** 本轮真实的范围/版本探测耗时；不冒充原脚本运行耗时。 */
  readonly probeMs: number
  /** 本轮真实授权捕获与纯派生分别记账；复用仍保留原派生 executionId/resultRef。 */
  readonly snapshot?: {
    readonly captureExecutionId: string
    readonly captureResultRef: string
    readonly checkedAt: string
    readonly captureMs: number
    readonly readRequests?: number
    readonly materialBytes?: number
    readonly deriveMs: number
    readonly derived: boolean
    readonly reused: boolean
  }
}

/** 一次 RuntimeSession 生命周期中的完整成功采集基线，重启后不恢复。 */
export interface ObservationReuseBaseline {
  readonly sourceRef: string
  readonly sourceHash: string
  readonly inputHash: string
  readonly scopeFingerprint: string
  readonly providerId: string
  readonly token: string
  readonly resultRef: string
  readonly executionId: string
  readonly observedAt: string
}

/** 有界宿主探测的结果，unknown 决定继续实际采集。 */
export type ObservationProbe =
  | (Pick<
      ObservationReuseBaseline,
      'sourceHash' | 'inputHash' | 'scopeFingerprint' | 'providerId' | 'token'
    > & { readonly kind: 'versioned' })
  | { readonly kind: 'unknown'; readonly reason: string }

/** 宿主固定的控制声明名称与流接收限额。 */
export interface ScriptProtocolOptions {
  /** 宿主选择面向标准 Node 的精简执行说明。 */
  readonly presentation?: 'node'
  /** 当前运行配置允许的控制声明。 */
  readonly allowed?: ReadonlyArray<'blobs' | 'observe' | 'execute' | 'done'>
  /** 文本协议一次执行的缺省可见期限，默认随历史封段退役；仍受展示预算约束。 */
  readonly defaultRetain?: ScriptRetention
  /** 每帧随机标记的前缀，只接受 @@ 后的字母数字下划线。 */
  readonly markerPrefix?: string
  /** 声明名称可配置，必须唯一且符合 JavaScript 标识符格式。 */
  readonly names?: Readonly<Partial<Record<'blobs' | 'observe' | 'execute' | 'done', string>>>
  /** 最大完整响应字符数。 */
  readonly maxChars?: number
  /** 单个控制头最大字符数。 */
  readonly maxHeaderChars?: number
  /** 控制段闭合后的连续空白上限；超过后终止响应，不自动重发。 */
  readonly maxIdleWhitespaceChars?: number
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
  /** 本任务的纯快照观察随阶段结束退役。 */
  readonly observationSnapshot?: boolean
  /** 快照计划所属的任务与授权重置水位；变化后整段计划退役。 */
  readonly observationSnapshotReset?: number
  /** 持久名称指向已归档不可变源码；历史版本由独立目录记录召回。 */
  readonly programCatalog?: Readonly<Record<string, ProgramDescriptor>>
  /** 目录别名所属的任务与授权重置水位。 */
  readonly programCatalogReset?: number
  /** 已接受的强制刷新身份；候选检查和协议修复不发布。 */
  readonly observationRefresh?: string
  readonly observationCollection?: ObservationCollection
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
  /** 本任务里显式释放的结果；它们已冻结的历史正文随下一次投影退成引用卡。 */
  readonly released?: readonly string[]
  readonly leases: ReadonlyArray<{
    readonly ref: string
    readonly sourceRef: string
    readonly executionId: string
    readonly expiresAfter: number
    readonly task?: boolean
    /** 结果随历史封段时释放，近期保留区内的结果继续进入下一段。 */
    readonly segment?: boolean
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
  /** 可信领域固定计划与提供者版本，不能从执行参数反向恢复。 */
  readonly snapshot?: SnapshotObservationPlan & { readonly revision: string }
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
  /** 已接受后请求下一正常业务轮真实采集；不恢复 paused。 */
  readonly refresh?: boolean
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
    /** 必需执行结果块的精确读取入口；原样完整输出返回页才形成来源证明。 */
    readonly read?: { readonly ref: string; readonly pointer: string }
  }>
  /** 有可召回的必需执行结果缺口时，说明分页交付的保守边界。 */
  readonly recall?: string
}
