#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
const productRoot = join(repoRoot, 'products', 'document-renderer')
const outputRoot = join(repoRoot, 'dist-document-renderer')
const releaseRoot = join(repoRoot, 'release', 'document-renderer')
const requireFromRenderer = createRequire(
  join(repoRoot, 'packages', 'document-renderer', 'package.json'),
)
const supportedTargets = new Map([
  ['darwin-arm64', {
    launcherExtension: '',
    runtimeName: 'bun',
    archiveExtension: 'arm64.zip',
    canvasPackage: 'canvas-darwin-arm64',
    canvasBinary: 'skia.darwin-arm64.node',
  }],
  ['win32-x64', {
    launcherExtension: '.cmd',
    runtimeName: 'bun.exe',
    archiveExtension: 'x64.zip',
    canvasPackage: 'canvas-win32-x64-msvc',
    canvasBinary: 'skia.win32-x64-msvc.node',
  }],
  ['linux-x64', {
    launcherExtension: '',
    runtimeName: 'bun',
    archiveExtension: 'x86_64.tar.gz',
    canvasPackage: 'canvas-linux-x64-gnu',
    canvasBinary: 'skia.linux-x64-gnu.node',
  }],
])

function parseArguments(argv) {
  const options = { notarize: false, adHoc: false }
  for (const argument of argv) {
    if (argument === '--notarize') options.notarize = true
    else if (argument === '--adhoc') options.adHoc = true
    else throw new Error(`Unknown Document Renderer packaging option: ${argument}`)
  }
  if (options.notarize && options.adHoc) {
    throw new Error('--notarize and --adhoc cannot be used together')
  }
  return options
}

function currentTarget(host = { platform: process.platform, arch: process.arch }) {
  const target = `${host.platform}-${host.arch}`
  if (!supportedTargets.has(target)) {
    throw new Error(
      `Document Renderer packs must be built natively on darwin-arm64, win32-x64, or linux-x64; received ${target}`,
    )
  }
  return target
}

