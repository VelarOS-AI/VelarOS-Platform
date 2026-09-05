import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertLocalReleaseIdentity,
  githubRepositoryIdentity,
  parseReleaseArguments,
  runLocalReleaseChecks,
} from './local-release-identity.mjs'

const sourceSha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const tagObject = 'c'.repeat(40)
const tag = 'v0.6.13'
const ref = `refs/tags/${tag}`
const repository = { type: 'git', url: 'git+https://github.com/VelarOS-AI/VelarOS-Platform.git' }

function identityFixture(overrides = {}) {
  const state = {
    head: sourceSha,
    status: '',
    origin: 'git@github.com:VelarOS-AI/VelarOS-Platform.git',
    localObject: sourceSha,
    localCommit: sourceSha,
    remote: `${sourceSha}\t${ref}`,
    ...overrides,
  }
  const calls = []
  const verify = () => assertLocalReleaseIdentity({
    root: '/isolated-source',
    tag,
    repository,
    expectedSourceSha: sourceSha,
    runForOutput(command, args, root) {
      calls.push([command, args, root])
      assert.equal(command, 'git')
      assert.equal(root, '/isolated-source')
      if (state.failCommand === args[0]) throw new Error('git failed')
      if (args[0] === 'check-ref-format') return ''
      if (args[0] === 'status') return state.status
      if (args[0] === 'remote') return state.origin
      if (args[0] === 'ls-remote') {
        assert.deepEqual(args, ['ls-remote', '--exit-code', 'origin', ref, `${ref}^{}`])
        return state.remote
      }
      assert.equal(args[0], 'rev-parse')
      if (args[1] === 'HEAD') return state.head
      assert.equal(args[1], '--verify')
      if (args[2] === ref) return state.localObject
      assert.equal(args[2], `${ref}^{commit}`)
      return state.localCommit
    },
  })
  return { state, calls, verify }
}

test('release arguments require explicit local intent and preserve dry-run/CI selectors', () => {
  assert.deepEqual(parseReleaseArguments([]), {
    dryRun: false, skipBuild: false, localTag: undefined, onlySelectors: [],
  })
  assert.deepEqual(parseReleaseArguments(['--local-tag', tag, '--only', 'agent, model', '--only', 'memory']), {
    dryRun: false, skipBuild: false, localTag: tag, onlySelectors: ['agent', 'model', 'memory'],
  })
  assert.deepEqual(parseReleaseArguments(['--dry-run', '--skip-build']), {
    dryRun: true, skipBuild: true, localTag: undefined, onlySelectors: [],
  })
})

