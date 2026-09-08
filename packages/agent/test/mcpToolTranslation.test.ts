import { describe, expect, it } from 'bun:test'

import { isKernelWriteLikeTool } from '../src/kernel/tool-loop-guard'
import type { ToolConfirmationDecisionOptions } from '../src/protocol'
import { isCanonicalToolId } from '../src/tool-contract/identity'
import type { KernelToolContext } from '../src/tool-library/KernelToolContext'
import { describeMcpApprovalArguments } from '../src/tool-library/mcp/mcpApprovalArguments'
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
  it('requires a fresh manual decision for destructive calls without autoApprove', async () => {
    const calls: unknown[] = []
    const confirmations: Array<{ message: string; options?: ToolConfirmationDecisionOptions }> = []
    const { tool } = translateMcpTool({
      connection: { callTool: async (_name, args) => { calls.push(args); return { content: [] } } },
      serverName: 'records', autoApprove: false,
      descriptor: {
        name: 'delete', inputSchema: { type: 'object' }, description: 'Delete record',
        annotations: { title: null, readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
    })
    const context = {
      abortSignal: new AbortController().signal,
      approval: { awaitConfirmationDecision: async (message: string, _signal: AbortSignal, options?: ToolConfirmationDecisionOptions) => {
        confirmations.push({ message, options })
        return { approved: confirmations.length === 1, message: null }
      } },
    } as unknown as KernelToolContext
    const first = { target: 'record-A', token: 'private-token' }
    await tool.execute(first, context)
    await tool.execute({ target: 'record-B' }, context)
    expect(calls).toEqual([first])
    expect(confirmations).toHaveLength(2)
    for (const confirmation of confirmations) {
      expect(confirmation.options).toMatchObject({ requireManualApproval: true, rememberRiskScope: false,
        detail: { approvalScope: 'call' } })
      expect(confirmation.message).not.toContain('private-token')
    }
    expect(confirmations[0]?.options?.detail).toMatchObject({
      argumentsPreview: '{"target":"record-A","token":"[redacted]"}',
    })
  })

  it.each([{ autoApprove: true }, { autoApprove: ['delete'] }] as const)('preserves an explicit destructive-tool autoApprove policy %p', async ({ autoApprove }) => {
    let calls = 0
    const { tool } = translateMcpTool({
      connection: { callTool: async () => { calls += 1; return { content: [] } } },
      serverName: 'records', autoApprove,
      descriptor: {
        name: 'delete', inputSchema: { type: 'object' }, description: 'Delete record',
        annotations: { title: null, readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
    })
    await tool.execute({ target: 'record-A' }, {
      abortSignal: new AbortController().signal,
      approval: { awaitConfirmationDecision: async () => { throw new Error('explicit approval must be honored') } },
    } as unknown as KernelToolContext)
    expect(calls).toBe(1)
  })

  it('bounds argument previews, redacts nested credentials, and avoids toJSON/accessor execution', () => {
    const args: Record<string, unknown> = {
      target: 'record-A', nested: { apiKey: 'secret', authorization: 'bearer secret' },
      content: 'x'.repeat(20_000), items: Array.from({ length: 1_000 }, (_, i) => `item-${i}`),
      toJSON: () => { throw new Error('must not execute') },
    }
    Object.defineProperty(args, 'dangerousGetter', { enumerable: true, get: () => { throw new Error('must not read') } })
    args.circular = args
    const text = describeMcpApprovalArguments(args)
    expect(text).toContain('record-A')
    expect(text).toContain('[redacted]')
    expect(text).not.toContain('bearer secret')
    expect(text).toContain('[accessor omitted]')
    expect(text).toContain('[circular]')
    expect(text.length).toBeLessThanOrEqual(4_020)
  })
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
