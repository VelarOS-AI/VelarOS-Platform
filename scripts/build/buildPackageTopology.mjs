#!/usr/bin/env node
// 用途：从 packages/*/package.json 的 @velaros-ai/* 依赖派生真实依赖图，拓扑排序后依序构建各包（支持 --for 依赖闭包与全量两种模式）。

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
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
const RootBuildInputPaths = ['bun.lock', 'bunfig.toml', 'package.json', 'tsconfig.json']

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
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
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
  for (const [name, fingerprint] of [...dependencyFingerprints.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBuildCache(value) {
  return (
    isRecord(value) &&
    value.schemaVersion === BUILD_CACHE_SCHEMA_VERSION &&
    Object.keys(value).length === 2 &&
    isRecord(value.packages) &&
    Object.entries(value.packages).every(
      ([name, entry]) =>
        name.trim() !== '' &&
        isRecord(entry) &&
        Object.keys(entry).length === 2 &&
        typeof entry.inputFingerprint === 'string' &&
        /^[a-f0-9]{64}$/u.test(entry.inputFingerprint) &&
        typeof entry.outputFingerprint === 'string' &&
        /^[a-f0-9]{64}$/u.test(entry.outputFingerprint)
    )
  )
}

function readBuildCache() {
  const empty = () => ({ schemaVersion: BUILD_CACHE_SCHEMA_VERSION, packages: {} })
  try {
    const parsed = readJson(BUILD_CACHE_PATH)
    return isBuildCache(parsed) ? parsed : empty()
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return empty()
    throw new Error(`无法读取构建缓存 ${BUILD_CACHE_PATH}：${error.message}`, { cause: error })
  }
}

function writeBuildCache(cache) {
  mkdirSync(BUILD_STATE_DIR, { recursive: true })
  const temporaryPath = `${BUILD_CACHE_PATH}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, BUILD_CACHE_PATH)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function assertBuildLockDirectory() {
  try {
    if (!lstatSync(BUILD_LOCK_PATH).isDirectory())
      throw new Error(`包构建锁不是当前目录格式：${BUILD_LOCK_PATH}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function readBuildLockOwner() {
  try {
    assertBuildLockDirectory()
    const entries = readdirSync(BUILD_LOCK_PATH, { withFileTypes: true })
    if (entries.length === 0) return undefined
    const [entry] = entries
    if (
      entries.length !== 1 ||
      !entry.isFile() ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.owner$/u.test(entry.name)
    )
      throw new Error(`包构建锁 owner 无效：${BUILD_LOCK_PATH}`)
    const path = resolve(BUILD_LOCK_PATH, entry.name)
    const text = readFileSync(path, 'utf8')
    const pid = Number(text.trim())
    if (!/^[1-9]\d*\n$/u.test(text) || !Number.isSafeInteger(pid))
      throw new Error(`包构建锁 PID 无效：${path}`)
    return { path, pid }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function reclaimBuildLock() {
  const owner = readBuildLockOwner()
  if (owner) {
    if (isProcessAlive(owner.pid))
      throw new Error(`已有包拓扑构建正在运行（pid ${owner.pid}），拒绝并发清理 dist。`)
    try {
      unlinkSync(owner.path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    rmdirSync(BUILD_LOCK_PATH)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
}

function acquireBuildLock() {
  mkdirSync(BUILD_STATE_DIR, { recursive: true })
  const staging = mkdtempSync(`${BUILD_LOCK_PATH}.`)
  const ownerName = `${randomUUID()}.owner`
  try {
    writeFileSync(resolve(staging, ownerName), `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    // Windows rename 可替换已存在的普通文件；发布前先拒绝未知锁形态。
    assertBuildLockDirectory()
    try {
      renameSync(staging, BUILD_LOCK_PATH)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error
      reclaimBuildLock()
      renameSync(staging, BUILD_LOCK_PATH)
    }
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '包构建锁发布与临时目录清理均失败')
    }
    throw error
  }
  return () => {
    // 只删自己发布的 nonce；旧 owner 的收尾不能移除继任者的非空目录。
    unlinkSync(resolve(BUILD_LOCK_PATH, ownerName))
    try {
      rmdirSync(BUILD_LOCK_PATH)
    } catch (error) {
      // 自己的 marker 已释放；并发者可能已收走空目录或发布新 marker。
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
    }
  }
}

async function withBuildLock(consume) {
  const release = acquireBuildLock()
  let result
  try {
    result = await consume()
  } catch (error) {
    try {
      release()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '包构建与锁释放均失败')
    }
    throw error
  }
  release()
  return result
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

// Workspace packages are flat: every package lives at packages/<package>/.
function listPackageDirectories() {
  const found = []
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = resolve(PACKAGES_DIR, entry.name, 'package.json')
    try {
      if (!statSync(manifestPath).isFile()) throw new Error(`包清单必须是文件：${manifestPath}`)
      found.push(entry.name)
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(`无法读取包清单 ${manifestPath}：${error.message}`, { cause: error })
    }
  }
  return found
}

function scanPackages() {
  const byName = new Map()
  const byDir = new Map()

  for (const directory of listPackageDirectories()) {
    const manifestPath = resolve(PACKAGES_DIR, directory, 'package.json')
    let manifest
    try {
      manifest = readJson(manifestPath)
    } catch (error) {
      throw new Error(`无法读取包清单 ${manifestPath}：${error.message}`, { cause: error })
    }
    if (
      !isRecord(manifest) ||
      typeof manifest.name !== 'string' ||
      manifest.name.trim() === '' ||
      manifest.name !== manifest.name.trim()
    )
      throw new Error(`包清单缺少有效 name：${manifestPath}`)
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'scripts']) {
      const value = manifest[section]
      if (
        value !== undefined &&
        (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string'))
      )
        throw new Error(`包清单 ${section} 必须是字符串映射：${manifestPath}`)
    }
    const duplicate = byName.get(manifest.name)
    if (duplicate)
      throw new Error(
        `包清单 name 重复（${manifest.name}）：${resolve(duplicate.dir, 'package.json')} 与 ${manifestPath}`
      )

    const node = {
      name: manifest.name,
      dir: resolve(PACKAGES_DIR, directory),
      dirName: directory,
      deps: collectVelarosDeps(manifest),
      hasBuild: Boolean(manifest.scripts && manifest.scripts.build),
    }
    byName.set(node.name, node)
    byDir.set(directory, node.name)
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

<pkg> 可用 @velaros 全名（@velaros-ai/velaros）、后缀（velaros）或目录名。
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

// 打包复用构建器的输入/产物指纹，并在整个消费期间持有同一把构建锁。
export async function withVerifiedPackageBuilds(targets, consume) {
  const graph = scanPackages()
  const { external, order } = resolveBuildOrder(
    graph,
    targets.map((target) => resolveTargetName(graph, target))
  )
  if (external.length)
    throw new Error(`Cannot verify external build dependencies: ${external.join(', ')}`)
  return withBuildLock(async () => {
    const verify = () => {
      const cache = readBuildCache()
      const resolvedFingerprints = new Map()
      const proof = {}
      for (const node of order) {
        const dependencies = new Map(
          node.deps.map((name) => [name, resolvedFingerprints.get(name)])
        )
        const inputFingerprint = computePackageInputFingerprint(node, dependencies)
        // 无构建的资源包只证明源输入，其指纹仍参与下游依赖链。
        const entry = { inputFingerprint }
        if (node.hasBuild) {
          const outputFingerprint = computeBuildOutputFingerprint(node)
          const cached = cache.packages[node.name]
          if (
            !outputFingerprint ||
            cached?.inputFingerprint !== inputFingerprint ||
            cached?.outputFingerprint !== outputFingerprint
          )
            throw new Error(
              `Stale or unverified build for ${node.name}; run the package topology build before preparing a candidate`
            )
          entry.outputFingerprint = outputFingerprint
        }
        resolvedFingerprints.set(node.name, inputFingerprint)
        proof[node.name] = entry
      }
      return proof
    }
    const proof = verify()
    const result = await consume(proof)
    if (JSON.stringify(verify()) !== JSON.stringify(proof))
      throw new Error('Build inputs or outputs changed while preparing the candidate')
    return result
  })
}

async function main() {
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

  let builtCount = 0
  let skippedCount = 0
  await withBuildLock(() => {
    const cache = readBuildCache()
    const resolvedFingerprints = new Map()
    for (const node of order) {
      const dependencyFingerprints = new Map(
        node.deps.flatMap((dependencyName) => {
          const fingerprint = resolvedFingerprints.get(dependencyName)
          return fingerprint ? [[dependencyName, fingerprint]] : []
        })
      )
      const inputFingerprint = computePackageInputFingerprint(node, dependencyFingerprints)
      if (!node.hasBuild) {
        buildPackage(node)
        resolvedFingerprints.set(node.name, inputFingerprint)
        continue
      }
      const cached = cache.packages[node.name]
      const outputFingerprint = options.incremental ? computeBuildOutputFingerprint(node) : null
      if (
        options.incremental &&
        cached?.inputFingerprint === inputFingerprint &&
        cached.outputFingerprint &&
        outputFingerprint === cached.outputFingerprint
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
  })
  console.log(`完成：构建 ${builtCount} 个包，跳过 ${skippedCount} 个未变化包。`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(`拓扑构建失败：${error.message}`)
    process.exit(1)
  }
}
