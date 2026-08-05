import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import {
  ContextBuilder,
  createBuiltInPromptRegistry,
  createRuntimePromptSegments,
  type RuntimePromptSnapshot,
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

  test('keeps governance metadata in trace instead of exposing it to the model', () => {
    const built = new ContextBuilder(createBuiltInPromptRegistry()).build()
    const stable = built.systemPrompt.slice(0, built.stableCutoff)
    const current = built.systemPrompt.slice(built.stableCutoff).trimStart()

    expect(stable).toStartWith('<instructions>')
    expect(stable).toEndWith('</instructions>')
    expect(current).toStartWith('<current_context>')
    expect(current).toEndWith('</current_context>')
    expect(built.systemPrompt).not.toContain('<rules>')
    expect(built.systemPrompt).not.toContain('<sp ')
    expect(built.systemPrompt).not.toContain(' src=')
    expect(built.systemPrompt).not.toContain(' tier=')
    expect(built.segments.some((segment) => segment.id === 'core.identity')).toBe(true)
  })

  test('keeps model settings structural and prompt text concise', () => {
    const snapshot: RuntimePromptSnapshot = {
      locale: 'zh-CN',
      roleId: 'chat',
      roleLabel: 'Chat',
      workflowType: 'chat',
      thinkingDepth: 'deep',
      developerContext: null,
      agentSurfaceId: 'chat',
      contextPhase: 'operational',
      activeCapabilityScope: 'system',
      toolCategories: [],
      toolSurfaceProfile: 'full',
      runProfile: 'expanded',
      toolCapabilityCategories: [],
      requestableToolCapabilityCategories: [],
      canUpdatePlan: false,
      userRequestedPlan: false,
      goalMode: false,
      selectedPromptFeatureLabels: [],
      enabledPromptFeatures: [],
      autoPromptFeatureLabels: [],
      availableSkills: [],
      customSubAgents: [],
      executionPlanPreview: null,
      currentExecutionAdvice: null,
      recentToolFailures: [],
      hasCompactedContext: false,
    }
    const segments = createRuntimePromptSegments(snapshot)

    expect(segments.some((segment) => segment.id === 'runtime.run-profile')).toBe(false)
    expect(segments.some((segment) => segment.id === 'runtime.run-strategy')).toBe(false)
    expect(String(segments.find((segment) => segment.id === 'runtime.session')?.render({})))
      .toContain('回复跟随用户当前使用的语言')
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
