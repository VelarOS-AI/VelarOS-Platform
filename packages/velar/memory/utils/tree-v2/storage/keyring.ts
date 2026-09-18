import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryKeyringFileV2,
  MemoryKeyringKeysV2,
  MemoryKeyringStoreOptionsV2,
  MemoryKeyringUnsignedV2,
  MemoryWrappingRootV2,
  StorageStepHooksV2,
} from '../../../types/tree-v2/storage.js'
import { isPlainRecordV2, isStrictRecordV2 } from '../checks.js'
import { canonicalStringifyV2 } from '../diff-chain.js'

import { writeFileAtomicV2 } from './atomic-file.js'
import { assertMemoryBlobIdV2 } from './blob-id.js'
import { MemoryStorageErrorCodesV2 } from './error-codes.js'
import { decodeCanonicalBase64V2, MemoryWrappingRootIdPatternV2, wrapMemoryKeyV2 } from './wrapping-root.js'

/**
 * 密钥环代际文件的建、写、封与严格解析。
 * 这些都是对文件字节做的判断，用不着实例状态，所以从 `MemoryKeyringStoreV2` 提到这里。
 */

/** 密钥环文件的格式身份。 */
export const MemoryKeyringFormatV2 = 'velaros.memory.keyring.v2'

/** 密钥环代际文件的后缀。 */
export const KeyringGenerationSuffixV2 = '.keyring.json'

/** 完整性摘要的形态：64 位小写 hex。 */
export const KeyringIntegrityPatternV2 = /^[0-9a-f]{64}$/

/** 派生索引代号作为 map key 时的形态：十进制正整数。 */
export const KeyringPositiveIntegerPatternV2 = /^[1-9][0-9]*$/

/** 造第一代密钥环：随机出身份密钥与匹配键根密钥，包装后封成代际文件内容。 */
export function createInitialKeyringV2(
  root: MemoryWrappingRootV2,
  options: MemoryKeyringStoreOptionsV2
): MemoryKeyringFileV2 {
  const random = options.random ?? randomBytes
  const identity = random(32)
  const matchRoot = random(32)
  if (identity.length !== 32 || matchRoot.length !== 32) {
    throw new AppError('INVARIANT', 'keyring 随机源必须返回 32 字节。')
  }
  try {
    return sealKeyringFileV2({
      format: MemoryKeyringFormatV2,
      generation: 1,
      createdAt: (options.now ?? Date.now)(),
      wrappingRootId: root.id,
      keys: {
        identity: wrapMemoryKeyV2(root, identity),
        matchRoot: wrapMemoryKeyV2(root, matchRoot),
        indexGenerations: {},
        contentDeks: {},
      },
    })
  } finally {
    identity.fill(0)
    matchRoot.fill(0)
  }
}

/** 原子写一代密钥环文件；同代文件已存在就是不变量破坏，拒绝覆盖。 */
export function writeKeyringGenerationV2(
  keyringDir: string,
  file: MemoryKeyringFileV2,
  hooks?: StorageStepHooksV2
): void {
  const path = join(keyringDir, `generation-${file.generation}${KeyringGenerationSuffixV2}`)
  if (existsSync(path)) {
    throw new AppError('INVARIANT', 'keyring 代际文件已存在，禁止覆盖。', undefined, {
      generation: file.generation,
    })
  }
  writeFileAtomicV2(path, canonicalStringifyV2(file), {
    label: `keyring-generation-${file.generation}`,
    hooks,
  })
}

/** 给未签名的密钥环内容补上 sha256 完整性摘要。 */
export function sealKeyringFileV2(unsigned: MemoryKeyringUnsignedV2): MemoryKeyringFileV2 {
  return {
    ...unsigned,
    integrity: createHash('sha256').update(canonicalStringifyV2(unsigned)).digest('hex'),
  }
}

/**
 * 严格解析一代密钥环文件：字段集、格式身份、代号、摘要都要对上。
 * 宽容解析等于给伪造留注入面，任何不符一律判 MEMORY_STORAGE_CORRUPTION。
 */
export function parseKeyringFileV2(raw: string, expectedGeneration: number): MemoryKeyringFileV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring JSON 无法解析。', error)
  }
  if (
    !isStrictRecordV2(parsed, [
      'format',
      'generation',
      'createdAt',
      'wrappingRootId',
      'keys',
      'integrity',
    ])
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring 顶层字段不符合 v2 严格格式。')
  }
  const createdAt = parsed['createdAt']
  const wrappingRootId = parsed['wrappingRootId']
  const integrity = parsed['integrity']
  if (
    parsed['format'] !== MemoryKeyringFormatV2 ||
    parsed['generation'] !== expectedGeneration ||
    !Number.isSafeInteger(createdAt) ||
    (createdAt as number) < 0 ||
    !isString(wrappingRootId) ||
    !MemoryWrappingRootIdPatternV2.test(wrappingRootId) ||
    !isString(integrity) ||
    !KeyringIntegrityPatternV2.test(integrity)
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring 标量字段不符合 v2 严格格式。')
  }
  const unsigned: MemoryKeyringUnsignedV2 = {
    format: MemoryKeyringFormatV2,
    generation: expectedGeneration,
    createdAt: createdAt as number,
    wrappingRootId: wrappingRootId as string,
    keys: parseKeyringKeysV2(parsed['keys']),
  }
  const expectedIntegrity = createHash('sha256')
    .update(canonicalStringifyV2(unsigned))
    .digest('hex')
  if (integrity !== expectedIntegrity) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring integrity 校验失败。')
  }
  return { ...unsigned, integrity: expectedIntegrity }
}

/** 严格解析密钥环里的四组密钥：键形态与信封 base64 都要过。 */
export function parseKeyringKeysV2(input: unknown): MemoryKeyringKeysV2 {
  if (!isStrictRecordV2(input, ['identity', 'matchRoot', 'indexGenerations', 'contentDeks'])) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'keyring keys 字段不符合 v2 严格格式。'
    )
  }
  const identity = input['identity']
  const matchRoot = input['matchRoot']
  if (!isString(identity) || !isString(matchRoot)) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring 基础密钥信封缺失。')
  }
  assertWrappedKeyEnvelopeV2(identity, 'identity')
  assertWrappedKeyEnvelopeV2(matchRoot, 'matchRoot')
  return {
    identity,
    matchRoot,
    indexGenerations: parseWrappedMapV2(input['indexGenerations'], (key) =>
      KeyringPositiveIntegerPatternV2.test(key)
    ),
    contentDeks: parseWrappedMapV2(input['contentDeks'], (key) => {
      try {
        assertMemoryBlobIdV2(key)
        return true
      } catch {
        // arch-guard:silent-catch-ok 这是 Map key 的验证谓词，false 会触发上层 corruption 诊断。
        return false
      }
    }),
  }
}

/** 解析「键 → 包装信封」的表；键或值不合规一律判损坏。 */
export function parseWrappedMapV2(
  input: unknown,
  validateKey: (key: string) => boolean
): Record<string, string> {
  if (!isPlainRecordV2(input)) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring wrapped map 不是纯对象。')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!validateKey(key) || !isString(value) || isEmpty(value)) {
      throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring wrapped map 含非法条目。')
    }
    assertWrappedKeyEnvelopeV2(value, key)
    result[key] = value
  }
  return result
}

/** 校验一个包装信封是规范 base64；不是就判损坏。 */
export function assertWrappedKeyEnvelopeV2(value: string, label: string): void {
  try {
    decodeCanonicalBase64V2(value, `keyring wrapped key ${label}`)
  } catch (error) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'keyring 密钥信封不是规范 base64。',
      error
    )
  }
}
