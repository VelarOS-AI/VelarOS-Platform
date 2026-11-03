// 将同仓源码构建产物组成单一发行包，不安装任何内部包。
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export const platformModules = [
  'core',
  'kernel',
  'model',
  'agent',
  'context',
  'script',
  'skill-jsts',
]
const scope = '@velaros-ai/'

export function relocatePlatformText(text) {
  for (const name of platformModules) {
    // Skill 的逻辑身份不变，仅重定位资源解析入口。
    const suffix = name === 'skill-jsts' ? '(?=/package\\.json|/SKILL\\.md)' : '(?![a-zA-Z0-9_-])'
    text = text.replace(new RegExp(`${scope}${name}${suffix}`, 'gu'), `${scope}velaros/${name}`)
  }
  return text
}

function mapTarget(value, name) {
  if (typeof value === 'string') return `./modules/${name}/${value.slice(2)}`
  if (Array.isArray(value)) return value.map((item) => mapTarget(item, name))
  if (!value) return value
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapTarget(item, name)])
  )
  if (result.import && !result.default) result.default = result.import
  return result
}

async function rewriteTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await rewriteTree(file)
    else if (
      /\.(?:[cm]?js|[cm]?ts|json|md|map)$/u.test(entry.name) &&
      entry.name !== 'package.json'
    ) {
      const before = await readFile(file, 'utf8')
      const after = relocatePlatformText(before)
      if (after !== before) await writeFile(file, after)
    }
  }
}

async function copyPublishedFiles(source, target, manifest) {
  await mkdir(target, { recursive: true })
  for (const file of manifest.files ?? []) {
    if (file === 'node_modules') continue
    if (file.includes('*') || file.includes('..') || path.isAbsolute(file))
      throw new Error(`Unsupported publish path: ${file}`)
    await cp(path.join(source, file), path.join(target, file), {
      recursive: true,
      dereference: true,
    })
  }
}

export async function stageUnifiedPlatformPackage(directory, manifest) {
  if (manifest.name !== '@velaros-ai/velaros') return
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'velaros-unified-platform-'))
  const packageDirectory = path.join(stagingRoot, 'package')
  try {
    const result = structuredClone(manifest)
    delete result.scripts
    delete result.devDependencies
    delete result.bundleDependencies
    result.files = [...new Set([...result.files, 'modules'])]
    const semver = createRequire(path.join(directory, 'package.json'))('semver')
    const ranges = new Map()
    const dependencyDirectories = {}
    const bundled = new Set(result.bundledDependencies ?? [])
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      result[field] = Object.fromEntries(
        Object.entries(result[field] ?? {}).filter(([name]) => !name.startsWith(scope))
      )
      for (const [name, range] of Object.entries(result[field])) ranges.set(name, [range])
    }
    await copyPublishedFiles(directory, packageDirectory, manifest)
    for (const name of platformModules) {
      const source = path.resolve(directory, '..', name)
      const internal = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
      if (internal.imports && Object.keys(internal.imports).length)
        throw new Error(`Internal imports require explicit relocation: ${name}`)
      const target = path.join(packageDirectory, 'modules', name)
      await copyPublishedFiles(source, target, internal)
      for (const [key, value] of Object.entries(internal.exports ?? {})) {
        result.exports[`./${name}${key === '.' ? '' : key.slice(1)}`] = mapTarget(value, name)
      }
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [dependency, range] of Object.entries(internal[field] ?? {})) {
          if (dependency.startsWith(scope)) {
            if (!platformModules.includes(dependency.slice(scope.length)))
              throw new Error(`Unknown internal dependency: ${dependency}`)
            continue
          }
          const existing = ranges.get(dependency) ?? []
          for (const previous of existing)
            if (!semver.intersects(previous, range))
              throw new Error(`Incompatible ${dependency}: ${previous} / ${range}`)
          existing.push(range)
          ranges.set(dependency, existing)
          // 取已安装且满足所有源码声明的精确版本，避免下游自行调和范围。
          const require = createRequire(path.join(source, 'package.json'))
          let installed
          for (const root of require.resolve.paths(dependency) ?? []) {
            try {
              installed = JSON.parse(
                await readFile(path.join(root, dependency, 'package.json'), 'utf8')
              )
              break
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
            }
          }
          if (!installed || !existing.every((item) => semver.satisfies(installed.version, item)))
            throw new Error(`Installed ${dependency} does not satisfy ${existing.join(', ')}`)
          result[field][dependency] = installed.version
          dependencyDirectories[dependency] = source
        }
      }
      for (const dependency of internal.bundledDependencies ?? [])
        if (!dependency.startsWith(scope)) bundled.add(dependency)
      // 保留 Skill 元数据身份；代码模块不创建嵌套包作用域，统一使用根 imports。
      if (name === 'skill-jsts')
        await writeFile(path.join(target, 'package.json'), `${JSON.stringify(internal, null, 2)}\n`)
      if (internal.bin) {
        result.bin ??= {}
        for (const [command, file] of Object.entries(internal.bin))
          result.bin[command] = `./modules/${name}/${file.replace(/^\.\//u, '')}`
      }
    }
    result.exports['./package.json'] = './package.json'
    result.bundledDependencies = [...bundled].sort()
    await rewriteTree(packageDirectory)
    await writeFile(
      path.join(packageDirectory, 'package.json'),
      `${JSON.stringify(result, null, 2)}\n`
    )
    return {
      packageDirectory,
      manifest: result,
      dependencyDirectories,
      cleanup: () => rm(stagingRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
}
