#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectReleasePackages,
  ReleaseRegistry,
  selectReleasedPackages,
} from './releaseTopology.mjs'

const DependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]
const IgnoredDirectories = new Set([
  '.git',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
])
const LocalSpecification = /^(?:file|link|portal|workspace):/u
const SimpleSemverSpecification = /^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const CloudDownloadPrefix = `${ReleaseRegistry}/download/`

export function desiredSpecification(current, version) {
  if (LocalSpecification.test(current)) return version
  const match = SimpleSemverSpecification.exec(current)
  if (!match) {
    throw new Error(`Unsupported Platform package version specification: ${current}`)
  }
  return `${match[1] ?? ''}${version}`
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export function replaceRequirementSource(source, packageName, current, desired) {
  const key = JSON.stringify(packageName)
  const value = JSON.stringify(current)
  const pattern = new RegExp(`(${escapeRegExp(key)}\\s*:\\s*)${escapeRegExp(value)}`, 'u')
  const updated = source.replace(pattern, `$1${JSON.stringify(desired)}`)
  if (updated === source) {
    throw new Error(`Unable to locate ${packageName}=${current} in package manifest source`)
  }
  return updated
}

async function collectManifestPaths(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (IgnoredDirectories.has(entry.name)) return []
        return collectManifestPaths(path.join(directory, entry.name))
      }
      return entry.isFile() && entry.name === 'package.json'
        ? [path.join(directory, entry.name)]
        : []
    }),
  )
  return nested.flat().sort()
}

async function readManifests(consumerRoot) {
  return Promise.all(
    (await collectManifestPaths(consumerRoot)).map(async (manifestPath) => {
      const source = await readFile(manifestPath, 'utf8')
      return {
        manifest: JSON.parse(source),
        manifestPath,
        source,
        workspaceKey: path
          .relative(consumerRoot, path.dirname(manifestPath))
          .split(path.sep)
          .join('/'),
      }
    }),
  )
}

function collectRequirements(manifests, platformPackageNames) {
  const ownPackageNames = new Set(
    manifests.map(({ manifest }) => manifest.name).filter((name) => typeof name === 'string'),
  )
  const requirements = []
  for (const item of manifests) {
    for (const field of DependencyFields) {
      for (const [packageName, specification] of Object.entries(item.manifest[field] ?? {})) {
        if (!platformPackageNames.has(packageName) || ownPackageNames.has(packageName)) continue
        if (typeof specification !== 'string') {
          throw new Error(`${packageName} in ${item.manifestPath} must use a string version`)
        }
        requirements.push({ ...item, field, packageName, specification })
      }
    }
  }
  return { ownPackageNames, requirements }
}

function assertRegistryConfiguration(consumerRoot) {
  const npmrcPath = path.join(consumerRoot, '.npmrc')
  if (!existsSync(npmrcPath)) {
    throw new Error(`${consumerRoot} is missing .npmrc for ${ReleaseRegistry}`)
  }
  return readFile(npmrcPath, 'utf8').then((source) => {
    if (!/^@velaros-ai:registry=https:\/\/npm\.pkg\.github\.com\s*$/mu.test(source)) {
      throw new Error(`${npmrcPath} must route @velaros-ai packages to ${ReleaseRegistry}`)
    }
  })
}

function assertCloudSpecifications(requirements) {
  const local = requirements.filter(({ specification }) => LocalSpecification.test(specification))
  if (local.length === 0) return
  throw new Error(
    `External Platform packages must use cloud versions, not local links:\n${local
      .map(
        ({ manifestPath, packageName, specification }) =>
          `  ${manifestPath}: ${packageName}=${specification}`,
      )
      .join('\n')}`,
  )
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function assertRegistryVersions(packages) {
  for (const item of packages) {
    const identity = `${item.manifest.name}@${item.manifest.version}`
    let readable = false
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = spawnSync(
        'bun',
        ['pm', 'view', identity, 'version', '--registry', ReleaseRegistry],
        { encoding: 'utf8', env: process.env },
      )
      const versions = (result.stdout ?? '')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
      if (result.status === 0 && versions.includes(item.manifest.version)) {
        readable = true
        break
      }
      if (attempt < 6) await wait(3_000)
    }
    if (!readable) {
      throw new Error(
        `${identity} is not readable from ${ReleaseRegistry} after 6 attempts; consumer manifests were not changed`,
      )
    }
  }
}

