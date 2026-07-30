/**
 * GovernanceEpoch —— 唯一的缓存重建点（上下文治理 v2 · §4B）。
 *
 * 轮与轮之间投影严格只追加，前缀逐字不变，缓存全命中；降级只在 **epoch 边界**一次性应用，
 * 每 epoch 恰好一次缓存失效。命名取 `GovernanceEpoch`（设计 §11 裁决 4）——
 * `kernel/context-epoch.ts` 是请求陈旧守卫，与本模块无关。
 *
 * ## 一次 epoch 的固定顺序
 *  1. **触发判定**：投影占用 > `epochTriggerPercent × G`，或模型调用 `distill_context` 声明阶段完成。
 *  2. **反空转**：先估这次能省多少，低于 `minEpochSavingPercent` 就整个跳过并记事件 ——
 *     宁可带着高占用多跑一轮，也不为 3% 的收益炸掉整条 KV 缓存。
 *  3. **I0 逐出**（免费、可召回）：pending-EVICT → 陈旧可重取 → 尾外低锚密度。
 *  4. **I1 规则骨架**（免费、保关键场）：把被降级的叙事段落折成六字段骨架记录 append 进账本，
 *     成员迁 SUMMARIZED。
 *  5. **I2 LLM 蒸馏**：B1 未实现 —— 显式降级为骨架并在报告里标注，**不静默**。
 *  6. 达标即停（`epochTargetPercent`），出 `GovernanceEpochReport`。
 *
 * ## 三条硬不变量
 *  - **尾保护不设旁路**（§11 裁决 5）：尾保护窗口内的记录治理器永不选中。极端压力的出路是
 *    handoff，不是压尾——压掉模型正在用的最近两轮，省下的 token 会以更多轮次的形式还回来。
 *  - **治理类记录不进候选**：P6 的护栏（权限判决 / 用户纠正 / 安全规则）连 EXCERPT 都不降。
 *  - **骨架不折骨架**：I1 产物是压缩的终点，再折一次就是有损叠有损。
 */
import { isEmpty } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import { anchorDensityPerKiloChar } from './anchors'
import type { ContextRecord, ContextResidency } from './ContextRecord'
import { estimateResidencyTokens, residentChars } from './ContextRecord'
import type { ContextGovernanceConfig } from './governanceConfig'
import type { ContextMigrationCause } from './migrationLog'
import { measureLedgerProjection } from './projection'
import type { ContextResidencyLedger } from './ResidencyLedger'
import { buildContextSkeleton, isContextSkeletonText } from './skeleton'

const log = logRuntime.tag('GovernanceEpoch')

/** 认定"陈旧"的最小轮距：可重取记录至少落后当前轮这么多轮才进 I0 候选。 */
const StaleRefetchableTurnDistance = 2
/** 低锚密度阈值（每千字符锚点数）。低于此值的段落信息密度不足以占住全文位。 */
const LowAnchorDensityPerKiloChar = 2

/** epoch 未执行的原因。 */
export type GovernanceEpochSkipReason =
  /** 占用未到触发水位，且模型也没请求。 */
  | 'below-trigger'
  /** 反空转：预计节省低于 `minEpochSavingPercent`。 */
  | 'insufficient-saving'
  /** 无可降级候选（全在尾保护窗口 / 全是治理类 / 已降到底）。 */
  | 'no-candidates'

/** 每次 epoch 的完整账（P8 测量原生：直接进 scoreboard，也是离线重放的输入）。 */
export interface GovernanceEpochReport {
  epoch: number
  /** 是否真正应用了迁移。 */
  applied: boolean
  skipReason: Nullable<GovernanceEpochSkipReason>
  /** 触发来源：水位 / 模型请求。 */
  trigger: Nullable<'watermark' | 'model-request'>
  budgetTokens: number
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  /** 相对 epoch 前占用的节省率（百分比，一位小数）。 */
  savingPercent: number
  beforePercent: number
  afterPercent: number
  /** 是否达到 `epochTargetPercent`。 */
  reachedTarget: boolean
  migrationCount: number
  /** 器械分布：各档实际迁移了几条。 */
  byInstrument: Record<'evict' | 'skeleton' | 'distill', number>
  /** I2 被降级为骨架（B1 未实现蒸馏）时为 true —— 显式记录，不静默。 */
  distillDowngradedToSkeleton: boolean
  durationMs: number
  at: number
}

