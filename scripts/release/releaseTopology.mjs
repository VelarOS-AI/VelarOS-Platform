// Canonical release topology shared by release verification and publication.
//
// 关键不变量:
//   ① **发布内容是声明过的,不是扫出来的**:发布集合与仓根 velaros.domainPackages 各域清单的
//      并集双向核对——磁盘上多出的可发布包(未登记)红,登记了却不可发布的包(悄悄掉队)也红。
//   ② manifest 版本必须等于 bun.lock 里该 workspace 的版本(lock 陈旧即红)。
//   ③ 顺序 = 依赖拓扑,被依赖者先发。
//   ④ **每个包声明的平台代必须与仓根一致**(velaros.platform)——见下「两根轴」。
//   ⑤ 可发布包的命令名必须唯一，且品牌入口 `velaros` 只能由 `@velaros-ai/cli` 拥有。
//
// Version model:
//   · **包版本**各自独立走 semver。破坏性变更升自己的位(0.x 下是 minor,1.x 下是 major),
//     消费者按包升级,互不牵连。这也是现实:workspace 已经在 1.2.6,core 还在 0.3.x。
//   · **平台代 `velaros.platform`** 表达「这批包属于同一代、互相兼容」。跨代才是整体破坏性
//     升级,应用方看这一个数就知道要不要整批动。它随包发布(写在各包 manifest 里),
//     所以装到消费者那边也读得到,不是只存在于本仓的约定。
// 为什么不把「代」塞进包版本号:那样任何一个包的破坏性变更都会强推全部包跳代——代号变成
// 「任意包破坏性变更」的公倍数,对没变的包是假信号;而且每个包只剩 patch 位一个自由度,
// 没法表达「加了功能但没 break」。两根轴各管一件事,谁也不替谁说话。
//
// Package versions intentionally do not have to equal the root train version. Package SemVer
// expresses package compatibility; velaros.platform expresses cross-package generation.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import * as TypeScriptModule from 'typescript'

export const ReleaseRegistry = 'https://npm.pkg.github.com'

// 所有第一方包均按公开包发布；显式声明可防止新增包意外回退为受限可见性。
const AllowedAccess = new Set(['public'])

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

const manifestBinCommands = (manifest) => {
  if (typeof manifest.bin === 'string') return [manifest.name.split('/').at(-1)]
  return Object.keys(manifest.bin ?? {})
}

// TypeScript is CommonJS today. Node and Bun expose its namespace/default interop differently
// across platforms, so resolve the parser from either standards-compatible shape explicitly.
export const resolveTypeScriptJsoncParser = (moduleNamespace) => {
  let candidate = moduleNamespace
  for (let depth = 0; depth < 3 && candidate; depth += 1) {
    if (typeof candidate.parseConfigFileTextToJson === 'function') {
      return candidate.parseConfigFileTextToJson
    }
    if (candidate.default === candidate) break
    candidate = candidate.default
  }
  throw new TypeError('TypeScript does not expose parseConfigFileTextToJson')
}

const parseConfigFileTextToJson = resolveTypeScriptJsoncParser(TypeScriptModule)

// bun.lock 是 JSONC(带注释、尾逗号),沿用七份旧脚本一致的做法:借 TypeScript 的 tsconfig
// 解析器读,不为一处解析再引一个 JSONC 依赖。
const readJsonc = async (file) => {
  const parsed = parseConfigFileTextToJson(file, await readFile(file, 'utf8'))
  if (parsed.error) {
    throw new Error(`Unable to parse ${file}: TypeScript diagnostic ${parsed.error.code}`)
  }
  return parsed.config
}

const declaredPackageDirectories = (rootManifest) => {
  const domains = rootManifest.velaros?.domainPackages
  const domainNames = Object.keys(domains ?? {})
  if (domainNames.length === 0) {
    throw new Error(
      'Root manifest is missing velaros.domainPackages; release contents must be declared, not discovered',
    )
  }
  const declared = new Set()
  for (const domain of domainNames) {
    const directories = domains[domain]
    if (!Array.isArray(directories) || directories.length === 0) {
      throw new Error(`velaros.domainPackages.${domain} must list at least one package directory`)
    }
    for (const directory of directories) declared.add(directory)
  }
  return declared
}

