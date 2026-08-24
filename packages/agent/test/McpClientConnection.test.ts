import { once } from 'node:events'
import { createServer, type Server } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { McpClientConnection } from '../src/tool-library/mcp'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close()
    await once(server, 'close')
  }))
})

describe('McpClientConnection', () => {
  test('owns Streamable HTTP tools and resources without host configuration policy', async () => {
    const authorizationHeaders: Array<string | undefined> = []
    const httpServer = createServer(async (request, response) => {
      authorizationHeaders.push(request.headers.authorization)
      const server = new McpServer({ name: 'platform-mcp-test', version: '1.0.0' })
      server.registerTool('lookup', {
        description: 'Look up a document.',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      }, async ({ query }) => ({ content: [{ type: 'text', text: `Found ${query}` }] }))
      server.registerResource(
        'guide',
        'docs://platform/guide',
        { description: 'Platform guide', mimeType: 'text/markdown' },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Platform' }],
        })
      )
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      try {
        await transport.handleRequest(request, response)
      } finally {
        await transport.close().catch(() => undefined)
        await server.close().catch(() => undefined)
      }
    })
    servers.push(httpServer)
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('test MCP server has no TCP address')

    const connection = new McpClientConnection('docs', {
      transport: 'http',
      command: '',
      args: [],
      env: {},
      cwd: null,
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: 'Bearer platform-test' },
    })
    await connection.connect()
    expect(await connection.listTools()).toEqual([expect.objectContaining({
      name: 'lookup',
      annotations: expect.objectContaining({ readOnlyHint: true }),
    })])
    expect(await connection.listResources()).toEqual([{
      uri: 'docs://platform/guide',
      name: 'guide',
      description: 'Platform guide',
      mimeType: 'text/markdown',
    }])
    expect(await connection.readResource('docs://platform/guide')).toEqual([{
      uri: 'docs://platform/guide',
      mimeType: 'text/markdown',
      text: '# Platform',
      blob: null,
    }])
    expect(await connection.callTool('lookup', { query: 'sessions' })).toEqual({
      content: [{ type: 'text', text: 'Found sessions' }],
    })
    expect(authorizationHeaders.length).toBeGreaterThan(0)
    expect(authorizationHeaders.every((header) => header === 'Bearer platform-test')).toBe(true)
    await connection.close()
  })
})
