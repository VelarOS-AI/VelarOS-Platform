import { isPresent } from '@velaros-ai/core'

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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
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
  if (!isPresent(value) || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0
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
