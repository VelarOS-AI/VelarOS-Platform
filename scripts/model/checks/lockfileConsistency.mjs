#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

export class BunSemverEvaluator {
  satisfies(version, range) {
    const result = spawnSync(
      'bun',
      [
        '--eval',
        "process.exit(Bun.semver.satisfies(process.env.ACTUAL_VERSION, process.env.EXPECTED_RANGE) ? 0 : 1)",
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTUAL_VERSION: version,
          EXPECTED_RANGE: range,
        },
      },
    )
    if (result.error) {
      throw new Error(`无法调用 Bun semver：${result.error.message}`)
    }
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(
        `Bun semver 校验失败：${result.stderr.trim() || `exit ${result.status}`}`,
      )
    }
    return result.status === 0
  }
}

export class LockfileConsistencyValidator {
  #repositoryRoot
  #semverEvaluator

  constructor({
    repositoryRoot = resolve(import.meta.dirname, '../..'),
    semverEvaluator = new BunSemverEvaluator(),
  } = {}) {
    this.#repositoryRoot = repositoryRoot
    this.#semverEvaluator = semverEvaluator
  }

  listExternalVelarosDependencyNames() {
    return [...this.#collectExternalVelarosDependencies().keys()].sort()
  }

  listExternalVelarosDependencyGroups() {
    const requirements = this.#collectExternalVelarosDependencies()
    const packageNamesByManifest = new Map()
    for (const [packageName, packageRequirements] of requirements) {
      for (const { manifestPath } of packageRequirements) {
        const packageNames = packageNamesByManifest.get(manifestPath) ?? new Set()
        packageNames.add(packageName)
        packageNamesByManifest.set(manifestPath, packageNames)
      }
    }
    return [...packageNamesByManifest]
      .map(([manifestPath, packageNames]) => ({
        directory:
          manifestPath === 'package.json'
            ? ''
            : manifestPath.slice(0, -'/package.json'.length),
        manifestPath,
        packageNames: [...packageNames].sort(),
      }))
      .sort((left, right) => left.manifestPath.localeCompare(right.manifestPath))
  }

  listWorkspaceManifestPaths() {
    const { workspaceManifests } = this.#readWorkspaceManifests()
    return [
      'package.json',
      ...workspaceManifests.map(
        ({ directory }) => `${directory}/package.json`,
      ),
    ]
  }

  validate() {
    const { rootManifest, workspaceManifests } = this.#readWorkspaceManifests()
    const lockfile = readFileSync(
      join(this.#repositoryRoot, 'bun.lock'),
      'utf8',
    )
    const externalDependencies = this.#collectExternalVelarosDependencies({
      rootManifest,
      workspaceManifests,
    })

    this.#assertWorkspaceManifest('', rootManifest, lockfile, false)
    for (const { directory, manifest } of workspaceManifests) {
      this.#assertWorkspaceManifest(
        directory,
        manifest,
        lockfile,
        true,
      )
    }
    for (const [packageName, requirements] of externalDependencies) {
      this.#assertRegistryResolution(lockfile, packageName, requirements)
    }

