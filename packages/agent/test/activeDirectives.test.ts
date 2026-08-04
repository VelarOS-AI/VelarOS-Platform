import { describe, expect, test } from 'bun:test'

import type {
  ActiveContextArchiveFilter,
  ActiveContextArtifact,
  ActiveContextListOptions,
  ActiveContextUpsertInput,
} from '@velaros-ai/agent/protocol'

import {
  type ActiveDirectiveContext,
  ActiveDirectiveLimits,
  archiveActiveDirectives,
  createDirectiveArtifactId,
  listActiveDirectives,
  upsertActiveDirective,
} from '../src/tool-library/builtin/ActiveDirectives'

function createHarness(seed: ActiveContextArtifact[] = []) {
  let now = 1_000
  let artifacts = [...seed]

  const context: ActiveDirectiveContext = {
    listActiveContextArtifacts: async (options: ActiveContextListOptions = {}) =>
      artifacts.filter((artifact) => {
        if (options.status && options.status !== 'all' && artifact.status !== options.status)
          return false
        if (options.kinds && !options.kinds.includes(artifact.kind)) return false
        return true
      }),
    upsertActiveContextArtifact: async (input: ActiveContextUpsertInput) => {
      now += 1
      const existing = artifacts.find((artifact) => artifact.id === input.id)
      const artifact: ActiveContextArtifact = {
        id: input.id ?? `artifact-${now}`,
        kind: input.kind,
        scope: input.scope ?? 'session',
        status: input.status ?? existing?.status ?? 'active',
        sessionId: 'active-directives-test',
        resourceId: input.resourceId,
        title: input.title,
        content: input.content,
        sourceMessageId: input.sourceMessageId,
        metadata: input.metadata,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      artifacts = [...artifacts.filter((candidate) => candidate.id !== artifact.id), artifact]
      return artifact
    },
    archiveActiveContextArtifacts: async (filter: ActiveContextArchiveFilter) => {
      const ids = new Set(filter.ids ?? [])
      const archived: ActiveContextArtifact[] = []
      artifacts = artifacts.map((artifact) => {
        if (!ids.has(artifact.id) || artifact.status !== 'active') return artifact
        const next = {
          ...artifact,
          status: 'archived' as const,
          updatedAt: ++now,
        }
        archived.push(next)
        return next
      })
      return archived
    },
  }

  return { context, readArtifacts: () => artifacts }
}

describe('active directive domain service', () => {
  test('keeps model maintenance and user removal on the same directive semantics', async () => {
    const harness = createHarness()
    const first = await upsertActiveDirective(harness.context, {
      title: '不要修改用户项目',
      content: '只能修改 VelarOS 插件。',
      directiveType: 'prohibition',
    })
    await upsertActiveDirective(harness.context, {
      title: '优先结构修复',
      content: '定位根因并处理一类问题。',
      directiveType: 'process',
    })

    expect(await listActiveDirectives(harness.context)).toHaveLength(2)

    const removed = await archiveActiveDirectives(harness.context, {
      ids: [first.id],
    })
    expect(removed.archivedIds).toEqual([first.id])
    expect(await listActiveDirectives(harness.context)).toHaveLength(1)
    expect(harness.readArtifacts().find((artifact) => artifact.id === first.id)?.status).toBe(
      'archived'
    )
  })

  test('enforces the protected-area limit and refuses non-directive id collisions', async () => {
    const harness = createHarness()
    for (let index = 0; index < ActiveDirectiveLimits.maxActive; index += 1) {
      await upsertActiveDirective(harness.context, {
        title: `Directive ${index}`,
        content: `Rule ${index}`,
        directiveType: 'requirement',
      })
    }

    await expect(
      upsertActiveDirective(harness.context, {
        title: 'One too many',
        content: 'Must fail',
        directiveType: 'other',
      })
    ).rejects.toThrow('already contains')

    const collisionId = createDirectiveArtifactId('id:collision')
    const collisionHarness = createHarness([
      {
        id: collisionId,
        kind: 'decision',
        scope: 'session',
        status: 'active',
        sessionId: 'active-directives-test',
        title: 'Existing decision',
        content: 'Not a directive',
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(
      upsertActiveDirective(collisionHarness.context, {
        id: 'collision',
        title: 'Conflicting directive',
        content: 'Must fail closed',
        directiveType: 'other',
      })
    ).rejects.toThrow('conflicts with non-directive')
  })
})
