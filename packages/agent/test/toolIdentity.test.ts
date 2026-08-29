import { describe, expect, it } from 'bun:test'

import {
  assertCanonicalToolId,
  isCanonicalToolId,
} from '../src/tool-contract/identity'
import {
  completeToolTransportNameAliases,
  createProviderToolReferenceCanonicalizer,
  createToolTransportNamePlan,
  createToolTransportProjection,
  ProviderToolNamePattern,
  rewriteCanonicalToolReferences,
  rewriteProviderToolReferences,
} from '../src/tools/ToolIdentity'

describe('canonical tool identity', () => {
  it('accepts namespace:tool ids and rejects provider aliases as canonical ids', () => {
    expect(isCanonicalToolId('project:read')).toBe(true)
    expect(isCanonicalToolId('development.code:query')).toBe(true)
    expect(isCanonicalToolId('project__read')).toBe(false)
    expect(() => assertCanonicalToolId('project:read')).not.toThrow()
    expect(() => assertCanonicalToolId('project__read')).toThrow('namespace:tool')
  })

  it('compiles canonical ids to reversible provider-safe aliases', () => {
    const plan = createToolTransportNamePlan([
      'project:read',
      'project:edit',
      'mcp.github:create_issue',
    ])

    expect(plan.canonicalToProvider).toEqual({
      'project:read': 'project__read',
      'project:edit': 'project__edit',
      'mcp.github:create_issue': 'mcp_github__create_issue',
    })
    expect(plan.providerToCanonical.project__read).toBe('project:read')
    expect(plan.providerToCanonical.mcp_github__create_issue).toBe('mcp.github:create_issue')
    expect(() => createToolTransportNamePlan(['legacy_safe_name'])).toThrow('namespace:tool')
  })

  it('projects request-visible aliases from the complete registered identity set', () => {
    const registered = ['mcp.github:read', 'mcp..github:read', 'project:read']
    const first = createToolTransportProjection(registered, ['mcp..github:read'])
    const expanded = createToolTransportProjection(registered, [
      'project:read',
      'mcp..github:read',
    ])
    const providerName = first.visibleCanonicalToProvider['mcp..github:read']

    expect(providerName).toBeTruthy()
    expect(first.plan.providerToCanonical[providerName!]).toBe('mcp..github:read')
    expect(first.visibleCanonicalToProvider).toEqual({
      'mcp..github:read': providerName,
    })
    expect(expanded.visibleCanonicalToProvider['mcp..github:read']).toBe(providerName)
    expect(() =>
      createToolTransportProjection(registered, ['browser:inspect_page'])
    ).toThrow('absent from the registered transport plan')
  })

  it('compiles page-out historical tools without advertising them as callable', () => {
    const visible = createToolTransportNamePlan(['tooling:map']).canonicalToProvider
    const requestAliases = completeToolTransportNameAliases(visible, [
      'system:run',
      'tooling:map',
      'legacy_safe_name',
    ])

    expect(requestAliases).toEqual({
      'tooling:map': 'tooling__map',
      'system:run': 'system__run',
    })
    expect(ProviderToolNamePattern.test(requestAliases['system:run']!)).toBe(true)
    expect(visible['system:run']).toBeUndefined()
  })

  it('rewrites only complete canonical references in model-visible text', () => {
    const aliases = {
      'project:read': 'project__read',
      'interaction:ask_user': 'interaction__ask_user',
    }

    expect(
      rewriteCanonicalToolReferences(
        '先用 project:read，再调用 interaction:ask_user；不要改 project:read_more。',
        aliases
      )
    ).toBe('先用 project__read，再调用 interaction__ask_user；不要改 project:read_more。')
  })

  it('restores provider aliases in complete and chunked assistant text', () => {
    const aliases = {
      project__read: 'project:read',
      interaction__ask_user: 'interaction:ask_user',
    }
    expect(
      rewriteProviderToolReferences(
        '已用 project__read. 未调用 project__read_more。',
        aliases
      )
    ).toBe('已用 project:read. 未调用 project__read_more。')

    const stream = createProviderToolReferenceCanonicalizer(aliases)
    expect(stream.push('已用 project__')).toBe('已用 ')
    expect(stream.push('read，接着 interaction__ask')).toBe('project:read，接着 ')
    expect(stream.push('_user')).toBe('')
    expect(stream.flush()).toBe('interaction:ask_user')
  })
})
