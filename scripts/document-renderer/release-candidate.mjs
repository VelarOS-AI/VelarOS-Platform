#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const platforms = ['darwin-arm64', 'win32-x64', 'linux-x64']
const channels = new Set(['stable', 'canary'])

function normalizePlatforms(selected = platforms) {
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some((platform) => !platforms.includes(platform))
  ) {
    throw new Error(
      `--platforms must select unique values from ${platforms.join(', ')}`,
    )
  }
  return platforms.filter((platform) => selected.includes(platform))
}

function assertPlatformScope(actual, selected) {
  if (JSON.stringify(actual) !== JSON.stringify(normalizePlatforms(selected))) {
    throw new Error(
      'Document Renderer manifest platform scope does not match this release',
    )
  }
}

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
    platforms: [...platforms],
    platformsExplicit: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--replace-existing') options.replaceExisting = true
    else if (
      argument === '--channel' ||
      argument === '--platform' ||
      argument === '--platforms' ||
      argument === '--artifact-manifest'
    ) {
      const value = argv[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === '--channel') options.channel = value
      else if (argument === '--platform') options.platform = value
      else if (argument === '--platforms') {
        options.platforms = normalizePlatforms(value.split(','))
        options.platformsExplicit = true
      }
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
  if (command === 'stage' && !options.platforms.includes(options.platform)) {
    throw new Error('--platform must belong to the selected --platforms scope')
  }
  if (command === 'stage' && !options.platformsExplicit) {
    options.platforms = [options.platform]
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
  const sourceRepository = process.env.VELAROS_SOURCE_REPOSITORY?.trim()
  const sourceCommit = process.env.VELAROS_SOURCE_COMMIT?.trim()
  if (typeof manifest.version !== 'string')
    throw new Error('Document Renderer version is missing')
  if (
    !sourceRepository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(sourceRepository)
  ) {
    throw new Error(
      'Document Renderer release requires VELAROS_SOURCE_REPOSITORY',
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

function buildStageManifest({
  identity,
  channel,
  platform,
  artifact,
  selectedPlatforms,
}) {
  const scope = normalizePlatforms(selectedPlatforms ?? [platform])
  if (!scope.includes(platform)) {
    throw new Error('Staged platform is outside the release scope')
  }
  return {
    schemaVersion: 1,
    product: 'document-renderer',
    version: identity.version,
    tag: identity.tag,
    channel,
    platform,
    platforms: scope,
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

function buildCandidateManifest({
  identity,
  channel,
  stages,
  selectedPlatforms = platforms,
}) {
  const scope = normalizePlatforms(selectedPlatforms)
  const byPlatform = new Map(stages.map((stage) => [stage.platform, stage]))
  if (
    byPlatform.size !== stages.length ||
    stages.some((stage) => !scope.includes(stage.platform))
  ) {
    throw new Error(
      'Duplicate or out-of-scope staged Document Renderer capability pack',
    )
  }
  for (const platform of scope) {
    const stage = byPlatform.get(platform)
    if (!stage) throw new Error(`Missing staged Document Renderer capability pack for ${platform}`)
    assertPlatformScope(stage.platforms, [platform])
    if (
      stage.schemaVersion !== 1 ||
      !Array.isArray(stage.artifacts) ||
      stage.artifacts.length !== 1
    ) {
      throw new Error(
        `Staged Document Renderer ${platform} must contain exactly one capability pack`,
      )
    }
    const artifact = stage.artifacts[0]
    if (
      artifact.role !== 'capability-pack' ||
      typeof artifact.fileName !== 'string' ||
      basename(artifact.fileName) !== artifact.fileName ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    ) {
      throw new Error(
        `Staged Document Renderer ${platform} artifact identity is invalid`,
      )
    }
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
    platforms: scope,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.sourceCommit,
    artifacts: scope.flatMap((platform) =>
      byPlatform
        .get(platform)
        .artifacts.map((artifact) => ({ platform, ...artifact })),
    ),
  }
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, sortCanonicalValue(value[key])]),
    )
  }
  return value
}

function assertCandidateIdentity(candidate, identity, channel, selectedPlatforms) {
  assertPlatformScope(candidate.platforms, selectedPlatforms)
  const rebuilt = buildCandidateManifest({
    identity,
    channel,
    selectedPlatforms,
    stages: candidate.artifacts.map(({ platform, ...artifact }) => ({
      ...candidate,
      platform,
      platforms: [platform],
      artifacts: [artifact],
    })),
  })
  if (
    JSON.stringify(sortCanonicalValue(candidate)) !==
    JSON.stringify(sortCanonicalValue(rebuilt))
  ) {
    throw new Error(
      'Completed Document Renderer manifest identity does not match this release',
    )
  }
}

function buildCandidateCatalogPayload({ identity, channel, candidate, release }) {
  assertCandidateIdentity(candidate, identity, channel, candidate.platforms)
  const assetsByName = new Map(
    release.assets.map((asset) => [asset.name, asset]),
  )
  return {
    schemaVersion: 1,
    product: 'document-renderer',
    version: identity.version,
    tag: identity.tag,
    channel,
    platforms: candidate.platforms,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.sourceCommit,
    artifacts: candidate.artifacts.map((artifact) => {
      const asset = assetsByName.get(artifact.fileName)
      if (!asset) {
        throw new Error(
          `Missing uploaded Document Renderer asset ${artifact.fileName}`,
        )
      }
      return { ...artifact, assetId: String(asset.id) }
    }),
  }
}

function releaseAttestationKey({ required = true } = {}) {
  const keyId = process.env.VELAROS_RELEASE_ATTESTATION_KEY_ID?.trim()
  const encodedKey =
    process.env.VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY?.trim()
  if ((keyId || encodedKey) && (!keyId || !encodedKey)) {
    throw new Error(
      'Document Renderer release attestation requires both key ID and private key',
    )
  }
  if (!keyId || !encodedKey) {
    if (required) {
      throw new Error(
        'Document Renderer catalog requires release attestation signing configuration',
      )
    }
    return null
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)) {
    throw new Error('Document Renderer release attestation key ID is invalid')
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(encodedKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Document Renderer release attestation key must be Ed25519')
  }
  return { keyId, privateKey }
}

function releaseAttestationPublicKeys(signing) {
  const keys = new Map()
  if (signing) keys.set(signing.keyId, createPublicKey(signing.privateKey))
  const encoded =
    process.env.VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS?.trim() ?? ''
  for (const entry of encoded
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(':')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error('VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS is invalid')
    }
    const keyId = entry.slice(0, separator)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)) {
      throw new Error(
        `Document Renderer trusted release key ID ${keyId} is invalid`,
      )
    }
    const publicKey = createPublicKey({
      key: Buffer.from(entry.slice(separator + 1), 'base64'),
      format: 'der',
      type: 'spki',
    })
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `Document Renderer trusted release key ${keyId} must be Ed25519`,
      )
    }
    const existing = keys.get(keyId)
    if (
      existing &&
      !existing
        .export({ format: 'der', type: 'spki' })
        .equals(publicKey.export({ format: 'der', type: 'spki' }))
    ) {
      throw new Error(
        `Document Renderer trusted release key ${keyId} conflicts with the current signing key`,
      )
    }
    if (!existing) keys.set(keyId, publicKey)
  }
  return keys
}

