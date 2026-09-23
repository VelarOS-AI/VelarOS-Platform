import { randomUUID } from 'node:crypto'

/** 生成带前缀的随机标识，形如 prefix_ 加 16 位十六进制。 */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}