export interface RunGovernanceEpochInput {
  ledger: ContextResidencyLedger
  config: ContextGovernanceConfig
  /** 治理窗口 G（token）= min(模型窗口, cap)。 */
  budgetTokens: number
  /** 本次 epoch 号（从 1 起，由会话维护）。 */
  epoch: number
  /** 时刻（迁移事件的 `at`）。epoch 自身不取时钟。 */
  at: number
  /** 模型是否调用了 `distill_context` 声明阶段边界。 */
  modelRequested?: LooseOptional<boolean>
  /** 耗时（毫秒）。调用方测量，本函数不取时钟。 */
  durationMs?: LooseOptional<number>
}

/** 候选来源档（越靠前越机械、越该先降）。 */
type EpochCandidateTier = 'superseded' | 'stale-refetchable' | 'low-density'

interface EpochCandidate {
  record: ContextRecord
  residency: ContextResidency
  tier: EpochCandidateTier
  /** 准入期已被同工具同目标的新快照取代（迁移因果记 `superseded` 而非 `evict`）。 */
  superseded: boolean
  /** 排序分：越小越先降。 */
  score: number
  /** 当前驻留态下可省的字符数（降到 EVICTED / SUMMARIZED 的净收益）。 */
  reclaimableChars: number
}

/** 跑一次治理 epoch。纯粹由 (账本, 配置, 预算) 决定 —— 同输入必同输出，可离线重放。 */
export function runGovernanceEpoch(input: RunGovernanceEpochInput): GovernanceEpochReport {
  const { ledger, config } = input
  const budgetTokens = Math.max(1, Math.floor(input.budgetTokens))
  const before = measureProjectedTokens(ledger, config, budgetTokens)
  const triggerTokens = (config.epochTriggerPercent / 100) * budgetTokens
  const targetTokens = (config.epochTargetPercent / 100) * budgetTokens
  const modelRequested = input.modelRequested === true

  if (before <= triggerTokens && !modelRequested)
    return buildReport(input, budgetTokens, before, before, null, 'below-trigger', {
      evict: 0,
      skeleton: 0,
      distill: 0,
    })

  const trigger = modelRequested ? 'model-request' : 'watermark'
  const candidates = collectCandidates(ledger, config, budgetTokens)
  if (isEmpty(candidates))
    return buildReport(input, budgetTokens, before, before, trigger, 'no-candidates', {
      evict: 0,
      skeleton: 0,
      distill: 0,
    })

  // 反空转（[P1] clear_at_least 同款）：先按候选的可回收量估一次上界，不够就整个跳过。
  const reclaimableTokens = estimateResidencyTokens(
    candidates.reduce((total, candidate) => total + candidate.reclaimableChars, 0)
  )
  const minSavingTokens = (config.minEpochSavingPercent / 100) * before
  if (reclaimableTokens < minSavingTokens)
    return buildReport(input, budgetTokens, before, before, trigger, 'insufficient-saving', {
      evict: 0,
      skeleton: 0,
      distill: 0,
    })

  const byInstrument = { evict: 0, skeleton: 0, distill: 0 }

  // ① I0 逐出：机械、免费、可召回。
  const skeletonMembers: ContextRecord[] = []
  for (const candidate of candidates) {
    // 达标即停 —— 但**模型请求的 epoch 例外**：模型调 `distill_context` 就是在说"这批结果我已经
    // 消化完了"，那些被取代/陈旧的快照该当场折掉，不该因为"现在还没胀到目标线"而留着。
    // 例外只覆盖免费且可召回的前两档（superseded / stale）；低锚密度那档仍只在真有压力时才动。
    const belowTarget = measureProjectedTokens(ledger, config, budgetTokens) <= targetTokens
    if (belowTarget && !(modelRequested && candidate.tier !== 'low-density')) break

    const target = resolveEvictionTarget(candidate.record)
    const cause: ContextMigrationCause = candidate.superseded ? 'superseded' : 'evict'
    const outcome = ledger.migrate(candidate.record.id, target, cause, input.at)
    if (!outcome.applied) continue

    byInstrument.evict += 1
    if (isSkeletonMember(candidate.record)) skeletonMembers.push(candidate.record)
  }

  // ② I1 规则骨架：把被降级的叙事段折成六字段骨架 append 进账本（P1：提升/新知识都是追加）。
  if (config.instruments.skeleton && !isEmpty(skeletonMembers)) {
    const skeleton = buildContextSkeleton({ members: skeletonMembers, epoch: input.epoch })
    if (skeleton) {
      ledger.append({
        kind: 'summary',
        message: { role: 'assistant', content: skeleton.text },
        createdAt: input.at,
        turn: resolveLatestTurn(ledger),
        pinned: true,
        refetchable: false,
        memberIds: skeleton.memberIds,
      })
      byInstrument.skeleton = skeleton.memberIds.length
    }
  }

  // ③ I2 LLM 蒸馏：B1 不实现。配置档存在时**显式**降级为骨架并记账，不静默吞掉配置意图。
  const distillDowngradedToSkeleton = config.instruments.distill !== 'off'
  if (distillDowngradedToSkeleton) {
    log.warn('I2 蒸馏档已配置但 B1 未实现，本次 epoch 显式降级为 I1 规则骨架', {
      epoch: input.epoch,
      distill: config.instruments.distill,
      skeletonEnabled: config.instruments.skeleton,
    })
  }

  const after = measureProjectedTokens(ledger, config, budgetTokens)
  return buildReport(input, budgetTokens, before, after, trigger, null, byInstrument, {
    distillDowngradedToSkeleton,
  })
}

