/**
 * GovernanceEpoch —— 唯一的缓存重建点（上下文治理 v2 · §4B）。
 *
 * 轮与轮之间投影严格只追加，前缀逐字不变，缓存全命中；降级只在 **epoch 边界**一次性应用，
 * 每 epoch 恰好一次缓存失效。命名取 `GovernanceEpoch`（设计 §11 裁决 4）——
 * `kernel/context-epoch.ts` 是请求陈旧守卫，与本模块无关。
 *
 * ## 一次 epoch 的固定顺序
 *  1. **触发判定**：投影占用 > `epochTriggerPercent × G`，或模型调用 `context:distill` 声明阶段完成。
 *  2. **反空转**：先估这次能省多少，低于 `minEpochSavingPercent` 就整个跳过并记事件 ——
 *     宁可带着高占用多跑一轮，也不为 3% 的收益炸掉整条 KV 缓存。
 *  3. **I2 产物落地**：把上一个 epoch 之后异步跑完的蒸馏产物应用进账本（B2 起）。放在最前是因为
 *     它已经付过钱了，先落地能让 I0 少动几条记录；也因为它是本 epoch 唯一"来自过去"的输入。
 *  4. **I0 逐出**（免费、可召回）：pending-EVICT → 陈旧可重取 → 尾外低锚密度。
 *  5. **I1 规则骨架**（免费、保关键场）：把被降级的叙事段落折成六字段骨架记录 append 进账本，
 *     成员迁 SUMMARIZED。
 *  6. 达标即停（`epochTargetPercent`），出 `GovernanceEpochReport`。
 *
 * **下一次蒸馏的规划不在这里**：本函数是纯的（同输入必同输出，可离线重放），而规划要问"有没有
 * 蒸馏器 / 有没有在飞的请求"这类会话运行态。规划归 `ContextGovernanceSession`，判据归 `distill.ts`。
 *
 * ## 三条硬不变量
 *  - **尾保护不设旁路**（§11 裁决 5）：尾保护窗口内的记录治理器永不选中。极端压力的出路是
 *    handoff，不是压尾——压掉模型正在用的最近两轮，省下的 token 会以更多轮次的形式还回来。
 *  - **治理类记录不进候选**：P6 的护栏（权限判决 / 用户纠正 / 安全规则）连 EXCERPT 都不降。
 *  - **摘要不折摘要**：I1/I2 产物是压缩的终点，再折一次就是有损叠有损。
 */
import { isEmpty } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import { anchorDensityPerKiloChar } from './anchors'
import type { ContextRecord, ContextResidency } from './ContextRecord'
import { estimateResidencyTokens, residentChars } from './ContextRecord'
import {
  type ContextDistillGateSignals,
  type ContextDistillProduct,
  type ContextDistillSkipReason,
  type ContextDistillTotals,
  createEmptyDistillTotals,
  isContextSummaryText,
} from './distill'
import type { ContextDistillInstrument, ContextGovernanceConfig } from './governanceConfig'
import type { ContextMigrationCause } from './migrationLog'
import { measureLedgerProjection } from './projection'
import type { ContextResidencyLedger } from './ResidencyLedger'
import { buildContextSkeleton } from './skeleton'

const log = logRuntime.tag('GovernanceEpoch')

/** epoch 未执行的原因。 */
export type GovernanceEpochSkipReason =
  /** 占用未到触发水位，且模型也没请求。 */
  | 'below-trigger'
  /** 反空转：预计节省低于 `minEpochSavingPercent`。 */
  | 'insufficient-saving'
  /** 无可降级候选（全在尾保护窗口 / 全是治理类 / 已降到底）。 */
  | 'no-candidates'

/**
 * epoch 报告里的 I2 分账。
 *
 * 分成"本 epoch 落地了什么"（epoch 纯函数填）与"本 epoch 规划了什么 + 会话累计"（会话填）两半：
 * 前者是账本事实，后者要问运行态。B3 电池两半都要读——接受率与拒收原因是 RQ3 的因变量。
 */
export interface GovernanceEpochDistillReport {
  mode: ContextDistillInstrument
  /** 本 epoch 应用的产物条数。 */
  appliedProducts: number
  /** 应用产物的器械分布：`distill` = 模型产物过验证，`skeleton` = 拒收后的规则回落。 */
  appliedByInstrument: { distill: number; skeleton: number }
  /** 跨代作废（账本重建后 id 已失效）而丢弃的产物条数。 */
  staleProducts: number
  /** 本 epoch 之后是否规划了新的蒸馏（会话填）。 */
  planned: boolean
  /** 未规划的原因（会话填）。 */
  skipReason: Nullable<ContextDistillSkipReason>
  /** adaptive 三判据取值（会话填；非 adaptive 档恒 passed）。 */
  gate: Nullable<ContextDistillGateSignals>
  /** 会话累计计数（会话填）。 */
  totals: ContextDistillTotals
}

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
  /** 器械分布：各档实际迁移了几条记录。 */
  byInstrument: Record<'evict' | 'skeleton' | 'distill', number>
  /** I2 分账。 */
  distill: GovernanceEpochDistillReport
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
  /** 模型是否调用了 `context:distill` 声明阶段边界。 */
  modelRequested?: LooseOptional<boolean>
  /** 耗时（毫秒）。调用方测量，本函数不取时钟。 */
  durationMs?: LooseOptional<number>
  /** 上一个 epoch 之后异步跑完、等本次边界落地的蒸馏产物（B2 起）。 */
  pendingDistills?: LooseOptional<readonly ContextDistillProduct[]>
  /** 当前账本代数：与产物代数不符即作废（重建后 id 会指向另一条消息）。 */
  ledgerGeneration?: LooseOptional<number>
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

