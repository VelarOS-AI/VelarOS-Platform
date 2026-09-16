/** 向量库统计：把 LanceDB 的表读数汇总成对外的诊断结构。 */

import type {
  VectorStoreStatsInput,
  VectorStoreStatsOutput,
} from '../types/storage.js'

/** 把一组向量表读数拼成对外的向量库统计，额外字段原样并进去。 */
export function buildVectorStoreStats<TExtra extends Record<string, unknown> = Record<string, never>>(
  input: VectorStoreStatsInput,
  extra?: TExtra
): VectorStoreStatsOutput & TExtra {
  return {
    path: input.path,
    tableName: input.tableName,
    rowCount: input.rowCount,
    dimensions: input.dimensions,
    ...(extra ?? ({} as TExtra)),
    indices: input.indices.map((index) => ({
      name: index.name,
      type: index.indexType,
      columns: [...index.columns],
    })),
  }
}
