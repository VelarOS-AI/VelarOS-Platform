import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'
import { nodeExecutable } from '@velaros-ai/script'

import { McpClientConnection } from '../impl/McpClientConnection'

const servers: Server[] = []
const fixtureDirectories: string[] = []
const node = nodeExecutable.resolve()
assert.ok(node, 'MCP stdio integration requires a native Node executable')

function stdioFixture(
  pagination: 'single' | 'paged' | 'repeated' = 'single',
  stderrBytes = 0
): string {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-lifecycle-test-'))
  fixtureDirectories.push(directory)
  const path = join(directory, 'server.mjs')
  writeFileSync(
    path,
    `
import { createInterface } from 'node:readline';
import { once } from 'node:events';
const lines = createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const pagination = ${JSON.stringify(pagination)};
const requestCounts = {};
const pending = new Map();
const cancelled = [];
const received = { tool: 0, resource: 0 };
const stderrBytes = ${JSON.stringify(stderrBytes)};
let diagnosticBytes = 0;
async function writeDiagnostics() {
  for (let bytes = 0; bytes < stderrBytes;) {
    const chunk = Buffer.alloc(Math.min(65536, stderrBytes - bytes), 'x');
    if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
    bytes += chunk.length;
    diagnosticBytes += chunk.length;
  }
}
lines.on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/cancelled') {
    const kind = pending.get(request.params.requestId);
    if (kind) cancelled.push(kind);
    pending.delete(request.params.requestId);
    return;
  }
  if (request.method === 'initialize') {
    await writeDiagnostics();
    setTimeout(() => reply(request.id, {
      protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1.0.0' }
    }), 75);
  }
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
  if (request.method === 'resources/read') {
    received.resource++;
    pending.set(request.id, 'resource');
    return;
  }
  if (request.method === 'tools/call') {
    if (request.params.name === 'wait') {
      received.tool++;
      pending.set(request.id, 'tool');
      return;
    }
    if (request.params.name === 'diagnostics') await writeDiagnostics();
    if (request.params.name === 'status' || request.params.name === 'diagnostics') {
      reply(request.id, { content: [{ type: 'text', text: JSON.stringify({
        pid: process.pid, pending: [...pending.values()], cancelled, received, diagnosticBytes
      }) }] });
      return;
    }
    reply(request.id, { content: [{ type: 'text', text: 'completed' }] });
    setTimeout(() => process.exit(0), 10);
  }
});
`
  )
  return path
}

async function stdioState(connection: McpClientConnection, tool = 'status') {
  const result = await connection.callTool(tool, {})
  const content = result.content as Array<{ text: string }>
  return JSON.parse(content[0]!.text) as {
    pid: number
    pending: string[]
    cancelled: string[]
    received: { tool: number; resource: number }
    diagnosticBytes: number
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close()
      await once(server, 'close')
    })
  )
  fixtureDirectories
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

