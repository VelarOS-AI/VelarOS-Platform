/**
 * I2 LLM 蒸馏（上下文治理 v2 · §4B 第三档器械，唯一花钱的一档）。
 *
 * 本文件只装**纯的那一半**：选段、判据、验证、产物拼装。真正发请求的异步调度归
 * `ContextDistillRunner`，模型解析归宿主注入的 {@link ContextDistiller} 端口。这样切是因为
 * B4 要拿真实账本做离线重放——只要规划与验证是纯函数，重放里就能用录好的模型输出复现同一条决策链。
 *
 * ## 三条设计判决
 *
 * ① **蒸馏永不内联阻塞回合**。v1 的语义压缩挂在循环里等一次模型调用，是它的死因之一。v2 里
 *    epoch 同步只跑 I0+I1，蒸馏在 epoch **之后**规划、异步跑，产物排队等**下一个 epoch 边界**
 *    才应用——既符合 P4「每 epoch 恰好一次缓存重建」，也正是调研里 sleep-time compute 的形态。
 *
 * ② **骨架永远是保底，蒸馏只能升级不能致损**。所以：(a) 只有机械器械跑完仍达不到目标水位时才
 *    规划蒸馏（段落本来就非折不可，只是用什么摘要去代表它）；(b) 锚点验证不过 / 超时 / 异常
 *    一律回落同一批成员的 I1 骨架；(c) 即便验证通过，产物里的**锚点行与召回指针行仍由规则机械
 *    生成**——模型只负责叙事正文那一段，硬事实不交给它记。
 *
 * ③ **档位即实验臂**（论文 RQ3）。`off` = 从不花这一跳；`aux`/`main` = 只要机械器械没达标就花
 *    （A2-distill-always）；`adaptive` = 再过三道判据（缺口够大 / 段落价值密度够高 / 预计节省
 *    ≥ 调用成本的若干倍）才花（A3，主臂）。三档共用同一条代码路径，差异只在 {@link resolveDistillGate}。
 */
import { isArray, isEmpty, isNonBlankString, isRecord, isString, toNullable } from '@velaros-ai/core'

import {
  anchorDensityPerKiloChar,
  normalizeAnchorText,
  toContextAnchorTexts,
} from './anchors'
import type { ContextRecord, ContextResidency } from './ContextRecord'
import { estimateResidencyTokens } from './ContextRecord'
import type { ContextDistillInstrument, ContextGovernanceConfig } from './governanceConfig'
import { residentChars } from './projection'
import type { ContextResidencyLedger } from './ResidencyLedger'
import {
  buildContextSkeleton,
  collectContextAnchorUnion,
  isContextSkeletonText,
  renderContextAnchorLine,
  renderContextRecallLine,
} from './skeleton'

/** 蒸馏产物的文本头（与骨架头同形，便于转录与"别再折摘要"判据识别）。 */
const DistillHeaderPrefix = '[context-distill'

/** 目标提示的字符上限：它进的是模型提示词，不是上下文。 */
const MaxGoalHintChars = 400

/** 蒸馏产物文本的识别谓词。 */
export function isContextDistillText(value: string): boolean {
  return value.trimStart().startsWith(DistillHeaderPrefix)
}

/** 摘要类文本（I1 骨架或 I2 蒸馏产物）的识别谓词——治理器据此不折摘要。 */
export function isContextSummaryText(value: string): boolean {
  return isContextSkeletonText(value) || isContextDistillText(value)
}

/**
 * 蒸馏器端口：宿主注入的一次辅助模型调用。
 *
 * 返回**摘要正文**即可——锚点行与召回行由本模块机械补齐，调用方不必也不该自己拼。
 * 失败一律抛错（调度器会算成拒收并回落骨架），不要返回空串装成功。
 */
export type ContextDistiller = (input: ContextDistillInput) => Promise<string>

