// 将同仓产物组成独立基础与能力归档，二者共享同一个基础 Runtime。
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import ts from 'typescript'

import { CodeSurfaces } from '../script/surfaces.mjs'

import {
  compositeModelSourceAssets,
  distributionExports,
  distributionForVelarosPath,
  platformDistributions,
  platformModules,
  sharedDeclarationSupport,
} from './platform-distributions.mjs'

export { platformModules } from './platform-distributions.mjs'
const scope = '@velaros-ai/'
const modelSourceAssets = new Set([
  ...compositeModelSourceAssets,
  ...CodeSurfaces.filter((surface) => surface.directory === 'velaros').flatMap((surface) =>
    [surface.templates].flat().map((template) => `dist/${surface.unit}/${template}`)
  ),
])

// 模型模板是登记的源码资产，里面的虚拟模块不由宿主 Node 解析。
export function isModelSourceAsset(file) {
  return modelSourceAssets.has(file)
}

export function relocatePlatformText(text) {
  for (const name of platformModules) {
    text = text.replace(
      new RegExp(`${scope}${name}(?![a-zA-Z0-9_-])`, 'gu'),
      `${scope}velaros/${name}`
    )
  }
  text = text.replace(
    /@velaros-ai\/skill-jsts(?=\/package\.json|\/SKILL\.md)/gu,
    '@velaros-ai/capabilities/skill-jsts'
  )
  for (const unit of platformDistributions.capabilities.units) {
    text = text.replace(
      new RegExp(`${scope}velaros/${unit}(?=[/"'\x60\\s]|$)`, 'gu'),
      `${scope}capabilities/${unit}`
    )
  }
  return text
}

// 使用语法树提取静态、类型及动态模块引用，不能受源码排版影响。
export function moduleReferences(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const references = []
  const visit = (node) => {
    let literal
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      literal = node.argument.literal
    else if (ts.isExternalModuleReference(node)) literal = node.expression
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'resolve' &&
          ((ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'require') ||
            (ts.isCallExpression(node.expression.expression) &&
              ts.isIdentifier(node.expression.expression.expression) &&
              node.expression.expression.expression.text === 'createRequire'))))
    )
      literal = node.arguments[0]
    if (literal && ts.isStringLiteralLike(literal))
      references.push({
        value: literal.text,
        start: literal.getStart(source) + 1,
        end: literal.getEnd() - 1,
      })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return references
}

// 宿主 peer 取源码支持范围的交集；必需声明不能被另一处 optional 降级。
export function resolvePeerContract(declarations, semver) {
  if (!declarations.length) throw new Error('A host peer needs at least one declared range')
  const ranges = [...new Set(declarations.map((entry) => entry.range))]
  const parsedRanges = ranges.map((range) => new semver.Range(range))
  let range = ranges[0]
  if (ranges.length > 1) {
    let terms = ['*']
    for (const parsed of parsedRanges) {
      const alternatives = parsed.set.map(
        (set) =>
          set
            .map((comparator) => comparator.value)
            .filter(Boolean)
            .join(' ') || '*'
      )
      const next = new Set()
      for (const term of terms) {
        for (const alternative of alternatives) {
          const conjunction = new semver.Range(`${term} ${alternative}`).range || '*'
          if (semver.minVersion(conjunction)) next.add(conjunction)
        }
      }
      terms = [...next]
      if (!terms.length) throw new Error(`Incompatible host peer ranges: ${ranges.join(' / ')}`)
    }
    range = new semver.Range(terms.join(' || ')).range || '*'
    // 合并 prerelease 比较器可能扩大允许集；无法证明仍是各源子集时明确失败。
    if (!ranges.every((declared) => semver.subset(range, declared)))
      throw new Error(
        `Cannot preserve every host peer prerelease constraint: ${ranges.join(' / ')}`
      )
  }
  return { range, optional: declarations.every((entry) => entry.optional === true) }
}

