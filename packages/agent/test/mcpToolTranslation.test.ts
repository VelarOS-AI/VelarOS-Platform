import { describe, expect, it } from 'bun:test'

import { isKernelWriteLikeTool } from '../src/kernel/tool-loop-guard'
import { isCanonicalToolId } from '../src/tool-contract/identity'
import type { McpToolDescriptor } from '../src/tool-library/mcp/McpClientConnection'
import {
  buildMcpToolName,
  translateMcpTool,
} from '../src/tool-library/mcp/mcpToolTranslation'

function translateWithAnnotations(
  annotations: McpToolDescriptor['annotations']
) {
  return translateMcpTool({
    connection: { callTool: async () => ({ content: [] }) },
    serverName: 'context-server',
    descriptor: {
      name: 'set_active_context',
      description: 'Set the active context.',
      inputSchema: { type: 'object' },
      annotations,
    },
    autoApprove: false,
  })
}

describe('MCP tool identity', () => {
  it('normalizes underscores out of the canonical namespace segment', () => {
    const name = buildMcpToolName('my_server', 'search-items')
    const [namespace] = name.split(':')

    expect(isCanonicalToolId(name)).toBe(true)
    expect(namespace).not.toContain('_')
  })
})

describe('MCP tool behavior classification', () => {
  it('classifies an unambiguously read-only tool as concurrency-safe', () => {
    const { tool } = translateWithAnnotations({
      title: null,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    })

    expect(tool.capabilities).toMatchObject({
      effectKind: 'read',
      readScopes: ['mcp'],
      concurrency: 'safe',
    })
    expect(tool.capabilities?.writeScopes).toBeUndefined()
    expect(tool.isConcurrencySafe?.({})).toBe(true)
  })

  it('keeps idempotent mutations concurrency-unsafe and visible to the write loop guard', () => {
    const { name, tool } = translateWithAnnotations({
      title: null,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })

    expect(tool.capabilities).toMatchObject({
      effectKind: 'external',
      readScopes: ['mcp'],
      writeScopes: ['mcp'],
      concurrency: 'unsafe',
    })
    expect(tool.isConcurrencySafe?.({})).toBe(false)
    expect(isKernelWriteLikeTool({
      toolName: name,
      permissions: tool.permissions,
      capabilities: tool.capabilities,
    })).toBe(true)
  })

  it('fails closed when read-only and destructive hints conflict', () => {
    const { tool } = translateWithAnnotations({
      title: null,
      readOnlyHint: true,
      destructiveHint: true,
      idempotentHint: true,
    })

    expect(tool.role).toBe('execute')
    expect(tool.capabilities).toMatchObject({
      effectKind: 'destructive',
      writeScopes: ['mcp'],
      concurrency: 'unsafe',
    })
    expect(tool.isConcurrencySafe?.({})).toBe(false)
  })
})
