#!/usr/bin/env bun

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packageDirectory = path.join(root, 'packages/model')
const manifestPath = path.join(packageDirectory, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const failures = []

const expected = {
  name: '@velaros-ai/model',
  repository: 'git+https://github.com/VelarOS-AI/VelarOS-Model.git',
}

// 版本锁步已于 2026-08-02 丢弃:包版本各自独立走 semver(见 README「版本方案」与
// scripts/release/releaseTopology.mjs 文件头的「两根轴」)。把 model 钉到某个仓库级版本
// 只会让它没法自己发补丁。这里改锁**平台代**——「同属一代、互相兼容」才是本仓要担保的东西,
// 具体版本号是 model 自己的事。一致性由 releaseTopology 不变量④对全部包统一核验,
// 本域门保留一条同义断言,是因为域门刻意不共享代码(一域被改弱不连带放过其它域)。
const expectedPlatform = rootManifest.velaros?.platform
if (manifest.name !== expected.name) failures.push(`package name must be ${expected.name}`)
if (!expectedPlatform) {
  failures.push('root manifest must declare velaros.platform')
} else if (manifest.velaros?.platform !== expectedPlatform) {
  failures.push(
    `package platform generation ${manifest.velaros?.platform ?? 'missing'} must match root ${expectedPlatform}`,
  )
}
if (manifest.repository?.url !== expected.repository) {
  failures.push(`repository must be ${expected.repository}`)
}
if (manifest.publishConfig?.access !== 'restricted') {
  failures.push('publishConfig.access must remain restricted')
}
if (manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') {
  failures.push('publishConfig.registry must remain GitHub Packages')
}
for (const [subpath, target] of [
  ['./contracts', './dist/contracts.js'],
  ['./catalog', './dist/catalog.js'],
]) {
  if (manifest.exports?.[subpath]?.import !== target) {
    failures.push(`${subpath} must export ${target}`)
  }
}

const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
// 单版本火车:core 已与 model-runtime 同仓,同仓依赖一律 workspace:*
// (发布时由包管理器代换成具体版本),旧的注册表范围锁(^0.3.2 / ^0.2.2)前提消失。
// P2 起 module ABI 并入内核基础层 core(@velaros-ai/core/kernel/abi),kernel-sdk 已解散。
const allowedVelarosDependencies = new Map([
  ['@velaros-ai/core', 'workspace:*'],
])

for (const section of dependencySections) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (/^(file:|link:|portal:)/.test(version)) {
      failures.push(`${section}.${name} must not use local dependency spec ${version}`)
    }
    if (version.startsWith('workspace:') && !allowedVelarosDependencies.has(name)) {
      failures.push(`${section}.${name} must not use local dependency spec ${version}`)
    }
    if (!name.startsWith('@velaros-ai/')) continue
    const expectedVersion = allowedVelarosDependencies.get(name)
    if (!expectedVersion) {
      failures.push(`${section}.${name} is outside the Model -> Kernel dependency boundary`)
    } else if (version !== expectedVersion) {
      failures.push(`${section}.${name} must be ${expectedVersion}, found ${version}`)
    }
  }
}

for (const [name, version] of allowedVelarosDependencies) {
  if (manifest.dependencies?.[name] !== version) {
    failures.push(`dependencies.${name} must be ${version}`)
  }
}

const sourceFiles = await collectFiles(path.join(packageDirectory, 'src'))
const importPattern =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](@velaros-ai\/[^'"]+)['"]/g

for (const file of sourceFiles) {
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]
    const allowed =
      specifier === '@velaros-ai/core' ||
      specifier === '@velaros-ai/core/error' ||
      specifier === '@velaros-ai/core/logger' ||
      specifier === '@velaros-ai/core/kernel/abi'
    if (!allowed) {
      failures.push(
        `${path.relative(root, file)} imports forbidden VelarOS implementation ${specifier}`,
      )
    }
  }
}

const entrySource = await readFile(path.join(packageDirectory, 'src/index.ts'), 'utf8')
for (const ownedExport of [
  './LocalModelEnvironment',
  './ModelCatalog',
  './ModelContracts',
  './ModelProviderCollection',
  './EmbeddingModelSelection',
  './ProviderRuntimeAvailability',
  './ProviderManifest',
]) {
  if (!entrySource.includes(ownedExport)) {
    failures.push(`public entry must export Model-owned contract ${ownedExport}`)
  }
}

for (const nodeOnlyModule of [
  './ModelAdapterRegistry',
  './ModelRuntimeComposition',
  './ProviderScriptRegistry',
  './UserJsModelAdapter',
]) {
  if (
    entrySource.includes(`from '${nodeOnlyModule}'`)
    || entrySource.includes(`from "${nodeOnlyModule}"`)
  ) {
    failures.push(`portable public entry must not export Node-only module ${nodeOnlyModule}`)
  }
}
if (!entrySource.includes('./ProviderScriptRegistryPort')) {
  failures.push('portable public entry must export ProviderScriptRegistryPort')
}
if (!entrySource.includes('./ModelAdapterRegistryPort')) {
  failures.push('portable public entry must export ModelAdapterRegistryPort')
}

const contractsSource = await readFile(
  path.join(packageDirectory, 'src/contracts.ts'),
  'utf8',
)
const contractsStatements = contractsSource
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
if (
  contractsStatements.length === 0
  || contractsStatements.some((statement) => !statement.startsWith('export type '))
) {
  failures.push('contracts entry must contain type-only exports and emit no runtime surface')
}
for (const requiredContractOwner of [
  './ModelContracts',
  './ModelProviderCollection',
  './ProviderManifest',
]) {
  if (!contractsSource.includes(requiredContractOwner)) {
    failures.push(`contracts entry must export types from ${requiredContractOwner}`)
  }
}

