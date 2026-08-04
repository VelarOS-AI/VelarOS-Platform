#!/usr/bin/env node
// 用途：从 packages/*/package.json 的 @velaros-ai/* 依赖派生真实依赖图，拓扑排序后依序构建各包（支持 --for 依赖闭包与全量两种模式）。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '../..')
const PACKAGES_DIR = resolve(ROOT_DIR, 'packages')
const VELAROS_SCOPE = '@velaros-ai/'
const BUILD_STATE_DIR = resolve(ROOT_DIR, '.velaros-workspace')
const BUILD_CACHE_PATH = resolve(BUILD_STATE_DIR, 'package-build-cache-v1.json')
const BUILD_LOCK_PATH = resolve(BUILD_STATE_DIR, 'package-build.lock')
const BUILD_CACHE_SCHEMA_VERSION = 1
const IgnoredInputDirectoryNames = new Set([
  '.cache',
  '.turbo',
  '.vite',
  'coverage',
  'dist',
  'node_modules',
  'out',
])
const RootBuildInputPaths = [
  'bun.lock',
  'bunfig.toml',
  'package.json',
  'tsconfig.json',
]

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function updateHashWithFile(hash, absolutePath, displayPath) {
  hash.update(`file\0${displayPath}\0`)
  hash.update(readFileSync(absolutePath))
  hash.update('\0')
}

function updateHashWithTree(hash, root, displayRoot = relative(ROOT_DIR, root)) {
  if (!existsSync(root)) {
    hash.update(`missing\0${displayRoot}\0`)
    return
  }

  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isDirectory() && IgnoredInputDirectoryNames.has(entry.name)) continue
      const absolutePath = resolve(directory, entry.name)
      const displayPath = relative(ROOT_DIR, absolutePath)
      if (entry.isDirectory()) {
        visit(absolutePath)
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${displayPath}\0${readlinkSync(absolutePath)}\0`)
      } else if (entry.isFile()) {
        updateHashWithFile(hash, absolutePath, displayPath)
      }
    }
  }

  visit(root)
}

function collectReferencedBuildScripts(node) {
  const referenced = new Set()
  const visitedScripts = new Set()
  const manifest = readJson(resolve(node.dir, 'package.json'))

  const visitScript = (scriptName) => {
    if (visitedScripts.has(scriptName)) return
    visitedScripts.add(scriptName)
    const command = manifest.scripts?.[scriptName]
    if (!command) return

    for (const match of command.matchAll(/(?:^|\s)([^\s"']+\.mjs)(?=\s|$)/gu)) {
      const absolutePath = resolve(node.dir, match[1])
      if (existsSync(absolutePath)) referenced.add(absolutePath)
    }
    for (const match of command.matchAll(/bun run ([a-zA-Z0-9:_-]+)/gu)) {
      visitScript(match[1])
    }
  }

  visitScript('build')
  return [...referenced].sort()
}

function computePackageInputFingerprint(node, dependencyFingerprints) {
  const hash = createHash('sha256')
  hash.update(`velaros-package-build-input-v${BUILD_CACHE_SCHEMA_VERSION}\0`)
  hash.update(`${process.platform}\0${process.arch}\0${process.version}\0`)
  updateHashWithTree(hash, node.dir, `packages/${node.dirName}`)

  for (const relativePath of RootBuildInputPaths) {
    const absolutePath = resolve(ROOT_DIR, relativePath)
    if (existsSync(absolutePath)) updateHashWithFile(hash, absolutePath, relativePath)
  }
  for (const scriptPath of collectReferencedBuildScripts(node)) {
    updateHashWithFile(hash, scriptPath, relative(ROOT_DIR, scriptPath))
  }
  for (const [name, fingerprint] of [...dependencyFingerprints.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`dependency\0${name}\0${fingerprint}\0`)
  }
  return hash.digest('hex')
}

function computeBuildOutputFingerprint(node) {
  const distDirectory = resolve(node.dir, 'dist')
  if (!existsSync(distDirectory) || !statSync(distDirectory).isDirectory()) return null
  const hash = createHash('sha256')
  hash.update(`velaros-package-build-output-v${BUILD_CACHE_SCHEMA_VERSION}\0`)
  updateHashWithTree(hash, distDirectory, `packages/${node.dirName}/dist`)
  return hash.digest('hex')
}

function readBuildCache() {
  if (!existsSync(BUILD_CACHE_PATH)) return { schemaVersion: BUILD_CACHE_SCHEMA_VERSION, packages: {} }
  try {
    const parsed = readJson(BUILD_CACHE_PATH)
    if (parsed.schemaVersion !== BUILD_CACHE_SCHEMA_VERSION || typeof parsed.packages !== 'object')
      return { schemaVersion: BUILD_CACHE_SCHEMA_VERSION, packages: {} }
    return parsed
  } catch {
    return { schemaVersion: BUILD_CACHE_SCHEMA_VERSION, packages: {} }
  }
}

function writeBuildCache(cache) {
  mkdirSync(BUILD_STATE_DIR, { recursive: true })
  const temporaryPath = `${BUILD_CACHE_PATH}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, BUILD_CACHE_PATH)
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireBuildLock() {
  mkdirSync(BUILD_STATE_DIR, { recursive: true })
  if (existsSync(BUILD_LOCK_PATH)) {
    let ownerPid = 0
    try {
      ownerPid = Number.parseInt(readFileSync(BUILD_LOCK_PATH, 'utf8'), 10)
    } catch {
      ownerPid = 0
    }
    if (isProcessAlive(ownerPid))
      throw new Error(`已有包拓扑构建正在运行（pid ${ownerPid}），拒绝并发清理 dist。`)
    rmSync(BUILD_LOCK_PATH, { force: true })
  }

  let fileDescriptor
  try {
    fileDescriptor = openSync(BUILD_LOCK_PATH, 'wx')
    writeFileSync(fileDescriptor, `${process.pid}\n`, 'utf8')
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
    throw new Error(`无法取得包构建锁：${error.message}`)
  }
  closeSync(fileDescriptor)
  return () => rmSync(BUILD_LOCK_PATH, { force: true })
}

