/**
 * 记忆后端窄端口（kernel-contract §15.7 裁决一 / mod-architecture-blueprint §九）。
 *
 * 这一层**只描述动词**，不假设后端是树、是文件还是向量库，也不下沉任何后端 schema：
 * 端口一旦假设某个后端形态，换后端就等于改核（「冻端口不冻 schema」的自然延伸）。
 *
 * 因此本文件：
 * - 只复用记忆产品自持的领域 DTO（Evidence / RecallItem / RecallOptions），不引入 SQLite、
 *   文件系统、向量库或 Kernel ABI 的任何类型；
 * - 动词表收敛为 **4 必备 + 2 能力扩展**（2026-08-05 产品裁决）：权威层后端必须声明
 *   `capture / recall / inspect / archive`，`dream / govern` 由后端按能力声明——缺席即
 *   partial activation 的「没装就没有」（§15.7 裁决二），不新造降级词汇。
 *
 * **为什么是 `archive` 而不是 §8 原本的 `erase`**：两个实现（files / tree）做的都是归档
 * ——退出普通召回、内容不删。名字叫 erase 会让设置页上的用户读到「记忆可以删」，而没有任何
 * 路径能物理删除一条记忆。「可证明擦除」是另一件事，它落地时必须自带工具与 UI 入口，
 * 在那之前不写进动词表（见 docs 的记忆产品需求清单）。
 *
 * capability token 与 kernel 模块注册**不在这里**：那是 mod 轴机制，住 `./adapter-kernel`
 * （方向铁律：adapter-kernel → 主干单向；主干不得反向依赖适配器）。
 */

import { isFunction } from '@velaros-ai/core'

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
 * 角色不只是标签，是**解析期的安全判据**：`resolveMemoryStoreBackend` 一律跳过 `derived-index`
 * ——派生索引不持内容，被当成权威层用等于静默丢数据。派生索引的动词面见 `./DerivedIndex`，
 * 两层怎么叠见 `./Layered`。
 */
export type MemoryBackendRole = 'authority' | 'derived-index'

/**
 * 窄端口动词面。
 *
 * `capture` / `recall` / `inspect` / `archive` 是**权威层**的入场券（见
 * {@link RequiredAuthorityMemoryVerbs}）；`dream` / `govern` 是能力扩展，由后端按实现声明。
 * 派生索引不是权威层，只声明自己真做的那几个（如 `recall` / `inspect` / `archive`）。
 */
export type MemoryBackendVerb =
  | 'capture'
  | 'recall'
  | 'inspect'
  | 'archive'
  | 'dream'
  | 'govern'

/**
 * 权威层必备动词。
 *
 * 少一个就不是一个能当真相层用的记忆后端：不能 capture 等于写不进，不能 recall 等于读不出，
 * 不能 inspect 等于诊断面永远是空的，不能 archive 等于用户没有任何撤回粒度。
 */
export const RequiredAuthorityMemoryVerbs: readonly MemoryBackendVerb[] = Object.freeze([
  'capture',
  'recall',
  'inspect',
  'archive',
])

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
   * **双写接缝**（§九 9.2，实现在 `./Layered`）：装了派生索引后，权威后端先落地，派生索引再
   * 消费落地**结果**（`MemoryEvidenceRecord` 才带得动权威层分配的指针）；派生写失败只记诊断，
   * 不回滚权威写入——派生物可重建，为一个索引回滚用户刚说的话是本末倒置。
   */
  captureBatch(
    inputs: readonly MemoryEvidenceInput[],
    options?: MemoryBackendCaptureBatchOptions,
  ): MemoryBackendAwaitable<MemoryCaptureBatchResult>

  /**
   * recall：按查询召回。
   *
   * **并联接缝**（§九 9.2，实现在 `./Layered`）：语义命中拿到的是指针，回权威后端 `getItem`
   * 取全文；索引永远只持有指针与向量、不持有内容副本（否则「删索引」就变成了删内容）。
   * 权威层认不出的指针即孤儿，当场剔除并清理。
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
   * archive：让一条记忆退出普通召回。
   *
   * 语义就是**归档**，不是物理删除——权威内容是用户资产（§九 9.4）。方法在类型上可选，是因为
   * 派生索引与本接口共用形状；**权威层必须实现它**（见 {@link RequiredAuthorityMemoryVerbs}）。
   */
  archive?(id: string): MemoryBackendAwaitable<MemoryForgetResult>

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
  if (verb === 'archive') return isFunction(backend.archive)
  if (verb === 'dream') return isFunction(backend.dream)
  if (verb === 'govern') return (
      isFunction(backend.governSourceEligibility)
      || isFunction(backend.governEvidenceEligibility)
    )
  return true
}

/**
 * 一个权威层后端缺了哪些必备动词（空数组 = 合格）。
 *
 * 解析器用它把「装了一个半成品权威层」变成启动期可见的诊断，而不是等用户按下归档才发现
 * 这个后端根本没有归档。
 */
export function listMissingAuthorityMemoryVerbs(
  backend: MemoryStoreBackend,
): readonly MemoryBackendVerb[] {
  return RequiredAuthorityMemoryVerbs.filter(
    (verb) => !supportsMemoryBackendVerb(backend, verb),
  )
}
