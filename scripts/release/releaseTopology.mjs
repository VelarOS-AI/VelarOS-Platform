// 单版本火车的「发布清单」单源:哪些包该发、按什么顺序发、发之前必须成立什么。
//
// 为什么存在:并仓前七个源仓各带一份 scripts/<domain>/release/publish-packages.mjs
// (agent / capabilities / core / kernel / memory / model / ui,共 1111 行),并仓之后它们枚举的
// 都是同一个 packages/ 目录、跑的是同一套校验——已经功能等价,只在格式与错误文案上分叉。
// 本模块把共有判据收成唯一事实来源,由 verify-release-ref.mjs(CI 预检)与
// publish-packages.mjs(真发布)共用;两者都不再各自枚举包。
//
// 关键不变量:
//   ① **发布内容是声明过的,不是扫出来的**:发布集合与仓根 velaros.domainPackages 各域清单的
//      并集双向核对——磁盘上多出的可发布包(未登记)红,登记了却不可发布的包(悄悄掉队)也红。
//   ② manifest 版本必须等于 bun.lock 里该 workspace 的版本(lock 陈旧即红)。
//   ③ 顺序 = 依赖拓扑,被依赖者先发。
//
// 为什么**不**校验「各包版本 == 仓根 version」:并仓前 memory / ui 的 verify-release 与 model 的
// publish 都带这条锁步断言(源仓里仓根 version 就是那个包的版本)。火车形态下仓根 version 是
// 火车号(0.6.0)、各包保留导入时现值(0.1.0–1.2.6,登记在 velaros.domainVersions),README
// 「版本方案」写明统一推进留到首次里程碑。原样搬过来会让任何 tag 都发不出去;强行把 18 个可发布包
// 对齐到 0.6.0 又会打断 Desktop 已声明的 ^0.5.0 / ^0.3.2 等 range。锁步断言的真实目的是
// 不变量 ①,故以 ① 承接、锁步本身丢弃。改动这里前先读 README「版本方案」。

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

export const ReleaseRegistry = 'https://npm.pkg.github.com'

// publishConfig.access 必须显式声明(承接 model 那份独有的 access 断言),但不钉死成
// 'restricted':html-artifacts 声明的是 'public'。发布时按各包声明值传给 --access,
// 而不是像七份旧脚本那样硬写 restricted 覆盖 manifest——门不该悄悄违背被检查者的声明。
const AllowedAccess = new Set(['restricted', 'public'])

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

// bun.lock 是 JSONC(带注释、尾逗号),沿用七份旧脚本一致的做法:借 TypeScript 的 tsconfig
// 解析器读,不为一处解析再引一个 JSONC 依赖。
const readJsonc = async (file) => {
  const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, 'utf8'))
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

  return { rootManifest, ordered: orderByDependencies(packages) }
}
