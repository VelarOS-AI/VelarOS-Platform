import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCandidateArtifactTrust,
  buildCandidateManifest,
  buildStageManifest,
  parseArguments,
  platforms,
} from './release-candidate.mjs'

const identity = {
  product: 'document-renderer',
  version: '0.2.0',
  tag: 'document-renderer-v0.2.0',
  sourceRepository: 'VelarOS-AI/VelarOS-Platform',
  sourceCommit: 'a'.repeat(40),
}

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
    },
  )
  assert.throws(
    () => parseArguments(['stage', '--platform', 'darwin-x64']),
    /--platform/u,
  )
})

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
