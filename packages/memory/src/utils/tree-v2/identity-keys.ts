import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { parse as parsePath } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { MemoryDreamFingerprintInputV2 } from '../../types/tree-v2/evidence'

import {
  assertNonEmptyStringV2,
  assertNonNegativeSafeIntegerV2,
  assertPositiveSafeIntegerV2,
  assertStringV2,
} from './checks'
import { canonicalStringifyV2 } from './diff-chain'

/**
 * 身份键的前缀、域分隔串与各类归一化。
 *
 * 归一化决定了"什么算同一个东西"，是身份键的一半；键怎么算（HMAC、密钥）在
 * `MemoryIdentityKeyServiceV2` 里，因为那要拿密钥环。
 */

/** 盲索引匹配键的前缀。 */
export const MatchKeyPrefixV2 = 'm2:'

/** 稳定键的前缀。 */
export const StableKeyPrefixV2 = 'k2:'

/** 主张分组键的前缀。 */
export const ClaimGroupKeyPrefixV2 = 'g2:'

/** 治理匹配键的前缀。 */
export const GovernanceMatchKeyPrefixV2 = 'd2:'

/** 整理运行输入指纹的前缀。 */
export const DreamFingerprintPrefixV2 = 'f2:'

/** 匹配键派生的域分隔串。 */
export const MatchKeyDomainV2 = 'velaros.memory.match-key.v2'

/** 稳定键派生的域分隔串。 */
export const StableKeyDomainV2 = 'velaros.memory.stable-key.v2'

/** 整理运行输入指纹的域分隔串。 */
export const DreamFingerprintDomainV2 = 'velaros.memory.dream-input.v2'

/** 登记在册的匹配键用途；不在这张表里的一律拒绝派生。 */
export const MemoryMatchKeyPurposesV2 = Object.freeze([
  'concept-name',
  'concept-alias',
  'scope',
  'source-ref',
] as const)

/** 标题为空时用的占位段。 */
export const UntitledIdentitySegmentV2 = 'untitled'

/**
 * 身份文本归一化的唯一实现：NFKC → 小写 → 非字母数字（保留 + # .）折成空格 → 去首尾。
 * 这里刻意用 `toLowerCase` 而不是 locale 版本：环境 locale 不得影响身份。
 */
export function normalizeIdentityTextV2(value: string): string {
  assertStringV2(value, 'identity text')
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
}

/** 采集边界的路径真值收敛：先让文件系统解掉符号链接与大小写，再做密码学归一化。 */
export function canonicalizeWorkspacePathV2(value: string): string {
  assertNonEmptyStringV2(value, 'workspace path')
  let canonical: string
  try {
    canonical = realpathSync.native(value)
  } catch (error) {
    throw new AppError('VALIDATION', 'workspace path 无法解析为文件系统权威路径。', error, {
      value,
    })
  }
  return normalizeCanonicalPathV2(canonical)
}

/** 权威路径的密码学归一化：NFC，并去掉非根路径末尾的分隔符。 */
export function normalizeCanonicalPathV2(value: string): string {
  assertNonEmptyStringV2(value, 'canonical workspace path')
  const normalized = value.normalize('NFC')
  const root = parsePath(normalized).root
  if (normalized === root) return normalized
  return normalized.replace(/[\\/]{1}$/, '')
}

/** 站点源归一化：取 URL 的 origin；不合法或 opaque origin 一律拒绝进盲索引。 */
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

/** 来源引用归一化：必须是合法 URL，去掉 fragment（同一页面的不同锚点算同一来源）。 */
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

/** 算一次整理运行的输入指纹：同样的证据集、模型与管线版本必定得到同一个指纹。 */
export function computeDreamInputFingerprintV2(input: MemoryDreamFingerprintInputV2): string {
  assertNonNegativeSafeIntegerV2(input.frontierBefore, 'frontierBefore')
  assertPositiveSafeIntegerV2(input.pipelineVersion, 'pipelineVersion')
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

/** 把一段正文按身份文本归一化后取 sha256：稳定键与治理键都拿它当内容段。 */
export function normalizedContentHashV2(content: string): string {
  return createHash('sha256').update(normalizeIdentityTextV2(content), 'utf8').digest('hex')
}

/** 把标题折成身份段；归一化后为空就用 untitled 占位。 */
export function identityTopicSegmentV2(title: string): string {
  return normalizeIdentityTextV2(title) || UntitledIdentitySegmentV2
}
