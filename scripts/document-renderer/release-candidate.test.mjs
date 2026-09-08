import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertCandidateArtifactTrust,
  buildCandidateManifest,
  buildStageManifest,
  finalize,
  parseArguments,
  plan,
  platforms,
  releaseIdentity,
  stage,
} from './release-candidate.mjs'

const identity = {
  product: 'document-renderer',
  version: '0.2.0',
  tag: 'document-renderer-v0.2.0',
  sourceRepository: 'VelarOS-AI/VelarOS-Platform',
  sourceCommit: 'a'.repeat(40),
}

test('Document Renderer source identity accepts only explicit local release inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'document-renderer-local-identity-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const names = [
    'VELAROS_SOURCE_REPOSITORY',
    'VELAROS_SOURCE_COMMIT',
    'GITHUB_REPOSITORY',
    'GITHUB_SHA',
    'GITHUB_OUTPUT',
  ]
  const previous = names.map((name) => process.env[name])
  t.after(() =>
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    }),
  )
  for (const name of names) delete process.env[name]
  process.env.GITHUB_REPOSITORY = identity.sourceRepository
  process.env.GITHUB_SHA = identity.sourceCommit
  const hostedOutput = join(root, 'hosted-output')
  process.env.GITHUB_OUTPUT = hostedOutput
  await assert.rejects(releaseIdentity(), /VELAROS_SOURCE_REPOSITORY/u)

  process.env.VELAROS_SOURCE_REPOSITORY = identity.sourceRepository
  process.env.VELAROS_SOURCE_COMMIT = identity.sourceCommit
  const resolved = await releaseIdentity()
  assert.equal(resolved.sourceRepository, identity.sourceRepository)
  assert.equal(resolved.sourceCommit, identity.sourceCommit)
  await plan(
    {
      command: 'plan',
      channel: 'stable',
      dryRun: true,
      replaceExisting: false,
      platforms: [...platforms],
      platformsExplicit: false,
    },
    { identity: async () => identity },
  )
  await assert.rejects(readFile(hostedOutput), { code: 'ENOENT' })
})

test('Document Renderer staged manifests bind one capability pack to one source identity', () => {
  const stage = buildStageManifest({
    identity,
    channel: 'stable',
    platform: 'darwin-arm64',
    artifact: {
      fileName: 'Velar-Document Renderer.dmg',
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
    },
  })
  assert.equal(stage.product, 'document-renderer')
  assert.equal(stage.sourceCommit, identity.sourceCommit)
  assert.deepEqual(stage.artifacts, [
    {
      fileName: 'Velar-Document Renderer.dmg',
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
      role: 'capability-pack',
    },
  ])
})

test('Document Renderer candidate finalization requires all three native platforms', () => {
  const stages = platforms.map((platform, index) =>
    buildStageManifest({
      identity,
      channel: 'canary',
      platform,
      artifact: {
        fileName: `document-renderer-${platform}`,
        sizeBytes: index + 1,
        sha256: String(index).repeat(64),
      },
    }),
  )
  const candidate = buildCandidateManifest({
    identity,
    channel: 'canary',
    stages,
  })
  assert.equal(candidate.artifacts.length, 3)
  assert.deepEqual(
    candidate.artifacts.map(({ platform }) => platform),
    platforms,
  )
  assert.throws(
    () =>
      buildCandidateManifest({
        identity,
        channel: 'canary',
        stages: stages.slice(1),
      }),
    /Missing staged Document Renderer capability pack/u,
  )
})

test('Document Renderer release arguments make remote writes explicit', () => {
  assert.deepEqual(
    parseArguments(['plan', '--dry-run', '--channel', 'canary']),
    {
      command: 'plan',
      channel: 'canary',
      dryRun: true,
      replaceExisting: false,
      platforms: [...platforms],
      platformsExplicit: false,
    },
  )
  assert.throws(
    () => parseArguments(['stage', '--platform', 'darwin-x64']),
    /--platform/u,
  )
})

