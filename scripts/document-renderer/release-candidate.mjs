#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const platforms = ['darwin-arm64', 'win32-x64', 'linux-x64']
const channels = new Set(['stable', 'canary'])

function parseArguments(argv) {
  const command = argv[0]
  if (!new Set(['plan', 'stage', 'finalize']).has(command)) {
    throw new Error('Expected Document Renderer release command: plan, stage, or finalize')
  }
  const options = {
    command,
    channel: 'stable',
    dryRun: false,
    replaceExisting: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--replace-existing') options.replaceExisting = true
    else if (
      argument === '--channel' ||
      argument === '--platform' ||
      argument === '--artifact-manifest'
    ) {
      const value = argv[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === '--channel') options.channel = value
      else if (argument === '--platform') options.platform = value
      else options.artifactManifest = resolve(repoRoot, value)
    } else throw new Error(`Unknown Document Renderer release argument: ${argument}`)
  }
  if (!channels.has(options.channel))
    throw new Error('--channel must be stable or canary')
  if (command === 'stage' && !platforms.includes(options.platform)) {
    throw new Error(`--platform must be one of ${platforms.join(', ')}`)
  }
  if (command === 'stage' && !options.artifactManifest) {
    throw new Error('stage requires --artifact-manifest')
  }
  return options
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function releaseIdentity() {
  const manifest = JSON.parse(
    await readFile(
      resolve(repoRoot, 'packages/document-renderer/package.json'),
      'utf8',
    ),
  )
  const sourceRepository =
    process.env.GITHUB_REPOSITORY?.trim() ||
    process.env.VELAROS_SOURCE_REPOSITORY?.trim()
  const sourceCommit =
    process.env.GITHUB_SHA?.trim() || process.env.VELAROS_SOURCE_COMMIT?.trim()
  if (typeof manifest.version !== 'string')
    throw new Error('Document Renderer version is missing')
  if (
    !sourceRepository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(sourceRepository)
  ) {
    throw new Error(
      'Document Renderer release requires GITHUB_REPOSITORY or VELAROS_SOURCE_REPOSITORY',
    )
  }
  if (!sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error('Document Renderer release requires an exact 40-character source commit')
  }
  return {
    product: 'document-renderer',
    version: manifest.version,
    tag: `document-renderer-v${manifest.version}`,
    sourceRepository,
    sourceCommit,
  }
}

function buildStageManifest({ identity, channel, platform, artifact }) {
  return {
    schemaVersion: 1,
    product: 'document-renderer',
    version: identity.version,
    tag: identity.tag,
    channel,
    platform,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.sourceCommit,
    artifacts: [
      {
        fileName: artifact.fileName,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        role: 'capability-pack',
      },
    ],
  }
}

function buildCandidateManifest({ identity, channel, stages }) {
  const byPlatform = new Map(stages.map((stage) => [stage.platform, stage]))
  for (const platform of platforms) {
    const stage = byPlatform.get(platform)
    if (!stage) throw new Error(`Missing staged Document Renderer capability pack for ${platform}`)
    for (const field of [
      'product',
      'version',
      'tag',
      'channel',
      'sourceRepository',
      'sourceCommit',
    ]) {
      const expected = field === 'channel' ? channel : identity[field]
      if (stage[field] !== expected) {
        throw new Error(
          `Staged Document Renderer ${platform} ${field} does not match this release`,
        )
      }
    }
  }
  return {
    schemaVersion: 1,
    product: 'document-renderer',
    version: identity.version,
    tag: identity.tag,
    channel,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.sourceCommit,
    artifacts: platforms.flatMap((platform) =>
      byPlatform
        .get(platform)
        .artifacts.map((artifact) => ({ platform, ...artifact })),
    ),
  }
}

function assertCandidateArtifactTrust(artifactManifest, platform) {
  if (
    platform === 'darwin-arm64' &&
    (artifactManifest.trust?.signature !== 'developer-id' ||
      artifactManifest.trust?.notarized !== true)
  ) {
    throw new Error('macOS Document Renderer candidates require Developer ID signing and notarization')
  }
}

class GitHubReleaseClient {
  constructor(repository, token) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error('VELAROS_RELEASE_REPOSITORY must be owner/repository')
    }
    if (!token) throw new Error('VELAROS_RELEASE_REPO_TOKEN is required')
    this.repository = repository
    this.token = token
  }

  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'velaros-document-renderer-release',
        ...options.headers,
      },
    })
    if (options.allowNotFound && response.status === 404) return null
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000)
      throw new Error(
        `GitHub ${response.status} ${response.statusText}: ${body}`,
      )
    }
    if (response.status === 204) return null
    const contentType = response.headers.get('content-type') ?? ''
    return contentType.includes('json')
      ? response.json()
      : response.arrayBuffer()
  }

  async assertPrivate() {
    const repository = await this.request(
      `https://api.github.com/repos/${this.repository}`,
    )
    if (repository.private !== true) {
      throw new Error(
        `Refusing to upload Document Renderer capability packs to non-private ${this.repository}`,
      )
    }
  }

  async findRelease(tag) {
    return this.request(
      `https://api.github.com/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`,
      { allowNotFound: true },
    )
  }

  async ensureRelease(identity) {
    const existing = await this.findRelease(identity.tag)
    if (existing) return existing
    return this.request(
      `https://api.github.com/repos/${this.repository}/releases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: identity.tag,
          name: `Velar Document Renderer v${identity.version} candidate`,
          body: `Private Velar Document Renderer candidate from ${identity.sourceRepository}@${identity.sourceCommit}.`,
          draft: false,
          prerelease: true,
          make_latest: 'false',
        }),
      },
    )
  }

  async readAsset(release, fileName) {
    const asset = release.assets.find((entry) => entry.name === fileName)
    if (!asset) return null
    const bytes = await this.request(asset.url, {
      headers: { Accept: 'application/octet-stream' },
    })
    return { asset, bytes: Buffer.from(bytes) }
  }

  async deleteAsset(assetId) {
    await this.request(
      `https://api.github.com/repos/${this.repository}/releases/assets/${assetId}`,
      { method: 'DELETE' },
    )
  }

  async uploadBytes(
    release,
    fileName,
    bytes,
    { replaceExisting = false } = {},
  ) {
    const current = await this.readAsset(release, fileName)
    if (current) {
      const same =
        current.bytes.length === bytes.length &&
        createHash('sha256').update(current.bytes).digest('hex') ===
          createHash('sha256').update(bytes).digest('hex')
      if (same) return { reused: true, asset: current.asset }
      if (!replaceExisting) {
        throw new Error(
          `${identityLabel(release)} already has different bytes for ${fileName}; bump the Document Renderer version`,
        )
      }
      await this.deleteAsset(current.asset.id)
      release.assets = release.assets.filter(
        (entry) => entry.id !== current.asset.id,
      )
    }
    const uploadUrl = release.upload_url.replace(/\{.*$/u, '')
    const asset = await this.request(
      `${uploadUrl}?name=${encodeURIComponent(fileName)}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
        },
        body: bytes,
      },
    )
    release.assets.push(asset)
    return { reused: false, asset }
  }
}

function identityLabel(release) {
  return release.tag_name ? `Release ${release.tag_name}` : 'Release'
}

async function output(name, value) {
  const line = `${name}=${String(value)}\n`
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.GITHUB_OUTPUT, line)
  }
  console.info(line.trim())
}

function clientFromEnvironment() {
  return new GitHubReleaseClient(
    process.env.VELAROS_RELEASE_REPOSITORY?.trim(),
    process.env.VELAROS_RELEASE_REPO_TOKEN?.trim(),
  )
}

async function plan(options) {
  const identity = await releaseIdentity()
  if (options.dryRun) {
    await output('renderer_needed', true)
    return { identity, needed: true }
  }
  const client = clientFromEnvironment()
  await client.assertPrivate()
  const release = await client.findRelease(identity.tag)
  if (!release) {
    await output('renderer_needed', true)
    return { identity, needed: true }
  }
  const markerName = `candidate-document-renderer-${options.channel}.json`
  const marker = await client.readAsset(release, markerName)
  if (!marker) {
    await output('renderer_needed', true)
    return { identity, needed: true }
  }
  const candidate = JSON.parse(marker.bytes.toString('utf8'))
  if (candidate.sourceCommit !== identity.sourceCommit) {
    throw new Error(
      `${identity.tag} is already complete from ${candidate.sourceCommit}; bump the Document Renderer version`,
    )
  }
  await output('renderer_needed', false)
  return { identity, needed: false }
}

async function stage(options) {
  const identity = await releaseIdentity()
  const artifactManifest = JSON.parse(
    await readFile(options.artifactManifest, 'utf8'),
  )
  for (const [field, expected] of Object.entries({
    product: 'document-renderer',
    version: identity.version,
    platform: options.platform,
    sourceCommit: identity.sourceCommit,
    sourceDirty: false,
  })) {
    if (artifactManifest[field] !== expected) {
      throw new Error(
        `Document Renderer artifact manifest ${field} does not match: expected ${expected}`,
      )
    }
  }
  assertCandidateArtifactTrust(artifactManifest, options.platform)
  const artifactPath = resolve(
    dirname(options.artifactManifest),
    artifactManifest.fileName,
  )
  const actual = {
    fileName: basename(artifactPath),
    sizeBytes: (await stat(artifactPath)).size,
    sha256: await sha256(artifactPath),
  }
  if (
    actual.sizeBytes !== artifactManifest.sizeBytes ||
    actual.sha256 !== artifactManifest.sha256
  ) {
    throw new Error('Document Renderer artifact bytes do not match the build manifest')
  }
  const stageManifest = buildStageManifest({
    identity,
    channel: options.channel,
    platform: options.platform,
    artifact: actual,
  })
  const client = clientFromEnvironment()
  await client.assertPrivate()
  const release = await client.ensureRelease(identity)
  await client.uploadBytes(
    release,
    actual.fileName,
    await readFile(artifactPath),
    {
      replaceExisting: options.replaceExisting,
    },
  )
  const stageName = `staged-document-renderer-${options.platform}.json`
  await client.uploadBytes(
    release,
    stageName,
    Buffer.from(`${JSON.stringify(stageManifest, null, 2)}\n`),
    { replaceExisting: options.replaceExisting },
  )
  console.info(`staged ${identity.tag}/${options.platform}`)
  return stageManifest
}

async function finalize(options) {
  const identity = await releaseIdentity()
  const client = clientFromEnvironment()
  await client.assertPrivate()
  const release = await client.findRelease(identity.tag)
  if (!release) throw new Error(`Missing staged release ${identity.tag}`)
  const stages = []
  for (const platform of platforms) {
    const staged = await client.readAsset(
      release,
      `staged-document-renderer-${platform}.json`,
    )
    if (!staged)
      throw new Error(`Missing staged Document Renderer capability pack for ${platform}`)
    stages.push(JSON.parse(staged.bytes.toString('utf8')))
  }
  const candidate = buildCandidateManifest({
    identity,
    channel: options.channel,
    stages,
  })
  const outputRoot = resolve(repoRoot, 'dist-document-renderer', 'release')
  const fileName = `candidate-document-renderer-${options.channel}.json`
  await mkdir(outputRoot, { recursive: true })
  await writeFile(
    resolve(outputRoot, fileName),
    `${JSON.stringify(candidate, null, 2)}\n`,
  )
  await client.uploadBytes(
    release,
    fileName,
    Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`),
    { replaceExisting: options.replaceExisting },
  )
  console.info(`finalized ${identity.tag}/${options.channel}`)
  return candidate
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.command === 'plan') await plan(options)
  else if (options.command === 'stage') await stage(options)
  else await finalize(options)
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export {
  assertCandidateArtifactTrust,
  buildCandidateManifest,
  buildStageManifest,
  GitHubReleaseClient,
  parseArguments,
  platforms,
  releaseIdentity,
}