export interface ContextDistillInput {
  /** 待蒸馏的成员记录（账本序，最老的在前）。 */
  members: readonly ContextRecord[]
  /** 当前任务目标（目标条件化压缩 [R6]）；账本里没有 user 记录时为 null。 */
  goalHint: Nullable<string>
  /** 期望正文字符上限。 */
  targetChars: number
  /**
   * 整段输入的字符预算（规划期切段用的同一个数）。
   *
   * 宿主按它给成员分配预览额度。写死一个 per-message 常量会让"规划期按 48K 切段"与"实际只喂
   * 2400 字符/条"两套预算互不知情：单条超大记录独占一段时，模型看到的不足全文的 5%，却被要求
   * 逐字保留它没看过的锚点（审计 V14）。
   */
  maxInputChars: number
  /** 必须逐字保留的锚点：提示词里明示，产物按此逐条验证。 */
  requiredAnchors: readonly string[]
  /** 档位（宿主据此选辅助模型还是主模型）。 */
  mode: ContextDistillInstrument
  /** 会话标识（宿主的模型请求遥测上下文）；无身份编译时为 null。 */
  sessionId: Nullable<string>
  /** 超时/中止信号。端口实现应当透传给模型请求。 */
  signal?: LooseOptional<AbortSignal>
}

/** 规划出的一次蒸馏请求（交给异步调度器）。 */
export interface ContextDistillRequest {
  /** 规划它的 epoch 号。 */
  epoch: number
  /**
   * 账本代数。账本一旦整本重建（历史前缀分叉）代数就 +1，跨代产物一律作废——
   * 记录 id 是按序号生成的，重建后同一个 id 会指向**另一条消息**，不设代数护栏就会张冠李戴。
   */
  generation: number
  members: readonly ContextRecord[]
  memberIds: string[]
  requiredAnchors: string[]
  goalHint: Nullable<string>
  targetChars: number
  /** 段落当前占用的字符数（收益估算的分子）。 */
  segmentChars: number
  /** 每次请求省下的 token（经常性收益）。 */
  savingTokensPerRequest: number
  /** 按摊销窗口折算后的总节省 token。 */
  estimatedSavingTokens: number
  /** 一次蒸馏调用的 token 成本（输入 + 输出，一次性）。 */
  estimatedCostTokens: number
}

/** 蒸馏未发生的原因（进 epoch 报告，B3 电池消费）。 */
export type ContextDistillSkipReason =
  /** 档位 off（A0/A1 臂）。 */
  | 'off'
  /** 宿主没注入蒸馏器（headless / 测试 / 模型不可用）。 */
  | 'no-distiller'
  /** 并发上限 1：上一次还没落地。 */
  | 'in-flight'
  /** 待应用产物已达上限。 */
  | 'pending-full'
  /** 机械器械已达标——没到"非花这一跳不可"的地步。 */
  | 'target-reached'
  /** 没有够格的叙事段（全在尾保护 / 全是摘要 / 太短）。 */
  | 'no-segment'
  /** adaptive 判据未过。 */
  | 'not-worth'

/** adaptive 三判据的取值（进报告：RQ3 的机制本体必须可观测）。 */
export interface ContextDistillGateSignals {
  /** ① 机械器械跑完后距目标水位还差几个百分点（占 G）。 */
  shortfallPercent: number
  /** ② 段落叙事字符量。 */
  narrativeChars: number
  /** ② 段落锚点密度（每千字符）。 */
  anchorDensityPerKiloChar: number
  /** ③ 摊销后的预计节省 token / 一次调用的成本 token。 */
  savingToCostRatio: number
  passed: boolean
}

export interface ContextDistillPlan {
  requests: ContextDistillRequest[]
  skipReason: Nullable<ContextDistillSkipReason>
  gate: Nullable<ContextDistillGateSignals>
}

