import { createHash, createHmac } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { parse as parsePath } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { MemoryKeyringStoreV2 } from './storage/Keyring'
import { canonicalStringifyV2 } from './DiffChain'

const MatchKeyPrefixV2 = 'm2:'
const StableKeyPrefixV2 = 'k2:'
const ClaimGroupKeyPrefixV2 = 'g2:'
const GovernanceMatchKeyPrefixV2 = 'd2:'
const DreamFingerprintPrefixV2 = 'f2:'
const MatchKeyDomainV2 = 'velaros.memory.match-key.v2'
const StableKeyDomainV2 = 'velaros.memory.stable-key.v2'
const DreamFingerprintDomainV2 = 'velaros.memory.dream-input.v2'

export const MemoryMatchKeyPurposesV2 = Object.freeze([
  'concept-name',
  'concept-alias',
  'scope',
  'source-ref',
] as const)

export type MemoryMatchKeyPurposeV2 = (typeof MemoryMatchKeyPurposesV2)[number]

export interface MemoryDreamFingerprintInputV2 {
  readonly frontierBefore: number
  readonly evidenceIds: readonly string[]
  readonly modelProfile: {
    readonly provider: string | null
    readonly model: string | null
  }
  readonly pipelineVersion: number
}

export interface MemoryConceptStableKeyInputV2 {
  readonly conceptType: string
  readonly scopeType: string
  readonly scopeId: string
  readonly discriminator: string
}

export interface MemoryEpisodeStableKeyInputV2 {
  readonly scopeType: string
  readonly scopeId: string
  readonly conceptStableKey: string
  readonly episodeRoot: string
  readonly phase: string
}

export interface MemoryClaimStableKeyInputV2 {
  readonly conceptStableKey: string
  readonly predicate: string
  readonly title: string
  readonly content: string
}

export interface MemoryClaimGovernanceMatchInputV2 {
  readonly conceptStableKey: string
  readonly predicate: string
  readonly content: string
}

/**
 * §4.2 identity-text 的唯一实现。这里刻意使用 toLowerCase 而不是 locale 版本。
 */
export function normalizeIdentityTextV2(value: string): string {
  assertStringV2(value, 'identity text')
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
}

/**
 * 采集边界的路径真值收敛：先由文件系统解析符号链接与权威大小写，再进入密码学归一化。
 */
export function canonicalizeWorkspacePathV2(value: string): string {
  assertNonEmptyStringV2(value, 'workspace path')
  let canonical: string
  try {
    canonical = realpathSync.native(value)
  } catch (error) {
    throw new AppError(
      'VALIDATION',
      'workspace path 无法解析为文件系统权威路径。',
      error,
      { value }
    )
  }
  return normalizeCanonicalPathV2(canonical)
}

export function normalizeCanonicalPathV2(value: string): string {
  assertNonEmptyStringV2(value, 'canonical workspace path')
  const normalized = value.normalize('NFC')
  const root = parsePath(normalized).root
  if (normalized === root) return normalized
  return normalized.replace(/[\\/]{1}$/, '')
}

export function normalizeOriginV2(value: string): string {
  assertNonEmptyStringV2(value, 'origin')
  let origin: string
  try {
    origin = new URL(value).origin
  } catch (error) {
    throw new AppError('VALIDATION', 'site origin 不是合法 URL。', error)
  }
  if (origin === 'null') {
    throw new AppError('VALIDATION', 'opaque origin 不得进入 scope 盲索引。')
  }
  return origin
}

export function normalizeSourceReferenceV2(value: string): string {
  assertNonEmptyStringV2(value, 'source reference')
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch (error) {
    throw new AppError('VALIDATION', 'source reference 不是合法 URL。', error)
  }
}

