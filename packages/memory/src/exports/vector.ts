/**
 * `@velaros-ai/memory/vector` —— **市场可选**的语义派生索引档（§九 9.1 增强档）。
 *
 * **不在 bundled 恒装清单里**：新用户开箱是 files-only（§九 9.6），装了才有语义召回，
 * 卸了只掉索引。这个切片是它的全部代码——包的其余部分对它零引用，`./vector` 不被 import
 * 就一行都不加载。
 */
export type { MemoryEmbedder, MemoryVectorIndexRecord, MemoryVectorIndexStore } from '../contract/vector'
export { MemoryVectorBackendId } from '../contract/vector'
export type { MemoryVectorBackendOptions } from '../impl/vector/MemoryVectorBackend'
export { createMemoryVectorBackend, MemoryVectorIndexSchemaVersion } from '../impl/vector/MemoryVectorBackend'
export type { FileVectorIndexStoreOptions, InMemoryVectorIndexStore } from '../impl/vector/VectorIndexStores'
export {
  createFileVectorIndexStore,
  createInMemoryVectorIndexStore,
  MemoryVectorIndexFileName,
} from '../impl/vector/VectorIndexStores'