// 声明的类型提供者跟随实际引用的运行包，不把宿主 UI peer 带入无关的 Node 发行单元。
export function declarationPeerNames(references, manifest) {
  return Object.keys(manifest.peerDependencies ?? {}).filter((name) => {
    if (!name.startsWith('@types/')) return false
    const short = name.slice('@types/'.length)
    const separator = short.indexOf('__')
    const provided =
      separator < 0 ? short : `@${short.slice(0, separator)}/${short.slice(separator + 2)}`
    return references.has(provided)
  })
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

async function treeFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await treeFiles(file)))
    else files.push(file)
  }
  return files
}

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

// 合成发行包的说明从实际清单派生，不冒充基础 Runtime 的包根。
function capabilityReadme(manifest) {
  return [
    '# @velaros-ai/capabilities',
    '',
    `VelarOS 的可选领域能力，与同版本 @velaros-ai/velaros@${manifest.version} 共享唯一 Runtime、Kernel、Agent 和 Context。宿主显式安装两个归档；基础包是必需的精确版本 peer，扩展不会另装一份基础运行时。`,
    '',
    '## 用法',
    '',
    '```ts',
    "import { createProjectKernel, createProjectCapabilityModule } from '@velaros-ai/capabilities/project'",
    "const root = '/srv/approved-project'",
    'const kernel = await createProjectKernel({ root })',
    'const module = createProjectCapabilityModule({',
    '  instanceId: root,',
    '  project: { getRootPath: () => root, kernel: async () => kernel },',
    '})',
    '// 产品核对执行身份与授权，再把 module 交给基础 Runtime 的 modules。',
    '```',
    '',
    '## 入口',
    '',
    ...Object.keys(manifest.exports)
      .sort()
      .map((entry) => `- \`@velaros-ai/capabilities${entry === '.' ? '' : entry.slice(1)}\``),
    '',
    '## 约定',
    '',
    '能力只在宿主显式装配后进入会话目录。项目选择、授权根、环境端口和资源生命周期由产品组合根负责。此扩展不内嵌第二套基础运行时。',
    '',
  ].join('\n')
}

function publicTargetMap(exports) {
  const targets = new Map()
  for (const [entry, target] of Object.entries(exports)) {
    for (const file of typeof target === 'string' ? [target] : Object.values(target)) {
      if (typeof file !== 'string') continue
      targets.set(file.replace(/^\.\//u, '').replace(/\.d\.ts$/u, '.js'), entry)
    }
  }
  return targets
}

function hasPublicExport(specifier, packageName, exports) {
  const entry = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
  return Object.keys(exports).some((key) => {
    if (key === entry) return true
    const wildcard = key.indexOf('*')
    return (
      wildcard >= 0 &&
      entry.startsWith(key.slice(0, wildcard)) &&
      entry.endsWith(key.slice(wildcard + 1))
    )
  })
}

// 跨发行单元只能经已有公开入口，不复制基础实现来补相对路径。
export function relocateRelativeReferences(text, file, targetMap, owner) {
  const edits = []
  for (const reference of moduleReferences(text, file)) {
    if (!reference.value.startsWith('.')) continue
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), reference.value)
    )
    if (!resolved.startsWith('dist/')) continue
    const destinationOwner = distributionForVelarosPath(resolved)
    if (destinationOwner === 'declarations') {
      if (!file.endsWith('.d.ts'))
        throw new Error(
          `Declaration support cannot be loaded as JavaScript: ${file} -> ${reference.value}`
        )
      continue
    }
    if (destinationOwner === owner) continue
    if (owner === 'velaros')
      throw new Error(`Base import reaches optional capability: ${file} -> ${reference.value}`)
    const entry = targetMap.get(resolved.replace(/\.d\.ts$/u, '.js'))
    if (!entry)
      throw new Error(
        `Cross-distribution import has no public entry: ${file} -> ${reference.value}`
      )
    edits.push({ ...reference, value: `@velaros-ai/velaros${entry === '.' ? '' : entry.slice(1)}` })
  }
  for (const edit of edits.reverse())
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end)
  return text
}

