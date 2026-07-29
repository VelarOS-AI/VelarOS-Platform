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
  /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/(?:browser-[^'"]*|memory|knowledge|computer-runtime|computer-tools|system-tools|office-tools|model-runtime|kernel-host|kernel-service)(?:\/[^'"]*)?['"]/
const ForbiddenKernelSemanticImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/agent-runtime(?:\/[^'"]*)?|@velaros-ai\/core\/(?:constants\/(?:workspace[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/
const CoreTypesImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core\/types['"]/g
const ConcreteCoreTypeName =
  /\b(?:Browser|Workspace|Workbench|Model|Memory|Knowledge)[A-Z_a-z0-9]*/

const manifest = JSON.parse(readFileSync(ManifestPath, 'utf8'))
const failures = []
const fail = (message) => failures.push(message)

if (manifest.name !== '@velaros-ai/workspace') {
  fail(`package name must be @velaros-ai/workspace, got ${manifest.name}`)
}
if (manifest.version !== '1.2.3') {
  fail(`package version must be 1.2.3, got ${manifest.version}`)
}
if (manifest.repository?.url !== 'git+https://github.com/VelarOS-AI/VelarOS-Capabilities.git') {
  fail('repository URL must point to VelarOS-Capabilities')
}
if (manifest.repository?.directory !== 'packages/capabilities/workspace') {
  fail('repository.directory must be packages/capabilities/workspace')
}
if (
  manifest.exports?.['./agent']?.import !== './dist/agent-runtime/index.js'
  || manifest.exports?.['./agent']?.types !== './dist/agent-runtime/index.d.ts'
) {
  fail('@velaros-ai/workspace/agent must expose the integrated Agent adapter')
}
for (const section of [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]) {
  if (manifest[section]?.['@velaros-ai/agent']) {
    fail(`@velaros-ai/agent must not appear in ${section}`)
  }
}
if (
  manifest.publishConfig?.access !== 'restricted'
  || manifest.publishConfig?.registry !== 'https://npm.pkg.github.com'
) {
  fail('publishConfig must target restricted GitHub Packages')
}

for (const path of walk(RepoRoot)) {
  if (path !== ManifestPath && path.endsWith('/package.json')) {
    fail(`Workspace repository must publish one package only; found ${relative(RepoRoot, path)}`)
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
  console.error(`Workspace architecture check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('✓ one standalone @velaros-ai/workspace package')
console.info('✓ Workspace-owned Agent adapter contracts and host/capability boundaries')

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist') return []
    const path = resolve(directory, entry)
    const stats = statSync(path)
    return stats.isDirectory() ? walk(path) : [path]
  })
}
