/** 作用域的规则：一个作用域一个目录，目录名由作用域字符串算出来，目录里有个小文件原样记着作用域字符串；列作用域时怎么排。 */

import { createHash } from 'node:crypto'

import type { MemoryScopeSummary } from '../types/memory.js'

/** 作用域目录里原样记着作用域字符串的文件：列作用域时读它。 */
export const ScopeRecordFileName = '.scope'

/**
 * 作用域字符串对应的目录名：小写的可读前缀（非字母数字换成 -，最多 48 个字符）接上 SHA-256 的前 16 位十六进制。
 * 前缀只给人看，身份靠哈希；整个名字都是小写，大小写不敏感的文件系统上两个作用域也落不进同一个目录。
 */
export function scopeDirectoryName(scope: string): string {
  const readable = scope.toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 48).replace(/^-+|-+$/gu, '')
  const hash = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 16)
  return readable ? `${readable}-${hash}` : hash
}

/** 作用域概况按最近一次更新从新到旧排；同一时刻的按作用域字符串排，结果稳定。 */
export function compareScopeSummaries(left: MemoryScopeSummary, right: MemoryScopeSummary): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
  return left.scope < right.scope ? -1 : 1
}
