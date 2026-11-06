import { createHash } from 'node:crypto'

import { expect, test } from 'bun:test'

import { nodeCapabilityClient } from '../src/utils/node-client'

test('the generated Node client retries a lost connection with the same id and exact byte views', async () => {
  const esm = (source: string) =>
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  const bridge = esm(`export const requests=[];
    export async function invoke(namespace,operation,input) {
      requests.push({namespace,operation,input});
      if (requests.length === 1) throw Object.assign(new Error('lost connection'),{code:'ECONNRESET'});
      return requests;
    }`)
  const source = nodeCapabilityClient('velaros:project', ['commit']).replace(
    "'./bridge.mjs'",
    JSON.stringify(bridge)
  )
  const { commit } = await import(esm(source))
  const bytes = Buffer.from('skip:abc').subarray(5)
  const calls = await commit({ changes: [{ path: 'x', before: bytes, after: bytes }] })
  expect(calls).toHaveLength(2)
  expect(calls[0]).toEqual(calls[1])
  expect(calls[0].input.requestId).toBeTruthy()
  expect(calls[0].input.changes).toEqual([
    {
      path: 'x',
      before: { sha256: createHash('sha256').update('abc').digest('hex') },
      after: { base64: 'YWJj' },
    },
  ])
})