export function computeDreamInputFingerprintV2(
  input: MemoryDreamFingerprintInputV2
): string {
  assertNonNegativeIntegerV2(input.frontierBefore, 'frontierBefore')
  assertPositiveIntegerV2(input.pipelineVersion, 'pipelineVersion')
  for (const evidenceId of input.evidenceIds) {
    assertNonEmptyStringV2(evidenceId, 'evidenceId')
  }
  const body = canonicalStringifyV2({
    domain: DreamFingerprintDomainV2,
    frontierBefore: input.frontierBefore,
    evidenceIds: [...input.evidenceIds],
    modelProfile: {
      provider: input.modelProfile.provider,
      model: input.modelProfile.model,
    },
    pipelineVersion: input.pipelineVersion,
  })
  return `${DreamFingerprintPrefixV2}${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

/**
 * K_identity / K_match_root 的窄能力面。调用结束立即擦除解包后的 key bytes。
 */
export class MemoryIdentityKeyServiceV2 {
  constructor(private readonly keyring: MemoryKeyringStoreV2) {}

  public conceptStableKey(input: MemoryConceptStableKeyInputV2): string {
    return this.stableKey([
      'concept',
      input.conceptType,
      input.scopeType,
      input.scopeId,
      normalizeIdentityTextV2(input.discriminator),
    ])
  }

  public episodeStableKey(input: MemoryEpisodeStableKeyInputV2): string {
    return this.stableKey([
      'episode',
      input.scopeType,
      input.scopeId,
      input.conceptStableKey,
      input.episodeRoot,
      normalizeIdentityTextV2(input.phase),
    ])
  }

  public claimStableKey(input: MemoryClaimStableKeyInputV2): string {
    const topicSegment = normalizeIdentityTextV2(input.title) || 'untitled'
    const normalizedContentHash = createHash('sha256')
      .update(normalizeIdentityTextV2(input.content), 'utf8')
      .digest('hex')
    return this.stableKey([
      'claim',
      input.conceptStableKey,
      input.predicate,
      topicSegment,
      normalizedContentHash,
    ])
  }

  public claimGroupKey(input: {
    conceptStableKey: string
    predicate: string
    title: string
  }): string {
    const topicSegment = normalizeIdentityTextV2(input.title) || 'untitled'
    return this.identityHmac(
      ClaimGroupKeyPrefixV2,
      ['claim-group', input.conceptStableKey, input.predicate, topicSegment],
      32
    )
  }

  /**
   * 跨库治理只比较语义身份，不继承旧 stable_key，也不依赖模型生成的标题。
   * 该 keyed token 只用于 forgotten/superseded/erased 的候选写回 deny。
   */
  public claimGovernanceMatchKey(
    input: MemoryClaimGovernanceMatchInputV2
  ): string {
    const normalizedContentHash = createHash('sha256')
      .update(normalizeIdentityTextV2(input.content), 'utf8')
      .digest('hex')
    return this.identityHmac(
      GovernanceMatchKeyPrefixV2,
      [
        'claim-governance',
        input.conceptStableKey,
        input.predicate,
        normalizedContentHash,
      ],
      32
    )
  }

  public conceptNameMatchKey(value: string): string {
    return this.matchKey('concept-name', normalizeIdentityTextV2(value))
  }

  public conceptAliasMatchKey(value: string): string {
    return this.matchKey('concept-alias', normalizeIdentityTextV2(value))
  }

  public workspaceScopeMatchKey(canonicalPath: string): string {
    return this.matchKey(
      'scope',
      canonicalStringifyV2(['workspace', normalizeCanonicalPathV2(canonicalPath)])
    )
  }

  public originScopeMatchKey(origin: string): string {
    return this.matchKey(
      'scope',
      canonicalStringifyV2(['origin', normalizeOriginV2(origin)])
    )
  }

  public sourceReferenceMatchKey(sourceReference: string): string {
    return this.matchKey('source-ref', normalizeSourceReferenceV2(sourceReference))
  }

  private stableKey(segments: readonly string[]): string {
    return this.identityHmac(StableKeyPrefixV2, segments, 32)
  }

  private identityHmac(
    prefix:
      | typeof StableKeyPrefixV2
      | typeof ClaimGroupKeyPrefixV2
      | typeof GovernanceMatchKeyPrefixV2,
    segments: readonly string[],
    hexLength: number
  ): string {
    for (const segment of segments) assertStringV2(segment, 'identity segment')
    const key = this.keyring.getIdentityKey()
    try {
      const message = Buffer.concat([
        Buffer.from(StableKeyDomainV2, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonicalStringifyV2(segments), 'utf8'),
      ])
      return `${prefix}${createHmac('sha256', key).update(message).digest('hex').slice(0, hexLength)}`
    } finally {
      key.fill(0)
    }
  }

  private matchKey(purpose: MemoryMatchKeyPurposeV2, normalizedInput: string): string {
    if (!MemoryMatchKeyPurposesV2.includes(purpose)) {
      throw new AppError('VALIDATION', '未知 match-key purpose。', undefined, { purpose })
    }
    const root = this.keyring.getMatchRootKey()
    let purposeKey: Buffer | undefined
    try {
      purposeKey = createHmac('sha256', root)
        .update(`${MatchKeyDomainV2}:${purpose}`, 'utf8')
        .digest()
      return `${MatchKeyPrefixV2}${createHmac('sha256', purposeKey)
        .update(normalizedInput, 'utf8')
        .digest('hex')}`
    } finally {
      root.fill(0)
      purposeKey?.fill(0)
    }
  }
}

function assertStringV2(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION', `${label} 必须是字符串。`)
  }
}

function assertNonEmptyStringV2(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION', `${label} 不得为空。`)
  }
}

function assertNonNegativeIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION', `${label} 必须是非负安全整数。`)
  }
}

function assertPositiveIntegerV2(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError('VALIDATION', `${label} 必须是正安全整数。`)
  }
}
