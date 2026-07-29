import { AppError } from '@velaros-ai/core/error'

import { MemoryStorageErrorCodesV2 } from './ErrorCodes'

/**
 * OS 安全存储中的 wrapping root 端口。
 *
 * memory 包永远不 import Electron、Keychain 或 DPAPI。Desktop 可用 safeStorage 包装这一个
 * root，headless host 可接平台 keychain；keyring 只持 `wrappingRootId` 和被包装字节。
 */
export interface MemoryWrappingRootV2 {
  /** 稳定引用 id，格式冻结为 `wr-<小写 hex>`；不是密钥本身。 */
  readonly id: string
  wrapKey(key: Buffer): Buffer
  unwrapKey(wrapped: Buffer): Buffer
}

export const MemoryWrappingRootIdPatternV2 = /^wr-[0-9a-f]{16,128}$/

export function assertMemoryWrappingRootV2(root: MemoryWrappingRootV2): void {
  if (!MemoryWrappingRootIdPatternV2.test(root.id)) {
    throw new AppError('VALIDATION', 'wrapping root id 必须是 wr- 前缀的小写 hex 标识。')
  }
}

export function wrapMemoryKeyV2(root: MemoryWrappingRootV2, key: Buffer): string {
  assertMemoryWrappingRootV2(root)
  assertRawMemoryKeyV2(key)
  const wrapped = root.wrapKey(Buffer.from(key))
  if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'wrapping root 返回了无效的密钥信封。'
    )
  }
  return wrapped.toString('base64')
}

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

export function decodeCanonicalBase64V2(value: string, label: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      `${label} 不是规范 base64。`
    )
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      `${label} 不是规范 base64。`
    )
  }
  return decoded
}

export function assertRawMemoryKeyV2(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'memory key 必须是 32 字节。'
    )
  }
}
