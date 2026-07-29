#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import {
  dirname,
  extname,
  relative,
  resolve,
} from 'node:path'

import {
  CapabilityPackages,
  RepositoryUrl,
} from './capability-owners.mjs'

const RepoRoot = resolve(import.meta.dir, '../..')
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
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/agent(?:\/[^'"]*)?|@velaros-ai\/core\/(?:constants\/(?:workspace[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/
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
// 可移植契约入口:exportKey = package.json exports 键,contractsFile = 对应源文件(合包在切片下),
// modules = 该入口只许 import 的可移植模块集合(相对 contractsFile 所在目录)。
const PortableContracts = [
  {
    packageDirectory: 'workspace',
    packageName: '@velaros-ai/workspace',
    exportKey: './contracts',
    contractsFile: 'src/contracts.ts',
    modules: new Set([
      './workspace-contracts.js',
      './workspace-root-source.js',
      './workspace-tool-names.js',
    ]),
  },
  {
    packageDirectory: 'browser',
    packageName: '@velaros-ai/browser/core',
    exportKey: './core/contracts',
    contractsFile: 'src/core/contracts.ts',
    modules: new Set([
      './types.js',
      './BrowserAddressHelper.js',
      './BrowserScreenshotPolicy.js',
    ]),
  },
  {
    packageDirectory: 'system-tools',
    packageName: '@velaros-ai/system-tools',
    exportKey: './contracts',
    contractsFile: 'src/contracts.ts',
    modules: new Set(['./SystemContracts.js']),
  },
]

// packages/ 下的包目录:顶层包 + 一层分组目录(如 capabilities/<pkg>)里的包。
function listPackageDirectories() {
  const found = []
  for (const entry of readdirSync(PackagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(resolve(PackagesRoot, entry.name, 'package.json'))) {
      found.push(entry.name)
      continue
    }
    for (const nested of readdirSync(resolve(PackagesRoot, entry.name), { withFileTypes: true })) {
      if (!nested.isDirectory()) continue
      if (existsSync(resolve(PackagesRoot, entry.name, nested.name, 'package.json'))) {
        found.push(`${entry.name}/${nested.name}`)
      }
    }
  }
  return found
}

const failures = []
const fail = (message) => failures.push(message)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function requirePublicTypeContracts(packageDirectory, rootSourceFile, contractsFile, typeNames) {
  const packageRoot = resolve(PackagesRoot, packageDirectory)
  const rootSourcePath = resolve(packageRoot, rootSourceFile)
  const rootSource = readFileSync(rootSourcePath, 'utf8')
  const contractsSource = readFileSync(resolve(packageRoot, contractsFile), 'utf8')
  const contractsSpecifier = `./${relative(dirname(rootSourcePath), resolve(packageRoot, contractsFile))
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

function requirePortableContractsEntry({
  packageDirectory,
  packageName,
  exportKey,
  contractsFile,
  modules,
}) {
  const packageRoot = resolve(PackagesRoot, packageDirectory)
  const manifest = readJson(resolve(packageRoot, 'package.json'))
  const distBase = `./${contractsFile.replace(/^src\//u, '').replace(/\.ts$/u, '')}`
  if (
    manifest.exports?.[exportKey]?.types !== `./dist/${distBase.slice(2)}.d.ts`
    || manifest.exports?.[exportKey]?.import !== `./dist/${distBase.slice(2)}.js`
  ) {
    fail(`${packageName} ${exportKey} must publish explicit types and import targets`)
  }

  const contractsPath = resolve(packageRoot, contractsFile)
  if (!existsSync(contractsPath)) {
    fail(`${packageName} ${exportKey} is missing ${contractsFile}`)
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
    [contractsFile, contractsSource],
    ...[...modules].map((specifier) => {
      const relativePath = specifier.replace(/^\.\//u, '').replace(/\.js$/u, '.ts')
      return [
        relativePath,
        readFileSync(resolve(dirname(contractsPath), relativePath), 'utf8'),
      ]
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

// VelarOS-Platform 单版本火车:packages/ 是全平台包的公共家,冻结面从「整个 packages/」收敛为
// 「capabilities 域的包集合」。域包清单单源 = 仓根 package.json 的
// velaros.domainPackages.capabilities;新增能力包必须同时登记该清单与 capability-owners.mjs。
const RootManifest = readJson(resolve(RepoRoot, 'package.json'))
const RegisteredDirectories = [
  ...(RootManifest.velaros?.domainPackages?.capabilities ?? []),
].sort()
const PackageDirectories = listPackageDirectories()
const WorkspacePackageNames = new Set(
  PackageDirectories.map((directory) => readJson(resolve(PackagesRoot, directory, 'package.json')).name),
)
const actualDirectories = PackageDirectories
  .filter((name) => RegisteredDirectories.includes(name))
  .sort()
if (JSON.stringify(RegisteredDirectories) !== JSON.stringify(ExpectedDirectories)) {
  fail(
    `package registry drift: velaros.domainPackages.capabilities = ${RegisteredDirectories.join(', ')}, owners table = ${ExpectedDirectories.join(', ')}`,
  )
}
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
  // 入口冻结:合包按切片子路径给入口(无根导出——切片运行面互斥),单入口包仍是 '.'。
  for (const entrySubpath of expected.entrySubpaths) {
    const entry = manifest.exports?.[entrySubpath]
    if (
      typeof entry !== 'object'
      || typeof entry.types !== 'string'
      || typeof entry.import !== 'string'
    ) {
      fail(`${expected.name}: exports["${entrySubpath}"] must declare types and import targets`)
    }
  }
  if (expected.entrySubpaths.includes('.') !== Boolean(manifest.exports?.['.'])) {
    fail(`${expected.name}: root export presence must match the owners table entrySubpaths`)
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
      if (name === '@velaros-ai/agent') {
        fail(`${expected.name}: capability packages must not depend on Agent runtime`)
      }
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
      // 单版本火车:core / kernel-sdk 等平台包已与能力包同仓,写死注册表范围的旧规则(^0.3.2 /
      // ^0.2.2)前提消失——同仓依赖一律 workspace:*,发布时由包管理器代换成具体版本。
      if (WorkspacePackageNames.has(name)) {
        if (version !== 'workspace:*') {
          fail(`${expected.name}: platform ${section} dependency ${name} must use workspace:* (single version train)`)
        }
        continue
      }
      if (version === 'workspace:*') {
        fail(`${expected.name}: external ${section} dependency ${name} cannot use workspace:*`)
      }
    }
  }

  const sourceRoot = resolve(packageRoot, 'src')
  const electronAllowedRoots = expected.electronRoots.map((slice) => resolve(sourceRoot, slice))
  for (const path of walk(sourceRoot)) {
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
      && !electronAllowedRoots.some((root) => path.startsWith(`${root}/`))
    ) {
      fail(
        `${expected.name}: only ${expected.electronRoots.map((slice) => `src/${slice}`).join(' / ') || '(none)'} may import Electron (${relative(packageRoot, path)})`,
      )
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

requirePublicTypeContracts('browser', 'src/core/index.ts', 'src/core/types.ts', [
  'BrowserActionPolicyConfig',
  'BrowserAutomationMode',
])
requirePublicTypeContracts('workspace', 'src/index.ts', 'src/workspace-contracts.ts', [
  'WorkspaceGitRemoteActionOptions',
  'WorkspaceRootEntry',
])
requirePublicTypeContracts('office-tools', 'src/index.ts', 'src/OfficeContracts.ts', [
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
