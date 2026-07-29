import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'bun:test'

const KernelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PackResolveUrl = pathToFileURL(
  join(KernelRoot, 'packs', 'pack-resolve.mjs'),
).href

interface PackResolveModule {
  resolvePackagesRoot(fromUrl?: string): string
  resolveSiblingPackageDist(
    packagesRoot: string,
    relativeDistEntry: string,
  ): string
}

// Dynamic (non-literal) import: packs/*.mjs are runtime assets, not typed sources.
const packResolve = await import(PackResolveUrl) as PackResolveModule

const originalPackagesRoot = process.env.VELAROS_PACKAGES_ROOT

afterEach(() => {
  if (originalPackagesRoot === undefined) {
    delete process.env.VELAROS_PACKAGES_ROOT
  } else {
    process.env.VELAROS_PACKAGES_ROOT = originalPackagesRoot
  }
})

describe('pack resolve', () => {
  test('falls back to the directory that holds the Kernel repo', () => {
    delete process.env.VELAROS_PACKAGES_ROOT
    const root = packResolve.resolvePackagesRoot(PackResolveUrl)

    expect(root).toBe(resolve(KernelRoot, '..'))
    expect(join(root, basename(KernelRoot))).toBe(KernelRoot)
    // Regression: landing inside the Kernel repo made every sibling dist ENOENT.
    expect(root.startsWith(`${KernelRoot}${sep}`)).toBe(false)
    expect(root).not.toBe(KernelRoot)
  })

  test('resolves sibling capability dists as peers of the Kernel repo', () => {
    delete process.env.VELAROS_PACKAGES_ROOT
    const root = packResolve.resolvePackagesRoot(PackResolveUrl)
    const entry = 'VelarOS-Capabilities/packages/workspace/dist/index.js'

    expect(packResolve.resolveSiblingPackageDist(root, entry))
      .toBe(resolve(KernelRoot, '..', entry))
  })

  test('prefers VELAROS_PACKAGES_ROOT, absolute or cwd-relative', () => {
    process.env.VELAROS_PACKAGES_ROOT = '/opt/velaros-packages'
    expect(packResolve.resolvePackagesRoot(PackResolveUrl))
      .toBe('/opt/velaros-packages')

    process.env.VELAROS_PACKAGES_ROOT = './packages-root'
    expect(packResolve.resolvePackagesRoot(PackResolveUrl))
      .toBe(resolve(process.cwd(), 'packages-root'))
  })
})