for (const args of [
  ['--local-tag'], ['--local-tag', ''], ['--local-tag', '  '], ['--local-tag', '--only', 'agent'],
  ['--local-tag', tag, '--local-tag', tag], ['--local-tag', ` ${tag}`],
  [`--local-tag=${tag}`], ['--local-tags', tag], ['--unknown'], [tag],
  ['--local-tag', tag, '--skip-build'], ['--skip-build'],
  ['--local-tag', tag, '--dry-run'], ['--only'], ['--only', ', ,'],
]) {
  test(`rejects unsafe release arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseReleaseArguments(args))
  })
}

test('repository identity accepts equivalent official HTTPS and SSH URLs', () => {
  for (const value of [repository, repository.url, 'https://github.com/velaros-ai/velaros-platform',
    'git@github.com:VelarOS-AI/VelarOS-Platform.git',
    'ssh://git@github.com/VelarOS-AI/VelarOS-Platform.git']) {
    assert.equal(githubRepositoryIdentity(value), 'velaros-ai/velaros-platform')
  }
})

test('repository identity rejects alternate hosts, credentials, paths and protocols', () => {
  for (const value of [undefined, '/tmp/repository', 'file:///tmp/repository',
    'https://github.com.attacker.test/VelarOS-AI/VelarOS-Platform.git',
    'https://user:secret@github.com/VelarOS-AI/VelarOS-Platform.git',
    'https://github.com/VelarOS-AI/VelarOS-Platform/tree/main',
    'https://github.com/VelarOS-AI/VelarOS-Platform.git?other=repository',
    'ssh://other@github.com/VelarOS-AI/VelarOS-Platform.git']) {
    assert.throws(() => githubRepositoryIdentity(value))
  }
})

test('local identity verifies a lightweight tag against the actual origin query', () => {
  const fixture = identityFixture()
  assert.deepEqual(fixture.verify(), { sourceSha, tag, repository: 'velaros-ai/velaros-platform' })
  assert.ok(fixture.calls.some(([, args]) => args[0] === 'ls-remote'))
})

test('annotated tags require the exact remote tag object and its peeled HEAD commit', () => {
  assert.equal(identityFixture({
    localObject: tagObject,
    remote: `${tagObject}\t${ref}\n${sourceSha}\t${ref}^{}`,
  }).verify().sourceSha, sourceSha)
})

for (const [name, changes] of [
  ['short HEAD', { head: 'abcdef' }],
  ['HEAD changed after checks', { head: otherSha }],
  ['dirty source', { status: ' M packages/agent/src/index.ts' }],
  ['different origin repository', { origin: 'https://github.com/other/VelarOS-Platform.git' }],
  ['local-only tag', { failCommand: 'ls-remote' }],
  ['invalid local tag', { failCommand: 'check-ref-format' }],
  ['missing local tag', { failCommand: 'rev-parse' }],
  ['local tag on another commit', { localCommit: otherSha }],
  ['remote tag on another commit', { remote: `${otherSha}\t${ref}` }],
  ['different remote annotated object', { localObject: tagObject, remote: `${otherSha}\t${ref}\n${sourceSha}\t${ref}^{}` }],
  ['different peeled commit', { localObject: tagObject, remote: `${tagObject}\t${ref}\n${otherSha}\t${ref}^{}` }],
  ['missing remote tag', { remote: '' }],
  ['peeled ref without tag object', { remote: `${sourceSha}\t${ref}^{}` }],
  ['unexpected remote ref', { remote: `${sourceSha}\trefs/tags/other` }],
  ['ambiguous duplicate remote ref', { remote: `${sourceSha}\t${ref}\n${sourceSha}\t${ref}` }],
]) {
  test(`rejects ${name}`, () => assert.throws(() => identityFixture(changes).verify()))
}

test('local quality sequence uses frozen install and the complete check with fresh identity checks', () => {
  const calls = []
  runLocalReleaseChecks({
    root: '/source', packageManager: 'bun@1.3.13',
    assertIdentity: () => calls.push('identity'),
    runForOutput: () => '1.3.13',
    run: (command, args) => calls.push([command, ...args].join(' ')),
  })
  assert.deepEqual(calls, ['identity', 'bun install --frozen-lockfile', 'identity', 'bun run check', 'identity'])
})

test('incorrect Bun version fails before installation or quality gates', () => {
  assert.throws(() => runLocalReleaseChecks({
    root: '/source', packageManager: 'bun@1.3.13',
    assertIdentity: () => assert.fail('must not advance'),
    runForOutput: () => '1.3.12',
    run: () => assert.fail('must not advance'),
  }), /declared package manager/u)
})

test('failed quality gate stops the release sequence', () => {
  const calls = []
  assert.throws(() => runLocalReleaseChecks({
    root: '/source', packageManager: 'bun@1.3.13',
    assertIdentity: () => calls.push('identity'),
    runForOutput: () => '1.3.13',
    run: (_command, args) => { if (args[0] === 'run') throw new Error('quality failed') },
  }), /quality failed/u)
  assert.equal(calls.length, 2)
})

test('a source or remote mutation during quality checks fails the post-check identity gate', () => {
  for (const changes of [{ head: otherSha }, { status: ' M package.json' }, { remote: `${otherSha}\t${ref}` }]) {
    const fixture = identityFixture()
    assert.throws(() => runLocalReleaseChecks({
      root: '/source', packageManager: 'bun@1.3.13',
      assertIdentity: fixture.verify,
      runForOutput: () => '1.3.13',
      run: (_command, args) => { if (args[0] === 'run') Object.assign(fixture.state, changes) },
    }))
  }
})