/** 当前投影占用（token）。与投影共用同一条尾保护规则。 */
export function measureProjectedTokens(
  ledger: ContextResidencyLedger,
  config: ContextGovernanceConfig,
  budgetTokens: number
): number {
  return measureLedgerProjection({
    records: ledger.list(),
    residency: ledger.residencyVector(),
    budget: { tailProtectTurns: config.tailProtectTurns, budgetTokens },
  }).projectedTokens
}

/**
 * 候选集与排序。
 *
 * 三档来源按"越机械越先"排：pending-EVICT（准入期已判定被新快照取代）→ 陈旧可重取（同一个
 * url/path 再跑一次就回来）→ 尾外低锚密度（信息密度不足以占住全文位）。faultCount 高者
 * **缓降**：被反复召回说明模型真的需要它，降了也会以 fault 的形式还回来（§4C 的回学闭环）。
 */
function collectCandidates(
  ledger: ContextResidencyLedger,
  config: ContextGovernanceConfig,
  budgetTokens: number
): EpochCandidate[] {
  const records = ledger.list()
  const residencyVector = ledger.residencyVector()
  const measurement = measureLedgerProjection({
    records,
    residency: residencyVector,
    budget: { tailProtectTurns: config.tailProtectTurns, budgetTokens },
  })
  const pendingEvictIds = new Set(ledger.pendingEvictions())
  const latestTurn = resolveLatestTurnOf(records)
  const candidates: EpochCandidate[] = []

  for (const record of records) {
    if (measurement.tailProtectedRecordIds.has(record.id)) continue
    if (!isDegradable(record)) continue

    const residency = residencyVector.get(record.id) ?? record.admittedResidency
    if (residency !== 'INLINE' && residency !== 'EXCERPT') continue

    const superseded = pendingEvictIds.has(record.id)
    const stale = record.refetchable && latestTurn - record.turn >= StaleRefetchableTurnDistance
    const density = anchorDensityPerKiloChar(record.anchors.length, record.bytes.full)
    const lowDensity = density < LowAnchorDensityPerKiloChar

    if (!superseded && !stale && !lowDensity) continue

    const tier: EpochCandidateTier = superseded
      ? 'superseded'
      : stale
        ? 'stale-refetchable'
        : 'low-density'
    const tierScore = superseded ? 0 : stale ? 100 : 200
    const faultPenalty = ledger.faultCountOf(record.id) * 50
    const reclaimableChars = Math.max(
      0,
      residentChars(record, residency) - residentChars(record, resolveEvictionTarget(record))
    )

    candidates.push({
      record,
      residency,
      tier,
      superseded,
      score: tierScore + faultPenalty + Math.round(density),
      reclaimableChars,
    })
  }

  // 同分按账本序（老的先降）—— 排序确定，离线重放才可复现。
  return candidates.sort(
    (left, right) => left.score - right.score || left.record.seq - right.record.seq
  )
}