/** 蒸馏产物：已验证（或已回落骨架）的摘要记录素材，等下一个 epoch 边界应用。 */
export interface ContextDistillProduct {
  epoch: number
  generation: number
  memberIds: string[]
  text: string
  /** `distill` = 模型产物过了锚点验证；`skeleton` = 拒收/超时/异常后的规则回落。 */
  instrument: 'distill' | 'skeleton'
  rejection: Nullable<ContextDistillRejection>
}

/** 模型产物被拒的原因。 */
export type ContextDistillRejection =
  /** 产物为空 / 全空白。 */
  | 'empty'
  /** 锚点验证不过：成员记录的关键场没有逐字出现。 */
  | 'missing-anchors'
  /** 产物不比原段落短——摘要不省钱就不叫摘要。 */
  | 'not-smaller'
  /** 超时。 */
  | 'timeout'
  /** 端口抛错。 */
  | 'error'

export interface ContextDistillTotals {
  requested: number
  accepted: number
  rejected: number
  timedOut: number
  failed: number
  /** 跨代作废的产物数（账本重建时丢弃）。 */
  staleDropped: number
}

export function createEmptyDistillTotals(): ContextDistillTotals {
  return { requested: 0, accepted: 0, rejected: 0, timedOut: 0, failed: 0, staleDropped: 0 }
}

export interface PlanContextDistillationInput {
  ledger: ContextResidencyLedger
  config: ContextGovernanceConfig
  budgetTokens: number
  /** 机械器械跑完后的投影占用（token）。 */
  projectedTokens: number
  /** 尾保护窗口内的记录 id（治理器永不选中，蒸馏同样不碰）。 */
  tailProtectedRecordIds: ReadonlySet<string>
  epoch: number
  generation: number
  /** 宿主是否注入了蒸馏器。 */
  hasDistiller: boolean
  /** 是否已有在跑/排队的请求（并发 1）。 */
  busy: boolean
  /** 已排队等应用的产物数。 */
  pendingCount: number
  maxPendingProducts: number
}

/**
 * 规划下一次蒸馏。
 *
 * **纯函数**：只读账本与配置，不改任何状态、不取时钟。给同一份账本与配置必给同一份计划，
 * 所以 B4 的离线重放能原地复现"当时为什么（不）花这一跳"。
 */
export function planContextDistillation(input: PlanContextDistillationInput): ContextDistillPlan {
  const { config } = input
  const mode = config.instruments.distill
  if (mode === 'off') return emptyPlan('off')
  if (!input.hasDistiller) return emptyPlan('no-distiller')
  if (input.busy) return emptyPlan('in-flight')
  if (input.pendingCount >= input.maxPendingProducts) return emptyPlan('pending-full')

  // 机械器械已达标 = 这一跳没有非花不可的理由。三档共用这条前置：它同时保证了"拒收回落骨架"
  // 是安全的——段落本来就非折不可，回落只是换个（更差但免费的）摘要去代表它。
  const targetTokens = (config.epochTargetPercent / 100) * input.budgetTokens
  if (input.projectedTokens <= targetTokens) return emptyPlan('target-reached')

  const segments = collectDistillSegments(input)
  if (isEmpty(segments)) return emptyPlan('no-segment')

  const goalHint = resolveGoalHint(input.ledger)
  const shortfallPercent = toPercent(input.projectedTokens - targetTokens, input.budgetTokens)
  const requests = segments.map((segment) =>
    buildDistillRequest(segment, {
      config,
      epoch: input.epoch,
      generation: input.generation,
      goalHint,
    })
  )

  const head = requests[0]!
  const gate = resolveDistillGate(mode, config, {
    shortfallPercent,
    narrativeChars: head.segmentChars,
    anchorDensityPerKiloChar: anchorDensityPerKiloChar(
      countSegmentAnchors(head.members),
      head.segmentChars
    ),
    savingToCostRatio: resolveSavingToCostRatio(head),
  })
  if (!gate.passed) return { requests: [], skipReason: 'not-worth', gate }

  return { requests, skipReason: null, gate }
}

