import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as modelPackage from '../../../packages/model/dist/index.js'
import { verifyCampaignDriver } from './model-driver.mjs'

test('campaign driver sends formal cache and reasoning fields on the real SDK wire', async () => {
  const original = globalThis.fetch
  assert.deepEqual(await verifyCampaignDriver(modelPackage), {
    provider: 'formal-model-composition',
    sessionKey: true,
    explicitBreakpoints: true,
  })
  assert.equal(globalThis.fetch, original)
})

test('a provider without explicit cache support keeps the session key and reasoning policy', async () => {
  assert.deepEqual(
    await verifyCampaignDriver(modelPackage, { openaiExplicitCacheBreakpoints: false }),
    {
      provider: 'formal-model-composition',
      sessionKey: true,
      explicitBreakpoints: false,
    }
  )
})
