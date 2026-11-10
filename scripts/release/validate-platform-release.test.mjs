import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  assertPlatformArtifactBytes,
  assertPlatformReleaseLockSources,
  platformReleasePair,
} from './validate-platform-release.mjs'

const sourceSha = 'a'.repeat(40)
const releaseTag = 'v0.7.8'
const rootManifest = { repository: { url: 'https://github.com/VelarOS-AI/VelarOS-Platform.git' } }
const bytes = Buffer.from('one exact release archive')
const artifact = (name) => ({
  name,
  version: '0.9.7',
  sourceSha,
  releaseTag,
  fileName: `${name.split('/').at(-1)}-0.9.7.tgz`,
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
})
const artifacts = ['@velaros-ai/velaros', '@velaros-ai/capabilities'].map(artifact)
const pair = () => platformReleasePair({ rootManifest, releaseTag, sourceSha, artifacts })
const lock = () => {
  const packages = pair()
  return {
    lockfileVersion: 2,
    workspaces: {
      '': { dependencies: Object.fromEntries(packages.map((item) => [item.name, item.url])) },
    },
    packages: Object.fromEntries(
      packages.map((item) => [
        item.name,
        [
          `${item.name}@${item.url}`,
          {
            dependencies:
              item.name === '@velaros-ai/capabilities'
                ? { '@velaros-ai/velaros': packages[0].url }
                : {},
          },
          item.integrity,
        ],
      ])
    ),
  }
}

test('release pair binds each official URL to the exact artifact source and preserves repository case', () => {
  const packages = pair()
  assert.equal(
    packages[0].url,
    'https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.8/velaros-0.9.7.tgz'
  )
  assert.equal(
    packages[1].url,
    'https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.8/capabilities-0.9.7.tgz'
  )
  for (const changes of [
    { sourceSha: 'b'.repeat(40) },
    { releaseTag: 'v0.7.7' },
    { fileName: '../velaros.tgz' },
    { fileName: 'C:velaros.tgz' },
    { url: packages[0].url.toLowerCase() },
    { url: 'file:/unverified/base.tgz' },
    { sizeBytes: 0 },
  ]) {
    const changed = [{ ...artifacts[0], ...changes }, artifacts[1]]
    assert.throws(() =>
      platformReleasePair({ rootManifest, releaseTag, sourceSha, artifacts: changed })
    )
  }
  assert.throws(() =>
    platformReleasePair({
      rootManifest,
      releaseTag,
      sourceSha,
      artifacts: [artifacts[0], ...artifacts],
    })
  )
  assert.throws(() =>
    platformReleasePair({ rootManifest, releaseTag, sourceSha, artifacts: [artifacts[0]] })
  )
})

test('archive receipts reject changed bytes, size, SHA-256 or integrity independently', () => {
  assert.doesNotThrow(() => assertPlatformArtifactBytes(artifacts[0], bytes))
  assert.throws(() =>
    assertPlatformArtifactBytes(artifacts[0], Buffer.from('other exact release blob'))
  )
  for (const changes of [
    { sizeBytes: bytes.length + 1 },
    { sha256: '0'.repeat(64) },
    { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
  ])
    assert.throws(() => assertPlatformArtifactBytes({ ...artifacts[0], ...changes }, bytes))
})

test('ordinary lock proof requires direct official sources and exact SRI for both packages', () => {
  const packages = pair()
  assert.equal(assertPlatformReleaseLockSources(lock(), packages).length, 2)
  for (const mutate of [
    (value) => {
      value.lockfileVersion = 1
    },
    (value) => {
      value.overrides = { [packages[0].name]: packages[0].url }
    },
    (value) => {
      value.resolutions = {}
    },
    (value) => {
      value.workspaces[''].dependencies[packages[0].name] = `file:/local/base.tgz`
    },
    (value) => {
      value.packages[packages[0].name][0] = `${packages[0].name}@0.9.7`
    },
    (value) => {
      value.packages[packages[0].name][0] = packages[0].url
    },
    (value) => {
      value.packages[packages[0].name][0] = `alias@${packages[0].url}`
    },
    (value) => {
      value.packages[packages[0].name][0] = packages[0].url.toLowerCase()
    },
    (value) => {
      value.packages[packages[0].name].pop()
    },
    (value) => {
      value.packages[packages[0].name].push(packages[0].integrity)
    },
    (value) => {
      value.packages[packages[0].name].push(`sha512-${Buffer.alloc(64).toString('base64')}`)
      value.packages[packages[0].name].splice(2, 1)
    },
    (value) => {
      value.packages[packages[0].name] = [
        `${packages[0].name}@0.9.7`,
        { source: packages[0].url, integrity: packages[0].integrity },
      ]
    },
    (value) => {
      value.packages[`nested/${packages[0].name}`] = value.packages[packages[0].name]
    },
    (value) => {
      value.packages[packages[1].name][1].dependencies[packages[0].name] = '0.9.7'
    },
    (value) => {
      value.workspaces.extra = {}
    },
  ]) {
    const changed = lock()
    mutate(changed)
    assert.throws(() => assertPlatformReleaseLockSources(changed, packages))
  }
})
