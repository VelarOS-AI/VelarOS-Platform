#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const releaseEnvironment = 'release-candidates'

function parseArguments(argv) {
  const options = {
    channel: 'stable',
    dryRun: false,
    checkOnly: false,
    replaceExisting: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--check-only') options.checkOnly = true
    else if (argument === '--replace-existing') options.replaceExisting = true
    else if (argument === '--channel') {
      const value = argv[++index]
      if (!new Set(['stable', 'canary']).has(value)) {
        throw new Error('--channel must be stable or canary')
      }
      options.channel = value
    } else throw new Error(`Unknown Host release argument: ${argument}`)
  }
  return options
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

async function preflight({ requirePublishConfig = true } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      `Host macOS release requires darwin-arm64; received ${process.platform}-${process.arch}`,
    )
  }
  const status = await command('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  if (status) throw new Error('Host releases require a clean working tree')
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
      'Current Host source commit must be pushed before remote native builds',
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
  await command('gh', ['auth', 'status'])
  await command('xcrun', [
    'notarytool',
    'history',
    '--keychain-profile',
    process.env.APPLE_KEYCHAIN_PROFILE?.trim() || 'velaros-notary',
    '--output-format',
    'json',
  ])

  let targetRepository = ''
  let releaseToken = ''
  if (requirePublishConfig) {
    targetRepository = await command('gh', [
      'variable',
      'get',
      'VELAROS_RELEASE_REPOSITORY',
      '--repo',
      sourceRepository,
    ])
    const visibility = await command('gh', [
      'repo',
      'view',
      targetRepository,
      '--json',
      'visibility',
      '--jq',
      '.visibility',
    ])
    if (visibility !== 'PRIVATE')
      throw new Error(`${targetRepository} must remain private`)
    const secrets = JSON.parse(
      await command('gh', [
        'secret',
        'list',
        '--env',
        releaseEnvironment,
        '--repo',
        sourceRepository,
        '--json',
        'name',
      ]),
    )
    if (!secrets.some(({ name }) => name === 'VELAROS_RELEASE_REPO_TOKEN')) {
      throw new Error(
        `${releaseEnvironment} is missing VELAROS_RELEASE_REPO_TOKEN`,
      )
    }
    releaseToken =
      process.env.VELAROS_RELEASE_REPO_TOKEN?.trim() ||
      (await command('gh', ['auth', 'token']))
  }
  const hostManifest = JSON.parse(
    await readFile(
      resolve(repoRoot, 'packages/serve-host/package.json'),
      'utf8',
    ),
  )
  return {
    branch,
    sourceCommit,
    sourceRepository,
    targetRepository,
    releaseToken,
    version: hostManifest.version,
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function reusableMacArtifact(context) {
  const manifestPath = resolve(
    repoRoot,
    'release/host/host-artifact-darwin-arm64.json',
  )
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const artifactPath = resolve(dirname(manifestPath), manifest.fileName)
    const reusable =
      manifest.product === 'host' &&
      manifest.version === context.version &&
      manifest.platform === 'darwin-arm64' &&
      manifest.sourceCommit === context.sourceCommit &&
      manifest.sourceDirty === false &&
      manifest.trust?.signature === 'developer-id' &&
      manifest.trust?.notarized === true &&
      manifest.sizeBytes === (await stat(artifactPath)).size &&
      manifest.sha256 === (await sha256(artifactPath))
    return reusable ? { manifestPath, artifactPath } : null
  } catch {
    return null
  }
}

async function run(options) {
  const context = await preflight({ requirePublishConfig: !options.dryRun })
  console.info(
    `Host release source ${context.sourceRepository}@${context.sourceCommit.slice(0, 12)} (v${context.version})`,
  )
  if (options.checkOnly) return context

  const releaseEnvironmentVariables = {
    VELAROS_SOURCE_REPOSITORY: context.sourceRepository,
    VELAROS_SOURCE_COMMIT: context.sourceCommit,
    VELAROS_RELEASE_REPOSITORY: context.targetRepository,
    VELAROS_RELEASE_REPO_TOKEN: context.releaseToken,
  }
  const planArguments = [
    'scripts/host/release-candidate.mjs',
    'plan',
    '--channel',
    options.channel,
    ...(options.dryRun ? ['--dry-run'] : []),
  ]
  const planOutput = await command('node', planArguments, {
    env: releaseEnvironmentVariables,
  })
  if (!planOutput.includes('host_needed=true')) {
    console.info(
      `host-v${context.version} is already complete; nothing was rebuilt or uploaded`,
    )
    return { ...context, needed: false }
  }

  let macArtifact = await reusableMacArtifact(context)
  if (!macArtifact) {
    await inheritedCommand('bun', [
      'run',
      options.dryRun ? 'package:host:mac:dev' : 'package:host:mac',
    ])
    macArtifact = await reusableMacArtifact(context)
    if (!macArtifact)
      throw new Error(
        'macOS Host artifact identity did not match the release source',
      )
  } else {
    console.info(`reuse signed/notarized ${macArtifact.artifactPath}`)
  }

  if (!options.dryRun) {
    await inheritedCommand(
      'node',
      [
        'scripts/host/release-candidate.mjs',
        'stage',
        '--channel',
        options.channel,
        '--platform',
        'darwin-arm64',
        '--artifact-manifest',
        macArtifact.manifestPath,
        ...(options.replaceExisting ? ['--replace-existing'] : []),
      ],
      { env: releaseEnvironmentVariables },
    )
  }

  await inheritedCommand('gh', [
    'workflow',
    'run',
    'release-host.yml',
    '--repo',
    context.sourceRepository,
    '--ref',
    context.branch,
    '-f',
    `channel=${options.channel}`,
    '-f',
    `dry_run=${options.dryRun ? 'true' : 'false'}`,
    '-f',
    `confirm_upload=${options.dryRun ? 'false' : 'true'}`,
    '-f',
    `replace_existing=${options.replaceExisting ? 'true' : 'false'}`,
  ])
  console.info(
    `Track Host: gh run list --repo ${context.sourceRepository} --workflow release-host.yml`,
  )
  return { ...context, needed: true, macArtifact }
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

export { parseArguments, preflight, reusableMacArtifact, run }
