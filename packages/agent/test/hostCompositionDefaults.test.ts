import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import {
  createBuiltInPromptRegistry,
  SkillFileStore,
  SkillMarketClient,
} from '../src'

describe('host-owned Agent identity', () => {
  test('uses a product-neutral identity when the host does not provide one', () => {
    const composition = createBuiltInPromptRegistry().compose()
    const identity = composition.stableParts.find((part) => part.id === 'core.identity')
    const defaultPrompt = [
      ...composition.stableParts,
      ...composition.dynamicParts,
    ].map((part) => part.text).join('\n')

    expect(identity?.text).toContain('宿主应用')
    expect(defaultPrompt).not.toContain('VelarOS')
  })

  test('uses the identity supplied by the host composition root', () => {
    const composition = createBuiltInPromptRegistry({
      primaryAgentIdentity: '你是 Acme Research Assistant。',
    }).compose()
    const identity = composition.stableParts.find((part) => part.id === 'core.identity')

    expect(identity?.text).toBe('你是 Acme Research Assistant。')
  })
})

describe('host-owned skill market endpoint', () => {
  test('is disabled without an injected endpoint and performs no network request', async () => {
    let requestCount = 0
    const client = new SkillMarketClient({
      store: new SkillFileStore({ skillsDir: () => '/path-that-is-never-read' }),
      fetchImpl: async () => {
        requestCount += 1
        throw new Error('fetch must not be called')
      },
    })

    expect(client.getAvailability()).toEqual({
      available: false,
      reason: 'endpoint-not-configured',
    })

    try {
      await client.listCatalog()
      throw new Error('listCatalog should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('UNAVAILABLE')
      expect((error as AppError).message).toBe('skill-market-disabled')
    }
    expect(requestCount).toBe(0)
  })

  test('uses only the endpoint injected by the host', async () => {
    const skillsDirectory = mkdtempSync(join(tmpdir(), 'agent-market-test-'))
    const requestedUrls: string[] = []
    const client = new SkillMarketClient({
      store: new SkillFileStore({ skillsDir: () => skillsDirectory }),
      marketBase: () => 'https://market.example.test/releases',
      fetchImpl: async (input) => {
        requestedUrls.push(String(input))
        return new Response(JSON.stringify({ skills: [] }), { status: 200 })
      },
      now: () => 42,
    })

    try {
      expect(client.getAvailability()).toEqual({ available: true })
      expect(await client.listCatalog()).toEqual({ generatedAt: 42, entries: [] })
      expect(requestedUrls).toEqual([
        'https://market.example.test/releases/skills-manifest.json',
      ])
    } finally {
      rmSync(skillsDirectory, { recursive: true, force: true })
    }
  })
})
