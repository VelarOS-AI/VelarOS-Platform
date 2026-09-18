/** 四个操作的中间形状：只在单元内部用，不出单元。 */

import type { MemoryKind } from './memory.js'

/** 核对过的一次召回：话题去掉首尾空白，条数、要不要连归档的一起找都已经定好。 */
export interface MemoryCheckedSearch {
  query: string
  limit: number
  deep: boolean
  categories?: MemoryKind[]
}
