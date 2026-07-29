import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Resolve the packages root used by thin system pack entries.
 *
 * Order: VELAROS_PACKAGES_ROOT → the workspace `packages/` directory that holds
 * this package.
 *
 * P2(合仓)后能力包与 kernel-daemon 是**同一个 workspace 的兄弟包**,不再是兄弟仓:
 * 入口 join 的是 `<cap>/dist/index.js`,落点必须是 `<repo>/packages/`。
 * 这里的 `../..` 正好从 `packages/kernel-daemon/packs` 走回 `packages/`——与拆仓期
 * 「Kernel 仓根的上一级」是同一句算式,换算出的语义变了而已。
 *
 * TODO(P4):`importSibling` 这套按磁盘布局找 dist 的机制整体退役,改由 workspace 直连
 * (宪章 §15.2 层间铁律「importSibling 退役」);本步只把路径改对,不动机制。
 */
export function resolvePackagesRoot(fromUrl = import.meta.url) {
  const configured = process.env.VELAROS_PACKAGES_ROOT?.trim()
  if (configured !== undefined && configured.length > 0) return isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured)
  const here = dirname(fileURLToPath(fromUrl))
  // <repo>/packages/kernel-daemon/packs/*.mjs → kernel-daemon 包根 → <repo>/packages
  return resolve(here, '../..')
}

export function resolveSiblingPackageDist(packagesRoot, relativeDistEntry) {
  return join(packagesRoot, relativeDistEntry)
}

export async function importSibling(packagesRoot, relativeDistEntry) {
  const absolute = resolveSiblingPackageDist(packagesRoot, relativeDistEntry)
  return import(pathToFileURL(absolute).href)
}
