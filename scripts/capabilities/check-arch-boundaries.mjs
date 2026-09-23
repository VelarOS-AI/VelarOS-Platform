#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'

const RepoRoot = resolve(import.meta.dir, '../..')
const PackagesRoot = resolve(RepoRoot, 'packages')
const SourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const ForbiddenHostImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const ElectronImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*)['"]/
// 能力包不许引「带具体域词的公共件」：core 里按空间/模型/记忆/知识命名的常量与工具。
// `@velaros-ai/agent` 的根入口在 1.0.0 之后不在这条禁令里：收口前它是 19 个子目录的通配聚合
// （1,607 个名字），引一下等于把整个运行时拖进来，所以当时要求走窄入口；收口后根入口只剩
// 合同登记的接口与 impl 的实例/工厂（86 个值，`check:module-ownership` 逐个盯着），
// 而那些窄入口（`./run-context` 等）已经按设计删掉，能力包要拿运行期的值只剩根入口一条路。
const ConcreteAgentRuntimeImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/core\/(?:constants\/(?:workspace[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/
const CoreTypesImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core\/types['"]/g
const ConcreteCoreTypeName = /\b(?:Browser|Workspace|Workbench|Model|Memory|Knowledge)[A-Z_a-z0-9]*/
const failures = []
const fail = (message) => failures.push(message)

function requirePublicTypeContracts(
  packageDirectory,
  rootSourceFile,
  contractsEntryFile,
  declarationFile,
  typeNames
) {
  const packageRoot = resolve(PackagesRoot, packageDirectory)
  const rootSourcePath = resolve(packageRoot, rootSourceFile)
  const rootSource = readFileSync(rootSourcePath, 'utf8')
  const contractsSource = readFileSync(resolve(packageRoot, declarationFile), 'utf8')
  const contractsRelative = relative(
    dirname(rootSourcePath),
    resolve(packageRoot, contractsEntryFile)
  )
    .split('\\')
    .join('/')
    .replace(/\.ts$/u, '')
  // 入口与被转发的文件不一定同目录:兄弟目录的说明符已经以 ".." 开头,再加 "./" 就对不上源码。
  const contractsSpecifier = contractsRelative.startsWith('..')
    ? contractsRelative
    : `./${contractsRelative}`

  // 入口可以整片转发（`export * from`），也可以逐个名字转发（去掉 barrel 之后的写法）；
  // 只要根入口确实从这个文件往外转发就算数。
  const forwardsContracts = new RegExp(
    `\\bfrom\\s+['"]${contractsSpecifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\.js)?['"]`,
    'u'
  )
  if (!forwardsContracts.test(rootSource)) {
    fail(`${packageDirectory}: root entrypoint must export ${contractsSpecifier}`)
  }
  for (const typeName of typeNames) {
    const declaration = new RegExp(`\\bexport\\s+(?:interface|type)\\s+${typeName}\\b`, 'u')
    if (!declaration.test(contractsSource)) {
      fail(`${packageDirectory}: missing public type contract ${typeName}`)
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

// 已经拆掉的包不许回来：工具并进了 velaros 的能力单元，空间的装配归产品（ADR 0013），底层能力并进 core 做单元、没人用的协议删掉、
// 工具契约并回 agent 的 `./tool-contract` 入口（ADR 0014）。
for (const obsoleteDirectory of [
  'cli',
  'development',
  'workspace',
  'workspace-agent-tools',
  'system-tools',
  'system',
  'project',
  'surface-protocol',
  'platform',
  'text-files',
  'path-rules',
  'tool-contract',
  'html-artifacts',
]) {
  if (existsSync(resolve(PackagesRoot, obsoleteDirectory)))
    fail(`obsolete capability package directory must be removed: ${obsoleteDirectory}`)
}

// 浏览器整包并进了 velaros 的 browser 单元（ADR 0011）：可移植数据仍要从根入口转发。
requirePublicTypeContracts(
  'velaros',
  'browser/index.ts',
  'browser/contracts.ts',
  'browser/types/browser.ts',
  ['BrowserActionPolicyConfig', 'BrowserAutomationMode']
)
// 浏览器单元的宿主边界：Electron 只许在 impl/electron、utils/electron 与 types/electron.ts 里 import（值和类型都算），
// 其余源码与宿主无关；不许引产品的宿主路径，也不许引 core 里按具体域命名的公共件。
{
  const unitRoot = resolve(PackagesRoot, 'velaros/browser')
  const electronAllowed = ['impl/electron', 'utils/electron', 'types/electron.ts'].map((slice) =>
    resolve(unitRoot, slice)
  )
  const skipped = ['spec', 'test', 'vendor'].map((slice) => resolve(unitRoot, slice))
  for (const path of walk(unitRoot)) {
    if (skipped.some((root) => path.startsWith(`${root}${sep}`))) continue
    const source = readFileSync(path, 'utf8')
    const shown = relative(PackagesRoot, path)
    if (ForbiddenHostImport.test(source)) fail(`velaros/browser: host import in ${shown}`)
    if (ConcreteAgentRuntimeImport.test(source))
      fail(`velaros/browser: capability code must not import domain-named core helpers in ${shown}`)
    for (const match of source.matchAll(CoreTypesImport)) {
      if (ConcreteCoreTypeName.test(match[1]))
        fail(`velaros/browser: concrete Core type import in ${shown}`)
    }
    if (
      ElectronImport.test(source) &&
      !electronAllowed.some((root) => path === root || path.startsWith(`${root}${sep}`))
    ) {
      fail(
        `velaros/browser: only browser/impl/electron / browser/utils/electron / browser/types/electron.ts may import Electron (${shown})`
      )
    }
  }
}
// 办公文档整包并进了 velaros 的 office 单元：可移植数据仍要从根入口转发，也仍不许用 NodeJS 的环境类型。
requirePublicTypeContracts(
  'velaros',
  'office/index.ts',
  'office/contracts.ts',
  'office/types/office.ts',
  ['OfficeEnvironmentInspection']
)

const officeContractsSource = readFileSync(
  resolve(PackagesRoot, 'velaros/office/types/office.ts'),
  'utf8'
)
if (/\bNodeJS\./u.test(officeContractsSource)) {
  fail('velaros/office: public office contracts must not depend on NodeJS ambient types')
}

if (failures.length > 0) {
  console.error(`Capability architecture check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('✓ capability unit contracts, host boundaries, and consolidated package ownership')