function collectVelarosDeps(manifest) {
  const sections = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
  const names = new Set()
  for (const section of sections) {
    if (!section) continue
    for (const key of Object.keys(section)) {
      if (key.startsWith(VELAROS_SCOPE)) names.add(key)
    }
  }
  return [...names].sort()
}

// packages/ 下的包目录:一律平铺一层(2026-07-30 QI 批把 capabilities/ 的四个包提到顶层后,
// 这里不再需要「顶层 + 一层分组目录」的两级扫描特例;新包直接放 packages/<pkg>/)。
function listPackageDirectories() {
  const found = []
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(resolve(PACKAGES_DIR, entry.name, 'package.json'))) found.push(entry.name)
  }
  return found
}

function scanPackages() {
  const byName = new Map()
  const byDir = new Map()

  for (const directory of listPackageDirectories()) {
    const manifestPath = resolve(PACKAGES_DIR, directory, 'package.json')
    if (!existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = readJson(manifestPath)
    } catch {
      continue
    }
    if (!manifest.name) continue

    const node = {
      name: manifest.name,
      dir: resolve(PACKAGES_DIR, directory),
      dirName: directory,
      deps: collectVelarosDeps(manifest),
      hasBuild: Boolean(manifest.scripts && manifest.scripts.build),
    }
    byName.set(node.name, node)
    byDir.set(directory, node.name)
    // 分组目录下的包也允许用裸目录名寻址(--for workspace)。
    const bare = directory.includes('/') ? directory.slice(directory.indexOf('/') + 1) : null
    if (bare && !byDir.has(bare)) byDir.set(bare, node.name)
  }

  return { byDir, byName }
}

function resolveTargetName(graph, raw) {
  if (graph.byName.has(raw)) return raw
  const scoped = raw.startsWith(VELAROS_SCOPE) ? raw : `${VELAROS_SCOPE}${raw}`
  if (graph.byName.has(scoped)) return scoped
  if (graph.byDir.has(raw)) return graph.byDir.get(raw)
  const known = [...graph.byName.keys()].sort().join(', ')
  throw new Error(`未找到目标包「${raw}」。可选：${known}`)
}

// 从目标集合出发做 deps-first 深度优先，返回拓扑构建顺序；未知 @velaros 依赖当作预构建外部叶子跳过；成环即报错。
function resolveBuildOrder(graph, targetNames) {
  const order = []
  const external = new Set()
  const state = new Map()
  const stack = []

  function visit(name) {
    const node = graph.byName.get(name)
    if (!node) {
      external.add(name)
      return
    }

    const current = state.get(name)
    if (current === 'done') return
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(name)
      const cyclePath = [...stack.slice(cycleStart), name].join(' -> ')
      throw new Error(`检测到 @velaros 依赖环：${cyclePath}`)
    }

    state.set(name, 'visiting')
    stack.push(name)
    for (const dep of node.deps) visit(dep)
    stack.pop()
    state.set(name, 'done')
    order.push(node)
  }

  for (const target of targetNames) visit(target)
  return { external: [...external].sort(), order }
}