const catalogSource = await readFile(
  path.join(packageDirectory, 'src/catalog.ts'),
  'utf8',
)
const catalogOwners = new Set(
  [...catalogSource.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1]),
)
const expectedCatalogOwners = new Set([
  './LocalModelEnvironment',
  './ModelCatalog',
  './ProviderManifest',
])
if (
  catalogOwners.size !== expectedCatalogOwners.size
  || [...catalogOwners].some((owner) => !expectedCatalogOwners.has(owner))
) {
  failures.push(
    'catalog entry may export only LocalModelEnvironment, ModelCatalog, and ProviderManifest',
  )
}
for (const catalogOwner of expectedCatalogOwners) {
  const source = await readFile(
    path.join(packageDirectory, `src/${catalogOwner.slice(2)}.ts`),
    'utf8',
  )
  const executableSource = stripTypeScriptComments(source)
  if (
    /(?:\bprocess\s*\.\s*env\b|\bglobalThis\b[\s\S]{0,120}\bprocess\b)/u.test(
      executableSource,
    )
  ) {
    failures.push(`${catalogOwner} must not discover an ambient process environment`)
  }
  if (/(?:from|import)\s*(?:\([^)]*)?['"]node:/u.test(executableSource)) {
    failures.push(`${catalogOwner} must not import Node builtins`)
  }
}

const nodeEntrySource = await readFile(
  path.join(packageDirectory, 'src/node.ts'),
  'utf8',
)
for (const nodeHostModule of [
  './ModelAdapterRegistry',
  './ModelRuntimeComposition',
  './NodeLocalModelEnvironment',
  './ProviderScriptRegistry',
]) {
  if (!nodeEntrySource.includes(nodeHostModule)) {
    failures.push(`Node entry must export host module ${nodeHostModule}`)
  }
}

const allowedNodeSources = new Set([
  path.join(packageDirectory, 'src/ModelRuntimeComposition.ts'),
  path.join(packageDirectory, 'src/NodeLocalModelEnvironment.ts'),
  path.join(packageDirectory, 'src/ProviderScriptRegistry.ts'),
  path.join(packageDirectory, 'src/UserJsModelAdapter.ts'),
])
for (const file of sourceFiles) {
  const source = await readFile(file, 'utf8')
  const executableSource = stripTypeScriptComments(source)
  if (
    (/(?:from|import)\s*(?:\([^)]*)?['"]node:/u.test(executableSource)
      || /\bprocess\s*\.\s*env\b/u.test(executableSource))
    && !allowedNodeSources.has(file)
  ) {
    failures.push(
      `${path.relative(root, file)} leaks Node host semantics outside the Node entry graph`,
    )
  }
}

for (const helperName of [
  'EmbeddingModelSelection',
  'ProviderRuntimeAvailability',
]) {
  const helperSource = await readFile(
    path.join(packageDirectory, `src/${helperName}.ts`),
    'utf8',
  )
  if (!helperSource.includes('providerCollection: ModelProviderCollection')) {
    failures.push(`${helperName} must receive an explicit ModelProviderCollection`)
  }
  if (
    helperSource.includes('new ModelProviderCollection')
    || helperSource.includes('createModelRuntimeComposition')
    || helperSource.includes('ProviderScriptRegistry')
  ) {
    failures.push(
      `${helperName} must not create or discover mutable provider collection state`,
    )
  }
  if (
    helperSource.includes('@velaros-ai/desktop')
    || helperSource.includes('@velaros-ai/project')
    || helperSource.includes('@velaros-ai/browser')
  ) {
    failures.push(`${helperName} must remain independent of product capabilities`)
  }
}

const compositionSource = await readFile(
  path.join(packageDirectory, 'src/ModelRuntimeComposition.ts'),
  'utf8',
)
if (
  !compositionSource.includes('new ModelProviderCollection(')
  || !compositionSource.includes('this.providerScriptRegistry')
) {
  failures.push('composition must create an explicit ModelProviderCollection')
}
if (
  !compositionSource.includes(
    'readonly providerCollection: ModelProviderCollection',
  )
) {
  failures.push('composition must expose its product-owned providerCollection')
}
if (!compositionSource.includes('readonly velarCloudRuntime: VelarCloudModelRuntime')) {
  failures.push('composition contract must expose its injected VelarCloudModelRuntime')
}

const runtimeSource = await readFile(
  path.join(packageDirectory, 'src/AgentModelRuntime.ts'),
  'utf8',
)
if (runtimeSource.includes("?? 'openrouter'") || runtimeSource.includes("|| 'openrouter'")) {
  failures.push('AgentModelRuntime must not fall back to a global/default provider')
}
if (
  !runtimeSource.includes(
    "requireRecord(value, 'Model Runtime context 必须显式提供。')",
  )
  || runtimeSource.includes('runtimeContext ??')
) {
  failures.push('AgentModelRuntime must require an explicitly injected runtime context')
}

if (failures.length > 0) {
  console.error('Model architecture boundary check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info(
  `Model architecture boundary passed: ${sourceFiles.length} source files, Model-owned provider semantics, generic Core utilities only, zero Agent implementation dependencies.`,
)

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute)))
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(absolute)
    }
  }
  return files.sort()
}

function stripTypeScriptComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
}
