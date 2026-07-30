// 域：provider 请求的**上下文纪元（epoch）**——「我拼装时看到的上下文，到真正发出去时还是不是同一份」
// 的乐观并发校验，外加把该纪元记进回合诊断。
//
// ## 为什么需要它
// 拼装一次请求（选历史、选工具、算预算）与真正把它发给 provider 之间隔着若干次 await。这期间用户可能
// 发了新消息、工具页可能换了、上下文可能被压缩过。发一份**基于陈旧上下文**的请求，症状是模型答非所问
// 或引用了已不存在的工具，而且不可复现。`claim()` 在拼装点领一个 (key, revision)，发送前
// `assertCurrent()` 复核；同一 key 再次 claim 会使前一次作废（**后来者赢**——新意图总是压过在途的旧请求）。
//
// ## 关键不变量
//  - **key 由 `scope ?? sessionId` + `phase` 组成**：子 Agent 传自己的 scope（threadId），因此父子并发
//    互不作废。把 scope 去掉会让并发子 Agent 互相踩废对方的请求。
//  - **revision 单调递增、只增不减**，`assertCurrent` 用严格相等而不是「大于等于」：任何一次插队都必须
//    让在途请求失效，不许放行。
//
// ## 纪元指纹的确定性（P7-2）
// `sortedUnique` 用码元序比较（`compareStableStrings`）而非 locale 相关比较，`normalize*` 把所有数值
// 钳到规范形态。判据：同一份上下文在不同机器/不同 locale 下必须算出**同一个纪元**，否则诊断会把
// 环境差异误报成「上下文变了」，而这类误报没有任何办法证伪。
//
import { isFiniteNumber, isPresent } from '@velaros-ai/core'

import { compareStableStrings } from '../agent/context/residency/determinism'

import type { ProviderTurnEventReducer } from './provider-events'

export type KernelContextEpochPhase = 'stream' | 'query'

export interface KernelContextUsageSnapshot {
  estimatedTokens: number
  tokenPercent: number
  usableContextWindow: number
}

export interface BuildKernelContextEpochInput {
  sessionId: string
  scope?: LooseOptional<string>
  phase: KernelContextEpochPhase
  turn?: LooseOptional<number>
  model: string
  messageCount: number
  availableToolNames: readonly string[]
  requestFingerprint?: unknown
  contextUsage: KernelContextUsageSnapshot
  createdAt?: number
}

export interface KernelContextEpoch {
  sessionId: string
  scope: Nullable<string>
  phase: KernelContextEpochPhase
  turn: Nullable<number>
  model: string
  messageCount: number
  availableToolNames: string[]
  requestFingerprint?: unknown
  contextUsage: KernelContextUsageSnapshot
  createdAt: number
}

export interface KernelContextEpochClaim {
  key: string
  revision: number
  epoch: KernelContextEpoch
}

export interface KernelContextEpochGuardLike {
  claim(epoch: KernelContextEpoch): KernelContextEpochClaim
  assertCurrent(claim: KernelContextEpochClaim): void
}

export class KernelContextEpochStaleError extends Error {
  public readonly code = 'KERNEL_CONTEXT_EPOCH_STALE'

  constructor(
    public readonly claim: KernelContextEpochClaim,
    public readonly currentRevision: number
  ) {
    super(
      `Stale provider request context epoch for ${claim.key}: claim revision ${claim.revision}, current revision ${currentRevision}.`
    )
    this.name = 'KernelContextEpochStaleError'
  }
}

export class KernelContextEpochGuard implements KernelContextEpochGuardLike {
  private readonly revisions = new Map<string, number>()

  public claim(epoch: KernelContextEpoch): KernelContextEpochClaim {
    const key = this.keyFor(epoch)
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    return { key, revision, epoch }
  }

  public isCurrent(claim: KernelContextEpochClaim): boolean {
    return this.revisions.get(claim.key) === claim.revision
  }

  public assertCurrent(claim: KernelContextEpochClaim): void {
    const currentRevision = this.revisions.get(claim.key) ?? 0
    if (currentRevision === claim.revision) return
    throw new KernelContextEpochStaleError(claim, currentRevision)
  }

  private keyFor(epoch: KernelContextEpoch): string {
    return [epoch.scope ?? epoch.sessionId, epoch.phase].join(':')
  }
}

export interface RecordKernelContextEpochDiagnosticOptions {
  claim?: LooseOptional<KernelContextEpochClaim>
  current?: LooseOptional<boolean>
}

/** P7-2：epoch 指纹里的清单序必须 locale 无关（码元序），否则同一份上下文跨机器判成"变了"。 */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    compareStableStrings
  )
}

function normalizeLabel(value: string, fallback: string): string {
  return value.trim() || fallback
}

function normalizeOptionalLabel(value: LooseOptional<string>): Nullable<string> {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function normalizeOptionalNonNegativeInteger(value: LooseOptional<number>): Nullable<number> {
  if (!isFiniteNumber(value) || value < 0) return null
  return Math.floor(value)
}

function normalizeNonNegativeInteger(value: number): number {
  if (!isFiniteNumber(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizePercent(value: number): number {
  if (!isFiniteNumber(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function buildKernelContextEpoch(input: BuildKernelContextEpochInput): KernelContextEpoch {
  const epoch: KernelContextEpoch = {
    sessionId: normalizeLabel(input.sessionId, 'unknown-session'),
    scope: normalizeOptionalLabel(input.scope),
    phase: input.phase,
    turn: normalizeOptionalNonNegativeInteger(input.turn),
    model: normalizeLabel(input.model, 'unknown-model'),
    messageCount: normalizeNonNegativeInteger(input.messageCount),
    availableToolNames: sortedUnique([...input.availableToolNames]),
    contextUsage: {
      estimatedTokens: normalizeNonNegativeInteger(input.contextUsage.estimatedTokens),
      tokenPercent: normalizePercent(input.contextUsage.tokenPercent),
      usableContextWindow: normalizeNonNegativeInteger(input.contextUsage.usableContextWindow),
    },
    createdAt: normalizeNonNegativeInteger(input.createdAt ?? Date.now()),
  }
  if (isPresent(input.requestFingerprint)) {
    epoch.requestFingerprint = input.requestFingerprint
  }
  return epoch
}

export function recordKernelContextEpochDiagnostic(
  reducer: ProviderTurnEventReducer,
  epoch: KernelContextEpoch,
  options: RecordKernelContextEpochDiagnosticOptions = {}
): void {
  reducer.apply({
    type: 'diagnostic',
    code: 'context-epoch',
    message: 'provider request context epoch recorded',
    details: {
      sessionId: epoch.sessionId,
      scope: epoch.scope,
      phase: epoch.phase,
      turn: epoch.turn,
      model: epoch.model,
      messageCount: epoch.messageCount,
      availableToolNames: epoch.availableToolNames,
      contextUsage: epoch.contextUsage,
      requestFingerprint: epoch.requestFingerprint,
      createdAt: epoch.createdAt,
      claimKey: options.claim?.key,
      revision: options.claim?.revision,
      current: options.current,
    },
  })
}