test('local platform scope cannot finalize a different native set', () => {
  const stages = [
    buildStageManifest({
      identity,
      channel: 'canary',
      platform: 'darwin-arm64',
      selectedPlatforms: ['darwin-arm64'],
      artifact: {
        fileName: 'Velar-Document-Renderer.zip',
        sizeBytes: 10,
        sha256: 'c'.repeat(64),
      },
    }),
  ]
  const candidate = buildCandidateManifest({
    identity,
    channel: 'canary',
    stages,
    selectedPlatforms: ['darwin-arm64'],
  })
  assert.deepEqual(stages[0].platforms, ['darwin-arm64'])
  assert.deepEqual(candidate.platforms, ['darwin-arm64'])
  assert.equal(candidate.artifacts.length, 1)
  assert.throws(
    () =>
      buildCandidateManifest({
        identity,
        channel: 'canary',
        stages,
      }),
    /Missing staged/u,
  )
  assert.throws(
    () =>
      parseArguments([
        'finalize',
        '--platforms',
        'darwin-arm64,darwin-arm64',
      ]),
    /unique/u,
  )
  assert.throws(
    () =>
      parseArguments([
        'stage',
        '--platform',
        'linux-x64',
        '--platforms',
        'darwin-arm64',
        '--artifact-manifest',
        'mac.json',
      ]),
    /belong/u,
  )
})

test('stage dry run validates bytes without opening the release client', async (t) => {
  const fixture = await releaseFixture(t)
  const result = await stage(
    {
      ...fixture.options,
      command: 'stage',
      dryRun: true,
      platform: 'darwin-arm64',
      artifactManifest: fixture.manifestPath,
    },
    {
      identity: async () => identity,
      client: () => {
        throw new Error('dry run attempted remote access')
      },
    },
  )
  assert.deepEqual(result.platforms, ['darwin-arm64'])
  await writeFile(
    join(fixture.root, 'Velar-Document-Renderer.zip'),
    'changed',
  )
  await assert.rejects(
    stage(
      {
        ...fixture.options,
        dryRun: true,
        platform: 'darwin-arm64',
        artifactManifest: fixture.manifestPath,
      },
      { identity: async () => identity },
    ),
    /bytes do not match/u,
  )
})

test('local finalization signs the catalog before publishing completion', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  signingEnvironment(t, privateKey)
  const fixture = await releaseFixture(t, 'stable')
  const candidate = await finalize(fixture.options, fixture.dependencies)
  const catalogName = `catalog-${identity.tag}-stable.json`
  assert.deepEqual(fixture.writes, [
    catalogName,
    'candidate-document-renderer-stable.json',
  ])
  assert.deepEqual(candidate.platforms, ['darwin-arm64'])
  const catalog = JSON.parse(fixture.assets.get(catalogName).toString('utf8'))
  const { attestation, ...payload } = catalog
  assert.equal(attestation.algorithm, 'ed25519')
  assert.equal(
    verify(
      null,
      Buffer.from(JSON.stringify(canonical(payload))),
      publicKey,
      Buffer.from(attestation.signature, 'base64url'),
    ),
    true,
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(join(fixture.outputRoot, catalogName), 'utf8'),
    ),
    catalog,
  )
  assert.equal((await plan(fixture.options, fixture.dependencies)).needed, false)
  assert.equal(
    (
      await plan(
        { ...fixture.options, platforms: [...platforms] },
        fixture.dependencies,
      )
    ).needed,
    true,
  )
})

test('missing attestation never publishes a completion marker', async (t) => {
  signingEnvironment(t)
  const fixture = await releaseFixture(t, 'stable')
  await assert.rejects(
    finalize(fixture.options, fixture.dependencies),
    /attestation signing configuration/u,
  )
  assert.deepEqual(fixture.writes, [])
})