function selectedPackagesFromSelectors(ordered, selectors) {
  const selected = []
  for (const selector of selectors) {
    const match = ordered.find(
      (item) => item.manifest.name === selector || item.directoryName === selector,
    )
    if (!match) throw new Error(`Unknown Platform package selector: ${selector}`)
    if (!selected.includes(match)) selected.push(match)
  }
  return ordered.filter((item) => selected.includes(item))
}

function parseCommaList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseArguments(argv) {
  const result = { only: [], packages: [], validateOnly: false, all: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--validate-only') result.validateOnly = true
    else if (argument === '--all') result.all = true
    else if (['--consumer', '--release-ref', '--only', '--packages'].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      if (argument === '--consumer') result.consumerRoot = path.resolve(value)
      else if (argument === '--release-ref') result.releaseRef = value
      else if (argument === '--only') result.only.push(...parseCommaList(value))
      else result.packages.push(...parseCommaList(value))
    } else throw new Error(`Unsupported argument: ${argument}`)
  }
  const selectionModes = [
    Boolean(result.releaseRef),
    result.all,
    result.packages.length > 0,
  ].filter(Boolean).length
  if (!result.consumerRoot) throw new Error('--consumer is required')
  if (selectionModes !== 1) {
    throw new Error('Choose exactly one package selection: --release-ref, --all, or --packages')
  }
  if (!result.releaseRef && result.only.length > 0) {
    throw new Error('--only is valid only with --release-ref')
  }
  return result
}

async function parseLockfile(lockfilePath) {
  const bunRuntime = Reflect.get(globalThis, 'Bun')
  if (typeof bunRuntime?.JSONC?.parse !== 'function') {
    throw new Error('sync-platform-consumer.mjs must run with Bun.JSONC support')
  }
  return bunRuntime.JSONC.parse(await readFile(lockfilePath, 'utf8'))
}

