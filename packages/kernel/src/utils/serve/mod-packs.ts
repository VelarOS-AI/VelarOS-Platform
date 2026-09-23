import type { KernelModuleDefinition } from '../../contract/requires.js'
import type { KernelBundledPack, KernelModPackRecord } from '../../types/serve.js'

/**
 * bundled pack 的 `specifier`：一个**身份 URI**，不是磁盘路径。
 *
 * wire 上的 `KernelModPackDescriptor.specifier` 对 installed pack 是可 import 的路径，对
 * bundled pack 是「它是谁」——用带 scheme 的形态把两者机械分开，避免有人拿它去 import。
 */
export function bundledPackSpecifier(moduleId: string): string {
  return `bundled:${moduleId}`
}

/** 把一个编译期模块折成 ModStore 记录（宿主注入 bundled 能力的唯一入口）。 */
export function createBundledModPack(input: {
  readonly id: string
  readonly module: KernelModuleDefinition
  readonly version?: string
  readonly provides?: readonly string[]
}): KernelBundledPack {
  return {
    id: input.id,
    version: input.version ?? input.module.manifest.version,
    provides: input.provides ?? input.module.manifest.provides.map((token) => token.id),
    module: input.module,
  }
}

/** 把一批编译期模块折成 ModStore 记录。 */
export function toBundledPackRecords(
  packs: readonly KernelBundledPack[]
): readonly KernelModPackRecord[] {
  return packs.map((pack) => ({
    id: pack.id,
    kind: 'system' as const,
    version: pack.version,
    specifier: bundledPackSpecifier(pack.module.manifest.id),
    enabled: true,
    provides: [...pack.provides],
    module: pack.module,
  }))
}
