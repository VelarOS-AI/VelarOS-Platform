import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const packageScopes = [
  {
    label: 'component library',
    source: 'component-library/src',
    manifest: 'package.json',
    allowedVelarosPackages: new Set([
      '@velaros-ai/conversation-ui',
      '@velaros-ai/ui',
    ]),
  },
  {
    label: '@velaros-ai/ui',
    source: 'packages/ui/src',
    manifest: 'packages/ui/package.json',
    allowedVelarosPackages: new Set(['@velaros-ai/ui']),
  },
  {
    label: '@velaros-ai/conversation-ui',
    source: 'packages/conversation-ui/src',
    manifest: 'packages/conversation-ui/package.json',
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
  const files = await sourceFiles(absoluteDirectory)
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
