import { createHmac } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryClaimGovernanceMatchInputV2,
  MemoryClaimGroupKeyInputV2,
  MemoryClaimStableKeyInputV2,
  MemoryConceptStableKeyInputV2,
  MemoryEpisodeStableKeyInputV2,
  MemoryMatchKeyPurposeV2,
} from '../../types/tree-v2/evidence'
import { assertStringV2 } from '../../utils/tree-v2/checks'
import { canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain'
import {
  ClaimGroupKeyPrefixV2,
  GovernanceMatchKeyPrefixV2,
  identityTopicSegmentV2,
  MatchKeyDomainV2,
  MatchKeyPrefixV2,
  MemoryMatchKeyPurposesV2,
  normalizeCanonicalPathV2,
  normalizedContentHashV2,
  normalizeIdentityTextV2,
  normalizeOriginV2,
  normalizeSourceReferenceV2,
  StableKeyDomainV2,
  StableKeyPrefixV2,
} from '../../utils/tree-v2/identity-keys'

import type { MemoryKeyringStoreV2Api } from './storage/MemoryKeyringStoreV2'

/**
 * 身份密钥与匹配键根密钥的窄能力面：把归一化过的语义身份变成带密钥的稳定键与盲索引键。
 *
 * 每次派生都现取现擦密钥字节，调用结束立刻清零；密钥本身绝不跨出这个类。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有，与一份密钥环成对。
 */
export interface MemoryIdentityKeyServiceV2Api {
  /** 算一个概念的稳定键 `k2:<32 hex>`。 */
  conceptStableKey(input: MemoryConceptStableKeyInputV2): string
  /** 算一个情节的稳定键 `k2:<32 hex>`。 */
  episodeStableKey(input: MemoryEpisodeStableKeyInputV2): string
  /** 算一条主张的稳定键 `k2:<32 hex>`。 */
  claimStableKey(input: MemoryClaimStableKeyInputV2): string
  /** 算一条主张的分组键 `g2:<32 hex>`：同概念同谓词同话题的主张归一组。 */
  claimGroupKey(input: MemoryClaimGroupKeyInputV2): string
  /**
   * 算跨库治理的匹配键 `d2:<32 hex>`。
   * 只比较语义身份，不继承旧稳定键、也不依赖模型写的标题；
   * 这个键只用于 forgotten / superseded / erased 的候选写回拒绝。
   */
  claimGovernanceMatchKey(input: MemoryClaimGovernanceMatchInputV2): string
  /** 算概念名的盲索引键 `m2:<64 hex>`。 */
  conceptNameMatchKey(value: string): string
  /** 算概念别名的盲索引键 `m2:<64 hex>`。 */
  conceptAliasMatchKey(value: string): string
  /** 算工作区作用域的盲索引键；传进来的路径要先经权威路径归一化。 */
  workspaceScopeMatchKey(canonicalPath: string): string
  /** 算站点作用域的盲索引键；opaque origin 抛 VALIDATION。 */
  originScopeMatchKey(origin: string): string
  /** 算来源引用的盲索引键；不是合法 URL 抛 VALIDATION。 */
  sourceReferenceMatchKey(sourceReference: string): string
}

export class MemoryIdentityKeyServiceV2 implements MemoryIdentityKeyServiceV2Api {
  /** 稳定键与分组键截取的十六进制位数（128 位身份空间）。 */
  private static readonly IdentityHmacHexLength = 32

  constructor(private readonly keyring: MemoryKeyringStoreV2Api) {}

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
    return this.stableKey([
      'claim',
      input.conceptStableKey,
      input.predicate,
      identityTopicSegmentV2(input.title),
      normalizedContentHashV2(input.content),
    ])
  }

  public claimGroupKey(input: MemoryClaimGroupKeyInputV2): string {
    return this.identityHmac(ClaimGroupKeyPrefixV2, [
      'claim-group',
      input.conceptStableKey,
      input.predicate,
      identityTopicSegmentV2(input.title),
    ])
  }

  public claimGovernanceMatchKey(input: MemoryClaimGovernanceMatchInputV2): string {
    return this.identityHmac(GovernanceMatchKeyPrefixV2, [
      'claim-governance',
      input.conceptStableKey,
      input.predicate,
      normalizedContentHashV2(input.content),
    ])
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
    return this.matchKey('scope', canonicalStringifyV2(['origin', normalizeOriginV2(origin)]))
  }

  public sourceReferenceMatchKey(sourceReference: string): string {
    return this.matchKey('source-ref', normalizeSourceReferenceV2(sourceReference))
  }

  /** 稳定键 = 身份密钥对各段 canonical 序列化后的 HMAC，带 `k2:` 前缀。 */
  private stableKey(segments: readonly string[]): string {
    return this.identityHmac(StableKeyPrefixV2, segments)
  }

  /** 用身份密钥对各段算 HMAC，截成固定长度并加前缀；密钥用完立刻清零。 */
  private identityHmac(prefix: string, segments: readonly string[]): string {
    for (const segment of segments) assertStringV2(segment, 'identity segment')
    const key = this.keyring.getIdentityKey()
    try {
      const message = Buffer.concat([
        Buffer.from(StableKeyDomainV2, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonicalStringifyV2(segments), 'utf8'),
      ])
      const digest = createHmac('sha256', key)
        .update(message)
        .digest('hex')
        .slice(0, MemoryIdentityKeyServiceV2.IdentityHmacHexLength)
      return `${prefix}${digest}`
    } finally {
      key.fill(0)
    }
  }

  /** 先由匹配键根密钥派出这个用途的子密钥，再对归一化输入算 HMAC；两把密钥都清零。 */
  private matchKey(purpose: MemoryMatchKeyPurposeV2, normalizedInput: string): string {
    if (!MemoryMatchKeyPurposesV2.includes(purpose)) {
      throw new AppError('VALIDATION', '未知 match-key purpose。', undefined, {
        purpose,
      })
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
