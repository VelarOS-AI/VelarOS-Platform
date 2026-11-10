import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as TypeScriptModule from 'typescript'

import { platformReleaseAssetUrl } from './platform-distributions.mjs'
import { resolveTypeScriptJsoncParser } from './releaseTopology.mjs'
import { runGuardedCommand } from './safe-package-pack.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixtures = path.join(import.meta.dirname, 'fixtures/host-contract-consumer')
const packageNames = ['@velaros-ai/velaros', '@velaros-ai/capabilities']
const parseJsonc = resolveTypeScriptJsoncParser(TypeScriptModule)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const inside = (directory, file) => {
  const relative = path.relative(directory, file)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

// 发布身份来自本次 artifacts；下载地址只能由同一官方仓库、tag 和文件名生成。
export function platformReleasePair({ rootManifest, releaseTag, sourceSha, artifacts }) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/u)
  assert.equal(typeof releaseTag, 'string')
  assert(releaseTag)
  assert(Array.isArray(artifacts))
  const packages = packageNames.map((name) => {
    const matching = artifacts.filter((artifact) => artifact.name === name)
    assert.equal(matching.length, 1, `Release must contain exactly one ${name} archive`)
    const artifact = matching[0]
    assert.equal(artifact.sourceSha, sourceSha)
    assert.equal(artifact.releaseTag, releaseTag)
    assert.equal(typeof artifact.version, 'string')
    assert(artifact.version)
    assert.equal(typeof artifact.fileName, 'string')
    assert.match(artifact.fileName, /^[^<>:"|?*\\/\u0000-\u001f]+\.tgz$/u)
    assert.equal(path.basename(artifact.fileName), artifact.fileName)
    assert(Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes > 0)
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u)
    assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
    const url = platformReleaseAssetUrl(rootManifest.repository, releaseTag, artifact.fileName)
    assert.equal(new URL(url).protocol, 'https:')
    assert.equal(new URL(url).hostname, 'github.com')
    if (artifact.url !== undefined) assert.equal(artifact.url, url, 'Artifact URL is not canonical')
    return {
      name,
      version: artifact.version,
      sourceSha,
      releaseTag,
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      url,
    }
  })
  assert.equal(new Set(packages.map((item) => item.fileName)).size, 2)
  assert.equal(new Set(packages.map((item) => item.url)).size, 2)
  return packages
}

// 下载字节必须同时满足本次发布的大小、SHA-256 和 SRI，不能把改写的清单当正式归档。
export function assertPlatformArtifactBytes(artifact, bytes) {
  assert.equal(bytes.byteLength, artifact.sizeBytes, `${artifact.name} archive size changed`)
  assert.equal(sha256(bytes), artifact.sha256, `${artifact.name} archive SHA-256 changed`)
  assert.equal(integrity(bytes), artifact.integrity, `${artifact.name} archive integrity changed`)
}