/**
 * adaptive 判据（论文 RQ3 的机制本体）。
 *
 * `aux` / `main` 恒过——它们的"判据"就是前置的 `target-reached`（机械器械没达标就花）。
 * `adaptive` 再加三道，全部读配置，一个阈值都不写死在逻辑里（B4 扫参对象）。
 */
export function resolveDistillGate(
  mode: ContextDistillInstrument,
  config: ContextGovernanceConfig,
  signals: Omit<ContextDistillGateSignals, 'passed'>
): ContextDistillGateSignals {
  if (mode !== 'adaptive') return { ...signals, passed: true }

  const policy = config.distillation.adaptive
  const passed =
    signals.shortfallPercent >= policy.minShortfallPercent &&
    signals.narrativeChars >= policy.minNarrativeChars &&
    signals.anchorDensityPerKiloChar <= policy.maxAnchorDensityPerKiloChar &&
    signals.savingToCostRatio >= policy.minSavingToCostRatio

  return { ...signals, passed }
}

/**
 * 模型产物 → 可应用的产物记录。
 *
 * 验证不过时返回 `instrument: 'skeleton'` 的回落产物（同一批成员的 I1 骨架），永不返回 null：
 * 段落已被判定非折不可，"什么都不给"比"给个规则摘要"更糟。
 */
export function buildDistillProduct(input: {
  request: ContextDistillRequest
  /** 端口返回的原始文本；缺席表示超时/异常。 */
  rawText: Nullable<string>
  /** 超时/异常的直接原因。 */
  failure?: LooseOptional<ContextDistillRejection>
}): ContextDistillProduct {
  const { request } = input
  const failure = toNullable(input.failure)
  const body = failure ? '' : extractDistilledBody(input.rawText ?? '')
  // 机械锚点行渲染的就是 `requiredAnchors` 本身：要求模型逐字复现 24 条、产物里却只机械补 16 条
  // （两个常量各定各的）是两头不讨好——多出来的那几条既抬高拒收概率又没进最终产物。
  const text = [
    `${DistillHeaderPrefix} epoch=${request.epoch} members=${request.members.length}]`,
    body,
    renderContextAnchorLine(request.requiredAnchors, request.requiredAnchors.length),
    renderContextRecallLine(request.members),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
  // "更短"这道验证必须量**装配后**的产物：机械补上的锚点行与召回行也要进上下文，只量正文
  // 会漏掉"正文刚好合格、加上锚点行反而更长"这一档——那种产物落地是净负收益。
  const rejection = failure ?? validateDistilledBody(body, request, text.length)

  if (rejection) return buildSkeletonFallbackProduct(request, rejection)

  return {
    epoch: request.epoch,
    generation: request.generation,
    memberIds: [...request.memberIds],
    text,
    instrument: 'distill',
    rejection: null,
  }
}

/** 回落产物：同一批成员的 I1 规则骨架（零 LLM、零成本、锚点逐字在内）。 */
export function buildSkeletonFallbackProduct(
  request: ContextDistillRequest,
  rejection: ContextDistillRejection
): ContextDistillProduct {
  const skeleton = buildContextSkeleton({
    members: request.members,
    epoch: request.epoch,
    // 回落骨架的锚点行与被拒产物同口径：两者代表同一批成员，条数不该因为走了哪条路而变。
    maxAnchors: request.requiredAnchors.length,
  })
  return {
    epoch: request.epoch,
    generation: request.generation,
    memberIds: [...request.memberIds],
    // 骨架抽不出任何字段时（纯寒暄段）给一行墓碑式说明：成员仍要折，但不能假装总结过。
    text: skeleton?.text ?? `[context-skeleton epoch=${request.epoch} members=${request.members.length}]`,
    instrument: 'skeleton',
    rejection,
  }
}

/**
 * 产物验证。
 *
 * 锚点用**记录元数据**逐条核对（v2 相对 v1 的实质升级：v1 是对规则摘要再跑一遍正则，等于用
 * 一个有损产物去校验另一个有损产物；v2 的锚点在准入期就抽好存在记录上，是更强的单源）。
 */
export function validateDistilledBody(
  body: string,
  request: Pick<ContextDistillRequest, 'requiredAnchors' | 'segmentChars'>,
  /** 装配后产物的字符数（含机械补的锚点行与召回行）；缺省按正文本身量。 */
  assembledChars: number = body.length
): Nullable<ContextDistillRejection> {
  if (!body.trim()) return 'empty'
  if (assembledChars >= request.segmentChars) return 'not-smaller'
  if (!isEmpty(collectMissingAnchors(body, request.requiredAnchors))) return 'missing-anchors'

  return null
}

/** 缺失锚点清单（归一后逐字比对：剥引号、压空白，与 v1 同口径）。 */
export function collectMissingAnchors(body: string, requiredAnchors: readonly string[]): string[] {
  if (isEmpty(requiredAnchors)) return []

  const haystack = normalizeAnchorText(body)
  return requiredAnchors.filter((anchor) => !haystack.includes(normalizeAnchorText(anchor)))
}

/**
 * 从端口返回文本里取出摘要正文。
 *
 * 容错沿用 v1 的解析链（剥 ```` ``` ```` 围栏 → 试 JSON → 退回纯文本）：辅助模型经常不听话地
 * 裹一层 Markdown 或返回 `{"summary": …}`，因为一个围栏就丢掉整次调用不划算。
 */
export function extractDistilledBody(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const fenceMatch = trimmed.match(/^```(?:json|markdown|md)?\s*([\S\s]*?)\s*```$/i)
  const unfenced = fenceMatch?.[1]?.trim() ?? trimmed
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return unfenced

  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1))
    if (isRecord(parsed) && isNonBlankString(parsed.summary)) return parsed.summary.trim()
  } catch {
    // arch-guard:silent-catch-ok 模型没按 JSON 返回是常态，退回纯文本是设计中的兼容路径。
  }

  return unfenced
}