// 发布顺序只跟**消费者可见**的边(dependencies / optionalDependencies / peerDependencies):
// 装 A 时 A 的依赖必须已经在 registry 上。devDependencies 是构建期关系,由
// scripts/build/buildPackageTopology.mjs 负责(它刻意把 devDependencies 也算进图);
// 混进这里只会把顺序约束得更紧,并可能因构建期回边造出假环。
const orderByDependencies = (packages) => {
  const byName = new Map(packages.map((item) => [item.manifest.name, item]))
  const ordered = []
  const visiting = new Set()
  const visited = new Set()
  const visit = (item) => {
    if (visited.has(item.manifest.name)) return
    if (visiting.has(item.manifest.name)) {
      throw new Error(`Package dependency cycle at ${item.manifest.name}`)
    }
    visiting.add(item.manifest.name)
    const dependencies = {
      ...item.manifest.dependencies,
      ...item.manifest.optionalDependencies,
      ...item.manifest.peerDependencies,
    }
    for (const name of Object.keys(dependencies)) {
      const dependency = byName.get(name)
      if (dependency) visit(dependency)
    }
    visiting.delete(item.manifest.name)
    visited.add(item.manifest.name)
    ordered.push(item)
  }
  for (const item of packages) visit(item)
  return ordered
}

/**
 * 读仓根 manifest + bun.lock,核对发布集合与版本,返回按依赖拓扑排好序的待发布包。
 * 任何不变量不成立都抛错——调用方不需要再自己校验。
 */
export async function collectReleasePackages(root) {
  const rootManifest = await readJson(path.join(root, 'package.json'))
  const platformGeneration = rootManifest.velaros?.platform
  if (!platformGeneration) {
    throw new Error('Root manifest is missing velaros.platform; the release generation must be declared')
  }
  const declared = declaredPackageDirectories(rootManifest)
  const lockfile = await readJsonc(path.join(root, 'bun.lock'))
  const packagesRoot = path.join(root, 'packages')

  const packages = []
  const privateDirectories = new Set()
  // readdir 的顺序不保证稳定,排序后再走拓扑,使发布计划与 artifact 日志逐次可复现。
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const directoryName of entries) {
    const directory = path.join(packagesRoot, directoryName)
    if (!existsSync(path.join(directory, 'package.json'))) continue
    const manifest = await readJson(path.join(directory, 'package.json'))
    if (manifest.private === true) {
      privateDirectories.add(directoryName)
      continue
    }
    if (!manifest.name?.startsWith('@velaros-ai/')) {
      throw new Error(`Refusing to publish invalid package name: ${manifest.name ?? directoryName}`)
    }
    if (manifest.publishConfig?.registry !== ReleaseRegistry) {
      throw new Error(`${manifest.name} must publish to ${ReleaseRegistry}`)
    }
    if (!AllowedAccess.has(manifest.publishConfig?.access)) {
      throw new Error(
        `${manifest.name} must declare publishConfig.access as one of ${[...AllowedAccess].join(' / ')}`,
      )
    }
    if (!declared.has(directoryName)) {
      throw new Error(
        `packages/${directoryName} is publishable but not registered in velaros.domainPackages; register it or mark the package private`,
      )
    }
    // 不变量 ④:代必须写明且与仓根一致。缺失单独报,因为新包漏写是最常见的一种——
    // 错误文案要直接给出该写什么,而不是丢一句「不一致」让人回来翻仓根。
    if (!manifest.velaros?.platform) {
      throw new Error(
        `${manifest.name} must declare velaros.platform (expected "${platformGeneration}"); it ships with the package so consumers can read which generation they installed`,
      )
    }
    if (manifest.velaros.platform !== platformGeneration) {
      throw new Error(
        `${manifest.name} declares platform generation ${manifest.velaros.platform}, but the repo root declares ${platformGeneration}; a release train is one generation`,
      )
    }
    packages.push({ directoryName, directory, manifest })
  }

  const publishable = new Set(packages.map((item) => item.directoryName))
  for (const directoryName of [...declared].sort()) {
    if (publishable.has(directoryName)) continue
    if (privateDirectories.has(directoryName)) continue
    throw new Error(
      `velaros.domainPackages registers packages/${directoryName}, but it is not a publishable package on disk`,
    )
  }

  const commandOwners = new Map()
  for (const item of packages) {
    for (const command of manifestBinCommands(item.manifest)) {
      const owners = commandOwners.get(command) ?? []
      owners.push(item.manifest.name)
      commandOwners.set(command, owners)
    }
  }
  for (const [command, owners] of commandOwners) {
    if (owners.length > 1) {
      throw new Error(`Published CLI command ${command} has multiple owners: ${owners.join(', ')}`)
    }
  }
  const velarosOwners = commandOwners.get('velaros') ?? []
  if (velarosOwners.length !== 1 || velarosOwners[0] !== '@velaros-ai/cli') {
    throw new Error(
      `The velaros command must be owned only by @velaros-ai/cli; got ${velarosOwners.join(', ') || 'no owner'}`,
    )
  }

  for (const item of packages) {
    const workspacePath = path.relative(root, item.directory).split(path.sep).join('/')
    const lockedWorkspace = lockfile.workspaces?.[workspacePath]
    if (!lockedWorkspace) {
      throw new Error(
        `${item.manifest.name} is missing from bun.lock workspaces; run bun install before publishing`,
      )
    }
    if (lockedWorkspace.version !== item.manifest.version) {
      throw new Error(
        `${item.manifest.name} manifest version ${item.manifest.version} does not match bun.lock workspace version ${lockedWorkspace.version}; run bun install before publishing`,
      )
    }
  }

  return { rootManifest, platformGeneration, ordered: orderByDependencies(packages) }
}

