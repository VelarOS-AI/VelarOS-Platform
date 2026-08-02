import { describe, expect, it } from 'bun:test'

import { buildMcpToolName } from '../src/tool-library/mcp/mcpToolTranslation'
import { isCanonicalToolId } from '../src/tools/ToolIdentity'

describe('MCP tool identity', () => {
  it('normalizes underscores out of the canonical namespace segment', () => {
    const name = buildMcpToolName('my_server', 'search-items')
    const [namespace] = name.split(':')

    expect(isCanonicalToolId(name)).toBe(true)
    expect(namespace).not.toContain('_')
  })
})