function buildCandidateCatalog(input, { requireAttestation = true } = {}) {
  const payload = buildCandidateCatalogPayload(input)
  const signing = releaseAttestationKey({ required: requireAttestation })
  if (!signing) return payload
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(sortCanonicalValue(payload)), 'utf8'),
    signing.privateKey,
  ).toString('base64url')
  return {
    ...payload,
    attestation: {
      algorithm: 'ed25519',
      keyId: signing.keyId,
      signature,
    },
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

  async assertPublic() {
    const repository = await this.request(
      `https://api.github.com/repos/${this.repository}`,
    )
    if (repository.private !== false || repository.visibility !== 'public') {
      throw new Error(
        `Refusing to upload Document Renderer capability packs to non-public ${this.repository}`,
      )
    }
  }

  async findRelease(tag) {
    const release = await this.request(
      `https://api.github.com/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`,
      { allowNotFound: true },
    )
    if (release && (release.draft || !release.prerelease)) {
      throw new Error(`${tag} must remain a published prerelease candidate`)
    }
    return release
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
          body: `Public Velar Document Renderer candidate from ${identity.sourceRepository}@${identity.sourceCommit}.`,
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

function output(name, value) {
  const line = `${name}=${String(value)}\n`
  console.info(line.trim())
}

function clientFromEnvironment() {
  return new GitHubReleaseClient(
    process.env.VELAROS_RELEASE_REPOSITORY?.trim(),
    process.env.VELAROS_RELEASE_REPO_TOKEN?.trim(),
  )
}

async function plan(options, dependencies = {}) {
  const identity = await (dependencies.identity ?? releaseIdentity)()
  if (options.dryRun) {
    await output('renderer_needed', true)
    return { identity, needed: true }
  }
  const client = (dependencies.client ?? clientFromEnvironment)()
  await client.assertPublic()
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
  assertCandidateIdentity(
    candidate,
    identity,
    options.channel,
    candidate.platforms,
  )
  const catalogAsset = await client.readAsset(
    release,
    `catalog-${identity.tag}-${options.channel}.json`,
  )
  if (!catalogAsset) {
    await output('renderer_needed', true)
    return { identity, needed: true }
  }
  const verified = assertCatalogMatchesCandidate(
    JSON.parse(catalogAsset.bytes.toString('utf8')),
    { identity, channel: options.channel, candidate, release },
  )
  if (!verified) {
    await output('renderer_needed', true)
    return { identity, needed: true }
  }
  await verifyRemoteCapabilityPacks(client, release, candidate)
  if (
    !options.platforms.every((platform) =>
      candidate.platforms.includes(platform),
    )
  ) {
    await output('renderer_needed', true)
    return {
      identity,
      needed: true,
      completedPlatforms: candidate.platforms,
    }
  }
  await output('renderer_needed', false)
  return { identity, needed: false }
}

async function stage(options, dependencies = {}) {
  const identity = await (dependencies.identity ?? releaseIdentity)()
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
    selectedPlatforms: options.platforms,
  })
  if (options.dryRun) {
    console.info(`would stage ${identity.tag}/${options.platform}`)
    return stageManifest
  }
  const client = (dependencies.client ?? clientFromEnvironment)()
  await client.assertPublic()
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

function assertCatalogMatchesCandidate(catalog, input) {
  const expected = buildCandidateCatalogPayload(input)
  const payload = { ...catalog }
  delete payload.attestation
  if (
    JSON.stringify(sortCanonicalValue(payload)) !==
    JSON.stringify(sortCanonicalValue(expected))
  ) {
    throw new Error(
      'Document Renderer catalog does not match the completed capability pack identities',
    )
  }
  if (
    catalog.attestation?.algorithm !== 'ed25519' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      catalog.attestation?.keyId,
    ) ||
    !/^[A-Za-z0-9_-]{86}$/u.test(catalog.attestation?.signature)
  ) {
    throw new Error('Document Renderer catalog is missing a valid attestation')
  }
  const signing = releaseAttestationKey({ required: false })
  const trustedKeys = releaseAttestationPublicKeys(signing)
  if (trustedKeys.size === 0) return false
  const publicKey = trustedKeys.get(catalog.attestation.keyId)
  if (!publicKey) {
    throw new Error(
      'Document Renderer catalog attestation key is not trusted by this release configuration',
    )
  }
  if (
    !verify(
      null,
      Buffer.from(JSON.stringify(sortCanonicalValue(expected)), 'utf8'),
      publicKey,
      Buffer.from(catalog.attestation.signature, 'base64url'),
    )
  ) {
    throw new Error(
      'Document Renderer catalog attestation signature verification failed',
    )
  }
  return true
}

