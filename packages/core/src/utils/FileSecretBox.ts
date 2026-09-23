import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { AppError } from '../error'

import { writeFileOnceSync } from './FilePersistence'

/** 宿主决定密钥位置与密文版本标记。 */
export interface FileSecretBoxOptions {
  keyPath(): string
  readonly prefix: Uint8Array
}

/**
 * 基于本地文件密钥的 AES-256-GCM 文本加密；构造时不触碰磁盘。
 * 格式错误返回 SECURITY AppError，context.reason 为 key-format 或 payload-format；
 * 文件访问和认证失败保留原始错误，由宿主决定呈现方式。
 */
export interface FileSecretBoxApi {
  /** 读取或一次性创建密钥；损坏密钥直接报错。 */
  prepare(): void
  encrypt(value: string): Buffer
  decrypt(payload: Uint8Array): string
}

const KeyBytes = 32
const IvBytes = 12
const TagBytes = 16

class FileSecretBox implements FileSecretBoxApi {
  private key?: Buffer
  private readonly prefix: Buffer

  public constructor(private readonly options: FileSecretBoxOptions) {
    if (options.prefix.byteLength === 0)
      throw new AppError('VALIDATION', 'Secret payload prefix is required')
    this.prefix = Buffer.from(options.prefix)
  }

  public prepare(): void {
    this.loadKey()
  }

  public encrypt(value: string): Buffer {
    const iv = randomBytes(IvBytes)
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(), iv)
    cipher.setAAD(this.prefix)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([this.prefix, iv, cipher.getAuthTag(), encrypted])
  }

  public decrypt(payload: Uint8Array): string {
    const buffer = Buffer.from(payload)
    const offset = this.prefix.length
    if (
      buffer.length < offset + IvBytes + TagBytes ||
      !buffer.subarray(0, offset).equals(this.prefix)
    )
      throw new AppError('SECURITY', 'Invalid encrypted payload', undefined, {
        reason: 'payload-format',
      })
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.loadKey(),
      buffer.subarray(offset, offset + IvBytes)
    )
    decipher.setAAD(this.prefix)
    decipher.setAuthTag(buffer.subarray(offset + IvBytes, offset + IvBytes + TagBytes))
    return Buffer.concat([
      decipher.update(buffer.subarray(offset + IvBytes + TagBytes)),
      decipher.final(),
    ]).toString('utf8')
  }

  private loadKey(): Buffer {
    if (this.key) return this.key
    const path = this.options.keyPath()
    let key: Buffer
    try {
      key = readFileSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      writeFileOnceSync(path, randomBytes(KeyBytes), { mode: 0o600 })
      // 竞争创建时读取实际发布者的完整密钥，不缓存本次落选的随机值。
      key = readFileSync(path)
    }
    if (key.length !== KeyBytes)
      throw new AppError('SECURITY', 'Invalid local secret key', undefined, {
        reason: 'key-format',
      })
    this.key = key
    return key
  }
}

/** 创建共享加密机制；产品选择密钥归属、密文标记和错误呈现。 */
export function createFileSecretBox(options: FileSecretBoxOptions): FileSecretBoxApi {
  return new FileSecretBox(options)
}
