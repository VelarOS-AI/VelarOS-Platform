#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import {
  dirname,
  extname,
  relative,
  resolve,
} from 'node:path'

import * as ts from 'typescript'

const RepoRoot = resolve(import.meta.dirname, '..')
const WorkspaceRoot = resolve(RepoRoot, '../..')
const ManifestPath = resolve(RepoRoot, 'package.json')
const SourceRoot = resolve(RepoRoot, 'src')
const SourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const ForbiddenHostImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const ForbiddenCapabilityImport =
  /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/(?:browser|memory|computer|system|development|office)(?:\/[^'"]*)?['"]/
const ForbiddenKernelSemanticImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/agent|@velaros-ai\/core\/(?:constants\/(?:project[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/
const CoreTypesImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core\/types['"]/g
const ConcreteCoreTypeName =
  /\b(?:Browser|Project|Workbench|Model|Memory|Knowledge)[A-Z_a-z0-9]*/

const manifest = JSON.parse(readFileSync(ManifestPath, 'utf8'))
const rootManifest = JSON.parse(readFileSync(resolve(WorkspaceRoot, 'package.json'), 'utf8'))
const failures = []
const fail = (message) => failures.push(message)

const TransactionObjectNames = new Set(['tx', 'transaction', 'preparedTx'])

function hasUnmanagedTransactionStatusAssignment(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const stateMachineResults = new Set()
  const collectStateMachineResults = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer?.getText(sourceFile).includes('transactionStateMachine.')
    ) {
      stateMachineResults.add(node.name.text)
    }
    ts.forEachChild(node, collectStateMachineResults)
  }
  collectStateMachineResults(sourceFile)

  let unmanaged = false
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === 'status'
      && ts.isIdentifier(node.left.expression)
      && TransactionObjectNames.has(node.left.expression.text)
    ) {
      const right = node.right.getText(sourceFile)
      if (!right.includes('transactionStateMachine.') && !stateMachineResults.has(right)) {
        unmanaged = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return unmanaged
}

const ForbiddenInternalDependencies = [
  {
    source: (sourcePath) => sourcePath.startsWith('types/'),
    targets: ['core/', 'agent/', 'composition/', 'infrastructure/'],
    label: 'types must not depend on core, Agent, composition, or infrastructure',
  },
  {
    source: (sourcePath) => sourcePath.startsWith('core/'),
    targets: ['agent/'],
    label: 'core must not depend on Agent adapters',
  },
  {
    source: (sourcePath) => sourcePath.startsWith('agent/'),
    targets: ['core/project-kernel'],
    label: 'Agent adapters must not depend on the ProjectKernel implementation',
  },
  {
    source: (sourcePath) => sourcePath === 'transaction-state.ts',
    targets: ['core/project-kernel'],
    label: 'transaction-state must depend on transaction domain types, not ProjectKernel',
  },
]

if (manifest.name !== '@velaros-ai/project') {
  fail(`package name must be @velaros-ai/project, got ${manifest.name}`)
}
// 断言「版本单源」而不是钉死某个字面量版本号：`PROJECT_PACKAGE_VERSION` 会被写进 kernel
// module manifest 与全部内置插件的 version 字段，与 package.json 漂移时，宿主看到的是一个
// 不存在的版本。钉字面量的旧写法让这条门在每次正常升版时变红（实测已卡在 1.2.3 而包已到
// 1.2.5），红成常态的门等于没有门。
const versionConstantSource = readFileSync(resolve(SourceRoot, 'core/defaults.ts'), 'utf8')
const versionConstant = /PROJECT_PACKAGE_VERSION\s*=\s*["']([^"']+)["']/.exec(versionConstantSource)?.[1]
if (versionConstant !== manifest.version) {
  fail(
    `PROJECT_PACKAGE_VERSION (${versionConstant ?? 'not found'}) must match package.json version (${manifest.version})`,
  )
}
if (manifest.repository?.url !== rootManifest.repository?.url) {
  fail('repository URL must point to VelarOS-Platform')
}
if (manifest.repository?.directory !== 'packages/project') {
  fail('repository.directory must be packages/project')
}
if (
  manifest.exports?.['./agent']?.import !== './dist/agent/index.js'
  || manifest.exports?.['./agent']?.types !== './dist/agent/index.d.ts'
) {
  fail('@velaros-ai/project/agent must expose the integrated Agent adapter')
}
if (manifest.peerDependencies?.['@velaros-ai/agent'] !== 'workspace:^') {
  fail('@velaros-ai/project must use the host-owned @velaros-ai/agent peer')
}
if (
  manifest.publishConfig?.access !== 'public'
  || manifest.publishConfig?.registry !== 'https://npm.pkg.github.com'
) {
  fail('publishConfig must target public GitHub Packages')
}

for (const path of walk(RepoRoot)) {
  if (path !== ManifestPath && path.endsWith('/package.json')) {
    fail(`Project package must not contain nested packages; found ${relative(RepoRoot, path)}`)
  }
}

for (const path of walk(SourceRoot)) {
  if (!SourceExtensions.has(extname(path))) continue
  const source = readFileSync(path, 'utf8')
  if (ForbiddenHostImport.test(source)) {
    fail(`host import in ${relative(RepoRoot, path)}`)
  }
  if (ForbiddenCapabilityImport.test(source)) {
    fail(`concrete capability import in ${relative(RepoRoot, path)}`)
  }
  if (ForbiddenKernelSemanticImport.test(source)) {
    fail(`concrete Kernel semantic import in ${relative(RepoRoot, path)}`)
  }
  for (const match of source.matchAll(CoreTypesImport)) {
    if (ConcreteCoreTypeName.test(match[1])) {
      fail(`concrete Core type import in ${relative(RepoRoot, path)}`)
    }
  }
  const sourcePath = relative(SourceRoot, path).replaceAll('\\', '/')
  if (sourcePath === 'core/project-kernel.ts' && hasUnmanagedTransactionStatusAssignment(source, path)) {
    fail('ProjectKernel transaction status changes must go through TransactionStateMachine')
  }
  const importedSpecifiers = ts.preProcessFile(source, true, true).importedFiles
    .map((reference) => reference.fileName)
  for (const rule of ForbiddenInternalDependencies) {
    if (!rule.source(sourcePath)) continue
    for (const specifier of importedSpecifiers) {
      if (!specifier.startsWith('.')) continue
      const targetPath = relative(SourceRoot, resolve(SourceRoot, dirname(sourcePath), specifier))
        .replaceAll('\\', '/')
        .replace(/\.js$/, '')
      if (rule.targets.some((target) => targetPath.startsWith(target))) {
        fail(`${rule.label} in ${sourcePath}: ${specifier}`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Project architecture check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('✓ one standalone @velaros-ai/project package')
console.info('✓ Project-owned Agent adapter contracts and host/capability boundaries')
console.info('✓ Project internal type, core, Agent, and transaction-state dependency directions')
console.info('✓ ProjectKernel transaction lifecycle changes go through TransactionStateMachine')

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist') return []
    const path = resolve(directory, entry)
    const stats = statSync(path)
    return stats.isDirectory() ? walk(path) : [path]
  })
}
