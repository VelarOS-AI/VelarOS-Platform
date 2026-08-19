#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
// macOS exposes /tmp through /private/tmp. Bun resolves the entrypoint to its real path, so the
// build cwd must use that same identity or workspace package resolution can fall outside tsconfig.
const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
const hostProductRoot = join(repoRoot, 'products', 'host')
const outputRoot = join(repoRoot, 'dist-host')
const releaseRoot = join(repoRoot, 'release', 'host')
const supportedTargets = new Map([
  ['darwin-arm64', { platform: 'darwin', arch: 'arm64', extension: '' }],
  ['win32-x64', { platform: 'win32', arch: 'x64', extension: '.exe' }],
  ['linux-x64', { platform: 'linux', arch: 'x64', extension: '' }],
])

function parseArguments(argv) {
  const options = { notarize: false, adHoc: false }
  for (const argument of argv) {
    if (argument === '--notarize') options.notarize = true
    else if (argument === '--adhoc') options.adHoc = true
    else throw new Error(`Unknown Host packaging option: ${argument}`)
  }
  if (options.notarize && options.adHoc) {
    throw new Error('--notarize and --adhoc cannot be used together')
  }
  return options
}

function currentTarget(
  host = { platform: process.platform, arch: process.arch },
) {
  const target = `${host.platform}-${host.arch}`
  if (!supportedTargets.has(target)) {
    throw new Error(
      `Velar Host installers must be built natively on darwin-arm64, win32-x64, or linux-x64; received ${target}`,
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

async function pathExists(path) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function readHostVersion() {
  const manifest = JSON.parse(
    await readFile(
      join(repoRoot, 'packages', 'serve-host', 'package.json'),
      'utf8',
    ),
  )
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version)
  ) {
    throw new Error(
      'packages/serve-host/package.json contains an invalid version',
    )
  }
  return manifest.version
}

async function copyRuntimeResources(destination) {
  await mkdir(destination, { recursive: true })
  await cp(
    join(repoRoot, 'packages', 'computer', 'runtime'),
    join(destination, 'computer-runtime'),
    { recursive: true },
  )
  await cp(
    join(
      repoRoot,
      'packages',
      'office',
      'node_modules',
      'pdfjs-dist',
      'standard_fonts',
    ),
    join(destination, 'pdfjs-standard-fonts'),
    { recursive: true },
  )
}

async function buildHostBinary(targetRoot, target) {
  const descriptor = supportedTargets.get(target)
  const binaryName = `velar-host${descriptor.extension}`
  const binaryPath = join(targetRoot, binaryName)
  await mkdir(targetRoot, { recursive: true })
  await run('bun', [
    'build',
    join(hostProductRoot, 'src', 'bin.ts'),
    '--compile',
    '--minify',
    `--outfile=${binaryPath}`,
  ])
  await chmod(binaryPath, 0o755)
  return binaryPath
}

function macInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Velar Host</string>
  <key>CFBundleExecutable</key><string>Velar Host</string>
  <key>CFBundleIdentifier</key><string>com.velaros.host</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Velar Host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppleEventsUsageDescription</key><string>Velar Host opens Terminal and may control applications when you approve an automation task.</string>
  <key>NSScreenCaptureUsageDescription</key><string>Velar Host uses screen capture only for Computer Use tasks that you approve.</string>
</dict>
</plist>
`
}

function macLaunchScript() {
  return `#!/bin/zsh
set -eu
RESOURCES_DIR="\${0:A:h}"
export VELAROS_HOST_RESOURCES_ROOT="$RESOURCES_DIR"
cd "$HOME"
exec "$RESOURCES_DIR/bin/velar-host" "$@"
`
}

async function signMacBundle({ appPath, binaryPath, launcherPath, adHoc }) {
  const identity = adHoc
    ? '-'
    : process.env.VELAROS_HOST_CODESIGN_IDENTITY?.trim() ||
      'REDACTED_DEVELOPER_IDENTITY'
  const entitlements = join(hostProductRoot, 'macos', 'entitlements.plist')
  const common = ['--force', '--options', 'runtime', '--sign', identity]
  if (!adHoc) common.splice(2, 0, '--timestamp')
  await run('codesign', [...common, '--entitlements', entitlements, binaryPath])
  await run('codesign', [...common, launcherPath])
  await run('codesign', [...common, '--entitlements', entitlements, appPath])
  await run('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ])
  return identity
}

async function packageMac({
  targetRoot,
  binaryPath,
  version,
  notarize,
  adHoc,
}) {
  const bundleRoot = join(targetRoot, 'bundle')
  const appPath = join(bundleRoot, 'Velar Host.app')
  const contents = join(appPath, 'Contents')
  const executableRoot = join(contents, 'MacOS')
  const resourcesRoot = join(contents, 'Resources')
  const packagedBinary = join(resourcesRoot, 'bin', 'velar-host')
  const launcherPath = join(executableRoot, 'Velar Host')
  const launchScriptPath = join(resourcesRoot, 'Launch Velar Host.command')

  await mkdir(executableRoot, { recursive: true })
  await mkdir(dirname(packagedBinary), { recursive: true })
  await copyFile(binaryPath, packagedBinary)
  await chmod(packagedBinary, 0o755)
  await copyRuntimeResources(resourcesRoot)
  await writeFile(join(contents, 'Info.plist'), macInfoPlist(version))
  await writeFile(launchScriptPath, macLaunchScript(), { mode: 0o755 })
  await run('xcrun', [
    'swiftc',
    join(hostProductRoot, 'macos', 'Launcher.swift'),
    '-o',
    launcherPath,
  ])
  await chmod(launcherPath, 0o755)
  const identity = await signMacBundle({
    appPath,
    binaryPath: packagedBinary,
    launcherPath,
    adHoc,
  })

  const dmgStage = join(targetRoot, 'dmg-root')
  await mkdir(dmgStage, { recursive: true })
  await cp(appPath, join(dmgStage, 'Velar Host.app'), { recursive: true })
  await symlink('/Applications', join(dmgStage, 'Applications'))
  const artifact = join(releaseRoot, `Velar-Host-${version}-arm64.dmg`)
  await mkdir(releaseRoot, { recursive: true })
  await run('hdiutil', [
    'create',
    '-volname',
    'Velar Host',
    '-srcfolder',
    dmgStage,
    '-ov',
    '-format',
    'UDZO',
    artifact,
  ])
  await run('codesign', [
    '--force',
    ...(adHoc ? [] : ['--timestamp']),
    '--sign',
    identity,
    artifact,
  ])

  if (notarize) {
    const profile =
      process.env.APPLE_KEYCHAIN_PROFILE?.trim() || 'velaros-notary'
    await run('xcrun', [
      'notarytool',
      'submit',
      artifact,
      '--keychain-profile',
      profile,
      '--wait',
    ])
    await run('xcrun', ['stapler', 'staple', artifact])
    await run('xcrun', ['stapler', 'validate', artifact])
    await run('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=2',
      artifact,
    ])
  }
  return artifact
}

async function resolveMakensis() {
  const candidates = [
    process.env.MAKENSIS?.trim(),
    'makensis',
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await run(candidate, ['/VERSION'])
      return candidate
    } catch {
      // Try the next well-known native Windows installation path.
    }
  }
  throw new Error('makensis is required to package the Windows Host installer')
}

async function packageWindows({ targetRoot, binaryPath, version }) {
  const resourcesRoot = join(targetRoot, 'resources')
  await copyRuntimeResources(resourcesRoot)
  const artifact = join(releaseRoot, `Velar-Host-${version}-x64-setup.exe`)
  await mkdir(releaseRoot, { recursive: true })
  const makensis = await resolveMakensis()
  await run(makensis, [
    `/DVERSION=${version}`,
    `/DHOST_BINARY=${binaryPath}`,
    `/DHOST_RESOURCES=${resourcesRoot}`,
    `/DOUTPUT_FILE=${artifact}`,
    join(hostProductRoot, 'windows', 'installer.nsi'),
  ])
  return artifact
}

async function resolveAppImageTool() {
  const configured = process.env.APPIMAGETOOL?.trim()
  if (configured) return configured
  await run('appimagetool', ['--version'])
  return 'appimagetool'
}

async function packageLinux({ targetRoot, binaryPath, version }) {
  const appDir = join(targetRoot, 'Velar_Host.AppDir')
  const binaryDestination = join(appDir, 'usr', 'bin', 'velar-host')
  const resourcesRoot = join(appDir, 'usr', 'share', 'velar-host')
  const iconDirectory = join(
    appDir,
    'usr',
    'share',
    'icons',
    'hicolor',
    'scalable',
    'apps',
  )
  await mkdir(dirname(binaryDestination), { recursive: true })
  await mkdir(iconDirectory, { recursive: true })
  await copyFile(binaryPath, binaryDestination)
  await chmod(binaryDestination, 0o755)
  await copyRuntimeResources(resourcesRoot)
  await copyFile(
    join(hostProductRoot, 'linux', 'AppRun'),
    join(appDir, 'AppRun'),
  )
  await chmod(join(appDir, 'AppRun'), 0o755)
  await copyFile(
    join(hostProductRoot, 'linux', 'velar-host.desktop'),
    join(appDir, 'velar-host.desktop'),
  )
  const iconPath = join(iconDirectory, 'velar-host.svg')
  await copyFile(join(hostProductRoot, 'assets', 'velar-host.svg'), iconPath)
  await symlink(
    'usr/share/icons/hicolor/scalable/apps/velar-host.svg',
    join(appDir, '.DirIcon'),
  )
  const artifact = join(releaseRoot, `Velar-Host-${version}-x86_64.AppImage`)
  await mkdir(releaseRoot, { recursive: true })
  const appImageTool = await resolveAppImageTool()
  await run(appImageTool, [appDir, artifact], { env: { ARCH: 'x86_64' } })
  await chmod(artifact, 0o755)
  return artifact
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function sourceIdentity() {
  const [{ stdout: sourceCommit }, { stdout: statusOutput }] =
    await Promise.all([
      run('git', ['rev-parse', 'HEAD']),
      run('git', ['status', '--porcelain=v1', '--untracked-files=all']),
    ])
  return {
    sourceCommit: sourceCommit.trim(),
    sourceDirty: Boolean(statusOutput.trim()),
  }
}

async function build(options = {}) {
  const target = currentTarget(options.host)
  const targetRoot = join(outputRoot, target)
  const version = await readHostVersion()
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })
  const binaryPath = await buildHostBinary(join(targetRoot, 'compiled'), target)
  const artifact =
    target === 'darwin-arm64'
      ? await packageMac({ targetRoot, binaryPath, version, ...options })
      : target === 'win32-x64'
        ? await packageWindows({ targetRoot, binaryPath, version })
        : await packageLinux({ targetRoot, binaryPath, version })
  const identity = await sourceIdentity()
  const manifest = {
    schemaVersion: 1,
    product: 'host',
    version,
    platform: target,
    fileName: artifact.split(/[\\/]/u).at(-1),
    sizeBytes: (await stat(artifact)).size,
    sha256: await sha256(artifact),
    ...identity,
  }
  const manifestPath = join(releaseRoot, `host-artifact-${target}.json`)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.info(JSON.stringify({ artifact, manifestPath, ...manifest }, null, 2))
  return { artifact, manifestPath, manifest }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await build(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export {
  build,
  currentTarget,
  macInfoPlist,
  macLaunchScript,
  parseArguments,
  readHostVersion,
}