// Bun 的包条目是数组；只承认条目自身的精确来源和 SRI，不从嵌套依赖文字推断出处。
export function assertPlatformReleaseLockSources(lockfile, packages) {
  assert(lockfile && typeof lockfile === 'object' && !Array.isArray(lockfile))
  assert.equal(
    lockfile.lockfileVersion,
    2,
    'Release consumer requires the observed Bun text lock schema'
  )
  assert.equal(lockfile.overrides, undefined, 'Release consumer lock must not contain overrides')
  assert.equal(
    lockfile.resolutions,
    undefined,
    'Release consumer lock must not contain resolutions'
  )
  assert.deepEqual(
    Object.keys(lockfile.workspaces ?? {}),
    [''],
    'Consumer must be an independent root'
  )
  const workspace = lockfile.workspaces['']
  const entries = lockfile.packages
  assert(entries && typeof entries === 'object' && !Array.isArray(entries))
  return packages.map((artifact) => {
    assert.equal(workspace.dependencies?.[artifact.name], artifact.url)
    const matching = Object.entries(entries).filter(
      ([key]) => key === artifact.name || key.endsWith(`/${artifact.name}`)
    )
    assert.equal(matching.length, 1, `${artifact.name} must have one concrete lock entry`)
    assert.equal(
      matching[0][0],
      artifact.name,
      `${artifact.name} must resolve at the consumer root`
    )
    const entry = matching[0][1]
    assert(Array.isArray(entry), `${artifact.name} lock entry must be an array`)
    assert.equal(entry.length, 3, `${artifact.name} requires the observed URL archive lock tuple`)
    assert.equal(
      entry[0],
      `${artifact.name}@${artifact.url}`,
      `${artifact.name} lock entry lacks its exact official source`
    )
    assert(entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
    assert.equal(
      entry[2],
      artifact.integrity,
      `${artifact.name} lock entry lacks its archive integrity`
    )
    if (artifact.name === '@velaros-ai/capabilities') {
      const base = packages.find((item) => item.name === '@velaros-ai/velaros')
      assert.equal(entry[1].dependencies?.[base.name], base.url)
      assert.equal(entry[1].peerDependencies?.[base.name], undefined)
    }
    return {
      name: artifact.name,
      url: artifact.url,
      integrity: artifact.integrity,
      entrySha256: sha256(JSON.stringify(entry)),
    }
  })
}

const DownloadSource = `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
const [url, target, expected] = process.argv.slice(1)
const artifact = JSON.parse(expected)
const response = await fetch(url, { signal: AbortSignal.timeout(115000) })
assert(response.ok, 'Official release download failed: ' + response.status)
assert.equal(new URL(response.url).protocol, 'https:')
const file = await open(target, 'wx')
const sha256 = createHash('sha256')
const sha512 = createHash('sha512')
let sizeBytes = 0
try {
  for await (const chunk of response.body) {
    sizeBytes += chunk.byteLength
    assert(sizeBytes <= artifact.sizeBytes, 'Official archive exceeds its release size')
    sha256.update(chunk)
    sha512.update(chunk)
    await file.writeFile(chunk)
  }
} finally {
  await file.close()
}
const result = { sizeBytes, sha256: sha256.digest('hex'), integrity: 'sha512-' + sha512.digest('base64') }
assert.equal(result.sizeBytes, artifact.sizeBytes)
assert.equal(result.sha256, artifact.sha256)
assert.equal(result.integrity, artifact.integrity)
console.log(JSON.stringify(result))
`

// 使用已经可公开下载的本次官方 pair；本函数不构建、不打包、不改写依赖来源。
export async function validatePlatformRelease({
  rootManifest,
  releaseTag,
  sourceSha,
  artifacts,
  receiptDirectory,
  bunVersion,
}) {
  assert.equal(process.release.name, 'node', 'Official pair validation must execute in Node')
  assert.equal(
    process.versions.bun,
    undefined,
    'Official pair validation must execute in plain Node'
  )
  const packages = platformReleasePair({ rootManifest, releaseTag, sourceSha, artifacts })
  assert.equal(typeof bunVersion, 'string')
  assert(bunVersion)
  const retained = await realpath(receiptDirectory)
  assert((await lstat(retained)).isDirectory())
  const temporaryRoot = await realpath(tmpdir())
  const directory = await mkdtemp(path.join(temporaryRoot, 'velaros-release-pair-consumer-'))
  assert(inside(temporaryRoot, directory), 'Consumer requires an exclusive temporary subdirectory')
  assert(!inside(await realpath(root), directory), 'Consumer must not inherit workspace modules')
  const consumer = path.join(directory, 'consumer')
  const downloads = path.join(directory, 'downloads')
  await mkdir(consumer)
  await mkdir(downloads)
  const receiptPath = path.join(retained, 'platform-release-pair-receipt.json')
  const typescript = JSON.parse(
    await readFile(path.join(root, 'node_modules/typescript/package.json'), 'utf8')
  ).version
  const nodeTypes = JSON.parse(
    await readFile(path.join(root, 'node_modules/@types/node/package.json'), 'utf8')
  ).version
  const receipt = {
    schemaVersion: 1,
    kind: 'platform-release-pair-consumer',
    sourceSha,
    releaseTag,
    packages,
    toolchain: {
      node: process.version,
      bun: bunVersion,
      typescript,
      nodeTypes,
      platform: process.platform,
      arch: process.arch,
    },
    validation: {
      ordinaryInstall: false,
      frozenInstall: false,
      sameBaseInstance: false,
      strictDeclarations: false,
      actualProjectMutation: false,
      sourceIntegrity: false,
    },
    evidence: { fixtures: {}, downloads: {}, commands: {} },
    local: { directory, consumer, downloads, receiptPath, archives: {}, commands: [] },
  }
  const saveReceipt = () => writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'BUN_INSTALL_CACHE_DIR'].includes(
          name.toUpperCase()
        )
    )
  )
  environment.BUN_INSTALL_CACHE_DIR = path.join(directory, 'bun-cache')
  environment.NODE_OPTIONS = '--max-old-space-size=2048'
  const run = async (label, command, args, timeoutMs = 120_000) => {
    const result = await runGuardedCommand({
      command,
      args,
      cwd: consumer,
      env: environment,
      timeoutMs,
      operation: label,
    })
    receipt.local.commands.push({
      label,
      command,
      args,
      stdout: result.stdout,
      stderr: result.stderr,
    })
    receipt.evidence.commands[label] = {
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    }
    await saveReceipt()
    return result
  }
  try {
    assert.equal(
      (await run('Read the release consumer Bun version', 'bun', ['--version'])).stdout.trim(),
      bunVersion
    )
    for (const artifact of packages) {
      const original = path.join(retained, artifact.fileName)
      assert(inside(retained, original), 'Release archive must remain inside its receipt directory')
      assert((await lstat(original)).isFile(), 'Release archive must be a regular retained file')
      const originalBytes = await readFile(original)
      assertPlatformArtifactBytes(artifact, originalBytes)
      const download = path.join(downloads, artifact.fileName)
      assert(
        inside(downloads, download),
        'Official download must remain inside its exclusive directory'
      )
      const downloaded = await run(`Download official ${artifact.name} archive`, process.execPath, [
        '--input-type=module',
        '--eval',
        DownloadSource,
        artifact.url,
        download,
        JSON.stringify(artifact),
      ])
      const downloadedBytes = await readFile(download)
      assertPlatformArtifactBytes(artifact, downloadedBytes)
      assert(
        downloadedBytes.equals(originalBytes),
        'Official asset differs from this release candidate'
      )
      receipt.evidence.downloads[artifact.name] = JSON.parse(downloaded.stdout.trim())
      receipt.local.archives[artifact.fileName] = { original, download }
      await saveReceipt()
    }
    const manifest = {
      name: 'velaros-official-release-pair-consumer',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(packages.map((artifact) => [artifact.name, artifact.url])),
      devDependencies: { typescript, '@types/node': nodeTypes },
    }
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(path.join(consumer, 'package.json'), manifestSource, { flag: 'wx' })
    await writeFile(
      path.join(consumer, 'expected-release-pair.json'),
      `${JSON.stringify(packages)}\n`,
      { flag: 'wx' }
    )
    receipt.evidence.manifestSha256 = sha256(manifestSource)
    for (const fileName of [
      'platform-installed-pair.mjs',
      'platform-release-consumer.mts',
      'capability-runtime.mjs',
    ]) {
      receipt.evidence.fixtures[fileName] = {
        sha256: sha256(await readFile(path.join(fixtures, fileName))),
      }
      await copyFile(path.join(fixtures, fileName), path.join(consumer, fileName))
    }
    await saveReceipt()
    await run(
      'Ordinary Bun install of the official Platform pair',
      'bun',
      ['install', '--ignore-scripts'],
      180_000
    )
    receipt.validation.ordinaryInstall = true
    await saveReceipt()
    const lockPath = path.join(consumer, 'bun.lock')
    const lockSource = await readFile(lockPath, 'utf8')
    const parsed = parseJsonc(lockPath, lockSource)
    assert(!parsed.error, `Unable to parse Bun lock: TypeScript diagnostic ${parsed.error?.code}`)
    receipt.evidence.lockSources = assertPlatformReleaseLockSources(parsed.config, packages)
    receipt.evidence.lockfileVersion = parsed.config.lockfileVersion
    receipt.evidence.lockSha256 = sha256(lockSource)
    await run(
      'Frozen Bun install of the same official Platform pair',
      'bun',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      180_000
    )
    assert.equal(
      sha256(await readFile(lockPath)),
      receipt.evidence.lockSha256,
      'Frozen install changed the lockfile'
    )
    assert.deepEqual(
      JSON.parse(await readFile(path.join(consumer, 'package.json'), 'utf8')),
      manifest
    )
    assert.deepEqual((await readdir(path.join(consumer, 'node_modules/@velaros-ai'))).sort(), [
      'capabilities',
      'velaros',
    ])
    receipt.validation.frozenInstall = true
    await saveReceipt()
    const identity = await run(
      'Resolve the installed Platform pair in plain Node',
      process.execPath,
      ['platform-installed-pair.mjs']
    )
    const installedPair = JSON.parse(identity.stdout.trim())
    assert.equal(installedPair.sameBaseInstance, true)
    assert.equal(installedPair.baseVersion, packages[0].version)
    assert.equal(installedPair.capabilitiesVersion, packages[1].version)
    for (const file of [
      installedPair.topLevelResolvedBase,
      installedPair.extensionResolvedBase,
      installedPair.resolvedCapabilities,
    ])
      assert(
        inside(path.join(consumer, 'node_modules'), file),
        'Installed pair resolved outside the independent consumer'
      )
    assert.equal(installedPair.topLevelResolvedBase, installedPair.extensionResolvedBase)
    receipt.local.installedPair = installedPair
    receipt.evidence.installedPair = {
      baseVersion: installedPair.baseVersion,
      capabilitiesVersion: installedPair.capabilitiesVersion,
      sameBaseInstance: true,
      baseManifestSha256: installedPair.baseManifestSha256,
      capabilitiesManifestSha256: installedPair.capabilitiesManifestSha256,
    }
    receipt.validation.sameBaseInstance = true
    receipt.validation.sourceIntegrity = true
    await saveReceipt()
    await run('Strict declarations for the official Platform pair', process.execPath, [
      path.join(consumer, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--types',
      'node',
      'platform-release-consumer.mts',
    ])
    receipt.validation.strictDeclarations = true
    await saveReceipt()
    const runtime = await run(
      'One shared Runtime with an actual Project file transaction',
      process.execPath,
      ['capability-runtime.mjs']
    )
    const result = JSON.parse(runtime.stdout.trim().split(/\r?\n/u).at(-1))
    assert.equal(result.explicitProject, true)
    assert.equal(result.sharedRuntime, true)
    assert.equal(result.actualFileChange, true)
    receipt.evidence.projectTransaction = { ...result, outputSha256: sha256(runtime.stdout) }
    receipt.validation.actualProjectMutation = true
    for (const artifact of packages) {
      const original = await readFile(path.join(retained, artifact.fileName))
      const downloaded = await readFile(path.join(downloads, artifact.fileName))
      assertPlatformArtifactBytes(artifact, original)
      assertPlatformArtifactBytes(artifact, downloaded)
      assert(original.equals(downloaded))
    }
    await saveReceipt()
    return receipt
  } catch (error) {
    receipt.local.failure = error instanceof Error ? error.message : String(error)
    try {
      await saveReceipt()
    } catch (receiptError) {
      console.error('Unable to preserve failed Platform pair receipt', receiptError)
    }
    throw error
  }
}