describe('McpClientConnection', () => {
  test('follows SDK nextCursor for the complete tools and resources catalogs', async () => {
    const connection = new McpClientConnection('paged', {
      command: node,
      args: [stdioFixture('paged')],
      env: {},
      cwd: null,
    })
    try {
      await connection.connect()
      expect((await connection.listTools()).map((tool) => tool.name)).toEqual(['first', 'second'])
      expect((await connection.listResources()).map((resource) => resource.name)).toEqual([
        'first',
        'second',
      ])
    } finally {
      await connection.close()
    }
  })

  test('rejects a repeated tools or resources cursor before requesting that page again', async () => {
    const connection = new McpClientConnection('repeated', {
      command: node,
      args: [stdioFixture('repeated')],
      env: {},
      cwd: null,
    })
    try {
      await connection.connect()
      await assert.rejects(connection.listTools(), {
        code: 'EXECUTION',
        message: /重复返回同一个分页 cursor/u,
      })
      await assert.rejects(connection.listResources(), {
        code: 'EXECUTION',
        message: /重复返回同一个分页 cursor/u,
      })
    } finally {
      await connection.close()
    }
  })

  for (const kind of ['tool', 'resource'] as const) {
    test(`${kind} cancellation preserves the caller reason before and after actual delivery`, async () => {
      const connection = new McpClientConnection(
        'cancelled',
        { command: node, args: [stdioFixture()], env: {}, cwd: null },
        { connectTimeoutMs: 2_000, callTimeoutMs: 2_000 }
      )
      const invoke = (abortSignal: AbortSignal) =>
        kind === 'tool'
          ? connection.callTool('wait', {}, abortSignal)
          : connection.readResource('docs://waiting', abortSignal)
      try {
        await connection.connect()
        const before = AbortSignal.abort()
        await assert.rejects(invoke(before), (error: unknown) => error === before.reason)
        expect((await stdioState(connection)).received[kind]).toBe(0)

        const controller = new AbortController()
        const reason = new AppError('CANCELLED', 'The caller ended this MCP operation.')
        const result = invoke(controller.signal).catch((error: unknown) => error)
        // 同一 stdio 连接保持请求顺序；status 的回执证明 wait 已由真实 server 接纳。
        expect((await stdioState(connection)).pending).toContain(kind)
        controller.abort(reason)
        expect(await result).toBe(reason)
        const state = await stdioState(connection)
        expect(state.received[kind]).toBe(1)
        expect(state.cancelled).toEqual([kind])
        expect(state.pending).toEqual([])
        expect(connection.isConnected).toBe(true)
      } finally {
        await connection.close()
      }
    })

    test(`${kind} SDK deadline remains a real timeout without a caller cancellation`, async () => {
      const connection = new McpClientConnection(
        'timed-out',
        { command: node, args: [stdioFixture()], env: {}, cwd: null },
        { connectTimeoutMs: 2_000, callTimeoutMs: 200 }
      )
      try {
        await connection.connect()
        const pending =
          kind === 'tool'
            ? connection.callTool('wait', {})
            : connection.readResource('docs://waiting')
        await assert.rejects(
          pending,
          (error: unknown) => error instanceof AppError && error.code === 'TIMEOUT'
        )
        const state = await stdioState(connection)
        expect(state.received[kind]).toBe(1)
        expect(state.cancelled).toEqual([kind])
        expect(state.pending).toEqual([])
        expect(connection.isConnected).toBe(true)
      } finally {
        await connection.close()
      }
    })
  }

  test('large server diagnostics cannot block initialize or tool replies and close releases the actual process', async () => {
    const bytes = 4 * 1024 * 1024
    const connection = new McpClientConnection(
      'noisy',
      { command: node, args: [stdioFixture('single', bytes)], env: {}, cwd: null },
      { connectTimeoutMs: 2_000, callTimeoutMs: 2_000 }
    )
    let pid = 0
    try {
      await connection.connect()
      const initialized = await stdioState(connection)
      expect(initialized.diagnosticBytes).toBe(bytes)
      const called = await stdioState(connection, 'diagnostics')
      expect(called.diagnosticBytes).toBe(2 * bytes)
      expect(called.pid).toBe(initialized.pid)
      pid = called.pid
      process.kill(pid, 0)
    } finally {
      await connection.close()
    }
    expect(connection.isConnected).toBe(false)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  })

  test('closing during initialize prevents late connection publication and permits a fresh connect', async () => {
    const connection = new McpClientConnection(
      'slow',
      {
        command: node,
        args: [stdioFixture()],
        env: {},
        cwd: null,
      },
      { connectTimeoutMs: 2_000 }
    )
    try {
      const connecting = connection.connect()
      const rejected = connecting.then(
        () => false,
        () => true
      )
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
    const closed = new Promise<void>((resolve) => {
      observeClose = resolve
    })
    const connection = new McpClientConnection(
      'exiting',
      {
        command: node,
        args: [stdioFixture()],
        env: {},
        cwd: null,
      },
      { connectTimeoutMs: 2_000, onClose: observeClose }
    )
    try {
      await Promise.all([connection.connect(), connection.connect()])
      expect(await connection.callTool('exit', {})).toEqual({
        content: [{ type: 'text', text: 'completed' }],
      })
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
      server.registerTool(
        'lookup',
        {
          description: 'Look up a document.',
          inputSchema: { query: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ query }) => ({ content: [{ type: 'text', text: `Found ${query}` }] })
      )
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
    if (!address || typeof address === 'string')
      throw new Error('test MCP server has no TCP address')

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
    expect(await connection.listTools()).toEqual([
      expect.objectContaining({
        name: 'lookup',
        annotations: expect.objectContaining({ readOnlyHint: true }),
      }),
    ])
    expect(await connection.listResources()).toEqual([
      {
        uri: 'docs://platform/guide',
        name: 'guide',
        description: 'Platform guide',
        mimeType: 'text/markdown',
      },
    ])
    expect(await connection.readResource('docs://platform/guide')).toEqual([
      {
        uri: 'docs://platform/guide',
        mimeType: 'text/markdown',
        text: '# Platform',
        blob: null,
      },
    ])
    expect(await connection.callTool('lookup', { query: 'sessions' })).toEqual({
      content: [{ type: 'text', text: 'Found sessions' }],
    })
    expect(authorizationHeaders.length).toBeGreaterThan(0)
    expect(authorizationHeaders.every((header) => header === 'Bearer platform-test')).toBe(true)
    await connection.close()
  })
})