interface DistillSegment {
  members: ContextRecord[]
  chars: number
}

/**
 * 选段。
 *
 * 只收**叙事面**（user / assistant）：工具结果要么已被 EXCERPT 摘录、要么正被 I0 逐出，正文另有
 * 句柄或墓碑；再让 LLM 抄一遍等于同一份内容在上下文里留三份影子。而且工具记录降级只能变结构
 * 墓碑（配对不可破），本来就轮不到蒸馏发言。
 *
 * 按账本序从**最老**开始装，装满 `maxInputChars` 就切一段，最多 `maxSegmentsPerEpoch` 段——
 * 最老的最该折，也最不可能是模型正在用的那一段。
 */
function collectDistillSegments(input: PlanContextDistillationInput): DistillSegment[] {
  const { config } = input
  const residency = input.ledger.residencyVector()
  const segments: DistillSegment[] = []
  let current: DistillSegment = { members: [], chars: 0 }

  for (const record of input.ledger.list()) {
    if (segments.length >= config.distillation.maxSegmentsPerEpoch) break
    if (input.tailProtectedRecordIds.has(record.id)) continue
    if (!isDistillable(record, residency.get(record.id) ?? record.admittedResidency)) continue

    const chars = residentChars(record, residency.get(record.id) ?? record.admittedResidency)
    if (chars <= 0) continue

    if (current.chars + chars > config.distillation.maxInputChars && !isEmpty(current.members)) {
      segments.push(current)
      current = { members: [], chars: 0 }
      if (segments.length >= config.distillation.maxSegmentsPerEpoch) break
    }

    current.members.push(record)
    current.chars += chars
  }

  if (!isEmpty(current.members) && segments.length < config.distillation.maxSegmentsPerEpoch) {
    segments.push(current)
  }

  return segments.filter((segment) => segment.chars >= config.distillation.minSegmentChars)
}