async function verifyRemoteCapabilityPacks(client, release, candidate) {
  for (const artifact of candidate.artifacts) {
    const uploaded = await client.readAsset(release, artifact.fileName)
    if (
      !uploaded ||
      uploaded.bytes.length !== artifact.sizeBytes ||
      createHash('sha256').update(uploaded.bytes).digest('hex') !==
        artifact.sha256
    ) {
      throw new Error(
        `Uploaded Document Renderer capability pack does not match its staged hash: ${artifact.fileName}`,
      )
    }
  }
}

async function finalize(options, dependencies = {}) {
  const identity = await (dependencies.identity ?? releaseIdentity)()
  const client = (dependencies.client ?? clientFromEnvironment)()
  await client.assertPublic()
  const release = await client.findRelease(identity.tag)
  if (!release) throw new Error(`Missing staged release ${identity.tag}`)
  const fileName = `candidate-document-renderer-${options.channel}.json`
  const incompleteCompletion = await client.readAsset(release, fileName)
  let previousCandidate = null
  if (incompleteCompletion) {
    previousCandidate = JSON.parse(incompleteCompletion.bytes.toString('utf8'))
    assertCandidateIdentity(
      previousCandidate,
      identity,
      options.channel,
      previousCandidate.platforms,
    )
  }
  const stages = []
  const requestedPlatforms = normalizePlatforms(
    options.platformsExplicit && previousCandidate
      ? [...new Set([...previousCandidate.platforms, ...options.platforms])]
      : options.platforms,
  )
  for (const platform of requestedPlatforms) {
    const staged = await client.readAsset(
      release,
      `staged-document-renderer-${platform}.json`,
    )
    if (!staged) {
      if (options.platformsExplicit) {
        throw new Error(
          `Missing staged Document Renderer capability pack for ${platform}`,
        )
      }
      continue
    }
    stages.push(JSON.parse(staged.bytes.toString('utf8')))
  }
  if (stages.length === 0) {
    throw new Error('No staged Document Renderer platform is available')
  }
  const selectedPlatforms = normalizePlatforms(
    stages.map(({ platform }) => platform),
  )
  const candidate = buildCandidateManifest({
    identity,
    channel: options.channel,
    stages,
    selectedPlatforms,
  })
  await verifyRemoteCapabilityPacks(client, release, candidate)
  const catalog = buildCandidateCatalog(
    { identity, channel: options.channel, candidate, release },
    { requireAttestation: !options.dryRun },
  )
  if (options.dryRun) {
    console.info(
      `would finalize ${identity.tag}/${options.channel} for ${selectedPlatforms.join(', ')}`,
    )
    return candidate
  }
  const outputRoot =
    dependencies.outputRoot ??
    resolve(repoRoot, 'dist-document-renderer', 'release')
  const catalogName = `catalog-${identity.tag}-${options.channel}.json`
  if (incompleteCompletion) {
    for (const artifact of previousCandidate.artifacts) {
      const next = candidate.artifacts.find(
        ({ platform }) => platform === artifact.platform,
      )
      if (
        JSON.stringify(sortCanonicalValue(next)) !==
        JSON.stringify(sortCanonicalValue(artifact))
      ) {
        throw new Error(
          `Document Renderer platform addition changed ${artifact.platform}`,
        )
      }
    }
    await client.deleteAsset(incompleteCompletion.asset.id)
    release.assets = release.assets.filter(
      ({ id }) => id !== incompleteCompletion.asset.id,
    )
    console.info(
      `removed incomplete ${identity.tag}/${fileName} before retrying finalization`,
    )
  }
  await mkdir(outputRoot, { recursive: true })
  await writeFile(
    resolve(outputRoot, catalogName),
    `${JSON.stringify(catalog, null, 2)}\n`,
  )
  await client.uploadBytes(
    release,
    catalogName,
    Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`),
    {
      replaceExisting:
        options.replaceExisting || Boolean(incompleteCompletion),
    },
  )
  await client.uploadBytes(
    release,
    fileName,
    Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`),
    { replaceExisting: options.replaceExisting },
  )
  await writeFile(
    resolve(outputRoot, fileName),
    `${JSON.stringify(candidate, null, 2)}\n`,
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
  buildCandidateCatalog,
  buildStageManifest,
  finalize,
  GitHubReleaseClient,
  normalizePlatforms,
  parseArguments,
  plan,
  platforms,
  releaseAttestationKey,
  releaseAttestationPublicKeys,
  releaseIdentity,
  stage,
}
