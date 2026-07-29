#!/usr/bin/env bun
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = path.join(repositoryRoot, 'packages')
const expectedRegistryVersions = new Map([
  ['@velaros-ai/core', '0.3.2'],
  ['@velaros-ai/kernel-sdk', '0.2.2'],
])

function assert(condition, message) {
  if (!condition) throw new Error(`Lockfile consistency check failed: ${message}`)
}

async function readJson(filePath) {
  return Bun.file(filePath).json()
}

function dependencySections(manifest) {
  return [
    ['dependencies', manifest.dependencies ?? {}],
    ['optionalDependencies', manifest.optionalDependencies ?? {}],
    ['peerDependencies', manifest.peerDependencies ?? {}],
    ['devDependencies', manifest.devDependencies ?? {}],
  ]
}

async function readWorkspaceRecords() {
  const rootManifest = await readJson(path.join(repositoryRoot, 'package.json'))
  const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const packageRecords = await Promise.all(
    packageDirectories.map(async (directoryName) => ({
      manifest: await readJson(path.join(packagesRoot, directoryName, 'package.json')),
      workspacePath: `packages/${directoryName}`,
    })),
  )
  return [
    { manifest: rootManifest, workspacePath: '' },
    ...packageRecords,
  ]
}

function externalVelarosRequirements(workspaceRecords) {
  const workspacePackageNames = new Set(
    workspaceRecords
      .filter(({ workspacePath }) => workspacePath)
      .map(({ manifest }) => manifest.name),
  )
  const requirements = new Map()

  for (const { manifest } of workspaceRecords) {
    for (const [sectionName, dependencies] of dependencySections(manifest)) {
      for (const [packageName, range] of Object.entries(dependencies)) {
        if (
          !packageName.startsWith('@velaros-ai/')
          || workspacePackageNames.has(packageName)
        ) continue
        const packageRequirements = requirements.get(packageName) ?? []
        packageRequirements.push({
          location: `${manifest.name}.${sectionName}.${packageName}`,
          range,
        })
        requirements.set(packageName, packageRequirements)
      }
    }
  }
  return requirements
}

function resolvedVersion(lockfile, packageName) {
  const resolution = lockfile.packages?.[packageName]?.[0]
  assert(
    typeof resolution === 'string',
    `${packageName} has no concrete registry resolution`,
  )
  const prefix = `${packageName}@`
  assert(
    resolution.startsWith(prefix),
    `${packageName} has malformed resolution ${resolution}`,
  )
  return resolution.slice(prefix.length)
}

const lockfilePath = path.join(repositoryRoot, 'bun.lock')
const lockfile = Bun.JSONC.parse(await Bun.file(lockfilePath).text())
const workspaceRecords = await readWorkspaceRecords()

for (const { manifest, workspacePath } of workspaceRecords) {
  const lockedWorkspace = lockfile.workspaces?.[workspacePath]
  assert(lockedWorkspace, `${manifest.name}: missing workspace snapshot`)
  if (workspacePath) {
    assert(
      lockedWorkspace.version === manifest.version,
      `${manifest.name}: manifest ${manifest.version} does not match workspace snapshot ${lockedWorkspace.version}`,
    )
  }
  for (const [sectionName, dependencies] of dependencySections(manifest)) {
    for (const [dependencyName, dependencyRange] of Object.entries(dependencies)) {
      assert(
        lockedWorkspace[sectionName]?.[dependencyName] === dependencyRange,
        `${manifest.name}: ${sectionName}.${dependencyName} snapshot does not match ${dependencyRange}`,
      )
    }
  }
}

const requirements = externalVelarosRequirements(workspaceRecords)
assert(requirements.size > 0, 'no external @velaros-ai/* dependencies were discovered')
for (const [packageName, packageRequirements] of requirements) {
  const version = resolvedVersion(lockfile, packageName)
  for (const { location, range } of packageRequirements) {
    assert(
      Bun.semver.satisfies(version, range),
      `${location} requires ${range}, but bun.lock resolves ${version}`,
    )
  }
  const expectedVersion = expectedRegistryVersions.get(packageName)
  if (expectedVersion) {
    assert(
      version === expectedVersion,
      `${packageName} must resolve exactly to ${expectedVersion}, got ${version}`,
    )
  }
}

console.info(
  `✓ ${workspaceRecords.length} workspace snapshots and ${requirements.size} external VelarOS registry resolutions are consistent`,
)