test('a later native host adds its platform without changing the completed one', async (t) => {
  const { privateKey } = generateKeyPairSync('ed25519')
  signingEnvironment(t, privateKey)
  const fixture = await releaseFixture(t, 'stable')
  const macCandidate = await finalize(fixture.options, fixture.dependencies)

  const windowsBytes = Buffer.from('verified Windows capability pack')
  const windowsArtifact = {
    fileName: 'Velar-Document-Renderer-0.2.0-x64.zip',
    sizeBytes: windowsBytes.length,
    sha256: createHash('sha256').update(windowsBytes).digest('hex'),
  }
  const windowsStage = buildStageManifest({
    identity,
    channel: 'stable',
    platform: 'win32-x64',
    artifact: windowsArtifact,
  })
  fixture.assets.set(windowsArtifact.fileName, windowsBytes)
  fixture.assets.set(
    'staged-document-renderer-win32-x64.json',
    Buffer.from(JSON.stringify(windowsStage)),
  )
  fixture.release.assets.push(
    { id: 20, name: windowsArtifact.fileName },
    { id: 21, name: 'staged-document-renderer-win32-x64.json' },
  )

  const candidate = await finalize(
    {
      ...fixture.options,
      platforms: ['win32-x64'],
      platformsExplicit: true,
    },
    fixture.dependencies,
  )
  assert.deepEqual(candidate.platforms, ['darwin-arm64', 'win32-x64'])
  assert.deepEqual(candidate.artifacts[0], macCandidate.artifacts[0])
})

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function signingEnvironment(t, privateKey) {
  const names = [
    'VELAROS_RELEASE_ATTESTATION_KEY_ID',
    'VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY',
  ]
  const previous = names.map((name) => process.env[name])
  for (const name of names) delete process.env[name]
  if (privateKey) {
    process.env[names[0]] = 'fixture-key'
    process.env[names[1]] = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64')
  }
  t.after(() =>
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    }),
  )
}

async function releaseFixture(t, channel = 'canary') {
  const root = await mkdtemp(join(tmpdir(), 'document-renderer-release-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('signed and notarized fixture')
  const artifact = {
    fileName: 'Velar-Document-Renderer.zip',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const manifestPath = join(root, 'mac.json')
  await writeFile(join(root, artifact.fileName), bytes)
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...artifact,
      ...identity,
      platform: 'darwin-arm64',
      sourceDirty: false,
      trust: { signature: 'developer-id', notarized: true },
    }),
  )
  const stageManifest = buildStageManifest({
    identity,
    channel,
    platform: 'darwin-arm64',
    artifact,
    selectedPlatforms: ['darwin-arm64'],
  })
  const stageName = 'staged-document-renderer-darwin-arm64.json'
  const assets = new Map([
    [artifact.fileName, bytes],
    [stageName, Buffer.from(JSON.stringify(stageManifest))],
  ])
  const release = {
    tag_name: identity.tag,
    assets: [...assets.keys()].map((name, index) => ({
      id: index + 1,
      name,
    })),
  }
  const writes = []
  const client = {
    assertPublic: async () => {},
    findRelease: async () => release,
    readAsset: async (_release, name) =>
      assets.has(name)
        ? {
            bytes: assets.get(name),
            asset: release.assets.find((asset_) => asset_.name === name),
          }
        : null,
    uploadBytes: async (_release, name, contents) => {
      writes.push(name)
      assets.set(name, contents)
      if (!release.assets.some((asset_) => asset_.name === name)) {
        release.assets.push({ id: release.assets.length + 1, name })
      }
    },
    deleteAsset: async (assetId) => {
      const asset = release.assets.find(({ id }) => id === assetId)
      if (!asset) return
      assets.delete(asset.name)
      release.assets = release.assets.filter(({ id }) => id !== assetId)
    },
  }
  const options = {
    channel,
    platforms: ['darwin-arm64'],
    platformsExplicit: true,
    dryRun: false,
    replaceExisting: false,
  }
  const outputRoot = join(root, 'output')
  const dependencies = {
    identity: async () => identity,
    client: () => client,
    outputRoot,
  }
  return {
    root,
    manifestPath,
    options,
    dependencies,
    outputRoot,
    assets,
    writes,
    release,
  }
}

test('macOS staging rejects development-signed artifacts', () => {
  assert.doesNotThrow(() =>
    assertCandidateArtifactTrust(
      { trust: { signature: 'developer-id', notarized: true } },
      'darwin-arm64',
    ),
  )
  assert.throws(
    () =>
      assertCandidateArtifactTrust(
        { trust: { signature: 'ad-hoc', notarized: false } },
        'darwin-arm64',
      ),
    /Developer ID signing and notarization/u,
  )
})
