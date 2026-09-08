#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { releaseAttestationKey } from './release-candidate.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const releasePlatforms = new Map([
  ['darwin-arm64', { buildArguments: ['--notarize'] }],
  ['win32-x64', { buildArguments: [] }],
  ['linux-x64', { buildArguments: [] }],
])

function parseArguments(argv) {
  const options = {
    channel: 'stable',
    dryRun: false,
    checkOnly: false,
    replaceExisting: false,
    platform: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (
      argument === '--local-macos' ||
      argument === '--local-windows' ||
      argument === '--local-linux'
    ) {
      const platform =
        argument === '--local-macos'
          ? 'darwin-arm64'
          : argument === '--local-windows'
            ? 'win32-x64'
            : 'linux-x64'
      if (options.platform && options.platform !== platform) {
        throw new Error(
          'Document Renderer release can select only one local native platform',
        )
      }
      options.platform = platform
    }
    else if (argument === '--check-only') options.checkOnly = true
    else if (argument === '--replace-existing') options.replaceExisting = true
    else if (argument === '--channel') {
      const value = argv[++index]
      if (!new Set(['stable', 'canary']).has(value)) {
        throw new Error('--channel must be stable or canary')
      }
      options.channel = value
    } else throw new Error(`Unknown Document Renderer release argument: ${argument}`)
  }
  return options
}

function releasePlatform(
  requestedPlatform,
  host = { platform: process.platform, arch: process.arch },
) {
  const hostPlatform = `${host.platform}-${host.arch}`
  const platform = requestedPlatform ?? hostPlatform
  if (!releasePlatforms.has(platform)) {
    throw new Error(
      'Document Renderer local release requires darwin-arm64, win32-x64, '
        + `or linux-x64; received ${platform}`,
    )
  }
  return platform
}