/**
 * 可蒸馏判据：叙事面、未降级、非护栏、非摘要（摘要是压缩的终点，再折就是有损叠有损）。
 * `pinned` 在这里与 `GovernanceEpoch.isDegradable` 同义 —— **完全免疫**，不是"降到 EXCERPT 为止"。
 */
function isDistillable(record: ContextRecord, residency: ContextResidency): boolean {
  if (record.kind !== 'user' && record.kind !== 'assistant') return false
  if (record.pinned || !record.message) return false
  if (residency !== 'INLINE' && residency !== 'EXCERPT') return false

  const content = record.message.content
  return !(isString(content) && isContextSummaryText(content))
}

function buildDistillRequest(
  segment: DistillSegment,
  context: {
    config: ContextGovernanceConfig
    epoch: number
    generation: number
    goalHint: Nullable<string>
  }
): ContextDistillRequest {
  const { config } = context
  // 并集已按类别优先序（路径 → 命令 → 标识符 → 数字）排好，截断因此先丢数字锚而不是先丢路径。
  const requiredAnchors = toContextAnchorTexts(collectContextAnchorUnion(segment.members)).slice(
    0,
    config.distillation.maxRequiredAnchors
  )
  const targetChars = config.distillation.targetChars
  // 两笔账不同量纲，必须分开算：
  //  - 收益 = （段落全文 - 产物）× 摊销窗口 —— 折下去之后**每一次请求**都少发这些 token；
  //  - 成本 = 一次调用的输入 + 输出 —— 只付一次，且输入里本来就装着整个段落。
  // 不摊销直接比，比值恒 < 1（成本 ≥ 段落本身），判据会退化成"永远不值得"。
  const savingTokensPerRequest = estimateResidencyTokens(Math.max(0, segment.chars - targetChars))
  const estimatedCostTokens =
    estimateResidencyTokens(Math.min(segment.chars, config.distillation.maxInputChars)) +
    estimateResidencyTokens(targetChars)

  return {
    epoch: context.epoch,
    generation: context.generation,
    members: segment.members,
    memberIds: segment.members.map((member) => member.id),
    requiredAnchors,
    goalHint: context.goalHint,
    targetChars,
    segmentChars: segment.chars,
    savingTokensPerRequest,
    estimatedSavingTokens: savingTokensPerRequest * config.distillation.adaptive.amortizationRequests,
    estimatedCostTokens,
  }
}

function resolveSavingToCostRatio(request: ContextDistillRequest): number {
  if (request.estimatedCostTokens <= 0) return 0
  return Math.round((request.estimatedSavingTokens / request.estimatedCostTokens) * 100) / 100
}

function countSegmentAnchors(members: readonly ContextRecord[]): number {
  const seen = new Set<string>()
  for (const member of members) {
    for (const anchor of member.anchors) {
      const normalized = normalizeAnchorText(anchor.text)
      if (normalized) seen.add(normalized)
    }
  }
  return seen.size
}

/**
 * 目标提示：账本里**最后一条** user 记录的开头。
 *
 * 取最后一条而不是第一条：条件化压缩要对齐的是"现在在干什么"，不是这个会话最初为什么开始。
 */
function resolveGoalHint(ledger: ContextResidencyLedger): Nullable<string> {
  const records = ledger.list()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record.kind !== 'user') continue

    const content = record.message?.content
    const text = isString(content) ? content : readTextParts(content)
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized) return normalized.slice(0, MaxGoalHintChars)
  }

  return null
}

function readTextParts(content: unknown): string {
  if (!isArray(content)) return ''

  return content
    .map((part) => (isRecord(part) && isString(part.text) ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function emptyPlan(skipReason: ContextDistillSkipReason): ContextDistillPlan {
  return { requests: [], skipReason, gate: null }
}

function toPercent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 1000) / 10
}
