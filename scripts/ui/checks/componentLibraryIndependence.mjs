import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const packageScopes = [
  {
    label: 'component library',
    source: 'component-library/src',
    // The component library has no standalone manifest, so its dependency boundary is
    // enforced from source imports. Package manifests are checked by their own scopes.
    manifest: undefined,
    // 说明符按包名归一(@velaros-ai/ui/conversation → @velaros-ai/ui),所以两切片写一个包名即可。
    allowedVelarosPackages: new Set(['@velaros-ai/ui']),
  },
  {
    // P7a 合包后 conversation 是 ui 包的一个切片:**源码面**仍按切片分别设防,
    // 主干切片扫描时排除 src/conversation。
    label: '@velaros-ai/ui(主干切片)',
    source: 'packages/ui/src',
    excludeSources: ['packages/ui/src/conversation'],
    manifest: undefined,
    allowedVelarosPackages: new Set(['@velaros-ai/ui']),
  },
  {
    label: '@velaros-ai/ui/conversation(切片)',
    source: 'packages/ui/src/conversation',
    // **清单面**只有一份(合包只有一个 package.json),挂在本 scope 上,允许集 = 两切片并集。
    manifest: 'packages/ui/package.json',
    allowedVelarosPackages: new Set([
      '@velaros-ai/html-artifacts',
      '@velaros-ai/ui',
    ]),
  },
]

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(absolutePath)
      return /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [absolutePath] : []
    })
  )
  return files.flat()
}

function importedSpecifiers(source) {
  const specifiers = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*['"]([^'"]+)['"]/gu,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

function packageName(specifier) {
  if (!specifier.startsWith('@velaros-ai/')) return null
  return specifier.split('/').slice(0, 2).join('/')
}

async function findForbiddenSourceImports(scope) {
  const absoluteDirectory = path.join(repositoryRoot, scope.source)
  const excluded = (scope.excludeSources ?? []).map((entry) => path.join(repositoryRoot, entry))
  const files = (await sourceFiles(absoluteDirectory))
    .filter((file) => !excluded.some((entry) => file.startsWith(`${entry}${path.sep}`)))
  const violations = []

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const specifier of importedSpecifiers(source)) {
      const dependency = packageName(specifier)
      if (!dependency || scope.allowedVelarosPackages.has(dependency)) continue
      violations.push(`${path.relative(repositoryRoot, file)} -> ${specifier}`)
    }
  }
  return violations
}

async function readManifest(relativeManifest) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativeManifest), 'utf8'))
}

async function findForbiddenManifestDependencies(scope) {
  if (!scope.manifest) return []
  const manifest = await readManifest(scope.manifest)
  const dependencyGroups = [
    manifest.dependencies ?? {},
    manifest.devDependencies ?? {},
    manifest.peerDependencies ?? {},
    manifest.optionalDependencies ?? {},
  ]
  const violations = []

  for (const [name, version] of dependencyGroups.flatMap((group) => Object.entries(group))) {
    const dependency = packageName(name)
    if (dependency && !scope.allowedVelarosPackages.has(dependency)) {
      violations.push(`${scope.manifest} -> ${name}`)
    }
    if (/^(?:file|link|portal):/u.test(version)) {
      violations.push(`${scope.manifest} -> ${name}@${version} (local-only protocol)`)
    }
  }
  return violations
}

async function findUiPackageSurfaceViolations() {
  const manifest = await readManifest('packages/ui/package.json')
  const violations = []
  if ((manifest.files ?? []).includes('src')) {
    violations.push('packages/ui/package.json -> files includes unpublished source tree')
  }
  if (Object.keys(manifest.exports ?? {}).some((entry) => entry.includes('*'))) {
    violations.push('packages/ui/package.json -> wildcard package export')
  }
  return violations
}

const violations = (
  await Promise.all([
    ...packageScopes.flatMap((scope) => [
      findForbiddenSourceImports(scope),
      findForbiddenManifestDependencies(scope),
    ]),
    findUiPackageSurfaceViolations(),
  ])
).flat()

if (violations.length > 0) {
  console.error('UI runtime independence check failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(
  'UI runtime independence: component catalog and both UI packages use only UI-owned contracts/ports.'
)