    return {
      externalResolutionCount: externalDependencies.size,
      workspaceCount: workspaceManifests.length,
    }
  }

  #assertRegistryResolution(lockfile, packageName, requirements) {
    const escapedName = escapeRegularExpression(packageName)
    const match = new RegExp(
      `"${escapedName}"\\s*:\\s*\\[\\s*"${escapedName}@([^"]+)"\\s*,\\s*"([^"]*)"`,
      'u',
    ).exec(lockfile)

    if (!match) {
      throw new Error(`bun.lock 缺少 registry 解析：${packageName}`)
    }
    const [, actualVersion, registryUrl] = match
    for (const { manifestPath, range } of requirements) {
      if (!this.#semverEvaluator.satisfies(actualVersion, range)) {
        throw new Error(
          `bun.lock 解析 ${packageName}@${actualVersion}，不满足 ${manifestPath} 的 ${range}`,
        )
      }
    }
    if (
      !registryUrl.startsWith('https://npm.pkg.github.com/download/')
      || !registryUrl.includes(`/${actualVersion}/`)
    ) {
      throw new Error(
        `bun.lock 中 ${packageName}@${actualVersion} 不是 GitHub Packages registry 解析`,
      )
    }
  }

  #assertWorkspaceManifest(
    workspaceDirectory,
    manifest,
    lockfile,
    requireVersion,
  ) {
    const workspaceEntry = this.#readWorkspaceEntry(lockfile, workspaceDirectory)
    const label = workspaceDirectory || '<root>'

    if (requireVersion) {
      this.#assertLockProperty(
        workspaceEntry,
        'version',
        manifest.version,
        `${label} version`,
      )
    }
    for (const section of DependencySections) {
      const dependencies = Object.entries(manifest[section] ?? {})
      if (dependencies.length === 0) continue
      const lockSection = this.#readWorkspaceDependencySection(
        workspaceEntry,
        section,
        label,
      )
      for (const [packageName, range] of dependencies) {
        this.#assertLockProperty(
          lockSection,
          packageName,
          range,
          `${label} ${section}.${packageName}`,
        )
      }
    }
  }

  #assertLockProperty(workspaceEntry, propertyName, expectedValue, label) {
    const propertyPattern = new RegExp(
      `"${escapeRegularExpression(propertyName)}"\\s*:\\s*"${escapeRegularExpression(expectedValue)}"`,
      'u',
    )
    if (!propertyPattern.test(workspaceEntry)) {
      throw new Error(`bun.lock 与 manifest 不一致：${label}=${expectedValue}`)
    }
  }

  #collectExternalVelarosDependencies(
    manifests = this.#readWorkspaceManifests(),
  ) {
    const { rootManifest, workspaceManifests } = manifests
    const workspacePackageNames = new Set(
      workspaceManifests.map(({ manifest }) => manifest.name),
    )
    const requirements = new Map()

    for (const { manifest, manifestPath } of [
      { manifest: rootManifest, manifestPath: 'package.json' },
      ...workspaceManifests.map(({ directory, manifest }) => ({
        manifest,
        manifestPath: `${directory}/package.json`,
      })),
    ]) {
      for (const section of DependencySections) {
        for (const [packageName, range] of Object.entries(
          manifest[section] ?? {},
        )) {
          if (
            !packageName.startsWith('@velaros-ai/')
            || workspacePackageNames.has(packageName)
          ) {
            continue
          }
          const packageRequirements = requirements.get(packageName) ?? []
          packageRequirements.push({ manifestPath, range, section })
          requirements.set(packageName, packageRequirements)
        }
      }
    }
    return requirements
  }

  #readManifest(relativePath) {
    return JSON.parse(
      readFileSync(join(this.#repositoryRoot, relativePath), 'utf8'),
    )
  }

  #readWorkspaceEntry(lockfile, workspaceDirectory) {
    const marker = `"${workspaceDirectory}": {`
    const start = lockfile.indexOf(marker)
    if (start === -1) {
      throw new Error(`bun.lock 缺少 workspace：${workspaceDirectory || '<root>'}`)
    }
    const end = lockfile.indexOf('\n    },', start)
    if (end === -1) {
      throw new Error(
        `bun.lock workspace 结构不完整：${workspaceDirectory || '<root>'}`,
      )
    }
    return lockfile.slice(start, end)
  }

  #readWorkspaceDependencySection(workspaceEntry, section, workspaceLabel) {
    const marker = `"${section}": {`
    const start = workspaceEntry.indexOf(marker)
    if (start === -1) {
      throw new Error(
        `bun.lock 与 manifest 不一致：${workspaceLabel} 缺少 ${section}`,
      )
    }
    const end = workspaceEntry.indexOf('\n      },', start)
    if (end === -1) {
      throw new Error(
        `bun.lock workspace 结构不完整：${workspaceLabel} ${section}`,
      )
    }
    return workspaceEntry.slice(start, end)
  }

  #readWorkspaceManifests() {
    const rootManifest = this.#readManifest('package.json')
    const workspaceDirectories = this.#resolveWorkspaceDirectories(
      rootManifest.workspaces,
    )
    return {
      rootManifest,
      workspaceManifests: workspaceDirectories.map((directory) => ({
        directory,
        manifest: this.#readManifest(join(directory, 'package.json')),
      })),
    }
  }

  #resolveWorkspaceDirectories(workspacePatterns = []) {
    const directories = []
    for (const pattern of workspacePatterns) {
      if (!pattern.endsWith('/*')) {
        const manifestPath = join(this.#repositoryRoot, pattern, 'package.json')
        if (existsSync(manifestPath)) directories.push(pattern)
        continue
      }

      const parentDirectory = pattern.slice(0, -2)
      const absoluteParent = join(this.#repositoryRoot, parentDirectory)
      for (const entry of readdirSync(absoluteParent).sort()) {
        const absoluteEntry = join(absoluteParent, entry)
        if (
          statSync(absoluteEntry).isDirectory()
          && existsSync(join(absoluteEntry, 'package.json'))
        ) {
          directories.push(
            relative(this.#repositoryRoot, absoluteEntry).replaceAll('\\', '/'),
          )
        }
      }
    }
    return directories
  }
}

export function assertLockfileConsistency(options) {
  return new LockfileConsistencyValidator(options).validate()
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function run() {
  const validator = new LockfileConsistencyValidator()
  if (process.argv.includes('--list-external-velaros-dependencies')) {
    process.stdout.write(
      `${validator.listExternalVelarosDependencyNames().join(' ')}\n`,
    )
    return
  }

  const report = validator.validate()
  process.stdout.write(
    `Lockfile consistency passed: ${report.workspaceCount} workspaces, ${report.externalResolutionCount} external VelarOS resolutions.\n`,
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) run()
