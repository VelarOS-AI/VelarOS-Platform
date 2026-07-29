import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const DependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]

/**
 * Resolves an installed dependency through public node_modules entrypoints.
 *
 * Bun may hoist a dependency to the repository root or keep it beside the
 * workspace that declares it. The private Bun store is deliberately not part
 * of this contract.
 */
export class InstalledPackageResolver {
  #manifestCache = new Map()
  #repositoryRoot
  #workspaceDirectories

  constructor({ repositoryRoot, workspaceDirectories }) {
    this.#repositoryRoot = path.resolve(repositoryRoot)
    this.#workspaceDirectories = workspaceDirectories.map((directory) =>
      path.resolve(directory)
    )
  }

  async resolve(packageName, { declaringPackageDirectories = [] } = {}) {
    const candidates = [
      path.join(this.#repositoryRoot, 'node_modules', ...packageName.split('/')),
    ]

    for (const workspaceDirectory of this.#workspaceDirectories) {
      if (await this.#workspaceDeclares(workspaceDirectory, packageName)) {
        candidates.push(
          path.join(workspaceDirectory, 'node_modules', ...packageName.split('/')),
        )
      }
    }

    for (const candidate of candidates) {
      try {
        return await realpath(candidate)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }

    for (const declaringPackageDirectory of declaringPackageDirectories) {
      try {
        const requireFromDeclarer = createRequire(
          path.join(declaringPackageDirectory, 'package.json'),
        )
        const entryPath = requireFromDeclarer.resolve(packageName)
        return await this.#findPackageRoot(entryPath, packageName)
      } catch (error) {
        if (
          error?.code !== 'MODULE_NOT_FOUND'
          && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
        ) throw error
      }
    }

    throw new Error(
      `Unable to resolve installed ${packageName}; checked public entries ${candidates.join(', ')}`,
    )
  }

  async #findPackageRoot(entryPath, packageName) {
    let directory = path.dirname(entryPath)
    while (true) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(directory, 'package.json'), 'utf8'),
        )
        if (manifest.name === packageName) return realpath(directory)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }

      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    throw new Error(
      `Resolved ${packageName} to ${entryPath}, but could not find its package root`,
    )
  }

  async #workspaceDeclares(workspaceDirectory, packageName) {
    let manifest = this.#manifestCache.get(workspaceDirectory)
    if (!manifest) {
      manifest = JSON.parse(
        await readFile(path.join(workspaceDirectory, 'package.json'), 'utf8'),
      )
      this.#manifestCache.set(workspaceDirectory, manifest)
    }
    return DependencySections.some((section) =>
      Object.hasOwn(manifest[section] ?? {}, packageName)
    )
  }
}
