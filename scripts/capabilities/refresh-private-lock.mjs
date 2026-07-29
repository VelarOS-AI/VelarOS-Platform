#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = path.join(repositoryRoot, 'packages')

async function readJson(filePath) {
  return Bun.file(filePath).json()
}

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  })
}

const rootManifestPath = path.join(repositoryRoot, 'package.json')
const packageManifestPaths = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packagesRoot, entry.name, 'package.json'))
  .sort()
const manifestRecords = await Promise.all(
  [rootManifestPath, ...packageManifestPaths].map(async (manifestPath) => ({
    directory: path.dirname(manifestPath),
    manifest: await readJson(manifestPath),
    manifestPath,
  })),
)
const workspacePackageNames = new Set(
  manifestRecords
    .filter(({ manifestPath }) => manifestPath !== rootManifestPath)
    .map(({ manifest }) => manifest.name),
)
const protectedManifestPaths = manifestRecords.map(({ manifestPath }) => manifestPath)
const manifestSnapshots = new Map(
  await Promise.all(
    protectedManifestPaths.map(async (manifestPath) => [
      manifestPath,
      await readFile(manifestPath),
    ]),
  ),
)

const updates = manifestRecords.flatMap(({ directory, manifest, manifestPath }) => {
  const packageNames = [
    ...new Set(
      dependencyNames(manifest).filter(
        (packageName) =>
          packageName.startsWith('@velaros-ai/')
          && !workspacePackageNames.has(packageName),
      ),
    ),
  ].sort()
  return packageNames.length > 0
    ? [{ directory, manifest, manifestPath, packageNames }]
    : []
})
if (updates.length === 0) {
  throw new Error('No external @velaros-ai/* dependencies were found in package manifests')
}

let commandFailure
for (const update of updates) {
  console.info(
    `Updating ${update.manifest.name}: ${update.packageNames.join(', ')}`,
  )
  const result = spawnSync(
    'bun',
    [
      'update',
      ...update.packageNames,
      '--lockfile-only',
      '--ignore-scripts',
    ],
    {
      cwd: update.directory,
      env: process.env,
      stdio: 'inherit',
    },
  )
  if (result.error || result.status !== 0) {
    commandFailure = {
      error: result.error,
      exitCode: result.status,
      manifestPath: update.manifestPath,
    }
    break
  }
}
const semanticMutations = []
const restoredFormatting = []
for (const [manifestPath, before] of manifestSnapshots) {
  const after = await readFile(manifestPath)
  if (before.equals(after)) continue

  const beforeManifest = JSON.parse(before.toString('utf8'))
  const afterManifest = JSON.parse(after.toString('utf8'))
  const relativeManifestPath = path.relative(repositoryRoot, manifestPath)
  if (!isDeepStrictEqual(beforeManifest, afterManifest)) {
    semanticMutations.push(relativeManifestPath)
    continue
  }

  await writeFile(manifestPath, before)
  restoredFormatting.push(relativeManifestPath)
}
if (semanticMutations.length > 0) {
  throw new Error(
    `bun update semantically modified protected package manifests: ${semanticMutations.join(', ')}`,
  )
}
const remainingByteMutations = []
for (const [manifestPath, before] of manifestSnapshots) {
  if (!before.equals(await readFile(manifestPath))) {
    remainingByteMutations.push(path.relative(repositoryRoot, manifestPath))
  }
}
if (remainingByteMutations.length > 0) {
  throw new Error(
    `Unable to restore protected package manifests byte-for-byte: ${remainingByteMutations.join(', ')}`,
  )
}
if (restoredFormatting.length > 0) {
  console.info(
    `Restored formatting-only manifest changes: ${restoredFormatting.join(', ')}`,
  )
}
if (commandFailure?.error) throw commandFailure.error
if (commandFailure) {
  throw new Error(
    `bun update failed for ${path.relative(repositoryRoot, commandFailure.manifestPath)} with exit code ${commandFailure.exitCode}`,
  )
}