async function command(executable, arguments_, options = {}) {
  try {
    const result = await execFileAsync(executable, arguments_, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      maxBuffer: 20 * 1024 * 1024,
    })
    return result.stdout.trim()
  } catch (error) {
    const detail = String(
      error?.stderr ?? error?.stdout ?? error?.message ?? error,
    ).trim()
    throw new Error(
      `${executable} ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    )
  }
}

async function inheritedCommand(executable, arguments_, options = {}) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    })
    child.once('error', rejectCommand)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCommand()
      else
        rejectCommand(
          new Error(
            `${executable} ${arguments_.join(' ')} ${signal ? `received ${signal}` : `exited ${code}`}`,
          ),
        )
    })
  })
}

async function preflight({
  requirePublishConfig = true,
  platform: requestedPlatform,
} = {}) {
  const platform = releasePlatform(requestedPlatform)
  const hostPlatform = `${process.platform}-${process.arch}`
  if (hostPlatform !== platform) {
    throw new Error(
      `Document Renderer ${platform} release requires a native ${platform} host; received ${hostPlatform}`,
    )
  }
  const status = await command('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  if (status) throw new Error('Document Renderer releases require a clean working tree')
  const configuredSourceRef = process.env.VELAROS_RELEASE_SOURCE_REF?.trim()
  const branch = configuredSourceRef || (await command('git', [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]))
  await command('git', ['fetch', '--quiet'])
  const sourceCommit = await command('git', ['rev-parse', 'HEAD'])
  const upstreamCommit = configuredSourceRef
    ? await command('git', ['rev-parse', `origin/${configuredSourceRef}`])
    : await command('git', ['rev-parse', '@{upstream}'])
  if (sourceCommit !== upstreamCommit) {
    throw new Error(
      'Current Document Renderer source commit must be pushed before local publication',
    )
  }
  const sourceRepository = await command('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ])
  if (sourceRepository !== 'VelarOS-AI/VelarOS-Platform') {
    throw new Error(
      'Document Renderer releases require the official VelarOS-AI/VelarOS-Platform source repository',
    )
  }
  const originUrl = await command('git', ['remote', 'get-url', 'origin'])
  if (
    ![
      'https://github.com/VelarOS-AI/VelarOS-Platform.git',
      'https://github.com/VelarOS-AI/VelarOS-Platform',
      'git@github.com:VelarOS-AI/VelarOS-Platform.git',
    ].includes(originUrl)
  ) {
    throw new Error(
      'Document Renderer release origin must point to the official source repository',
    )
  }
  await command('gh', ['auth', 'status'])
  if (platform === 'darwin-arm64') {
    await command('xcrun', [
      'notarytool',
      'history',
      '--keychain-profile',
      process.env.APPLE_KEYCHAIN_PROFILE?.trim() || 'velaros-notary',
      '--output-format',
      'json',
    ])
  }

  let targetRepository = ''
  let releaseToken = ''
  if (requirePublishConfig) {
    targetRepository =
      process.env.VELAROS_RELEASE_REPOSITORY?.trim() ||
      (await command('gh', [
        'variable',
        'get',
        'VELAROS_RELEASE_REPOSITORY',
        '--repo',
        sourceRepository,
      ]))
    const visibility = await command('gh', [
      'repo',
      'view',
      targetRepository,
      '--json',
      'visibility',
      '--jq',
      '.visibility',
    ])
    if (visibility !== 'PUBLIC')
      throw new Error(`${targetRepository} must remain public`)
    releaseToken =
      process.env.VELAROS_RELEASE_REPO_TOKEN?.trim() ||
      (await command('gh', ['auth', 'token']))
  }
  const rendererManifest = JSON.parse(
    await readFile(
      resolve(repoRoot, 'packages/document-renderer/package.json'),
      'utf8',
    ),
  )
  return {
    branch,
    sourceCommit,
    sourceRepository,
    targetRepository,
    releaseToken,
    platform,
    version: rendererManifest.version,
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function reusableArtifact(context, platform) {
  if (!releasePlatforms.has(platform)) {
    throw new Error(
      `Unsupported Document Renderer local release platform: ${platform}`,
    )
  }
  const manifestPath = resolve(
    repoRoot,
    `release/document-renderer/document-renderer-artifact-${platform}.json`,
  )
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const artifactPath = resolve(dirname(manifestPath), manifest.fileName)
    const reusable =
      manifest.product === 'document-renderer' &&
      manifest.version === context.version &&
      manifest.platform === platform &&
      manifest.sourceCommit === context.sourceCommit &&
      manifest.sourceDirty === false &&
      (platform !== 'darwin-arm64' ||
        (manifest.trust?.signature === 'developer-id' &&
          manifest.trust?.notarized === true)) &&
      manifest.sizeBytes === (await stat(artifactPath)).size &&
      manifest.sha256 === (await sha256(artifactPath))
    return reusable ? { manifestPath, artifactPath } : null
  } catch {
    return null
  }
}

async function reusableMacArtifact(context) {
  return reusableArtifact(context, 'darwin-arm64')
}

async function assertSourceUnchanged(context) {
  const commit = await command('git', ['rev-parse', 'HEAD'])
  const status = await command('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  const remote = await command('git', [
    'ls-remote',
    'origin',
    `refs/heads/${context.branch}`,
  ])
  if (
    commit !== context.sourceCommit ||
    status ||
    remote.split(/\s+/u)[0] !== commit
  ) {
    throw new Error(
      'Document Renderer release source changed or no longer matches the pushed branch',
    )
  }
}

async function run(options, dependencies = {}) {
  const runCommand = dependencies.command ?? command
  const inheritCommand = dependencies.inheritedCommand ?? inheritedCommand
  const readArtifact =
    dependencies.reusableArtifact ??
    dependencies.reusableMacArtifact ??
    reusableArtifact
  const checkSource =
    dependencies.assertSourceUnchanged ?? assertSourceUnchanged
  const platform = releasePlatform(options.platform)
  const context = await (dependencies.preflight ?? preflight)({
    requirePublishConfig: !options.dryRun,
    platform,
  })
  console.info(
    `Document Renderer release source ${context.sourceRepository}@${context.sourceCommit.slice(0, 12)} (v${context.version})`,
  )
  if (!options.dryRun) releaseAttestationKey({ required: true })
  if (options.checkOnly) return context

  if (options.dryRun) {
    console.info(
      `would release ${platform} locally; no build, signing, notarization, upload, or finalization`,
    )
    return { ...context, dryRun: true }
  }

  const scopeArguments = ['--platforms', platform]
  const releaseEnvironmentVariables = {
    VELAROS_SOURCE_REPOSITORY: context.sourceRepository,
    VELAROS_SOURCE_COMMIT: context.sourceCommit,
    VELAROS_RELEASE_REPOSITORY: context.targetRepository,
    VELAROS_RELEASE_REPO_TOKEN: context.releaseToken,
  }
  const planArguments = [
    'scripts/document-renderer/release-candidate.mjs',
    'plan',
    '--channel',
    options.channel,
    ...scopeArguments,
  ]
  const planOutput = await runCommand('node', planArguments, {
    env: releaseEnvironmentVariables,
  })
  if (!planOutput.includes('renderer_needed=true')) {
    console.info(
      `document-renderer-v${context.version} is already complete; nothing was rebuilt or uploaded`,
    )
    return { ...context, needed: false }
  }

  await inheritCommand('bun', ['install', '--frozen-lockfile'])
  await inheritCommand('bun', ['run', 'check'])
  await checkSource(context)

  let artifact = await readArtifact(context, platform)
  if (!artifact) {
    await inheritCommand('node', [
      'scripts/document-renderer/build-product.mjs',
      ...releasePlatforms.get(platform).buildArguments,
    ])
    artifact = await readArtifact(context, platform)
    if (!artifact)
      throw new Error(
        `${platform} Document Renderer artifact identity did not match the release source`,
      )
  } else {
    console.info(`reuse verified ${artifact.artifactPath}`)
  }

  await checkSource(context)
  await inheritCommand(
    'node',
    [
      'scripts/document-renderer/release-candidate.mjs',
      'stage',
      '--channel',
      options.channel,
      ...scopeArguments,
      '--platform',
      platform,
      '--artifact-manifest',
      artifact.manifestPath,
      ...(options.replaceExisting ? ['--replace-existing'] : []),
    ],
    { env: releaseEnvironmentVariables },
  )
  await checkSource(context)
  await inheritCommand(
    'node',
    [
      'scripts/document-renderer/release-candidate.mjs',
      'finalize',
      '--channel',
      options.channel,
      ...scopeArguments,
      ...(options.replaceExisting ? ['--replace-existing'] : []),
    ],
    { env: releaseEnvironmentVariables },
  )
  console.info(
    `Document Renderer ${context.version} ${platform} candidate finalized locally`,
  )
  return { ...context, needed: true, artifact, platforms: [platform] }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  run(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export {
  parseArguments,
  preflight,
  releasePlatform,
  reusableArtifact,
  reusableMacArtifact,
  run,
}
