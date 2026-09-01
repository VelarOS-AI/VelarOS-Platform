#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import {
  extname,
  relative,
  resolve,
} from 'node:path'

const RepoRoot = resolve(import.meta.dirname, '..')
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
const failures = []
const fail = (message) => failures.push(message)

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
if (manifest.repository?.url !== 'git+https://github.com/VelarOS-AI/VelarOS-Platform.git') {
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
if (manifest.peerDependencies?.['@velaros-ai/agent'] !== 'workspace:*') {
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
}

if (failures.length > 0) {
  console.error(`Project architecture check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('✓ one standalone @velaros-ai/project package')
console.info('✓ Project-owned Agent adapter contracts and host/capability boundaries')

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist') return []
    const path = resolve(directory, entry)
    const stats = statSync(path)
    return stats.isDirectory() ? walk(path) : [path]
  })
}