async function installedDependency(name, source) {
  const require = createRequire(path.join(source, 'package.json'))
  for (const root of require.resolve.paths(name) ?? []) {
    try {
      return JSON.parse(await readFile(path.join(root, name, 'package.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`Cannot resolve declared dependency ${name} from ${source}`)
}

export async function stageUnifiedPlatformPackage(directory, manifest, distribution = 'velaros') {
  if (manifest.name !== '@velaros-ai/velaros') {
    if (distribution !== 'velaros')
      throw new Error('Platform distributions require the Velaros source package')
    return
  }
  const configuration = platformDistributions[distribution]
  if (!configuration) throw new Error(`Unknown Platform distribution: ${distribution}`)
  const stagingRoot = await mkdtemp(path.join(tmpdir(), `velaros-${distribution}-`))
  const packageDirectory = path.join(stagingRoot, 'package')
  try {
    const result = structuredClone(manifest)
    for (const field of [
      'scripts',
      'devDependencies',
      'bundleDependencies',
      'bin',
      'imports',
      'dependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'optionalDependencies',
    ])
      delete result[field]
    result.name = configuration.name
    if (distribution === 'capabilities')
      result.description = 'Explicit optional capabilities for the shared VelarOS Runtime.'
    result.exports = distributionExports(manifest, distribution)
    result.exports['./package.json'] = './package.json'
    result.files = ['dist', 'README.md', ...configuration.resources, 'modules', 'node_modules']
    result.dependencies = {}
    result.peerDependencies =
      distribution === 'capabilities' ? { '@velaros-ai/velaros': manifest.version } : {}
    result.bundledDependencies = []
    result.velaros.distribution = distribution
    const owners = [{ source: directory, manifest }]
    const dependencyDirectories = {}
    const semver = createRequire(path.join(directory, 'package.json'))('semver')
    const publicTargets = publicTargetMap(manifest.exports)
    const baseExports = distributionExports(manifest, 'velaros')
    baseExports['./package.json'] = true
    for (const name of platformModules) {
      const internal = JSON.parse(
        await readFile(path.resolve(directory, '..', name, 'package.json'), 'utf8')
      )
      for (const key of Object.keys(internal.exports))
        baseExports[`./${name}${key === '.' ? '' : key.slice(1)}`] = true
    }
    await mkdir(packageDirectory)
    await cp(path.join(directory, 'README.md'), path.join(packageDirectory, 'README.md'))
    for (const file of [
      ...configuration.units.map((unit) => `dist/${unit}`),
      ...sharedDeclarationSupport,
      ...configuration.resources,
    ]) {
      await cp(path.join(directory, file), path.join(packageDirectory, file), {
        recursive: true,
        dereference: true,
      })
    }
    for (const name of configuration.modules) {
      const source = path.resolve(directory, '..', name)
      const internal = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
      if (Object.keys(internal.imports ?? {}).length)
        throw new Error(`Internal imports require explicit relocation: ${name}`)
      owners.push({ source, manifest: internal })
      const target = path.join(packageDirectory, 'modules', name)
      await copyPublishedFiles(source, target, internal)
      for (const [key, value] of Object.entries(internal.exports ?? {}))
        result.exports[`./${name}${key === '.' ? '' : key.slice(1)}`] = mapTarget(value, name)
      if (name === 'skill-jsts')
        await writeFile(path.join(target, 'package.json'), `${JSON.stringify(internal, null, 2)}\n`)
      for (const [command, file] of Object.entries(internal.bin ?? {})) {
        result.bin ??= {}
        result.bin[command] = `./modules/${name}/${file.replace(/^\.\//u, '')}`
      }
    }
    // 私有 vendor imports 跟随资源所有者，不进入基础清单。
    if (distribution === 'capabilities') result.imports = structuredClone(manifest.imports ?? {})
    const dependencies = new Set()
    const dependencyOrigins = new Map()
    const recordDependency = (name, origin) => {
      dependencies.add(name)
      const origins = dependencyOrigins.get(name) ?? []
      if (!origins.includes(origin)) origins.push(origin)
      dependencyOrigins.set(name, origins)
    }
    for (const file of await treeFiles(packageDirectory)) {
      if (
        !/\.(?:[cm]?js|[cm]?ts|json|md|map)$/u.test(file) ||
        path.basename(file) === 'package.json'
      )
        continue
      const relative = path.relative(packageDirectory, file).split(path.sep).join('/')
      const before = await readFile(file, 'utf8')
      let after = relocatePlatformText(before)
      if (/\.[cm]?[jt]s$/u.test(file) && !isModelSourceAsset(relative)) {
        if (relative.startsWith('dist/'))
          after = relocateRelativeReferences(after, relative, publicTargets, distribution)
        for (const { value } of moduleReferences(after, relative)) {
          if (value.startsWith('.') || value.startsWith('#') || isBuiltin(value)) continue
          const dependency = packageName(value)
          if (dependency === configuration.name) {
            if (!hasPublicExport(value, configuration.name, result.exports))
              throw new Error(`Private self import in ${distribution}: ${relative} -> ${value}`)
            continue
          }
          if (distribution === 'velaros' && dependency === '@velaros-ai/capabilities')
            throw new Error(
              `Base declaration or code reaches optional capability: ${relative} -> ${value}`
            )
          if (dependency.startsWith(scope)) {
            if (distribution === 'capabilities' && dependency === '@velaros-ai/velaros') {
              if (!hasPublicExport(value, dependency, baseExports))
                throw new Error(`Extension reaches private base code: ${relative} -> ${value}`)
              continue
            }
            throw new Error(`Unrelocated internal dependency: ${relative} -> ${value}`)
          }
          recordDependency(dependency, `${relative} -> ${value}`)
        }
      }
      if (after !== before) await writeFile(file, after)
    }
    // 独立基础模块与 Skill 的清单还声明了运行时按名字发现的依赖，不能只看静态 import。
    for (const owner of owners.slice(1))
      for (const name of Object.keys(owner.manifest.dependencies ?? {}))
        if (!name.startsWith(scope))
          recordDependency(
            name,
            `${path.relative(directory, owner.source).split(path.sep).join('/')}/package.json dependencies.${name}`
          )
    const referencedPackages = new Set(dependencies)
    for (const owner of owners)
      for (const name of declarationPeerNames(referencedPackages, owner.manifest))
        recordDependency(
          name,
          `${path.relative(directory, owner.source).split(path.sep).join('/')}/package.json declaration peer ${name}`
        )
    for (const name of [...dependencies].sort()) {
      const declarations = owners.flatMap((owner) =>
        ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'].flatMap(
          (field) =>
            owner.manifest[field]?.[name]
              ? [{ ...owner, field, range: owner.manifest[field][name] }]
              : []
        )
      )
      const origins = (dependencyOrigins.get(name) ?? []).join('\n')
      if (!declarations.length)
        throw new Error(`Undeclared ${distribution} dependency: ${name}\n${origins}`)
      const runtime = declarations.filter((entry) => entry.field !== 'devDependencies')
      if (!runtime.length)
        throw new Error(
          `Public ${distribution} declaration depends on development-only ${name}\n${origins}`
        )
      const selected =
        runtime.find((entry) => entry.field === 'dependencies') ??
        runtime.find((entry) => entry.field === 'optionalDependencies') ??
        runtime[0]
      const installed = await installedDependency(name, selected.source)
      if (!runtime.every((entry) => semver.satisfies(installed.version, entry.range)))
        throw new Error(
          `Installed ${name}@${installed.version} does not satisfy ${runtime.map((entry) => entry.range).join(', ')}`
        )
      const peerOnly = runtime.every((entry) => entry.field === 'peerDependencies')
      if (peerOnly) {
        let peer
        try {
          peer = resolvePeerContract(
            runtime.map((entry) => ({
              range: entry.range,
              optional: entry.manifest.peerDependenciesMeta?.[name]?.optional,
            })),
            semver
          )
        } catch (error) {
          throw new Error(
            `${distribution} host peer ${name}: ${error instanceof Error ? error.message : String(error)}\n${origins}`,
            { cause: error }
          )
        }
        result.peerDependencies[name] = peer.range
        if (peer.optional) {
          result.peerDependenciesMeta ??= {}
          result.peerDependenciesMeta[name] = { optional: true }
        }
      } else result.dependencies[name] = installed.version
      dependencyDirectories[name] = selected.source
      if (owners.some((owner) => owner.manifest.bundledDependencies?.includes(name)))
        result.bundledDependencies.push(name)
    }
    result.exports['./package.json'] = './package.json'
    if (distribution === 'capabilities')
      await writeFile(path.join(packageDirectory, 'README.md'), capabilityReadme(result))
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
