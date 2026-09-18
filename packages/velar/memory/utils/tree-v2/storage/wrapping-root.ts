import { AppError } from '@velaros-ai/core/error'

import type { MemoryWrappingRootV2 } from '../../../types/tree-v2/storage.js'

import { MemoryStorageErrorCodesV2 } from './error-codes.js'

/** wrapping root id 的形态：`wr-` 前缀加 16–128 位小写 hex。 */
export const MemoryWrappingRootIdPatternV2 = /^wr-[0-9a-f]{16,128}$/

/** 校验 wrapping root 的 id 形态，不合规抛 VALIDATION。 */
export function assertMemoryWrappingRootV2(root: MemoryWrappingRootV2): void {
  if (!MemoryWrappingRootIdPatternV2.test(root.id)) {
    throw new AppError('VALIDATION', 'wrapping root id 必须是 wr- 前缀的小写 hex 标识。')
  }
}

/** 经 wrapping root 把 32 字节明文密钥包装成 base64 信封；root 返回空信封判损坏。 */
export function wrapMemoryKeyV2(root: MemoryWrappingRootV2, key: Buffer): string {
  assertMemoryWrappingRootV2(root)
  assertRawMemoryKeyV2(key)
  const wrapped = root.wrapKey(Buffer.from(key))
  if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'wrapping root 返回了无效的密钥信封。')
  }
  return wrapped.toString('base64')
}

/** 经 wrapping root 把 base64 信封解回 32 字节明文密钥；解不开或长度不对判损坏。 */
export function unwrapMemoryKeyV2(root: MemoryWrappingRootV2, wrappedBase64: string): Buffer {
  assertMemoryWrappingRootV2(root)
  const wrapped = decodeCanonicalBase64V2(wrappedBase64, 'wrapped key')
  let key: Buffer
  try {
    key = root.unwrapKey(wrapped)
  } catch (error) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'wrapping root 无法解开密钥信封。',
      error
    )
  }
  assertRawMemoryKeyV2(key)
  return Buffer.from(key)
}

/** 严格解码规范 base64（长度、字符集、往返一致都要过），不合规判损坏。 */
export function decodeCanonicalBase64V2(value: string, label: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, `${label} 不是规范 base64。`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, `${label} 不是规范 base64。`)
  }
  return decoded
}

/** 断言这是 32 字节的明文密钥，不是就判损坏。 */
export function assertRawMemoryKeyV2(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'memory key 必须是 32 字节。')
  }
}
