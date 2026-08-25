import assert from 'node:assert/strict'
import test from 'node:test'

import { desiredSpecification, replaceRequirementSource } from './sync-platform-consumer.mjs'
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