function buildPackage(node) {
  if (!node.hasBuild) {
    console.log(`· 跳过 ${node.name}（无 build 脚本）`)
    return
  }

  console.log(`▸ 构建 ${node.name}`)
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: node.dir,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    throw new Error(`无法启动 ${node.name} 构建：${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`
    throw new Error(`构建失败 ${node.name}（${detail}）`)
  }
}

function printHelp() {
  console.log(`VelarOS 包拓扑构建 runner

从 packages/*/package.json 的 @velaros-ai/* 依赖派生真实依赖图，拓扑排序后依序构建。

用法：
  node scripts/build/buildPackageTopology.mjs                 # 全量：拓扑序构建所有包
  node scripts/build/buildPackageTopology.mjs --incremental   # 全量：未变化且产物完整的包跳过
  node scripts/build/buildPackageTopology.mjs --for <pkg>     # 只建某包的依赖闭包 + 自身
  node scripts/build/buildPackageTopology.mjs --list          # 打印拓扑序，不构建

<pkg> 可用 @velaros 全名（@velaros-ai/cli）、后缀（cli）或目录名。
`)
}

function parseArgs(argv) {
  const targets = []
  let list = false
  let incremental = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--list') {
      list = true
      continue
    }
    if (arg === '--incremental') {
      incremental = true
      continue
    }
    if (arg === '--for') {
      const value = argv[index + 1]
      if (!value) throw new Error('--for 需要一个包名')
      targets.push(value)
      index += 1
      continue
    }
    if (arg.startsWith('--for=')) {
      targets.push(arg.slice('--for='.length))
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }

  return { incremental, list, targets }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const graph = scanPackages()

  const targetNames =
    options.targets.length > 0
      ? options.targets.map((raw) => resolveTargetName(graph, raw))
      : [...graph.byName.keys()].sort()

  const { external, order } = resolveBuildOrder(graph, targetNames)

  const mode = options.targets.length > 0 ? `--for ${targetNames.join(', ')}` : '全量'
  console.log(`拓扑构建（${mode}）：${order.map((node) => node.name).join(' -> ')}`)
  if (external.length > 0) {
    console.log(`外部/预构建依赖（跳过）：${external.join(', ')}`)
  }

  if (options.list) return

  const releaseLock = acquireBuildLock()
  const cache = readBuildCache()
  const resolvedFingerprints = new Map()
  let builtCount = 0
  let skippedCount = 0
  try {
    for (const node of order) {
      if (!node.hasBuild) {
        buildPackage(node)
        continue
      }
      const dependencyFingerprints = new Map(
        node.deps.flatMap((dependencyName) => {
          const fingerprint = resolvedFingerprints.get(dependencyName)
          return fingerprint ? [[dependencyName, fingerprint]] : []
        })
      )
      const inputFingerprint = computePackageInputFingerprint(node, dependencyFingerprints)
      const cached = cache.packages[node.name]
      const outputFingerprint = options.incremental
        ? computeBuildOutputFingerprint(node)
        : null
      if (
        options.incremental
        && cached?.inputFingerprint === inputFingerprint
        && cached.outputFingerprint
        && outputFingerprint === cached.outputFingerprint
      ) {
        console.log(`· 跳过 ${node.name}（输入与 dist 均未变化）`)
        resolvedFingerprints.set(node.name, inputFingerprint)
        skippedCount += 1
        continue
      }

      buildPackage(node)
      const builtOutputFingerprint = computeBuildOutputFingerprint(node)
      if (!builtOutputFingerprint)
        throw new Error(`构建 ${node.name} 后缺少 dist 产物，拒绝写入增量缓存。`)
      cache.packages[node.name] = {
        inputFingerprint,
        outputFingerprint: builtOutputFingerprint,
      }
      writeBuildCache(cache)
      resolvedFingerprints.set(node.name, inputFingerprint)
      builtCount += 1
    }
  } finally {
    releaseLock()
  }
  console.log(`完成：构建 ${builtCount} 个包，跳过 ${skippedCount} 个未变化包。`)
}

try {
  main()
} catch (error) {
  console.error(`拓扑构建失败：${error.message}`)
  process.exit(1)
}