/**
 * 把一个 git tag 解析成「这次要发什么」。两种合法形态,别的一律 unknown:
 *   · `v<仓根 version>`     —— 整列火车,发全部已声明的包;
 *   · `<包名或目录名>@<版本>` —— 单包发布,且 tag 里的版本必须与该包 manifest 逐字相同。
 *
 * 为什么单包 tag 要带版本:tag 是这次发布的**身份**,不是一个开关。写死版本以后,
 * 「tag 指向的提交里那个包是什么版本」和「tag 自己说发什么版本」对不上就当场红,
 * 而不是发完才发现发的是上一版。@ 之前允许写全名(@velaros-ai/agent-lab)或目录名(agent-lab)。
 *
 * 调用方只信 kind:'train' / 'package';unknown 一律拒发,不做「大概是想发这个吧」的补全。
 */
export function resolveReleaseSelection(rootManifest, ordered, refName) {
  const trainTag = `v${rootManifest.version}`
  if (refName === trainTag) {
    return { kind: 'train', tag: trainTag, packages: ordered }
  }
  const separator = refName?.lastIndexOf('@') ?? -1
  // lastIndexOf 而不是 split('@'):全名本身以 @ 开头(@velaros-ai/agent-lab@0.1.0)。
  if (refName && separator > 0) {
    const identifier = refName.slice(0, separator)
    const version = refName.slice(separator + 1)
    const match = ordered.find(
      (item) => item.manifest.name === identifier || item.directoryName === identifier,
    )
    if (match && match.manifest.version === version) {
      return { kind: 'package', tag: refName, packages: [match] }
    }
    if (match) {
      return {
        kind: 'unknown',
        tag: refName,
        packages: [],
        reason: `tag says ${identifier}@${version} but packages/${match.directoryName} declares ${match.manifest.version}`,
      }
    }
    return {
      kind: 'unknown',
      tag: refName,
      packages: [],
      reason: `${identifier} matches no declared release package`,
    }
  }
  return {
    kind: 'unknown',
    tag: refName ?? '',
    packages: [],
    reason: `expected ${trainTag} (full train) or <package>@<version> (single package)`,
  }
}

/**
 * 在 tag 已经确定发布身份之后，再应用本机发布命令的 --only 收窄。
 * 发布器和消费仓更新器必须共用这一处，否则会出现「发了 A、却去升级 B」的分叉。
 */
export function selectReleasedPackages(rootManifest, ordered, refName, selectors = []) {
  const selection = resolveReleaseSelection(rootManifest, ordered, refName)
  if (selection.kind === 'unknown') {
    throw new Error(`Unknown release ref ${refName ?? '(missing)'}: ${selection.reason}`)
  }
  if (selection.kind === 'package') {
    if (selectors.length > 0) {
      throw new Error(
        `--only cannot narrow a single-package tag (${selection.tag}); the tag already names what ships`,
      )
    }
    return { selection, packages: selection.packages }
  }

  if (selectors.length === 0) return { selection, packages: ordered }

  const chosen = new Set()
  for (const selector of selectors) {
    const match = ordered.find(
      (item) => item.manifest.name === selector || item.directoryName === selector,
    )
    if (!match) {
      const known = ordered.map((item) => item.manifest.name).join(', ')
      throw new Error(`--only ${selector} matches no declared release package. Declared: ${known}`)
    }
    chosen.add(match.manifest.name)
  }
  return {
    selection,
    packages: ordered.filter((item) => chosen.has(item.manifest.name)),
  }
}
