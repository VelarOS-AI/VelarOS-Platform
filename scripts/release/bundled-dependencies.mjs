// 用途：将实际安装的 bundle 闭包实体化到独占暂存目录，保留覆盖版本与安全补丁。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

function installedPackage(name, parent, optional = false) {
  const require = createRequire(path.join(parent, 'package.json'))
  for (const directory of require.resolve.paths(`${name}/package.json`) ?? []) {
    const manifestPath = path.join(directory, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const resolved = realpathSync(manifestPath)
    return { root: path.dirname(resolved), manifest: JSON.parse(readFileSync(resolved, 'utf8')) }
  }
  if (!optional) throw new Error(`Cannot bundle missing dependency ${name} from ${parent}`)
}

function publishedManifest(manifest, directory) {
  const result = structuredClone(manifest)
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    for (const [name, range] of Object.entries(result[field] ?? {})) {
      if (!range.startsWith('workspace:')) continue
      const suffix = range.slice('workspace:'.length)
      result[field][name] = ['*', '^', '~'].includes(suffix)
        ? `${suffix === '*' ? '' : suffix}${installedPackage(name, directory).manifest.version}`
        : suffix
    }
  }
  return result
}

async function copyPackage(source, destination, manifest) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) =>
      !path
        .relative(source, entry)
        .split(path.sep)
        .some((part) => ['node_modules', '.git'].includes(part)),
  })
  await writeFile(
    path.join(destination, 'package.json'),
    `${JSON.stringify(publishedManifest(manifest, source), null, 2)}\n`
  )
}

/** Bun 1.3 的 workspace pack 不收集链接依赖；在独立目录打包同一份真实字节。 */
export async function stageBundledPackage(directory, manifest) {
  const configured = manifest.bundledDependencies ?? manifest.bundleDependencies
  const names = configured === true ? Object.keys(manifest.dependencies ?? {}) : configured
  if (!names?.length) return
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'velaros-bundled-package-'))
  const packageDirectory = path.join(stagingRoot, 'package')
  try {
    await copyPackage(directory, packageDirectory, manifest)
    const copy = async (name, parent, destination, ancestors, optional = false) => {
      const record = installedPackage(name, parent, optional)
      if (!record || ancestors.get(name) === record.root) return
      const target = path.join(destination, 'node_modules', name)
      await copyPackage(record.root, target, record.manifest)
      const branch = new Map(ancestors).set(name, record.root)
      const optionalNames = new Set(Object.keys(record.manifest.optionalDependencies ?? {}))
      const required = new Set([
        ...Object.keys(record.manifest.dependencies ?? {}).filter(
          (item) => !optionalNames.has(item)
        ),
        ...Object.keys(record.manifest.peerDependencies ?? {}).filter(
          (item) => !record.manifest.peerDependenciesMeta?.[item]?.optional
        ),
      ])
      for (const dependency of required) await copy(dependency, record.root, target, branch)
      for (const dependency of optionalNames)
        await copy(dependency, record.root, target, branch, true)
    }
    for (const name of names) {
      if (!manifest.dependencies?.[name] && !manifest.optionalDependencies?.[name])
        throw new Error(`Bundled dependency ${name} must be declared in ${manifest.name}`)
      await copy(name, directory, packageDirectory, new Map())
    }
    return { packageDirectory, cleanup: () => rm(stagingRoot, { recursive: true, force: true }) }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
}
