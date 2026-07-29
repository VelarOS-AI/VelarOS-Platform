import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Resolve the sibling-repos root used by thin system pack entries.
 *
 * Order: VELAROS_PACKAGES_ROOT → parent directory of the Kernel repo.
 *
 * The fallback must land one level *above* the Kernel repo: entries join
 * `VelarOS-Capabilities/packages/<cap>/dist/...` onto it, and that sibling repo
 * is a peer of VelarOS-Kernel, not a child of it.
 */
export function resolvePackagesRoot(fromUrl = import.meta.url) {
  const configured = process.env.VELAROS_PACKAGES_ROOT?.trim()
  if (configured !== undefined && configured.length > 0) return isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured)
  const here = dirname(fileURLToPath(fromUrl))
  // <root>/VelarOS-Kernel/packs/*.mjs → Kernel repo root → <root> (holds sibling repos)
  return resolve(here, '../..')
}

export function resolveSiblingPackageDist(packagesRoot, relativeDistEntry) {
  return join(packagesRoot, relativeDistEntry)
}

export async function importSibling(packagesRoot, relativeDistEntry) {
  const absolute = resolveSiblingPackageDist(packagesRoot, relativeDistEntry)
  return import(pathToFileURL(absolute).href)
}
