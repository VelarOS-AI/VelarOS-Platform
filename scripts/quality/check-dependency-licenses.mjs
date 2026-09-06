#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(repositoryRoot, 'packages')
const overridePath = join(
  repositoryRoot,
  'third-party-licenses',
  'dependency-license-overrides.json',
)
const allowedLicenseExpressions = new Set([
  '(AFL-2.1 OR BSD-3-Clause)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  '(MIT AND Zlib)',
  '(MIT OR CC0-1.0)',
  '(MIT OR GPL-3.0-or-later)',
  '(MIT OR WTFPL)',
  '(MPL-2.0 OR Apache-2.0)',
  '0BSD',
  'Apache-2.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT/X11',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
])

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function dependencyManifestPath(packageName, fromDirectory) {
  let current = fromDirectory
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'), 'package.json')
    if (existsSync(candidate)) return realpathSync(candidate)
    if (current === repositoryRoot || current === parse(current).root) return undefined
    current = dirname(current)
  }
}

function licenseFromIncludedText(manifestPath) {
  const directory = dirname(manifestPath)
  const licenseFile = readdirSync(directory).find((entry) =>
    /^(?:licen[sc]e|copying)(?:\.|$)/iu.test(entry)
  )
  if (!licenseFile) return undefined
  const text = readFileSync(join(directory, licenseFile), 'utf8').slice(0, 512)
  if (/MIT License/iu.test(text)) return 'MIT'
  return undefined
}

function selectedWorkspaceManifests() {
  return readdirSync(packageRoot)
    .map((directory) => join(packageRoot, directory, 'package.json'))
    .filter(existsSync)
    .filter((manifestPath) => {
      const manifest = readJson(manifestPath)
      return manifest.private !== true || manifest.name === '@velaros-ai/document-renderer'
    })
}

const overrides = readJson(overridePath)
const queue = selectedWorkspaceManifests()
const seenManifests = new Set()
const packages = []
const failures = []

while (queue.length > 0) {
  const manifestPath = realpathSync(queue.shift())
  if (seenManifests.has(manifestPath)) continue
  seenManifests.add(manifestPath)
  const manifest = readJson(manifestPath)
  if (typeof manifest.name !== 'string') continue
  packages.push({ manifest, manifestPath })

  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const packageName of Object.keys(manifest[section] ?? {})) {
      const dependencyPath = dependencyManifestPath(packageName, dirname(manifestPath))
      if (dependencyPath) queue.push(dependencyPath)
      else if (section === 'dependencies') {
        failures.push(`${manifest.name}: installed manifest missing for dependency ${packageName}`)
      }
    }
  }
}

const usedOverrides = new Set()
for (const { manifest, manifestPath } of packages) {
  if (manifest.name.startsWith('@velaros-ai/')) continue
  const identity = `${manifest.name}@${manifest.version}`
  let license = typeof manifest.license === 'string' && manifest.license.trim()
    ? manifest.license.trim()
    : licenseFromIncludedText(manifestPath)
  const override = overrides[identity]
  if (!license && override) {
    license = override.license
    usedOverrides.add(identity)
    const fullLicensePath = join(repositoryRoot, override.licenseFile ?? '')
    if (!existsSync(fullLicensePath)) {
      failures.push(`${identity}: override license file is missing (${override.licenseFile})`)
    }
    if (typeof override.evidence !== 'string' || !/^https:\/\//u.test(override.evidence)) {
      failures.push(`${identity}: override must include an HTTPS evidence URL`)
    }
  }
  if (!license) failures.push(`${identity}: license metadata is missing or unrecognized`)
  else if (!allowedLicenseExpressions.has(license)) {
    failures.push(`${identity}: license is not approved by policy (${license})`)
  }
}

for (const identity of Object.keys(overrides)) {
  if (!usedOverrides.has(identity)) {
    failures.push(`${identity}: stale dependency license override is not used by the runtime closure`)
  }
}

if (failures.length > 0) {
  console.error(`Dependency-license check failed with ${failures.length} issue(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  const thirdPartyCount = packages.filter(({ manifest }) =>
    !manifest.name.startsWith('@velaros-ai/')
  ).length
  console.info(
    `Dependency-license check passed for ${thirdPartyCount} installed third-party runtime package versions (${usedOverrides.size} documented override).`,
  )
}
