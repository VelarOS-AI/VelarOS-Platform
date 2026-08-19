import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArguments } from './release-host.mjs'

test('Host local release defaults to the stable immutable path', () => {
  assert.deepEqual(parseArguments([]), {
    channel: 'stable',
    dryRun: false,
    checkOnly: false,
    replaceExisting: false,
  })
})

test('Host local release makes replacement and dry run explicit', () => {
  assert.deepEqual(
    parseArguments(['--channel', 'canary', '--dry-run', '--replace-existing']),
    {
      channel: 'canary',
      dryRun: true,
      checkOnly: false,
      replaceExisting: true,
    },
  )
  assert.throws(
    () => parseArguments(['--channel', 'nightly']),
    /stable or canary/u,
  )
})
