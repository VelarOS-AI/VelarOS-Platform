import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  desiredSpecification,
  manifestPathsFromLockfile,
  readManifests,
  replaceRequirementSource,
} from './sync-platform-consumer.mjs'
import { resolveTypeScriptJsoncParser, selectReleasedPackages } from './releaseTopology.mjs'

test('resolves the TypeScript JSONC parser from namespace and default interop shapes', () => {
  const directParser = () => ({ config: {} })
  const defaultParser = () => ({ config: {} })

  assert.equal(
    resolveTypeScriptJsoncParser({ parseConfigFileTextToJson: directParser }),
    directParser,
  )
  assert.equal(
    resolveTypeScriptJsoncParser({
      default: { parseConfigFileTextToJson: defaultParser },
    }),
    defaultParser,
  )
  assert.equal(
    resolveTypeScriptJsoncParser({
      default: { default: { parseConfigFileTextToJson: defaultParser } },
    }),
    defaultParser,
  )
})

test('preserves ordinary semver range intent while replacing the version', () => {
  assert.equal(desiredSpecification('^0.5.1', '0.6.0'), '^0.6.0')
  assert.equal(desiredSpecification('~2.0.1', '2.0.2'), '~2.0.2')
  assert.equal(desiredSpecification('1.0.0', '1.1.0'), '1.1.0')
})

test('converts local external package links into cloud-installable exact versions', () => {
  assert.equal(desiredSpecification('workspace:*', '0.6.0'), '0.6.0')
  assert.equal(desiredSpecification('file:../Platform/packages/agent', '0.6.0'), '0.6.0')
})

test('updates only the selected dependency value without reformatting the manifest', () => {
  const source = '{\n  "dependencies": {\n    "@velaros-ai/agent": "^0.5.1"\n  }\n}\n'
  assert.equal(
    replaceRequirementSource(source, '@velaros-ai/agent', '^0.5.1', '^0.6.0'),
    '{\n  "dependencies": {\n    "@velaros-ai/agent": "^0.6.0"\n  }\n}\n',
  )
})

test('rejects ambiguous version expressions instead of guessing', () => {
  assert.throws(
    () => desiredSpecification('>=0.4.0 <1', '0.6.0'),
    /Unsupported Platform package version specification/u,
  )
})

test('release selection keeps a single-package tag from upgrading unrelated packages', () => {
  const ordered = [
    {
      directoryName: 'core',
      manifest: { name: '@velaros-ai/core', version: '0.4.0' },
    },
    {
      directoryName: 'agent',
      manifest: { name: '@velaros-ai/agent', version: '0.6.0' },
    },
  ]
  const result = selectReleasedPackages({ version: '0.6.0' }, ordered, '@velaros-ai/agent@0.6.0')
  assert.deepEqual(result.packages, [ordered[1]])
})

test('train-only selection rejects unknown package names', () => {
  assert.throws(
    () =>
      selectReleasedPackages(
        { version: '0.6.0' },
        [
          {
            directoryName: 'core',
            manifest: { name: '@velaros-ai/core', version: '0.4.0' },
          },
        ],
        'v0.6.0',
        ['missing'],
      ),
    /matches no declared release package/u,
  )
})

test('a Bun lockfile limits consumer manifests to registered workspaces', async (t) => {
  const consumerRoot = await mkdtemp(path.join(tmpdir(), 'velaros-consumer-workspaces-'))
  t.after(() => rm(consumerRoot, { recursive: true, force: true }))
  await Promise.all([
    mkdir(path.join(consumerRoot, 'packages', 'ipc'), { recursive: true }),
    mkdir(path.join(consumerRoot, 'scratchpad', 'agent-harness-package-patch'), {
      recursive: true,
    }),
  ])
  await Promise.all([
    writeFile(
      path.join(consumerRoot, 'package.json'),
      '{"name":"desktop","dependencies":{"@velaros-ai/agent":"^0.6.10"}}\n',
    ),
    writeFile(
      path.join(consumerRoot, 'packages', 'ipc', 'package.json'),
      '{"name":"ipc","devDependencies":{"@velaros-ai/agent":"^0.6.10"}}\n',
    ),
    writeFile(
      path.join(consumerRoot, 'scratchpad', 'agent-harness-package-patch', 'package.json'),
      '{"name":"scratch-copy","dependencies":{"@velaros-ai/agent":"^0.6.8"}}\n',
    ),
  ])

  const manifests = await readManifests(consumerRoot, {
    lockfile: {
      workspaces: {
        '': { name: 'desktop' },
        'packages/ipc': { name: 'ipc' },
      },
    },
  })

  assert.deepEqual(
    manifests.map(({ workspaceKey }) => workspaceKey),
    ['', 'packages/ipc'],
  )
  assert.deepEqual(
    manifests.map(({ manifest }) => manifest.name),
    ['desktop', 'ipc'],
  )

  const manifestsWithoutLock = await readManifests(consumerRoot)
  assert.deepEqual(
    manifestsWithoutLock.map(({ manifest }) => manifest.name).sort(),
    ['desktop', 'ipc', 'scratch-copy'],
  )
})

test('lockfile workspace keys cannot escape or alias the consumer root', () => {
  for (const workspaceKey of ['../outside', 'packages/../outside', 'packages\\outside']) {
    assert.throws(
      () => manifestPathsFromLockfile('/tmp/consumer', { workspaces: { [workspaceKey]: {} } }),
      /invalid workspace key|escapes the consumer root/u,
    )
  }
  assert.throws(
    () => manifestPathsFromLockfile('/tmp/consumer', { workspaces: {} }),
    /at least one workspace/u,
  )
})