async function run(command, arguments_, options = {}) {
  try {
    return await execFileAsync(command, arguments_, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const detail = String(
      error?.stderr ?? error?.stdout ?? error?.message ?? error,
    ).trim()
    throw new Error(
      `${command} ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    )
  }
}

async function readVersion() {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'packages', 'document-renderer', 'package.json'), 'utf8'),
  )
  if (
    typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version)
  ) throw new Error('packages/document-renderer/package.json contains an invalid version')
  return manifest.version
}

async function resolveBunExecutable(target) {
  const locator = target === 'win32-x64' ? 'where.exe' : 'which'
  const { stdout } = await run(locator, ['bun'])
  const firstMatch = stdout.split(/\r?\n/u).find((line) => line.trim())?.trim()
  if (!firstMatch) throw new Error('Bun executable was not found on PATH')
  return realpath(firstMatch)
}

function capabilityPackManifest(version, target, executable) {
  return {
    schemaVersion: 1,
    id: 'velaros.document-renderer',
    product: 'document-renderer',
    version,
    platform: target,
    protocolVersion: 1,
    executable,
    integration: {
      kind: 'external-command',
      bundledWithHost: false,
      registeredByHost: false,
      requestTransport: 'one-json-request-per-process',
    },
    permissions: {
      filesystem: 'explicit-project-root',
      network: false,
      processExecution: false,
    },
    operations: ['render-office', 'render-pdf-page'],
  }
}

function launcherScript(target) {
  if (target === 'win32-x64') return `@echo off\r
setlocal\r
set "PACK_ROOT=%~dp0"\r
set "VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT=%PACK_ROOT%"\r
set "NAPI_RS_NATIVE_LIBRARY_PATH=%PACK_ROOT%canvas.node"\r
"%PACK_ROOT%runtime\\bun.exe" "%PACK_ROOT%app\\renderer.js" %*\r
exit /b %ERRORLEVEL%\r
`
  return `#!/bin/sh
set -eu
PACK_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT="$PACK_ROOT"
export NAPI_RS_NATIVE_LIBRARY_PATH="$PACK_ROOT/canvas.node"
exec "$PACK_ROOT/runtime/bun" "$PACK_ROOT/app/renderer.js" "$@"
`
}

async function stagePack(targetRoot, target, bundlePath, version) {
  const descriptor = supportedTargets.get(target)
  const executable = `velar-document-renderer${descriptor.launcherExtension}`
  const packRoot = join(targetRoot, 'Velar Document Renderer')
  const appRoot = join(packRoot, 'app')
  const runtimeRoot = join(packRoot, 'runtime')
  await mkdir(appRoot, { recursive: true })
  await mkdir(runtimeRoot, { recursive: true })
  await copyFile(bundlePath, join(appRoot, 'renderer.js'))
  await copyFile(
    join(
      repoRoot,
      'packages',
      'document-renderer',
      'node_modules',
      'pdfjs-dist',
      'legacy',
      'build',
      'pdf.worker.mjs',
    ),
    join(appRoot, 'pdf.worker.mjs'),
  )
  const runtimePath = join(runtimeRoot, descriptor.runtimeName)
  await copyFile(await resolveBunExecutable(target), runtimePath)
  await chmod(runtimePath, 0o755)
  const launcherPath = join(packRoot, executable)
  await writeFile(launcherPath, launcherScript(target), { mode: 0o755 })
  const canvasRoot = dirname(requireFromRenderer.resolve('@napi-rs/canvas/package.json'))
  const canvasSource = await realpath(join(
    canvasRoot,
    '..',
    descriptor.canvasPackage,
    descriptor.canvasBinary,
  ))
  const canvasPath = join(packRoot, 'canvas.node')
  await copyFile(canvasSource, canvasPath)
  await cp(
    canvasRoot,
    join(appRoot, 'node_modules', '@napi-rs', 'canvas'),
    { recursive: true },
  )
  await cp(
    join(repoRoot, 'packages', 'document-renderer', 'node_modules', 'pdfjs-dist', 'standard_fonts'),
    join(packRoot, 'pdfjs-standard-fonts'),
    { recursive: true },
  )
  await copyFile(
    join(repoRoot, 'packages', 'document-renderer', 'LICENSE'),
    join(packRoot, 'LICENSE'),
  )
  await writeFile(
    join(packRoot, 'capability-pack.json'),
    `${JSON.stringify(capabilityPackManifest(version, target, executable), null, 2)}\n`,
  )
  return { packRoot, launcherPath, runtimePath, canvasPath }
}

async function buildApplication(targetRoot) {
  const bundlePath = join(targetRoot, 'renderer.js')
  await mkdir(targetRoot, { recursive: true })
  await run('node', [
    'scripts/build/buildPackageTopology.mjs',
    '--for',
    '@velaros-ai/document-renderer',
  ])
  await run('bun', [
    'build',
    join(productRoot, 'src', 'bin.ts'),
    '--target=bun',
    '--minify',
    '--external=@napi-rs/canvas',
    `--outfile=${bundlePath}`,
  ])
  return bundlePath
}

function macCodesignArguments(identity, adHoc) {
  return [
    '--force',
    ...(adHoc ? [] : ['--timestamp']),
    '--options',
    'runtime',
    '--sign',
    identity,
  ]
}

async function archivePack({ targetRoot, target, packRoot, version, options }) {
  const descriptor = supportedTargets.get(target)
  const artifact = join(
    releaseRoot,
    `Velar-Document-Renderer-${version}-${descriptor.archiveExtension}`,
  )
  await mkdir(releaseRoot, { recursive: true })
  if (target === 'darwin-arm64') {
    await run('ditto', ['-c', '-k', '--keepParent', packRoot, artifact])
    if (options.notarize) {
      const profile = process.env.APPLE_KEYCHAIN_PROFILE?.trim() || 'velaros-notary'
      await run('xcrun', [
        'notarytool',
        'submit',
        artifact,
        '--keychain-profile',
        profile,
        '--wait',
      ])
    }
  } else if (target === 'win32-x64') {
    await run('tar', [
      '-a',
      '-c',
      '-f',
      artifact,
      '-C',
      targetRoot,
      'Velar Document Renderer',
    ])
  } else {
    await run('tar', [
      '-czf',
      artifact,
      '-C',
      targetRoot,
      'Velar Document Renderer',
    ])
  }
  return artifact
}

async function signMacFiles(runtimePath, canvasPath, options) {
  if (process.platform !== 'darwin') return null
  const identity = options.adHoc
    ? '-'
    : process.env.VELAROS_RENDERER_CODESIGN_IDENTITY?.trim()
      || process.env.VELAROS_HOST_CODESIGN_IDENTITY?.trim()
      || 'REDACTED_DEVELOPER_IDENTITY'
  const common = macCodesignArguments(identity, options.adHoc)
  await run('codesign', [
    ...common,
    canvasPath,
  ])
  await run('codesign', [
    ...common,
    '--entitlements',
    join(productRoot, 'macos', 'entitlements.plist'),
    runtimePath,
  ])
  await run('codesign', ['--verify', '--strict', '--verbose=2', runtimePath])
  await run('codesign', ['--verify', '--strict', '--verbose=2', canvasPath])
  return identity
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function sourceIdentity() {
  const [{ stdout: sourceCommit }, { stdout: statusOutput }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']),
    run('git', ['status', '--porcelain=v1', '--untracked-files=all']),
  ])
  return {
    sourceCommit: sourceCommit.trim(),
    sourceDirty: Boolean(statusOutput.trim()),
  }
}

function artifactTrust(target, options) {
  return target === 'darwin-arm64'
    ? {
        signature: options.adHoc ? 'ad-hoc' : 'developer-id',
        notarized: options.notarize === true,
      }
    : { signature: 'unsigned', notarized: false }
}

async function build(options = {}) {
  const target = currentTarget(options.host)
  const version = await readVersion()
  const targetRoot = join(outputRoot, target)
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })
  const bundlePath = await buildApplication(join(targetRoot, 'compiled'))
  const staged = await stagePack(targetRoot, target, bundlePath, version)
  if (target === 'darwin-arm64') {
    await signMacFiles(staged.runtimePath, staged.canvasPath, options)
  }
  const artifact = await archivePack({
    targetRoot,
    target,
    packRoot: staged.packRoot,
    version,
    options,
  })
  const identity = await sourceIdentity()
  const manifest = {
    schemaVersion: 1,
    product: 'document-renderer',
    version,
    platform: target,
    fileName: artifact.split(/[\\/]/u).at(-1),
    sizeBytes: (await stat(artifact)).size,
    sha256: await sha256(artifact),
    trust: artifactTrust(target, options),
    ...identity,
  }
  const manifestPath = join(
    releaseRoot,
    `document-renderer-artifact-${target}.json`,
  )
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.info(JSON.stringify({ artifact, manifestPath, ...manifest }, null, 2))
  return { artifact, manifestPath, manifest }
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await build(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export {
  artifactTrust,
  build,
  capabilityPackManifest,
  currentTarget,
  launcherScript,
  macCodesignArguments,
  parseArguments,
  readVersion,
}
