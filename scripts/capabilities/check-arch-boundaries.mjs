#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import {
  extname,
  relative,
  resolve,
} from 'node:path'

import {
  CapabilityPackages,
  RepositoryUrl,
} from './capability-owners.mjs'

const RepoRoot = resolve(import.meta.dir, '..')
const PackagesRoot = resolve(RepoRoot, 'packages')
const SourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const KnownByName = new Map(CapabilityPackages.map((item) => [item.name, item]))
const ExpectedDirectories = CapabilityPackages.map((item) => item.directory).sort()
const ForbiddenHostImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const InternalImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](@velaros-ai\/[^/'"]+)/
const ElectronImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*)['"]/
const ConcreteKernelPathImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/agent-runtime(?:\/[^'"]*)?|@velaros-ai\/core\/(?:constants\/(?:workspace[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/
const CoreTypesImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core\/types['"]/g
const ConcreteCoreTypeName = /\b(?:Browser|Workspace|Workbench|Model|Memory|Knowledge)[A-Z_a-z0-9]*/
const RequiredPackageFiles = ['dist', 'README.md', 'docs']
const RequiredApiDocumentationSections = [
  '## 定位与非目标',
  '## 安装',
  '## 公共入口',
  '## 核心类与接口',
  '## 生命周期/并发',
  '## 依赖注入',
  '## 错误模型',
  '## 最小第三方示例',
  '## 扩展点',
  '## 兼容策略',
]
const PortableContracts = [
  {
    packageDirectory: 'workspace',
    packageName: '@velaros-ai/workspace',
    modules: new Set([
      './workspace-contracts.js',
      './workspace-root-source.js',
      './workspace-tool-names.js',
    ]),
  },
  {
    packageDirectory: 'browser-core',
    packageName: '@velaros-ai/browser-core',
    modules: new Set([
      './types.js',
      './BrowserAddressHelper.js',
      './BrowserScreenshotPolicy.js',
    ]),
  },
  {
    packageDirectory: 'system-tools',
    packageName: '@velaros-ai/system-tools',
    modules: new Set(['./SystemContracts.js']),
  },
]

const failures = []
const fail = (message) => failures.push(message)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function requirePublicTypeContracts(packageDirectory, contractsFile, typeNames) {
  const packageRoot = resolve(PackagesRoot, packageDirectory)
  const rootSource = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8')
  const contractsSource = readFileSync(resolve(packageRoot, contractsFile), 'utf8')
  const contractsSpecifier = `./${relative(resolve(packageRoot, 'src'), resolve(packageRoot, contractsFile))
    .split('\\')
    .join('/')
    .replace(/\.ts$/u, '')}`

  if (
    !rootSource.includes(`export type * from '${contractsSpecifier}'`)
    && !rootSource.includes(`export type * from '${contractsSpecifier}.js'`)
  ) {
    fail(`${packageDirectory}: root entrypoint must type-export ${contractsSpecifier}`)
  }
  for (const typeName of typeNames) {
    const declaration = new RegExp(`\\bexport\\s+(?:interface|type)\\s+${typeName}\\b`, 'u')
    if (!declaration.test(contractsSource)) {
      fail(`${packageDirectory}: missing public type contract ${typeName}`)
    }
  }
}

function requirePortableContractsEntry({ packageDirectory, packageName, modules }) {
  const packageRoot = resolve(PackagesRoot, packageDirectory)
  const manifest = readJson(resolve(packageRoot, 'package.json'))
  if (
    manifest.exports?.['./contracts']?.types !== './dist/contracts.d.ts'
    || manifest.exports?.['./contracts']?.import !== './dist/contracts.js'
  ) {
    fail(`${packageName}/contracts must publish explicit types and import targets`)
  }

  const contractsPath = resolve(packageRoot, 'src/contracts.ts')
  if (!existsSync(contractsPath)) {
    fail(`${packageName}/contracts is missing src/contracts.ts`)
    return
  }

  const contractsSource = readFileSync(contractsPath, 'utf8')
  const contractImports = [...contractsSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)]
    .map((match) => match[1])
  for (const specifier of contractImports) {
    if (!modules.has(specifier)) {
      fail(`${packageName}/contracts imports forbidden implementation module ${specifier}`)
    }
  }

  const portableSources = [
    ['contracts.ts', contractsSource],
    ...[...modules].map((specifier) => {
      const relativePath = specifier.replace(/^\.\//u, '').replace(/\.js$/u, '.ts')
      return [relativePath, readFileSync(resolve(packageRoot, 'src', relativePath), 'utf8')]
    }),
  ]
  const hostDependencyImport =
    /(?:from\s+|import\s*\(|require\()\s*['"](?:node:[^'"]*|execa(?:\/[^'"]*)?)['"]/u
  for (const [relativePath, source] of portableSources) {
    if (hostDependencyImport.test(source)) {
      fail(`${packageName}/contracts portable module ${relativePath} imports a host dependency`)
    }
  }
}

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) return walk(path)
    return SourceExtensions.has(extname(path)) ? [path] : []
  })
}

function dependencyEntries(manifest) {
  return [
    ['dependencies', manifest.dependencies ?? {}],
    ['optionalDependencies', manifest.optionalDependencies ?? {}],
    ['peerDependencies', manifest.peerDependencies ?? {}],
    ['devDependencies', manifest.devDependencies ?? {}],
  ]
}

const actualDirectories = readdirSync(PackagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(resolve(PackagesRoot, entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort()
if (JSON.stringify(actualDirectories) !== JSON.stringify(ExpectedDirectories)) {
  fail(
    `package set drift: expected ${ExpectedDirectories.join(', ')}, got ${actualDirectories.join(', ')}`,
  )
}

for (const expected of CapabilityPackages) {
  const packageRoot = resolve(PackagesRoot, expected.directory)
  const manifest = readJson(resolve(packageRoot, 'package.json'))
  if (manifest.name !== expected.name) {
    fail(`${expected.directory}: expected package name ${expected.name}, got ${manifest.name}`)
  }
  if (manifest.version !== expected.version) {
    fail(`${expected.name}: expected version ${expected.version}, got ${manifest.version}`)
  }
  if (manifest.repository?.url !== RepositoryUrl) {
    fail(`${expected.name}: repository URL must be ${RepositoryUrl}`)
  }
  if (manifest.repository?.directory !== `packages/${expected.directory}`) {
    fail(`${expected.name}: repository.directory must be packages/${expected.directory}`)
  }
  if (manifest.private === true) {
    fail(`${expected.name}: capability packages must remain independently publishable`)
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim().length < 20) {
    fail(`${expected.name}: package description must explain the public responsibility`)
  }
  const isOpenSourceWorkspace = expected.name === '@velaros-ai/workspace'
  const expectedLicense = isOpenSourceWorkspace ? 'MIT' : 'UNLICENSED'
  if (manifest.license !== expectedLicense) {
    fail(`${expected.name}: package license must be ${expectedLicense}`)
  }
  if (manifest.engines?.node !== '>=20.0.0') {
    fail(`${expected.name}: engines.node must be >=20.0.0`)
  }
  if (manifest.sideEffects !== false) {
    fail(`${expected.name}: package must declare sideEffects=false`)
  }
  for (const requiredFile of RequiredPackageFiles) {
    if (!manifest.files?.includes(requiredFile)) {
      fail(`${expected.name}: package files must include ${requiredFile}`)
    }
  }
  if (isOpenSourceWorkspace && !manifest.files?.includes('LICENSE')) {
    fail(`${expected.name}: package files must include LICENSE`)
  }
  if (!isOpenSourceWorkspace && manifest.files?.includes('LICENSE')) {
    fail(`${expected.name}: restricted package must not publish a LICENSE file`)
  }
  if (
    typeof manifest.exports?.['.'] !== 'object'
    || typeof manifest.exports['.'].types !== 'string'
    || typeof manifest.exports['.'].import !== 'string'
  ) {
    fail(`${expected.name}: root exports must declare types and import targets`)
  }
  if (
    manifest.publishConfig?.access !== 'restricted'
    || manifest.publishConfig?.registry !== 'https://npm.pkg.github.com'
  ) {
    fail(`${expected.name}: publishConfig must target restricted GitHub Packages`)
  }

  const readmePath = resolve(packageRoot, 'README.md')
  const documentationPath = resolve(packageRoot, 'docs/api.zh-CN.md')
  const licensePath = resolve(packageRoot, 'LICENSE')
  if (!existsSync(readmePath) || !readFileSync(readmePath, 'utf8').includes(
    '[中文接口文档](./docs/api.zh-CN.md)',
  )) {
    fail(`${expected.name}: README must link docs/api.zh-CN.md`)
  }
  if (!existsSync(documentationPath)) {
    fail(`${expected.name}: missing docs/api.zh-CN.md`)
  } else {
    const documentation = readFileSync(documentationPath, 'utf8')
    for (const section of RequiredApiDocumentationSections) {
      if (!documentation.includes(section)) {
        fail(`${expected.name}: API documentation is missing ${section}`)
      }
    }
  }
  if (isOpenSourceWorkspace && !existsSync(licensePath)) {
    fail(`${expected.name}: missing package LICENSE`)
  }
  if (!isOpenSourceWorkspace && existsSync(licensePath)) {
    fail(`${expected.name}: restricted package must not contain a package LICENSE`)
  }

  for (const [section, dependencies] of dependencyEntries(manifest)) {
    for (const [name, version] of Object.entries(dependencies)) {
      const internal = KnownByName.get(name)
      if (internal) {
        if (version !== 'workspace:*') {
          fail(`${expected.name}: internal ${section} dependency ${name} must use workspace:*`)
        }
        if (expected.owner !== internal.owner && expected.owner !== 'composition') {
          fail(`${expected.name}: ${expected.owner} owner cannot depend on ${internal.owner} owner (${name})`)
        }
        continue
      }
      if (version === 'workspace:*') {
        fail(`${expected.name}: external ${section} dependency ${name} cannot use workspace:*`)
      }
      if (name === '@velaros-ai/core' && version !== '^0.3.2') {
        fail(`${expected.name}: @velaros-ai/core must use ^0.3.2`)
      }
      if (name === '@velaros-ai/kernel-sdk' && version !== '^0.2.2') {
        fail(`${expected.name}: @velaros-ai/kernel-sdk must use ^0.2.2`)
      }
      if (name === '@velaros-ai/agent-runtime') {
        fail(`${expected.name}: capability packages must not depend on Agent runtime`)
      }
    }
  }

  for (const path of walk(resolve(packageRoot, 'src'))) {
    const source = readFileSync(path, 'utf8')
    if (ForbiddenHostImport.test(source)) {
      fail(`${expected.name}: host import in ${relative(packageRoot, path)}`)
    }
    if (ConcreteKernelPathImport.test(source)) {
      fail(
        `${expected.name}: concrete Kernel semantic import in ${relative(packageRoot, path)}`,
      )
    }
    for (const match of source.matchAll(CoreTypesImport)) {
      if (
        ['browser', 'workspace'].includes(expected.owner)
        && ConcreteCoreTypeName.test(match[1])
      ) {
        fail(
          `${expected.name}: concrete Core type import in ${relative(packageRoot, path)}`,
        )
      }
    }
    if (
      ElectronImport.test(source)
      && expected.name !== '@velaros-ai/browser-runtime'
    ) {
      fail(`${expected.name}: only browser-runtime may import Electron (${relative(packageRoot, path)})`)
    }
    for (const match of source.matchAll(new RegExp(InternalImport.source, 'g'))) {
      const imported = KnownByName.get(match[1])
      if (!imported) continue
      if (expected.owner !== imported.owner && expected.owner !== 'composition') {
        fail(
          `${expected.name}: source crosses ${expected.owner} -> ${imported.owner} in ${relative(packageRoot, path)}`,
        )
      }
    }
  }
}

if (existsSync(resolve(PackagesRoot, 'workspace-agent-tools'))) {
  fail('Workspace must remain one package; workspace-agent-tools must not exist')
}

for (const contracts of PortableContracts) {
  requirePortableContractsEntry(contracts)
}

requirePublicTypeContracts('browser-core', 'src/types.ts', [
  'BrowserActionPolicyConfig',
  'BrowserAutomationMode',
])
requirePublicTypeContracts('workspace', 'src/workspace-contracts.ts', [
  'WorkspaceGitRemoteActionOptions',
  'WorkspaceRootEntry',
])
requirePublicTypeContracts('office-tools', 'src/OfficeContracts.ts', [
  'OfficeEnvironmentInspection',
  'OfficeRuntimePlatform',
])

const officeContractsSource = readFileSync(
  resolve(PackagesRoot, 'office-tools/src/OfficeContracts.ts'),
  'utf8',
)
if (/\bNodeJS\./u.test(officeContractsSource)) {
  fail('office-tools: public OfficeContracts must not depend on NodeJS ambient types')
}

if (failures.length > 0) {
  console.error(`Capability architecture check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

for (const owner of [...new Set(CapabilityPackages.map((item) => item.owner))]) {
  const names = CapabilityPackages
    .filter((item) => item.owner === owner)
    .map((item) => item.name)
  console.info(`✓ ${owner}: ${names.join(', ')}`)
}
console.info('✓ capability ownership, dependency direction, release metadata, and host boundaries')
