import { randomBytes } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

/**
 * blob_id 的生成与形态校验。
 *
 * **禁内容寻址**（规范 §7.1 冻结）：content-addressed id 是明文派生指纹，同内容跨行同 id
 * 就等于泄露等值关系；id 一律 128-bit CSPRNG 随机、写成 32 位小写 hex。
 */

/** blob_id 的形态：32 位小写 hex。 */
export const MemoryBlobIdPatternV2 = /^[0-9a-f]{32}$/

/** blob 分片目录名的形态：blob_id 的前两位 hex。 */
export const MemoryBlobShardPatternV2 = /^[0-9a-f]{2}$/

/** blob 文件的扩展名。 */
export const MemoryBlobFileSuffixV2 = '.blob'

/** 生成随机 blob_id（128-bit CSPRNG → 32 hex）；随机源可注入，便于确定性复现。 */
export function generateMemoryBlobIdV2(
  random: (byteLength: number) => Buffer = randomBytes
): string {
  const id = random(16).toString('hex')
  assertMemoryBlobIdV2(id)
  return id
}

/** 校验 blob_id 形态（兼作路径穿越防御：id 是路径组件，非法形态一律拒绝）。 */
export function assertMemoryBlobIdV2(blobId: string): void {
  if (!MemoryBlobIdPatternV2.test(blobId)) {
    throw new AppError('VALIDATION', 'blob_id 必须是 32 位小写 hex 随机标识。')
  }
}
