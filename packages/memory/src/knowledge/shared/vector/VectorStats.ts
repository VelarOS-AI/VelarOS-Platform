interface LanceIndexDescriptor {
  name: string
  indexType: string
  columns: readonly string[]
}

interface VectorStoreStatsInput {
  path: string
  tableName: string
  rowCount: number
  dimensions: Nullable<number>
  indices: readonly LanceIndexDescriptor[]
}

interface VectorStoreStatsOutput {
  path: string
  tableName: string
  rowCount: number
  dimensions: Nullable<number>
  indices: Array<{ name: string; type: string; columns: string[] }>
}

function buildVectorStoreStats<TExtra extends Record<string, unknown> = Record<string, never>>(
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

export { buildVectorStoreStats }
export type { LanceIndexDescriptor, VectorStoreStatsInput, VectorStoreStatsOutput }
