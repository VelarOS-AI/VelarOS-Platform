import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { McpClientConnection } from '../src/tool-library/mcp'

const servers: Server[] = []
const fixtureDirectories: string[] = []

function stdioFixture(pagination: 'single' | 'paged' | 'repeated' = 'single'): string {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-lifecycle-test-'))
  fixtureDirectories.push(directory)
  const path = join(directory, 'server.mjs')
  writeFileSync(path, `
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const pagination = ${JSON.stringify(pagination)};
const requestCounts = {};
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') setTimeout(() => reply(request.id, {
    protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1.0.0' }
  }), 75);
  if (request.method === 'tools/list' || request.method === 'resources/list') {
    requestCounts[request.method] = (requestCounts[request.method] ?? 0) + 1;
    if (requestCounts[request.method] > 2 && pagination === 'repeated') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'cursor loop continued' } }) + '\\n');
      return;
    }
    const second = request.params?.cursor === 'second';
    const name = pagination === 'single' ? 'exit' : second ? 'second' : 'first';
    const nextCursor = pagination === 'single' || (pagination === 'paged' && second) ? undefined : 'second';
    reply(request.id, request.method === 'tools/list'
      ? { tools: [{ name, inputSchema: { type: 'object' } }], nextCursor }
      : { resources: [{ name, uri: 'docs://' + name }], nextCursor });
  }
  if (request.method === 'tools/call') {
    reply(request.id, { content: [{ type: 'text', text: 'completed' }] });
    setTimeout(() => process.exit(0), 10);
  }
});
`)
  return path
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close()
    await once(server, 'close')
  }))
  fixtureDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

describe('McpClientConnection', () => {
  test('follows SDK nextCursor for the complete tools and resources catalogs', async () => {
    const connection = new McpClientConnection('paged', {
      command: process.execPath, args: [stdioFixture('paged')], env: {}, cwd: null,
    })
    try {
      await connection.connect()
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['first', 'second'])
      expect((await connection.listResources()).map((resource) => resource.name)).toEqual(['first', 'second'])
    } finally {
      await connection.close()
    }
  })

  test('rejects a repeated tools or resources cursor before requesting that page again', async () => {
    const connection = new McpClientConnection('repeated', {
      command: process.execPath, args: [stdioFixture('repeated')], env: {}, cwd: null,
    })
    try {
      await connection.connect()
      await expect(connection.listTools()).rejects.toThrow(/Repeated MCP pagination cursor/u)
      await expect(connection.listResources()).rejects.toThrow(/Repeated MCP pagination cursor/u)
    } finally {
      await connection.close()
    }
  })

  test('closing during initialize prevents late connection publication and permits a fresh connect', async () => {
    const connection = new McpClientConnection('slow', {
      command: process.execPath, args: [stdioFixture()], env: {}, cwd: null,
    }, { connectTimeoutMs: 2_000 })
    try {
      const connecting = connection.connect()
      const rejected = connecting.then(() => false, () => true)
      await connection.close()
      expect(await rejected).toBe(true)
      expect(connection.isConnected).toBe(false)

      await connection.connect()
      expect(connection.isConnected).toBe(true)
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['exit'])
    } finally {
      await connection.close()
    }
  })

  test('server exit withdraws connected state and reconnect establishes a fresh transport', async () => {
    let observeClose!: () => void
    const closed = new Promise<void>((resolve) => { observeClose = resolve })
    const connection = new McpClientConnection('exiting', {
      command: process.execPath, args: [stdioFixture()], env: {}, cwd: null,
    }, { connectTimeoutMs: 2_000, onClose: observeClose })
    try {
      await Promise.all([connection.connect(), connection.connect()])
      expect(await connection.callTool('exit', {})).toEqual({ content: [{ type: 'text', text: 'completed' }] })
      await closed
      expect(connection.isConnected).toBe(false)
      await expect(connection.callTool('exit', {})).rejects.toThrow(/尚未连接/u)

      await connection.connect()
      expect(connection.isConnected).toBe(true)
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['exit'])
    } finally {
      await connection.close()
    }
  })

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