/**
 * 可降级判据。
 *
 * 三类记录一律不进候选：
 *  - `governance`（P6 护栏，连 EXCERPT 都不降；system 消息降级还会破坏角色语义）；
 *  - `summary`（I1/I2 产物，压缩的终点，再折就是有损叠有损）；
 *  - 已是骨架文本的 assistant 消息（跨 epoch 复用同一判据，防止上一轮骨架被这一轮当叙事折掉）。
 */
function isDegradable(record: ContextRecord): boolean {
  if (record.kind === 'governance' || record.kind === 'summary') return false
  if (record.pinned) return false
  if (!record.message) return false

  const content = record.message.content
  return !(typeof content === 'string' && isContextSkeletonText(content))
}

/**
 * 逐出落点。工具类记录降到 EVICTED（墓碑仍带召回指针，配对结构保留）；叙事类降到 SUMMARIZED
 * （真正从投影里消失，由骨架代表）。
 */
function resolveEvictionTarget(record: ContextRecord): ContextResidency {
  return record.kind === 'tool-result' || record.kind === 'tool-call' ? 'EVICTED' : 'SUMMARIZED'
}

/** 该记录是否值得进骨架：只有叙事面（user / assistant）有可抽的六字段素材。 */
function isSkeletonMember(record: ContextRecord): boolean {
  return record.kind === 'user' || record.kind === 'assistant'
}

function resolveLatestTurn(ledger: ContextResidencyLedger): number {
  return resolveLatestTurnOf(ledger.list())
}

function resolveLatestTurnOf(records: readonly ContextRecord[]): number {
  return records.reduce((latest, record) => Math.max(latest, record.turn), 0)
}

function buildReport(
  input: RunGovernanceEpochInput,
  budgetTokens: number,
  beforeTokens: number,
  afterTokens: number,
  trigger: Nullable<'watermark' | 'model-request'>,
  skipReason: Nullable<GovernanceEpochSkipReason>,
  byInstrument: Record<'evict' | 'skeleton' | 'distill', number>,
  extra: { distillDowngradedToSkeleton?: boolean } = {}
): GovernanceEpochReport {
  const savedTokens = Math.max(0, beforeTokens - afterTokens)
  const migrationCount = byInstrument.evict + byInstrument.skeleton + byInstrument.distill

  return {
    epoch: input.epoch,
    applied: migrationCount > 0,
    skipReason,
    trigger,
    budgetTokens,
    beforeTokens,
    afterTokens,
    savedTokens,
    savingPercent: toPercent(savedTokens, beforeTokens),
    beforePercent: toPercent(beforeTokens, budgetTokens),
    afterPercent: toPercent(afterTokens, budgetTokens),
    reachedTarget: afterTokens <= (input.config.epochTargetPercent / 100) * budgetTokens,
    migrationCount,
    byInstrument,
    distillDowngradedToSkeleton: extra.distillDowngradedToSkeleton === true,
    durationMs: Math.max(0, Math.floor(input.durationMs ?? 0)),
    at: input.at,
  }
}

function toPercent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 1000) / 10
}
