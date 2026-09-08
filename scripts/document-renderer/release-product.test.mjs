import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  parseArguments,
  releasePlatform,
  run,
} from './release-product.mjs'

test('Document Renderer local release defaults to the stable immutable path', () => {
  assert.deepEqual(parseArguments([]), {
    channel: 'stable',
    dryRun: false,
    checkOnly: false,
    replaceExisting: false,
    platform: null,
  })
})

test('Document Renderer local release makes replacement and dry run explicit', () => {
  assert.deepEqual(
    parseArguments(['--channel', 'canary', '--dry-run', '--replace-existing']),
    {
      channel: 'canary',
      dryRun: true,
      checkOnly: false,
      replaceExisting: true,
      platform: null,
    },
  )
  assert.throws(
    () => parseArguments(['--channel', 'nightly']),
    /stable or canary/u,
  )
})

test('Document Renderer local release selects exactly one native platform', () => {
  assert.equal(parseArguments(['--local-macos']).platform, 'darwin-arm64')
  assert.equal(parseArguments(['--local-windows']).platform, 'win32-x64')
  assert.equal(parseArguments(['--local-linux']).platform, 'linux-x64')
  assert.equal(
    releasePlatform(null, { platform: 'darwin', arch: 'arm64' }),
    'darwin-arm64',
  )
  assert.equal(
    releasePlatform(null, { platform: 'win32', arch: 'x64' }),
    'win32-x64',
  )
  assert.throws(
    () => parseArguments(['--local-macos', '--local-windows']),
    /only one local native platform/u,
  )
  assert.throws(
    () => releasePlatform(null, { platform: 'darwin', arch: 'x64' }),
    /requires darwin-arm64, win32-x64, or linux-x64/u,
  )
})

test('local macOS release verifies, stages, and finalizes only macOS', async (t) => {
  attestationEnvironment(t)
  const calls = []
  const source = {
    sourceRepository: 'VelarOS-AI/VelarOS-Platform',
    sourceCommit: 'a'.repeat(40),
    version: '0.1.4',
  }
  const artifact = {
    manifestPath: '/release/mac.json',
    artifactPath: '/release/Velar-Document-Renderer.zip',
  }
  const result = await run(
    parseArguments(['--local-macos', '--channel', 'canary']),
    {
      preflight: async (options) => {
        assert.deepEqual(options, {
          requirePublishConfig: true,
          platform: 'darwin-arm64',
        })
        return source
      },
      command: async (_command, arguments_) => {
        assert.deepEqual(
          arguments_.slice(-2),
          ['--platforms', 'darwin-arm64'],
        )
        return 'renderer_needed=true'
      },
      inheritedCommand: async (...arguments_) => calls.push(arguments_),
      reusableArtifact: async (_context, platform) => {
        assert.equal(platform, 'darwin-arm64')
        return artifact
      },
      assertSourceUnchanged: async () => {},
    },
  )
  assert.deepEqual(result.platforms, ['darwin-arm64'])
  assert.deepEqual(
    calls.slice(0, 2).map(([command, arguments_]) => [command, arguments_]),
    [
      ['bun', ['install', '--frozen-lockfile']],
      ['bun', ['run', 'check']],
    ],
  )
  assert.deepEqual(
    calls.slice(2).map(([command, arguments_]) => [command, arguments_[1]]),
    [
      ['node', 'stage'],
      ['node', 'finalize'],
    ],
  )
  assert.ok(
    calls
      .slice(2)
      .every(
        ([, arguments_]) =>
          arguments_.includes('--platforms') &&
          arguments_.includes('darwin-arm64'),
      ),
  )
})

test('local dry run never builds, uploads, or dispatches a workflow', async () => {
  const unexpected = async () => {
    throw new Error('dry run reached a mutating command')
  }
  const result = await run(parseArguments(['--local-macos', '--dry-run']), {
    preflight: async () => ({
      sourceRepository: 'VelarOS-AI/VelarOS-Platform',
      sourceCommit: 'a'.repeat(40),
      version: '0.1.4',
    }),
    command: unexpected,
    inheritedCommand: unexpected,
    reusableArtifact: unexpected,
  })
  assert.equal(result.dryRun, true)
})

test('local publication requires attestation before running quality or upload', async (t) => {
  attestationEnvironment(t, false)
  let reachedWork = false
  await assert.rejects(
    run(parseArguments(['--local-macos', '--channel', 'canary']), {
      preflight: async () => ({
        sourceRepository: 'VelarOS-AI/VelarOS-Platform',
        sourceCommit: 'a'.repeat(40),
        version: '0.1.4',
      }),
      command: async () => {
        reachedWork = true
      },
      inheritedCommand: async () => {
        reachedWork = true
      },
    }),
    /attestation signing configuration/u,
  )
  assert.equal(reachedWork, false)
})

test('all GitHub Actions routes remain inert local-only policy sentinels', async () => {
  const workflows = [
    {
      path: '../../.github/workflows/ci.yml',
      forbidden: /actions\/checkout|pull_request:|push:/u,
    },
    {
      path: '../../.github/workflows/codeql.yml',
      forbidden: /github\/codeql-action|security-events:|schedule:/u,
    },
    {
      path: '../../.github/workflows/release-packages.yml',
      forbidden: /publish-packages\.mjs|actions\/checkout|secrets\./u,
    },
    {
      path: '../../.github/workflows/release-document-renderer.yml',
      forbidden: /release-candidate\.mjs|build-product\.mjs|actions\/checkout|secrets\./u,
    },
  ]
  for (const workflow of workflows) {
    const source = (await readFile(new URL(workflow.path, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    )
    const jobsMarker = '\njobs:\n'
    const jobsIndex = source.indexOf(jobsMarker)
    assert.notEqual(jobsIndex, -1)
    const jobsSource = source.slice(jobsIndex + jobsMarker.length)
    assert.equal(jobsSource.match(/^  [A-Za-z0-9_-]+:\s*$/gmu)?.length, 1)
    assert.equal(jobsSource.match(/^    if: \$\{\{ false \}\}\s*$/gmu)?.length, 1)
    assert.deepEqual(
      [...jobsSource.matchAll(/^\s*-\s+(run|uses):\s*(.+)$/gmu)].map((match) =>
        `${match[1]}: ${match[2]}`,
      ),
      ['run: exit 1'],
    )
    assert.doesNotMatch(jobsSource, /^\s+uses:/mu)
    assert.doesNotMatch(source, workflow.forbidden)
  }
})

function attestationEnvironment(t, configured = true) {
  const names = [
    'VELAROS_RELEASE_ATTESTATION_KEY_ID',
    'VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY',
  ]
  const previous = names.map((name) => process.env[name])
  for (const name of names) delete process.env[name]
  if (configured) {
    const { privateKey } = generateKeyPairSync('ed25519')
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
