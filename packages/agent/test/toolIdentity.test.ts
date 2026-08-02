import { describe, expect, it } from 'bun:test'

import {
  assertCanonicalToolId,
  createToolTransportNamePlan,
  isCanonicalToolId,
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
})