/** 跑一次治理 epoch。纯粹由 (账本, 配置, 预算, 待落地产物) 决定 —— 同输入必同输出，可离线重放。 */
export function runGovernanceEpoch(input: RunGovernanceEpochInput): GovernanceEpochReport {
  const { ledger, config } = input
  const budgetTokens = Math.max(1, Math.floor(input.budgetTokens))
  const before = measureProjectedTokens(ledger, config, budgetTokens)
  const triggerTokens = (config.epochTriggerPercent / 100) * budgetTokens
  const targetTokens = (config.epochTargetPercent / 100) * budgetTokens
  const modelRequested = input.modelRequested === true
  const emptyInstruments = { evict: 0, skeleton: 0, distill: 0 }

  // 未触发时**产物不落地**：它们已经付过钱，可以再等一个边界；为了一份不着急的摘要炸掉整条
  // KV 缓存，正是 P4 要消灭的那种"随手重建"。调用方靠 {@link shouldOpenGovernanceEpoch} 提前
  // 问同一个问题来决定要不要把待落地产物交出来 —— 交出来又不落地就是把它们丢了。
  if (before <= triggerTokens && !modelRequested)
    return buildReport(input, budgetTokens, before, before, null, 'below-trigger', emptyInstruments)

  const trigger = modelRequested ? 'model-request' : 'watermark'

  // ① I2 产物落地（B2）：先落地已付费的摘要，I0 随后只需处理剩下的压力。
  const byInstrument = { evict: 0, skeleton: 0, distill: 0 }
  const distillOutcome = applyPendingDistills(input, budgetTokens)
  byInstrument.distill += distillOutcome.appliedByInstrument.distill
  byInstrument.skeleton += distillOutcome.appliedByInstrument.skeleton

  const candidates = collectCandidates(ledger, config, budgetTokens)
  if (isEmpty(candidates)) {
    const after = measureProjectedTokens(ledger, config, budgetTokens)
    return buildReport(
      input,
      budgetTokens,
      before,
      after,
      trigger,
      distillOutcome.appliedProducts > 0 ? null : 'no-candidates',
      byInstrument,
      distillOutcome
    )
  }

  // 反空转（[P1] clear_at_least 同款）：先按候选的可回收量估一次上界，不够就整个跳过。
  // 已落地的产物不参与这道闸——钱已经花了，收益该算进本次报告，不该被"预计还能省多少"否掉。
  const reclaimableTokens = estimateResidencyTokens(
    candidates.reduce((total, candidate) => total + candidate.reclaimableChars, 0)
  )
  const minSavingTokens = (config.minEpochSavingPercent / 100) * before
  if (reclaimableTokens < minSavingTokens) {
    const after = measureProjectedTokens(ledger, config, budgetTokens)
    return buildReport(
      input,
      budgetTokens,
      before,
      after,
      trigger,
      distillOutcome.appliedProducts > 0 ? null : 'insufficient-saving',
      byInstrument,
      distillOutcome
    )
  }

  // ② I0 逐出：机械、免费、可召回。
  const skeletonMembers: ContextRecord[] = []
  for (const candidate of candidates) {
    // 达标即停 —— 但**模型请求的 epoch 例外**：模型调 `context:distill` 就是在说"这批结果我已经
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

  // ③ I1 规则骨架：把被降级的叙事段折成六字段骨架 append 进账本（P1：提升/新知识都是追加）。
  if (config.instruments.skeleton && !isEmpty(skeletonMembers)) {
    const skeleton = buildContextSkeleton({ members: skeletonMembers, epoch: input.epoch })
    if (skeleton) {
      appendSummaryRecord(ledger, {
        text: skeleton.text,
        memberIds: skeleton.memberIds,
        at: input.at,
      })
      byInstrument.skeleton += skeleton.memberIds.length
    }
  }

  const after = measureProjectedTokens(ledger, config, budgetTokens)
  return buildReport(input, budgetTokens, before, after, trigger, null, byInstrument, distillOutcome)
}

interface AppliedDistillOutcome {
  appliedProducts: number
  appliedByInstrument: { distill: number; skeleton: number }
  staleProducts: number
}

/**
 * 把异步跑完的蒸馏产物落进账本。
 *
 * 三道过滤，一道都不能省：
 *  - **代数**：账本重建后 id 会被重新发号，跨代产物一律作废（张冠李戴比不摘要糟得多）；
 *  - **成员仍可降**：产物规划之后成员可能已被别的器械折掉，只对仍 INLINE/EXCERPT 的成员生效；
 *  - **尾保护**：尾保护是投影级硬不变量（裁决 5），蒸馏不设旁路。
 * 过滤后一个成员都不剩就整条丢弃 —— 一条谁也不代表的摘要只是白占预算。
 */
function applyPendingDistills(
  input: RunGovernanceEpochInput,
  budgetTokens: number
): AppliedDistillOutcome {
  const products = input.pendingDistills ?? []
  const outcome: AppliedDistillOutcome = {
    appliedProducts: 0,
    appliedByInstrument: { distill: 0, skeleton: 0 },
    staleProducts: 0,
  }
  if (isEmpty(products)) return outcome

  const { ledger, config } = input
  const generation = input.ledgerGeneration ?? 0
  const measurement = measureLedgerProjection({
    records: ledger.list(),
    residency: ledger.residencyVector(),
    budget: { tailProtectTurns: config.tailProtectTurns, budgetTokens },
  })

  for (const product of products) {
    if (product.generation !== generation) {
      outcome.staleProducts += 1
      continue
    }

    const members = product.memberIds
      .map((memberId) => ledger.get(memberId))
      .filter((record): record is ContextRecord => record !== null)
      .filter((record) => !measurement.tailProtectedRecordIds.has(record.id))
      .filter((record) => {
        const residency = ledger.residencyOf(record.id)
        return residency === 'INLINE' || residency === 'EXCERPT'
      })
    if (isEmpty(members)) {
      outcome.staleProducts += 1
      continue
    }

    appendSummaryRecord(ledger, {
      text: product.text,
      memberIds: members.map((member) => member.id),
      at: input.at,
    })
    const cause: ContextMigrationCause = product.instrument === 'distill' ? 'distill' : 'skeleton'
    for (const member of members) {
      const migrated = ledger.migrate(member.id, resolveEvictionTarget(member), cause, input.at)
      if (migrated.applied) outcome.appliedByInstrument[product.instrument] += 1
    }
    outcome.appliedProducts += 1
    log.info('蒸馏产物落地', {
      epoch: input.epoch,
      instrument: product.instrument,
      members: members.length,
      rejection: product.rejection,
    })
  }

  return outcome
}

/**
 * 追加摘要记录（I1 与 I2 共用）。
 *
 * `pinned: true` 不是特权而是常识：摘要是压缩的终点，再折一次就是有损叠有损；
 * `turn` 取最新轮，让它落在活动尾——刚生成的摘要正是模型下一轮最需要读到的东西。
 */
function appendSummaryRecord(
  ledger: ContextResidencyLedger,
  input: { text: string; memberIds: readonly string[]; at: number }
): void {
  ledger.append({
    kind: 'summary',
    message: { role: 'assistant', content: input.text },
    createdAt: input.at,
    turn: resolveLatestTurn(ledger),
    pinned: true,
    refetchable: false,
    memberIds: [...input.memberIds],
  })
}

/**
 * 本次 epoch 会不会真的开（触发判定，与 {@link runGovernanceEpoch} 的第一道闸同一份公式）。
 *
 * 单独导出是有具体原因的：待落地的蒸馏产物由调用方持有，交给 epoch 就等于交出所有权——
 * 若 epoch 当场以 `below-trigger` 返回，这批已经付过钱的产物就凭空消失了。调用方先问这一句，
 * 只在会开的时候才把产物交出来。把判据抄一份到调用方是不行的：两份触发公式迟早会漂。
 */
export function shouldOpenGovernanceEpoch(input: {
  ledger: ContextResidencyLedger
  config: ContextGovernanceConfig
  budgetTokens: number
  modelRequested?: LooseOptional<boolean>
}): boolean {
  if (input.modelRequested === true) return true

  const budgetTokens = Math.max(1, Math.floor(input.budgetTokens))
  const projected = measureProjectedTokens(input.ledger, input.config, budgetTokens)
  return projected > (input.config.epochTriggerPercent / 100) * budgetTokens
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
    const stale =
      record.refetchable && latestTurn - record.turn >= config.eviction.staleRefetchableTurnDistance
    const density = anchorDensityPerKiloChar(record.anchors.length, record.bytes.full)
    const lowDensity = density < config.eviction.lowAnchorDensityPerKiloChar

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
  return !(typeof content === 'string' && isContextSummaryText(content))
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
  distillOutcome: AppliedDistillOutcome = {
    appliedProducts: 0,
    appliedByInstrument: { distill: 0, skeleton: 0 },
    staleProducts: 0,
  }
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
    distill: {
      mode: input.config.instruments.distill,
      appliedProducts: distillOutcome.appliedProducts,
      appliedByInstrument: distillOutcome.appliedByInstrument,
      staleProducts: distillOutcome.staleProducts,
      planned: false,
      skipReason: null,
      gate: null,
      totals: createEmptyDistillTotals(),
    },
    durationMs: Math.max(0, Math.floor(input.durationMs ?? 0)),
    at: input.at,
  }
}

function toPercent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 1000) / 10
}