async function validateLockfile(
  consumerRoot,
  requirements,
  ownPackageNames,
  selectedByName,
  platformPackageNames,
) {
  const lockfilePath = path.join(consumerRoot, 'bun.lock')
  if (!existsSync(lockfilePath)) {
    console.warn(
      `! ${consumerRoot} has no bun.lock; cloud registry and manifest versions were checked`,
    )
    return
  }
  const lockfile = await parseLockfile(lockfilePath)
  for (const requirement of requirements) {
    const lockedSpecification =
      lockfile.workspaces?.[requirement.workspaceKey]?.[requirement.field]?.[
        requirement.packageName
      ]
    if (lockedSpecification !== requirement.specification) {
      throw new Error(
        `${requirement.packageName} lock requirement is ${lockedSpecification ?? '(missing)'}, expected ${requirement.specification}`,
      )
    }
    const entry = lockfile.packages?.[requirement.packageName]
    if (!Array.isArray(entry)) {
      throw new Error(`bun.lock is missing a canonical resolution for ${requirement.packageName}`)
    }
    const selected = selectedByName.get(requirement.packageName)
    if (selected && entry[0] !== `${requirement.packageName}@${selected.manifest.version}`) {
      throw new Error(
        `${requirement.packageName} resolved as ${entry[0]}, expected ${selected.manifest.version}`,
      )
    }
    if (typeof entry[1] !== 'string' || !entry[1].startsWith(CloudDownloadPrefix)) {
      throw new Error(`${requirement.packageName} must resolve from ${CloudDownloadPrefix}`)
    }
  }

  for (const entry of Object.values(lockfile.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const packageName = entry[0].slice(0, entry[0].lastIndexOf('@'))
    if (!platformPackageNames.has(packageName) || ownPackageNames.has(packageName)) continue
    if (typeof entry[1] !== 'string' || !entry[1].startsWith(CloudDownloadPrefix)) {
      throw new Error(`${entry[0]} uses a non-cloud lock resolution: ${entry[1] ?? '(missing)'}`)
    }
  }
}

async function restoreFiles(snapshots) {
  await Promise.all([...snapshots].map(([file, source]) => writeFile(file, source, 'utf8')))
}

async function restoreExpectedManifestSources(expectedSources) {
  for (const [manifestPath, expectedSource] of expectedSources) {
    const currentSource = await readFile(manifestPath, 'utf8')
    if (currentSource === expectedSource) continue
    // `bun update name@version` 会把范围临时改成 exact。清单由本脚本按既定范围策略负责，
    // 因而无条件恢复验明过的目标字节；随后再跑一次 install，让锁文件按恢复后的清单归一化。
    await writeFile(manifestPath, expectedSource, 'utf8')
  }
}

function runLockUpdate(consumerRoot, packageIdentities) {
  const result = spawnSync(
    'bun',
    ['update', ...packageIdentities, '--lockfile-only', '--ignore-scripts'],
    { cwd: consumerRoot, env: process.env, stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`bun update failed with exit code ${result.status ?? 'unknown'}`)
  }
}

function normalizeLockRequirements(consumerRoot) {
  const result = spawnSync('bun', ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: consumerRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `bun install --lockfile-only failed with exit code ${result.status ?? 'unknown'}`,
    )
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  const platformRoot = path.resolve(import.meta.dirname, '../..')
  const { rootManifest, ordered } = await collectReleasePackages(platformRoot)
  const selected = arguments_.releaseRef
    ? selectReleasedPackages(rootManifest, ordered, arguments_.releaseRef, arguments_.only).packages
    : arguments_.all
      ? ordered
      : selectedPackagesFromSelectors(ordered, arguments_.packages)
  const platformPackageNames = new Set(ordered.map((item) => item.manifest.name))
  const selectedByName = new Map(selected.map((item) => [item.manifest.name, item]))

  await assertRegistryConfiguration(arguments_.consumerRoot)
  const originalManifests = await readManifests(arguments_.consumerRoot)
  const originalSnapshots = new Map(
    originalManifests.map(({ manifestPath, source }) => [manifestPath, source]),
  )
  const lockfilePath = path.join(arguments_.consumerRoot, 'bun.lock')
  if (existsSync(lockfilePath))
    originalSnapshots.set(lockfilePath, await readFile(lockfilePath, 'utf8'))

  const initial = collectRequirements(originalManifests, platformPackageNames)
  const selectedRequirements = initial.requirements.filter(({ packageName }) =>
    selectedByName.has(packageName),
  )
  const referencedPackages = selected.filter((item) =>
    selectedRequirements.some(({ packageName }) => packageName === item.manifest.name),
  )
  await assertRegistryVersions(referencedPackages)

  try {
    if (!arguments_.validateOnly) {
      const updatedSources = new Map(originalSnapshots)
      for (const requirement of selectedRequirements) {
        const desired = desiredSpecification(
          requirement.specification,
          selectedByName.get(requirement.packageName).manifest.version,
        )
        if (desired === requirement.specification) continue
        const currentSource = updatedSources.get(requirement.manifestPath)
        updatedSources.set(
          requirement.manifestPath,
          replaceRequirementSource(
            currentSource,
            requirement.packageName,
            requirement.specification,
            desired,
          ),
        )
      }
      for (const { manifestPath } of originalManifests) {
        const updatedSource = updatedSources.get(manifestPath)
        if (updatedSource !== originalSnapshots.get(manifestPath)) {
          await writeFile(manifestPath, updatedSource, 'utf8')
        }
      }
      const expectedManifestSources = new Map(
        originalManifests.map(({ manifestPath }) => [
          manifestPath,
          updatedSources.get(manifestPath),
        ]),
      )
      if (existsSync(lockfilePath) && referencedPackages.length > 0) {
        runLockUpdate(
          arguments_.consumerRoot,
          referencedPackages.map((item) => `${item.manifest.name}@${item.manifest.version}`),
        )
        await restoreExpectedManifestSources(expectedManifestSources)
        normalizeLockRequirements(arguments_.consumerRoot)
      }
    }

    const finalManifests = await readManifests(arguments_.consumerRoot)
    const final = collectRequirements(finalManifests, platformPackageNames)
    assertCloudSpecifications(final.requirements)
    for (const requirement of final.requirements) {
      const selectedPackage = selectedByName.get(requirement.packageName)
      if (!selectedPackage) continue
      const expected = desiredSpecification(
        requirement.specification,
        selectedPackage.manifest.version,
      )
      if (requirement.specification !== expected) {
        throw new Error(
          `${requirement.packageName} remains at ${requirement.specification}; expected ${expected}`,
        )
      }
    }
    await validateLockfile(
      arguments_.consumerRoot,
      final.requirements,
      final.ownPackageNames,
      selectedByName,
      platformPackageNames,
    )
  } catch (error) {
    if (!arguments_.validateOnly) await restoreFiles(originalSnapshots)
    throw error
  }

  console.info(
    `✓ ${path.basename(arguments_.consumerRoot)} checked ${referencedPackages.length} released Platform package(s) from ${ReleaseRegistry}`,
  )
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
