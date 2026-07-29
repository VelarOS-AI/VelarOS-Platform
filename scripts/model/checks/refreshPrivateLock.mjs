#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { LockfileConsistencyValidator } from './lockfileConsistency.mjs'

export class GroupedPrivateLockRefresher {
  #repositoryRoot
  #runUpdate
  #validator

  constructor({
    repositoryRoot = resolve(import.meta.dirname, '../..'),
    runUpdate = runBunUpdate,
    validator,
  } = {}) {
    this.#repositoryRoot = repositoryRoot
    this.#runUpdate = runUpdate
    this.#validator =
      validator ?? new LockfileConsistencyValidator({ repositoryRoot })
  }

  refresh() {
    const updateGroups =
      this.#validator.listExternalVelarosDependencyGroups()
    if (updateGroups.length === 0) {
      throw new Error(
        'No external @velaros-ai packages were found in repository manifests.',
      )
    }
    const manifestSnapshots = new Map(
      this.#validator.listWorkspaceManifestPaths().map((manifestPath) => [
        manifestPath,
        readFileSync(join(this.#repositoryRoot, manifestPath)),
      ]),
    )

    for (const group of updateGroups) {
      this.#runGuardedUpdate(group, manifestSnapshots)
    }
    const validation = this.#validator.validate()
    return {
      ...validation,
      updateGroupCount: updateGroups.length,
    }
  }

  #runGuardedUpdate(group, manifestSnapshots) {
    let updateError
    try {
      this.#runUpdate({
        cwd: join(this.#repositoryRoot, group.directory),
        manifestPath: group.manifestPath,
        packageNames: group.packageNames,
      })
    } catch (error) {
      updateError = error
    }

    const formattingOnlyChanges = []
    const semanticChanges = []
    for (const [manifestPath, source] of manifestSnapshots) {
      const absolutePath = join(this.#repositoryRoot, manifestPath)
      const currentSource = readFileSync(absolutePath)
      if (currentSource.equals(source)) continue

      try {
        const originalManifest = JSON.parse(source.toString('utf8'))
        const currentManifest = JSON.parse(currentSource.toString('utf8'))
        if (isDeepStrictEqual(currentManifest, originalManifest)) {
          formattingOnlyChanges.push(manifestPath)
        } else {
          semanticChanges.push(manifestPath)
        }
      } catch {
        semanticChanges.push(manifestPath)
      }
      writeFileSync(absolutePath, source)
    }
    if (formattingOnlyChanges.length > 0) {
      process.stdout.write(
        `Restored formatting-only manifest changes: ${formattingOnlyChanges.join(', ')}\n`,
      )
    }
    if (semanticChanges.length > 0) {
      throw new Error(
        `bun update changed package manifest semantics; original bytes restored: ${semanticChanges.join(', ')}`,
        updateError ? { cause: updateError } : undefined,
      )
    }
    if (updateError) throw updateError
  }
}

function runBunUpdate({ cwd, manifestPath, packageNames }) {
  process.stdout.write(
    `Refreshing ${manifestPath}: ${packageNames.join(', ')}\n`,
  )
  const result = spawnSync(
    'bun',
    [
      'update',
      ...packageNames,
      '--lockfile-only',
      '--ignore-scripts',
    ],
    {
      cwd,
      env: process.env,
      stdio: 'inherit',
    },
  )
  if (result.error) {
    throw new Error(`bun update failed for ${manifestPath}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `bun update failed for ${manifestPath}${
        result.signal
          ? ` with signal ${result.signal}`
          : ` with exit code ${result.status}`
      }`,
    )
  }
}

function run() {
  const report = new GroupedPrivateLockRefresher().refresh()
  process.stdout.write(
    `Grouped lock refresh passed: ${report.updateGroupCount} manifest groups, ${report.externalResolutionCount} external resolutions.\n`,
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) run()
