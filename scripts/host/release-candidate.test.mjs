import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCandidateManifest,
  buildStageManifest,
  parseArguments,
  platforms,
} from './release-candidate.mjs'

const identity = {
  product: 'host',
  version: '0.2.0',
  tag: 'host-v0.2.0',
  sourceRepository: 'VelarOS-AI/VelarOS-Platform',
  sourceCommit: 'a'.repeat(40),
}

test('Host staged manifests bind one installer to one source identity', () => {
  const stage = buildStageManifest({
    identity,
    channel: 'stable',
    platform: 'darwin-arm64',
    artifact: {
      fileName: 'Velar-Host.dmg',
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
    },
  })
  assert.equal(stage.product, 'host')
  assert.equal(stage.sourceCommit, identity.sourceCommit)
  assert.deepEqual(stage.artifacts, [
    {
      fileName: 'Velar-Host.dmg',
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
      role: 'installer',
    },
  ])
})

test('Host candidate finalization requires all three native platforms', () => {
  const stages = platforms.map((platform, index) =>
    buildStageManifest({
      identity,
      channel: 'canary',
      platform,
      artifact: {
        fileName: `host-${platform}`,
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
    /Missing staged Host installer/u,
  )
})

test('Host release arguments make remote writes explicit', () => {
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
