/**
 * 记忆后端窄端口（kernel-contract §15.7 裁决一 / mod-architecture-blueprint §九）。
 *
 * 这一层**只描述动词**，不假设后端是树、是文件还是向量库，也不下沉任何后端 schema：
 * 端口一旦假设某个后端形态，换后端就等于改核（「冻端口不冻 schema」的自然延伸）。
 *
 * 因此本文件：
 * - 只复用记忆产品自持的领域 DTO（Evidence / RecallItem / RecallOptions），不引入 SQLite、
 *   文件系统、向量库或 Kernel ABI 的任何类型；
 * - 把 §8 六动词面按「必备 / 可选」裁剪：capture + recall + inspect 是任何后端的入场券，
 *   erase / dream / govern 由后端按能力声明——缺席即 partial activation 的
 *   「没装就没有」（§15.7 裁决二），不新造降级词汇。
 *
 * capability token 与 kernel 模块注册**不在这里**：那是 mod 轴机制，住 `./adapter-kernel`
 * （方向铁律：adapter-kernel → 主干单向；主干不得反向依赖适配器）。
 */

import type {
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemorySourceEligibilityResult,
} from '../memory-tree/Types'

/** 端口内部的同步/异步兼容包装；不从 Kernel ABI 借类型，保持契约层零 kernel 依赖。 */
export type MemoryBackendAwaitable<T> = T | Promise<T>

/**
 * 后端在叠加语义里的角色（§九 9.2）。
 *
 * - `authority`：权威层，记忆内容的唯一真相住在这里（`memory-files`；迁移完成前是 `memory-tree`）。
 * - `derived-index`：派生索引，丢了能重建，不是权威内容（`memory-vector`）。
 *
 * TODO(批二)：`memory-vector` 以 `derived-index` 入场后，capture 走双写、recall 走并联
 * （语义命中 → 回权威后端取全文），卸载只删派生索引、权威内容零丢失。本批只落角色标注，
 * 不实改任何向量链路。
 */
export type MemoryBackendRole = 'authority' | 'derived-index'

/** 六动词面在窄端口上的投影。`capture` / `recall` / `inspect` 为必备，其余按能力声明。 */
export type MemoryBackendVerb =
  | 'capture'
  | 'recall'
  | 'inspect'
  | 'erase'
  | 'dream'
  | 'govern'

/** 后端自述。宿主诊断面与后端选择器只读它，不做 `instanceof` 之类的实现探测。 */
export interface MemoryBackendDescriptor {
  /** 后端短 id（`files` / `tree` / `vector`）。capability token 由它派生。 */
  readonly id: string
  readonly role: MemoryBackendRole
  readonly displayName: string
  /** 本后端实现了哪些动词；未列出的可选动词在实现上必须缺席（而不是抛 not-implemented）。 */
  readonly verbs: readonly MemoryBackendVerb[]
}

/**
 * 后端无关的健康读数。
 *
 * 刻意不复用 `MemoryTreeDiagnostics`：那是树后端的 schema（concept / episode / claim /
 * dreamRun / treeVersion），窄端口一旦返回它就等于把树形态钉进契约。树后端把自己的
 * 诊断投影到这里，文件后端填自己能诚实回答的三项。
 */
export interface MemoryBackendStats {
  readonly backendId: string
  /** 该后端当前持有的记忆条目数（树后端 = claim 数，文件后端 = 索引条目数）。 */
  readonly itemCount: number
  /** 还没被整理/索引的待处理量；无此概念的后端返回 0。 */
  readonly pendingCount: number
  /** 后端自有的单调版本号；无版本概念的后端返回 0。 */
  readonly version: number
  /** 后端私有读数，仅供诊断展示，禁止参与任何判定逻辑。 */
  readonly details?: Readonly<Record<string, number | string>>
}

export interface MemoryBackendCaptureBatchOptions {
  /**
   * 是否在本次写入后立即整理。无整理管线的后端忽略该项（写入即最终态）。
   */
  readonly consolidate?: boolean
}

/**
 * 一个可插拔的记忆后端。
 *
 * 实现方：`memory-files`（bundled 默认，权威层）、`memory-tree`（当前已接线的树后端）、
 * `memory-vector`（批二，派生索引）。消费方只有 `./adapter-kernel`——它经 capability token
 * 解析出后端，再把三端口接到宿主上。
 */
export interface MemoryStoreBackend {
  readonly descriptor: MemoryBackendDescriptor

  /** capture：单条证据入库。 */
  capture(input: MemoryEvidenceInput): MemoryBackendAwaitable<MemoryCaptureResult>

  /**
   * capture：批量证据入库。
   *
   * TODO(批二)：装了 `memory-vector` 后此处是**双写**接缝——权威后端先落地，派生索引再消费
   * 同一批 input；派生写失败不得回滚权威写入（派生物可重建）。
   */
  captureBatch(
    inputs: readonly MemoryEvidenceInput[],
    options?: MemoryBackendCaptureBatchOptions,
  ): MemoryBackendAwaitable<MemoryCaptureBatchResult>

  /**
   * recall：按查询召回。
   *
   * TODO(批二)：装了 `memory-vector` 后此处是**并联**接缝——语义命中回权威后端取全文，
   * 索引永远只持有指针与向量、不持有内容副本（否则「删索引」就变成了删内容）。
   */
  recall(
    query: string,
    options?: MemoryRecallOptions,
  ): MemoryBackendAwaitable<MemoryRecallItem[]>

  /** recall/inspect：按 id 读单条（`MemoryRecallItem.id`）。 */
  getItem(id: string): MemoryBackendAwaitable<Nullable<MemoryRecallItem>>

  /** inspect：后端无关健康读数。 */
  inspect(): MemoryBackendAwaitable<MemoryBackendStats>

  /**
   * erase：让一条记忆退出普通召回。
   *
   * 语义是**沉睡/归档**，不是物理删除——权威内容是用户资产（§九 9.4）。物理擦除走记忆产品
   * 自己的擦除动词，不从这个窄端口下发。
   */
  erase?(id: string): MemoryBackendAwaitable<MemoryForgetResult>

  /** dream：后台整理。无整理管线的后端不实现该动词。 */
  dream?(options: MemoryDreamRunOptions): MemoryBackendAwaitable<MemoryDreamRunResult>

  /** govern：按来源（会话）批量改变证据可用性。 */
  governSourceEligibility?(
    sourceId: string,
    state: MemoryEvidenceEligibilityState,
  ): MemoryBackendAwaitable<MemorySourceEligibilityResult>

  /** govern：按单条证据改变可用性。 */
  governEvidenceEligibility?(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState,
  ): MemoryBackendAwaitable<MemoryEvidenceEligibilityResult>
}

/** 后端是否声明并实现了某个可选动词（声明与实现必须一致，否则视为未实现）。 */
export function supportsMemoryBackendVerb(
  backend: MemoryStoreBackend,
  verb: MemoryBackendVerb,
): boolean {
  if (!backend.descriptor.verbs.includes(verb)) return false
  if (verb === 'erase') return typeof backend.erase === 'function'
  if (verb === 'dream') return typeof backend.dream === 'function'
  if (verb === 'govern') {
    return (
      typeof backend.governSourceEligibility === 'function'
      || typeof backend.governEvidenceEligibility === 'function'
    )
  }
  return true
}
