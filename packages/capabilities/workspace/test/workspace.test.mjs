/**
 * @test-meta
 * title: 工作区核心接口
 * summary: 发布契约：验证读写、搜索、编辑、校验、回滚全链路与智能体工具集成。
 * area: packages
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { test } from 'bun:test'

import { createToolSchemaBundle } from '@velaros-ai/core/tool-contract'

import {
  asWorkspaceResult,
  corePlugin,
  createAgentTools,
  createFileFilterProvider,
  createMcpLikeServer,
  createMcpTools,
  createRecommendedWorkspace,
  createSecretRedactionProvider,
  createVelarosWorkspaceBridge,
  createWorkspace,
  createWorkspaceToolSchemaBundle,
  getWorkspaceToolExampleInputs,
  typescriptPlugin,
  validationPlugin,
  WorkspaceConcepts,
  WorkspaceKernelToolNames as wsTool,
} from '../dist/index.js'
import { jsTsPlugin, treeSitterPlugin } from '../dist/plugins/index.js'
import { lspPlugin } from '../dist/plugins/lsp.js'

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'velaros-workspace-'))
}

async function readJsonFixture(relativePath) {
  return JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'fixtures', relativePath), 'utf8'))
}

async function readWorkspacePackageJson() {
  return JSON.parse(
    await fs.readFile(
      path.resolve(import.meta.dirname, '../package.json'),
      'utf8'
    )
  )
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function collectSchemaDescriptions(value, descriptions = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaDescriptions(item, descriptions)
    return descriptions
  }
  if (!value || typeof value !== 'object') return descriptions
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'description' && typeof nested === 'string') {
      descriptions.push(nested)
    } else {
      collectSchemaDescriptions(nested, descriptions)
    }
  }
  return descriptions
}

function collectSchemaRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, refs)
    return refs
  }
  if (!value || typeof value !== 'object') return refs
  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string') {
      refs.push(nested)
    } else {
      collectSchemaRefs(nested, refs)
    }
  }
  return refs
}

function hasJsonReadBoundRequirement(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value.anyOf)) {
    const requiredFields = new Set(value.anyOf.flatMap((branch) => (
      branch && typeof branch === 'object' && Array.isArray(branch.required)
        ? branch.required
        : []
    )))
    if (
      requiredFields.has('range') &&
      requiredFields.has('maxBytes') &&
      requiredFields.has('maxChars') &&
      requiredFields.has('allowUnbounded')
    ) return true
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      if (nested.some((item) => hasJsonReadBoundRequirement(item))) return true
    } else if (hasJsonReadBoundRequirement(nested)) return true
  }
  return false
}

function findPathArraySchema(pathSchema) {
  return pathSchema?.anyOf?.find((branch) => branch?.type === 'array')
}

function testRangeFromOffsets(content, startOffset, endOffset) {
  const beforeStart = content.slice(0, startOffset)
  const beforeEnd = content.slice(0, endOffset)
  const startLine = beforeStart.split('\n').length
  const endLine = beforeEnd.split('\n').length
  const startLineOffset = beforeStart.lastIndexOf('\n') + 1
  const endLineOffset = beforeEnd.lastIndexOf('\n') + 1
  return {
    startLine,
    endLine,
    startOffset,
    endOffset,
    startColumn: startOffset - startLineOffset + 1,
    endColumn: endOffset - endLineOffset + 1,
  }
}

test('read/search/resolve/prepare/apply/validate/rollback text transaction', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src/a.ts'),
    'export const x = 1\nfunction hello() {\n  return x\n}\n'
  )
  const workspace = await createWorkspace({ root })

  const read = await workspace.read({ path: 'src/a.ts' })
  assert.equal(read.content.includes('export const x = 1'), true)

  const search = await workspace.search({ query: 'hello' })
  assert.equal(search.hits.length > 0, true)

  const resolved = await workspace.resolveTarget({
    path: 'src/a.ts',
    target: { exactSnippet: 'export const x = 1' },
    expectedMatches: 1,
  })
  assert.equal(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return

  const tx = await workspace.prepareEdit({
    operations: [
      {
        targetId: resolved.target.targetId,
        operation: {
          type: 'replace_text',
          oldText: 'export const x = 1',
          newText: 'export const x = 2',
        },
      },
    ],
  })
  assert.equal(tx.status, 'prepared')
  assert.match(tx.diff, /export const x = 2/)

  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')
  assert.match(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), /x = 2/)

  const validation = await workspace.validate({
    transactionId: tx.transactionId,
    postconditions: [{ type: 'must_contain', value: 'x = 2' }],
  })
  assert.equal(validation.ok, true)

  await workspace.rollback({ transactionId: tx.transactionId })
  assert.match(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), /x = 1/)
})

test('workspace status and symbols stay unique when plugins are installed more than once', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src/symbols.ts'),
    'export function duplicateCandidate() {\n  return 1\n}\n'
  )
  const workspace = await createWorkspace({
    root,
    plugins: [corePlugin(), corePlugin()],
  })

  const status = await workspace.status()
  assert.equal(
    status.plugins.filter((name) => name === '@velaros-ai/workspace/core').length,
    1
  )
  assert.equal(status.adapters.length, new Set(status.adapters).size)

  const symbols = await workspace.listSymbols('src/symbols.ts')
  const duplicateCandidates = symbols.filter((symbol) => symbol.name === 'duplicateCandidate')
  assert.equal(duplicateCandidates.length, 1)
})

test('workspace.stat reports text file metadata without body content', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;\nexport const b = 2;\n')
  const workspace = await createWorkspace({ root })

  const stat = await workspace.stat({ path: 'src/a.ts' })

  assert.equal(stat.path, 'src/a.ts')
  assert.equal(stat.exists, true)
  assert.equal(stat.kind, 'file')
  assert.equal(stat.isBinary, false)
  assert.equal(stat.readableText, true)
  assert.equal(stat.lineCount, 2)
  assert.ok(stat.sizeBytes > 0)
  assert.ok(stat.revision)
  assert.deepEqual(stat.recommendedRead, {
    path: 'src/a.ts',
    range: { startLine: 1, endLine: 2 },
  })
  assert.equal(Object.hasOwn(stat, 'content'), false)
})

test('workspace.stat returns stable metadata for directory, missing, and binary targets', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/blob.bin'), Buffer.from([0, 1, 2, 3, 255]))
  const workspace = await createWorkspace({ root })

  const directory = await workspace.stat({ path: 'src' })
  assert.equal(directory.exists, true)
  assert.equal(directory.kind, 'directory')
  assert.equal(directory.readableText, false)
  assert.equal(directory.recommendedRead, null)

  const missing = await workspace.stat({ path: 'src/missing.ts' })
  assert.equal(missing.exists, false)
  assert.equal(missing.kind, 'missing')
  assert.equal(missing.revision, null)
  assert.equal(missing.recommendedRead, null)

  const binary = await workspace.stat({ path: 'src/blob.bin' })
  assert.equal(binary.exists, true)
  assert.equal(binary.kind, 'file')
  assert.equal(binary.isBinary, true)
  assert.equal(binary.readableText, false)
  assert.equal(binary.lineCount, null)
  assert.equal(binary.recommendedRead, null)
})

test('MCP workspace server treats omitted args as an empty object for no-arg tools', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const server = createMcpLikeServer(workspace)

  const status = await server.callTool(wsTool.status)

  assert.equal(status.root, root)
  assert.ok(Array.isArray(status.plugins))
})

test('MCP workspace server lists compact shared-def tool schemas by default', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const server = createMcpLikeServer(workspace)

  const compact = server.listTools()
  const expanded = server.listExpandedTools()

  assert.equal(compact.schemaVersion, 1)
  assert.equal(compact.tools.length, expanded.length)
  assert.ok(Object.keys(compact.$defs).length > 0)
  assert.ok(JSON.stringify(compact.tools).includes('#/$defs/'))
  assert.ok(JSON.stringify(compact).length <= 40_000)
  assert.ok(JSON.stringify(expanded).length > JSON.stringify(compact).length)
  assert.equal(expanded.some((tool) => tool.name === wsTool.read), true)
})

test('workspace schema bundle delegates to the global tool contract bundler', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const tools = createAgentTools(workspace)

  assert.deepEqual(
    createWorkspaceToolSchemaBundle(tools),
    createToolSchemaBundle(tools, { sharedSchemaExternalUri: 'workspace-shared' })
  )
})

test('workspace tool execution adapters share schema parsing and runtime behavior', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/exec.ts'), 'export const value = 1\n')
  const workspace = await createWorkspace({ root })
  const agentTools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))
  const mcpDescriptors = new Map(createMcpTools(workspace).map((tool) => [tool.name, tool]))
  const mcp = createMcpLikeServer(workspace)

  assert.equal(agentTools.size, mcpDescriptors.size)
  assert.equal(mcp.listTools().tools.length, agentTools.size)
  assert.equal(mcpDescriptors.get(wsTool.prepareEdit).inputSchema.properties.operations.items.properties.operation.oneOf.length, 17)

  const agentRead = await agentTools.get(wsTool.read).execute({
    path: 'src/exec.ts',
    maxBytes: 1000,
  })
  const mcpRead = await mcp.callTool(wsTool.read, {
    path: 'src/exec.ts',
    maxBytes: 1000,
  })
  assert.equal(agentRead.files[0].content, mcpRead.files[0].content)
  assert.match(mcpRead.files[0].content, /value = 1/)

  const mcpBatchRead = await mcp.callTool(wsTool.runBatch, {
    tasks: [{
      id: 'read-exec',
      op: {
        kind: 'read',
        input: {
          path: 'src/exec.ts',
          maxBytes: 1000,
        },
      },
    }],
  })
  assert.equal(mcpBatchRead.ok, true)
  assert.match(mcpBatchRead.results[0].result.files[0].content, /value = 1/)

  await assert.rejects(
    () => mcp.callTool(wsTool.runBatch, {
      tasks: [{
        id: 'read-exec',
        op: {
          kind: 'read',
          input: {
            paths: ['src/exec.ts'],
            maxBytes: 1000,
          },
        },
      }],
    }),
    /paths|Unrecognized/i
  )

  await assert.rejects(
    () => agentTools.get(wsTool.read).execute({ path: [123], maxBytes: 1000 }),
    /expected string/i
  )
  await assert.rejects(
    () => mcp.callTool(wsTool.read, { path: [123], maxBytes: 1000 }),
    /expected string/i
  )

  const prepared = await agentTools.get(wsTool.prepareEdit).execute({
    operations: [{
      operation: {
        type: 'replace_text',
        path: 'src/exec.ts',
        oldText: 'value = 1',
        newText: 'value = 2',
      },
    }],
  })
  assert.equal(prepared.status, 'prepared')

  const validation = await mcp.callTool(wsTool.validate, {
    transactionId: prepared.transactionId,
    postconditions: [{ type: 'must_contain', value: 'value = 2' }],
  })
  assert.equal(validation.ok, true)

  const diff = await agentTools.get(wsTool.diff).execute({
    transactionId: prepared.transactionId,
  })
  assert.match(diff.diff, /value = 2/)

  const applied = await mcp.callTool(wsTool.applyEdit, {
    transactionId: prepared.transactionId,
  })
  assert.equal(applied.status, 'applied')
  assert.match(await fs.readFile(path.join(root, 'src/exec.ts'), 'utf8'), /value = 2/)
})

test('workspace agent tool descriptions keep the progressive evidence protocol localized', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))
  const names = [
    wsTool.listFiles,
    wsTool.search,
    wsTool.stat,
    wsTool.read,
    wsTool.resolveTarget,
    wsTool.buildEvidence,
  ]
  const protocolText = '路径发现或正文搜索 -> 轻量元数据或有界读取 -> 目标解析 -> evidence 构建'

  for (const name of names) {
    const description = tools.get(name)?.description ?? ''
    assert.match(description, /描述：/)
    assert.match(description, /适合：/)
    assert.match(description, /禁止：/)
    assert.match(description, /用法：/)
    assert.match(description, /示例：/)
    if (name === wsTool.buildEvidence) {
      assert.match(description, /强制流程：/)
      assert.ok(description.includes(protocolText))
      assert.match(description, /EvidencePack/)
      assert.match(description, /citation/)
      assert.match(description, /revision/)
    } else {
      assert.doesNotMatch(description, /强制流程：/)
      assert.equal(description.includes(protocolText), false)
    }
  }
})

test('workspace tool typed examples parse against their own schema (L3/L5 guardrail)', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))
  const exampleInputs = getWorkspaceToolExampleInputs()

  assert.equal(exampleInputs.size, tools.size, 'every tool must register at least one typed example')
  for (const [name, tool] of tools) {
    const examples = exampleInputs.get(name)
    assert.ok(examples && examples.length > 0, `${name} should register typed examples`)
    for (const example of examples) {
      const parsed = tool.schema.safeParse(example)
      assert.equal(parsed.success, true, `${name} example must satisfy its schema: ${JSON.stringify(example)}`)
    }
  }
})

test('workspace tool descriptions reference every shared concept (L1 single-source)', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const descriptions = createAgentTools(workspace).map((tool) => tool.description)
  const haystack = descriptions.join('\n')

  for (const [conceptId, text] of Object.entries(WorkspaceConcepts)) {
    assert.ok(
      haystack.includes(text),
      `concept ${conceptId} is defined but never referenced by any tool description`
    )
  }
})

test('workspace compact tool descriptions stay structured but shrink token cost (L4)', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const fullTools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))
  const compactTools = new Map(
    createAgentTools(workspace, { detail: 'compact' }).map((tool) => [tool.name, tool])
  )

  assert.equal(compactTools.size, fullTools.size, 'compact mode must expose the same tools')

  let fullChars = 0
  let compactChars = 0
  for (const [name, compact] of compactTools) {
    const full = fullTools.get(name)
    fullChars += full.description.length
    compactChars += compact.description.length

    // Compact stays a valid structured description: keeps every required section in order.
    assert.match(compact.description, /^描述：/, `${name} compact description must keep 描述`)
    for (const section of ['适合', '禁止', '用法', '示例', '注意']) {
      assert.match(
        compact.description,
        new RegExp(`${section}：\\n- `),
        `${name} compact description must keep at least one ${section} bullet`
      )
    }
    // Compact must never be longer than full.
    assert.ok(
      compact.description.length <= full.description.length,
      `${name} compact description must not exceed full length`
    )
  }

  // The whole point of L4: meaningfully fewer characters overall. The package surface
  // is already lean, so the floor is modest here; the App kernel tools save much more.
  assert.ok(
    compactChars < fullChars * 0.9,
    `compact descriptions should cut >=10% chars (full=${fullChars}, compact=${compactChars})`
  )
})

test('workspace agent tool examples are concrete parameter objects', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })

  for (const tool of createAgentTools(workspace)) {
    assert.match(tool.description, /示例：/)
    assert.match(tool.description, /调用参数示例：\{/)
    assert.doesNotMatch(tool.description, new RegExp(`${tool.name}\\(`))
    assert.doesNotMatch(tool.description, /velaros_workspace_/)
  }
})

test('workspace agent tools expose zod schemas and derived json schemas', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const x = 1\n')
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))

  const readTool = tools.get(wsTool.read)
  assert.equal(typeof readTool?.schema?.parse, 'function')
  assert.equal('inputSchema' in readTool, false)

  const mcpTools = new Map(createMcpTools(workspace).map((tool) => [tool.name, tool]))
  const readDescriptor = mcpTools.get(wsTool.read)
  assert.equal(readDescriptor?.inputSchema?.type, 'object')
  assert.equal(Object.hasOwn(readDescriptor?.inputSchema?.properties ?? {}, 'path'), true)
  assert.equal(Object.hasOwn(readDescriptor?.inputSchema?.properties ?? {}, 'paths'), false)
  assert.equal(findPathArraySchema(readDescriptor?.inputSchema?.properties?.path)?.type, 'array')

  assert.throws(() => readTool.schema.parse(null), /expected object/i)
  await assert.rejects(
    () => readTool.execute({ path: 'src/a.ts', maxBytes: 1000, extra: true }),
    /extra|Unrecognized/i
  )
  const result = await readTool.execute({ path: 'src/a.ts', maxBytes: 1000 })
  assert.equal(result.files[0].snapshot.path, 'src/a.ts')
})

test('workspace read honors maxChars from the generated schema', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'abcdef\nsecond line\n')
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))

  const result = await tools.get(wsTool.read).execute({ path: 'src/a.ts', maxChars: 3 })

  assert.equal(result.files[0].content, 'abc')
  assert.equal(result.files[0].truncated, true)
})

test('workspace read and stat honor bounds for files above the full-read limit', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'big.txt'), `${'x'.repeat(2048)}\n`)
  const workspace = await createWorkspace({
    root,
    corePolicy: { maxFileSizeToReadBytes: 64 },
  })

  const stat = await workspace.stat({ path: 'big.txt' })
  const result = await workspace.read({ path: 'big.txt', maxChars: 12 })

  assert.equal(stat.readableText, true)
  assert.equal(typeof stat.revision, 'string')
  assert.equal(result.content, 'x'.repeat(12))
  assert.equal(result.truncated, true)
  assert.equal(result.hasMore, true)
})

test('workspace read decodes BOM-less UTF-16LE source files as text', async () => {
  const root = await tmp()
  const source = '// Created by 69431 on 2024/12/31\n#include "CameraManagerLogLoader.h"\n'
  await fs.writeFile(path.join(root, 'CameraManagerLogLoader.cpp'), Buffer.from(source, 'utf16le'))
  const workspace = await createWorkspace({ root })

  const stat = await workspace.stat({ path: 'CameraManagerLogLoader.cpp' })
  const result = await workspace.read({ path: 'CameraManagerLogLoader.cpp' })

  assert.equal(stat.isBinary, false)
  assert.equal(stat.readableText, true)
  assert.match(result.content, /Created by 69431/)
  assert.match(result.content, /#include/)
  assert.equal(result.content.includes('\u0000'), false)
})

test('workspace applyEdit preserves BOM-less UTF-16LE encoding on overwrite', async () => {
  const root = await tmp()
  const source = 'first line\nsecond line\nthird line\n'
  await fs.writeFile(path.join(root, 'notes.txt'), Buffer.from(source, 'utf16le'))
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'notes.txt',
          oldText: 'second line',
          newText: 'updated second line',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'notes.txt'))
  assert.equal(raw.includes(Buffer.from('updated second line', 'utf8')), false)
  assert.match(raw.toString('utf16le'), /updated second line/)
  assert.doesNotMatch(raw.toString('utf16le'), /^second line$/m)
})

test('workspace read decodes GB18030 source files as text', async () => {
  const root = await tmp()
  const gb18030 = Buffer.from('c4e3bac3cac0bde70ab5dab6fed0d00a', 'hex')
  await fs.writeFile(path.join(root, 'gbk.txt'), gb18030)
  const workspace = await createWorkspace({ root })

  const stat = await workspace.stat({ path: 'gbk.txt' })
  const result = await workspace.read({ path: 'gbk.txt' })

  assert.equal(stat.isBinary, false)
  assert.equal(stat.readableText, true)
  assert.equal(result.content, '你好世界\n第二行\n')
})

test('workspace applyEdit preserves GB18030 encoding on overwrite', async () => {
  const root = await tmp()
  const source = Buffer.from('c4e3bac3cac0bde70ab5dab6fed0d00a', 'hex')
  await fs.writeFile(path.join(root, 'gbk.txt'), source)
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'gbk.txt',
          oldText: '第二行',
          newText: '新的行',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'gbk.txt'))
  assert.equal(raw.toString('hex'), 'c4e3bac3cac0bde70ad0c2b5c4d0d00a')
})

test('workspace replace_text adapts LF-only oldText to CRLF files without changing line endings', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'crlf.txt',
          oldText: 'one\ntwo',
          newText: 'ONE\nTWO',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'crlf.txt'), 'utf8')
  assert.equal(raw, 'ONE\r\nTWO\r\nthree\r\n')
  assert.equal(raw.includes('ONE\nTWO'), false)
})

test('workspace delete_text adapts LF-only oldText to CRLF files', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf-delete.txt'), 'one\r\ntwo\r\nthree\r\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'delete_text',
          path: 'crlf-delete.txt',
          oldText: 'one\ntwo',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'crlf-delete.txt'), 'utf8')
  assert.equal(raw, '\r\nthree\r\n')
})

test('workspace insert_text_at_anchor adapts LF-only anchors and inserted text to CRLF files', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf-anchor.txt'), 'one\r\ntwo\r\nthree\r\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'insert_text_at_anchor',
          path: 'crlf-anchor.txt',
          anchorText: 'one\ntwo',
          position: 'after',
          text: '\ninserted',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'crlf-anchor.txt'), 'utf8')
  assert.equal(raw, 'one\r\ntwo\r\ninserted\r\nthree\r\n')
})

test('workspace resolveTarget adapts LF-only exact snippets and range replacements to CRLF files', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf-resolve.txt'), 'one\r\ntwo\r\nthree\r\n')
  const workspace = await createWorkspace({ root })

  const resolved = await workspace.resolveTarget({
    path: 'crlf-resolve.txt',
    target: { exactSnippet: 'one\ntwo' },
  })

  assert.equal(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return

  const tx = await workspace.prepareEdit({
    operations: [
      {
        targetId: resolved.target.targetId,
        operation: {
          type: 'replace_text',
          newText: 'ONE\nTWO',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'crlf-resolve.txt'), 'utf8')
  assert.equal(raw, 'ONE\r\nTWO\r\nthree\r\n')
})

test('workspace range replacement uses CRLF file style even when the selected text is single-line', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf-single-line-target.txt'), 'one\r\ntwo\r\n')
  const workspace = await createWorkspace({ root })

  const resolved = await workspace.resolveTarget({
    path: 'crlf-single-line-target.txt',
    target: { exactSnippet: 'one' },
  })

  assert.equal(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return

  const tx = await workspace.prepareEdit({
    operations: [
      {
        targetId: resolved.target.targetId,
        operation: {
          type: 'replace_text',
          newText: 'ONE\nONE',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const raw = await fs.readFile(path.join(root, 'crlf-single-line-target.txt'), 'utf8')
  assert.equal(raw, 'ONE\r\nONE\r\ntwo\r\n')
})

test('workspace resolveTarget adapts LF-only before after and mustContain anchors to CRLF files', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf-target-anchors.txt'), 'begin\r\none\r\ntwo\r\nend\r\n')
  const workspace = await createWorkspace({ root })

  const resolved = await workspace.resolveTarget({
    path: 'crlf-target-anchors.txt',
    target: {
      anchors: {
        before: 'begin\n',
        after: '\nend',
        mustContain: ['one\ntwo'],
      },
    },
  })

  assert.equal(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  assert.equal(resolved.target.anchors.exactSnippet, 'one\r\ntwo')
})

test('workspace append_text adapts LF-only text and skip checks to CRLF files', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'crlf-append.txt'), 'one\r\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'append_text',
          path: 'crlf-append.txt',
          text: 'two\n',
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })

  const skipped = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'append_text',
          path: 'crlf-append.txt',
          text: 'two\n',
          skipIfAlreadyPresent: true,
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: skipped.transactionId })

  const raw = await fs.readFile(path.join(root, 'crlf-append.txt'), 'utf8')
  assert.equal(raw, 'one\r\ntwo\r\n')
})

test('workspace range read on oversized files does not compute full-file line counts', async () => {
  const root = await tmp()
  const content = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n')
  await fs.writeFile(path.join(root, 'large-window.txt'), content)
  const workspace = await createWorkspace({
    root,
    corePolicy: { maxFileSizeToReadBytes: 64 },
  })

  const result = await workspace.read({
    path: 'large-window.txt',
    range: { startLine: 2, endLine: 3 },
  })

  assert.equal(result.content, 'line 2\nline 3')
  assert.deepEqual(result.range, {
    startLine: 2,
    endLine: 3,
  })
  assert.equal(result.hasMore, true)
  assert.equal(result.nextStartLine, 4)
  assert.equal(result.totalLines, undefined)
  assert.equal(result.remainingLines, undefined)
})

test('workspace read agent tool requires path and applies a safe default bound', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n')
  await fs.writeFile(path.join(root, 'b.txt'), 'b\n')
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))
  const readTool = tools.get(wsTool.read)

  await assert.rejects(
    () => readTool.execute({}),
    /path|required/i
  )
  const defaultBounded = await readTool.execute({ path: 'a.txt' })
  assert.equal(defaultBounded.files[0].content, 'a\n')
  assert.deepEqual(defaultBounded.appliedDefaultBound, { maxChars: 500_000 })
  await assert.rejects(
    () =>
      readTool.execute({
        path: 'a.txt',
        range: { startOffset: 1, endOffset: 2 },
        allowUnbounded: true,
      }),
    /startOffset|endOffset|Unrecognized/i
  )

  const unbounded = await readTool.execute({ path: 'a.txt', allowUnbounded: true })
  assert.equal(unbounded.files[0].content, 'a\n')

  const multi = await readTool.execute({ path: ['a.txt', 'b.txt'], maxChars: 10 })
  assert.deepEqual(multi.files.map((file) => file.snapshot.path), ['a.txt', 'b.txt'])

  await assert.rejects(
    () => readTool.execute({ paths: ['a.txt'], maxChars: 10 }),
    /paths|Unrecognized/i
  )
})

test('workspace read agent tool accepts per-path base revisions', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n')
  await fs.writeFile(path.join(root, 'b.txt'), 'b\n')
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))
  const readTool = tools.get(wsTool.read)
  const revA = (await workspace.read({ path: 'a.txt' })).snapshot.revision
  const revB = (await workspace.read({ path: 'b.txt' })).snapshot.revision

  const result = await readTool.execute({
    path: ['a.txt', 'b.txt'],
    baseRevisions: { 'a.txt': revA, 'b.txt': revB },
    maxChars: 10,
  })

  assert.deepEqual(result.files.map((file) => file.snapshot.path), ['a.txt', 'b.txt'])
  await assert.rejects(
    () =>
      readTool.execute({
        path: ['a.txt', 'b.txt'],
        baseRevision: revA,
        maxChars: 10,
      }),
    /baseRevision|Unrecognized|Expected/i
  )
})

test('workspace agent tool input schemas describe model-facing parameters', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const tools = new Map(createMcpTools(workspace).map((tool) => [tool.name, tool]))

  const readSchema = tools.get(wsTool.read).inputSchema
  assert.equal(Object.hasOwn(readSchema.properties, 'path'), true)
  assert.equal(Object.hasOwn(readSchema.properties, 'paths'), false)
  assert.equal(Object.hasOwn(readSchema.properties, 'baseRevision'), false)
  assert.ok(Object.hasOwn(readSchema.properties, 'baseRevisions'))
  assert.ok(Object.hasOwn(readSchema.properties, 'allowUnbounded'))
  assert.match(readSchema.properties.path.description, /描述：/)
  assert.equal(findPathArraySchema(readSchema.properties.path)?.maxItems, 20)
  assert.match(readSchema.properties.range.description, /有界/)
  assert.equal(Object.hasOwn(readSchema.properties.range.properties, 'startOffset'), false)
  assert.match(readSchema.properties.maxBytes.description, /字节/)
  assert.match(readSchema.properties.maxBytes.description, /5MB/)
  assert.match(readSchema.properties.maxChars.description, /500000/)
  assert.equal(hasJsonReadBoundRequirement(readSchema), false)

  const listSchema = tools.get(wsTool.listFiles).inputSchema
  assert.match(listSchema.properties.include.description, /glob/)
  assert.match(listSchema.properties.maxDepth.description, /递归/)

  const evidenceSchema = tools.get(wsTool.buildEvidence).inputSchema
  assert.match(evidenceSchema.properties.task.description, /任务/)
  assert.match(evidenceSchema.properties.task.properties.goal.description, /目标/)
  assert.match(evidenceSchema.properties.target.properties.targetId.description, /目标解析/)
  assert.match(evidenceSchema.properties.include.properties.windowLinesBefore.description, /之前/)
  assert.match(evidenceSchema.properties.editScope.properties.allowedFiles.description, /允许/)

  const prepareSchema = tools.get(wsTool.prepareEdit).inputSchema
  assert.match(prepareSchema.properties.operations.description, /编辑 intent/)
  assert.equal(prepareSchema.properties.operations.items.properties.operation.oneOf.length, 17)

  const amendSchema = tools.get(wsTool.amendEdit).inputSchema
  assert.match(amendSchema.properties.operations.description, /追加到已准备事务/)
  assert.equal(amendSchema.properties.operations.items.properties.operation.oneOf.length, 17)

  const commitSchema = tools.get(wsTool.commitEdit).inputSchema
  assert.match(commitSchema.properties.operations.description, /编辑 intent/)
  assert.match(commitSchema.properties.checks.description, /校验器/)
  assert.match(commitSchema.properties.postconditions.description, /后置条件/)

  const postconditionItem = commitSchema.properties.postconditions.items
  assert.match(postconditionItem.description, /按 type 选择/)
  const postconditionTypes = [
    'must_contain',
    'must_not_contain',
    'must_keep_symbol',
    'must_modify_symbol',
    'must_not_modify_symbol',
    'changed_files_allowlist',
    'max_changed_lines',
    'schema_valid',
    'layout_preserved',
    'formula_preserved',
    'custom',
  ]
  const postconditionBranches = postconditionItem.oneOf
  assert.equal(postconditionBranches.length, postconditionTypes.length)
  const postconditionBranchByType = new Map(
    postconditionBranches.map((branch) => [branch.properties.type.const, branch])
  )
  assert.deepEqual([...postconditionBranchByType.keys()], postconditionTypes)
  for (const [postconditionType, valueShape] of [
    ['must_contain', '字符串'],
    ['must_not_contain', '字符串'],
    ['must_keep_symbol', '符号'],
    ['must_modify_symbol', '符号'],
    ['must_not_modify_symbol', '符号'],
    ['changed_files_allowlist', '允许'],
    ['max_changed_lines', '最大行数'],
    ['schema_valid', '校验'],
    ['layout_preserved', '布局'],
    ['formula_preserved', '公式'],
    ['custom', '自定义'],
  ]) {
    const branch = postconditionBranchByType.get(postconditionType)
    assert.match(branch.description, /后置条件/)
    assert.doesNotMatch(branch.description, new RegExp(postconditionType))
    assert.match(branch.properties.type.description, /描述：/)
    assert.match(branch.properties.value.description, new RegExp(valueShape))
  }
  assert.match(postconditionBranchByType.get('must_contain').description, /默认 core\.postcondition/)
  assert.match(postconditionBranchByType.get('schema_valid').description, /自定义 validator/)
  assert.match(postconditionBranchByType.get('formula_preserved').properties.value.properties.ranges.description, /单元格范围/)

  const operationItem = commitSchema.properties.operations.items
  assert.match(operationItem.properties.reason.description, /修改原因/)
  assert.match(operationItem.properties.constraints.description, /约束/)
  assert.match(operationItem.properties.operation.description, /编辑操作载荷/)
  assert.match(operationItem.properties.operation.description, /按 type 选择/)
  const operationTypes = [
    'replace_text',
    'insert_text',
    'insert_text_at_anchor',
    'append_text',
    'prepend_text',
    'delete_text',
    'create_file',
    'delete_file',
    'rename_file',
    'replace_symbol',
    'insert_around_symbol',
    'insert_before_symbol',
    'insert_after_symbol',
    'add_import',
    'remove_import',
    'json_patch',
    'custom',
  ]
  const operationBranches = operationItem.properties.operation.oneOf
  assert.equal(operationBranches.length, operationTypes.length)
  const operationBranchByType = new Map(
    operationBranches.map((branch) => [branch.properties.type.const, branch])
  )
  assert.deepEqual([...operationBranchByType.keys()], operationTypes)
  for (const [operationType, parameterName] of [
    ['replace_text', 'oldText'],
    ['insert_text', 'position'],
    ['insert_text_at_anchor', 'anchorText'],
    ['append_text', 'skipIfAlreadyPresent'],
    ['prepend_text', 'skipIfAlreadyPresent'],
    ['delete_text', 'oldText'],
    ['create_file', 'content'],
    ['delete_file', 'path'],
    ['rename_file', 'from'],
    ['replace_symbol', 'replacement'],
    ['insert_around_symbol', 'position'],
    ['insert_before_symbol', 'text'],
    ['insert_after_symbol', 'text'],
    ['add_import', 'module'],
    ['remove_import', 'name'],
    ['json_patch', 'patches'],
    ['custom', 'payload'],
  ]) {
    const branch = operationBranchByType.get(operationType)
    assert.match(branch.description, /操作结构/)
    assert.doesNotMatch(branch.description, new RegExp(operationType))
    assert.match(branch.properties.type.description, /描述：/)
    assert.ok(branch.properties[parameterName])
    assert.match(branch.properties[parameterName].description, /描述：/)
  }
  assert.match(operationBranchByType.get('replace_text').properties.newText.description, /替换后/)
  assert.match(operationBranchByType.get('add_import').properties.importStatement.description, /完整 import/)
  assert.match(operationBranchByType.get('json_patch').properties.patches.items.properties.path.description, /JSON Pointer/)

  const validateSchema = tools.get(wsTool.validate).inputSchema
  assert.match(validateSchema.properties.checks.description, /校验器/)

  const batchSchema = tools.get(wsTool.runBatch).inputSchema
  assert.match(batchSchema.properties.tasks.description, /任务/)
  assert.equal(batchSchema.properties.tasks.minItems, 1)
  assert.equal(batchSchema.properties.concurrency.type, 'integer')
  const batchOperation = batchSchema.properties.tasks.items.properties.op
  assert.match(batchOperation.description, /按 kind 选择/)
  assert.equal(batchOperation.oneOf.length, 7)
  const batchBranchByKind = new Map(
    batchOperation.oneOf.map((branch) => [branch.properties.kind.const, branch])
  )
  assert.deepEqual([...batchBranchByKind.keys()], ['read', 'search', 'resolve', 'prepare', 'apply', 'validate', 'rollback'])
  const batchReadInput = batchBranchByKind.get('read').properties.input
  assert.equal(Object.hasOwn(batchReadInput.properties, 'path'), true)
  assert.equal(Object.hasOwn(batchReadInput.properties, 'paths'), false)
  assert.equal(findPathArraySchema(batchReadInput.properties.path)?.type, 'array')
  assert.equal(findPathArraySchema(batchReadInput.properties.path)?.maxItems, 20)
  assert.equal(Object.hasOwn(batchReadInput.properties.range.properties, 'startOffset'), false)
  assert.match(batchReadInput.properties.path.description, /路径/)
  assert.match(batchReadInput.properties.maxChars.description, /字符数/)
  assert.equal(hasJsonReadBoundRequirement(batchReadInput), false)
  assert.match(batchBranchByKind.get('prepare').properties.input.properties.operations.description, /编辑 intent/)
  assert.equal(batchBranchByKind.has('custom'), false)
  assert.match(batchSchema.properties.mode.description, /执行模式/)
  assert.match(batchSchema.properties.conflictCheck.description, /冲突/)
})

test('workspace compact tool schema bundle freezes the 1.0 model-facing contract', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const tools = createAgentTools(workspace)

  const bundle = createWorkspaceToolSchemaBundle(tools)
  const mcpTools = new Map(createMcpTools(workspace).map((tool) => [tool.name, tool]))
  const toolNames = bundle.tools.map((tool) => tool.name)
  const commitSchema = mcpTools.get(wsTool.commitEdit).inputSchema
  const editOperationTypes = commitSchema.properties.operations.items.properties.operation.oneOf.map(
    (branch) => branch.properties.type.const
  )
  const postconditionTypes = commitSchema.properties.postconditions.items.oneOf.map(
    (branch) => branch.properties.type.const
  )
  const batchKinds = mcpTools
    .get(wsTool.runBatch)
    .inputSchema.properties.tasks.items.properties.op.oneOf.map((branch) => branch.properties.kind.const)

  assert.equal(bundle.schemaVersion, 1)
  assert.deepEqual(toolNames, [
    wsTool.status,
    wsTool.read,
    wsTool.stat,
    wsTool.listFiles,
    wsTool.search,
    wsTool.symbols,
    wsTool.resolveTarget,
    wsTool.buildEvidence,
    wsTool.prepareEdit,
    wsTool.amendEdit,
    wsTool.commitEdit,
    wsTool.applyEdit,
    wsTool.validate,
    wsTool.rollback,
    wsTool.diff,
    wsTool.runBatch,
  ])
  assert.ok(Object.keys(bundle.$defs).length > 0)
  assert.ok(JSON.stringify(bundle.tools).includes('#/$defs/'))
  assert.equal(JSON.stringify(bundle).includes('ws_prepare_edit#/$defs'), false)
  for (const tool of bundle.tools) {
    for (const [propertyName, propertySchema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.equal(
        typeof propertySchema.description,
        'string',
        `${tool.name}.${propertyName} should keep a local description even when it uses $ref`
      )
    }
  }
  for (const description of collectSchemaDescriptions(bundle)) {
    assert.doesNotMatch(description, /velaros_workspace_/)
  }
  for (const ref of collectSchemaRefs(bundle)) {
    assert.match(ref, /^#\/\$defs\//)
    assert.ok(bundle.$defs[ref.slice('#/$defs/'.length)], `schema ref must resolve: ${ref}`)
  }
  assert.ok(
    JSON.stringify(bundle).length <= 40_000,
    `schema bundle is too large: ${JSON.stringify(bundle).length}`
  )
  const bundleToolByName = new Map(bundle.tools.map((tool) => [tool.name, tool]))
  assert.equal(
    hasJsonReadBoundRequirement({
      ...bundleToolByName.get(wsTool.read).inputSchema,
      $defs: bundle.$defs,
    }),
    false
  )
  assert.equal(
    hasJsonReadBoundRequirement({
      ...bundleToolByName.get(wsTool.runBatch).inputSchema,
      $defs: bundle.$defs,
    }),
    false
  )

  const contractSnapshot = {
    schemaVersion: bundle.schemaVersion,
    toolNames,
    editOperationTypes,
    postconditionTypes,
    batchKinds,
    bundleChars: JSON.stringify(bundle).length,
    bundleSha256: sha256Hex(JSON.stringify(bundle)),
  }
  assert.deepEqual(contractSnapshot, await readJsonFixture('workspace-tool-schema-contract.json'))
})

test('workspace commit_edit returns a flat transaction/apply summary', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const x = 1\n')
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))

  const result = await tools.get(wsTool.commitEdit).execute({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'src/a.ts',
          oldText: 'export const x = 1',
          newText: 'export const x = 2',
        },
      },
    ],
  })

  assert.equal(result.status, 'applied')
  assert.equal(result.changed, true)
  assert.equal(result.applied, true)
  assert.deepEqual(result.changedFiles, ['src/a.ts'])
  assert.equal(typeof result.newRevisions?.['src/a.ts'], 'string')
  assert.equal(result.patchCount, 1)
  assert.equal('prepared' in result, false)
  assert.equal('apply' in result, false)
  assert.equal('patches' in result, false)
  assert.equal('diff' in result, false)
  assert.equal('baseSnapshots' in result, false)
})

test('workspace custom edit operation is executable through a registered plugin strategy', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes/custom.txt'), 'before custom\n')
  const workspace = await createWorkspace({
    root,
    plugins: [{
      name: 'test.custom-edit-strategy',
      version: '0.0.0',
      setup(ctx) {
        ctx.registerPatchStrategy({
          id: 'test.custom-edit-strategy',
          priority: 500,
          canHandle(input) {
            return input.intent.operation.type === 'custom' &&
              input.intent.operation.adapterId === 'test.custom'
          },
          prepare(input) {
            const op = input.intent.operation
            const content = input.snapshot?.content ?? ''
            const nextContent = content.replace(op.payload.oldText, op.payload.newText)
            return [{
              patchId: 'patch_custom_test',
              strategyId: 'test.custom-edit-strategy',
              path: input.snapshot.path,
              baseRevision: input.snapshot.revision,
              oldContent: content,
              newContent: nextContent,
              diff: `--- ${input.snapshot.path}\n+++ ${input.snapshot.path}\n`,
              changedLines: 1,
              risk: 'low',
              metadata: { op: 'custom' },
            }]
          },
        })
      },
    }],
  })

  const tx = await workspace.prepareEdit({
    operations: [{
      operation: {
        type: 'custom',
        path: 'notes/custom.txt',
        adapterId: 'test.custom',
        payload: {
          oldText: 'before custom',
          newText: 'after custom',
        },
      },
    }],
  })
  assert.equal(tx.status, 'prepared')

  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')
  assert.match(await fs.readFile(path.join(root, 'notes/custom.txt'), 'utf8'), /after custom/)
})

test('workspace plugin extension points compose through public execution paths', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes/fixture.fixture'), 'fixture-symbol()\nneeds-fix\n')
  const events = []

  const workspace = await createWorkspace({
    root,
    plugins: [{
      name: 'test.composite-plugin',
      version: '0.0.0',
      setup(pluginCtx) {
        for (const event of [
          'BeforeRead',
          'AfterRead',
          'BeforeSearch',
          'AfterSearch',
          'BeforeResolve',
          'AfterResolve',
          'BeforePrepareEdit',
          'AfterPrepareEdit',
          'BeforeValidate',
          'AfterValidate',
          'BeforeApplyEdit',
          'AfterApplyEdit',
        ]) {
          pluginCtx.registerHook({
            id: `test.hook.${event}`,
            event,
            run() {
              events.push(`hook:${event}`)
            },
          })
        }
        pluginCtx.registerPipelineStage({
          id: 'test.pipeline.read-alias',
          phase: 'read.input',
          order: 1,
          run(input, ctx) {
            events.push(`pipeline:${ctx.phase}`)
            return input.path === 'alias.fixture'
              ? { ...input, path: 'notes/fixture.fixture' }
              : input
          },
        })
        pluginCtx.registerPipelineStage({
          id: 'test.pipeline.search-alias',
          phase: 'search.input',
          order: 1,
          run(input, ctx) {
            events.push(`pipeline:${ctx.phase}`)
            return input.query === 'PLUGIN_ALIAS'
              ? { ...input, query: 'fixture-symbol' }
              : input
          },
        })
        pluginCtx.registerPipelineStage({
          id: 'test.pipeline.prepare-metadata',
          phase: 'prepare.input',
          order: 1,
          run(input, ctx) {
            events.push(`pipeline:${ctx.phase}`)
            return {
              ...input,
              metadata: {
                ...(input.metadata ?? {}),
                preparedByPipeline: true,
              },
            }
          },
        })
        pluginCtx.registerAdapterFactory({
          id: 'test.fixture-adapter.factory',
          canHandle(snapshot) {
            return snapshot.path.endsWith('.fixture')
          },
          create() {
            const adapter = {
              id: 'test.fixture-adapter',
              kind: 'code',
              priority: 1000,
              capabilities: ['search', 'resolve', 'symbols', 'validate'],
              parse({ snapshot }) {
                const content = snapshot.content ?? ''
                const snippet = 'fixture-symbol'
                const start = content.indexOf(snippet)
                if (start < 0) return { ok: true, diagnostics: [], symbols: [] }
                return {
                  ok: true,
                  diagnostics: [],
                  symbols: [{
                    kind: 'function',
                    name: 'fixtureSymbol',
                    range: testRangeFromOffsets(content, start, start + snippet.length),
                    metadata: { source: 'fixture' },
                  }],
                }
              },
              search({ snapshot, query, maxResults }) {
                const parsed = adapter.parse({ snapshot })
                return parsed.symbols
                  .filter((symbol) => symbol.name.includes(query) || (snapshot.content ?? '').includes(query))
                  .slice(0, maxResults ?? 20)
                  .map((symbol) => ({
                    path: snapshot.path,
                    score: 10,
                    kind: 'symbol',
                    range: symbol.range,
                    snippet: symbol.name,
                    adapterId: adapter.id,
                  }))
              },
              resolveTarget(input) {
                const wanted = input.target?.symbol
                if (!wanted?.name) return { status: 'not_found', reason: 'missing symbol selector' }
                const parsed = adapter.parse({ snapshot: input.snapshot })
                const matches = parsed.symbols.filter((symbol) => symbol.name === wanted.name)
                if (matches.length !== 1) return { status: 'not_found', reason: 'symbol not found' }
                const symbol = matches[0]
                const content = input.snapshot.content ?? ''
                const exactSnippet = content.slice(symbol.range.startOffset, symbol.range.endOffset)
                return {
                  status: 'resolved',
                  target: {
                    targetId: 'target_fixture_symbol',
                    path: input.snapshot.path,
                    baseRevision: input.snapshot.revision,
                    sha256: input.snapshot.sha256,
                    kind: 'symbol',
                    range: symbol.range,
                    symbol: { kind: symbol.kind, name: symbol.name },
                    anchors: {
                      exactSnippet,
                      startSnippet: exactSnippet,
                      endSnippet: exactSnippet,
                      mustContain: [symbol.name],
                    },
                    confidence: 1,
                    expectedMatches: 1,
                    adapterId: adapter.id,
                  },
                }
              },
              validate({ snapshot, changedContent }) {
                const content = changedContent ?? snapshot.content ?? ''
                const diagnostics = content.includes('adapter-error')
                  ? [{
                      severity: 'error',
                      path: snapshot.path,
                      source: adapter.id,
                      message: 'adapter validation failed',
                    }]
                  : []
                return {
                  ok: diagnostics.length === 0,
                  diagnostics,
                  checks: [{ id: adapter.id, ok: diagnostics.length === 0, diagnostics }],
                }
              },
            }
            return adapter
          },
        })
        pluginCtx.registerPatchStrategy({
          id: 'test.custom-strategy',
          priority: 600,
          canHandle(input) {
            return input.intent.operation.type === 'custom' &&
              input.intent.operation.adapterId === 'test.custom'
          },
          prepare(input) {
            const op = input.intent.operation
            const content = input.snapshot?.content ?? ''
            const nextContent = `${content}${op.payload.text}`
            return [{
              patchId: 'patch_custom_composite',
              strategyId: 'test.custom-strategy',
              path: input.snapshot.path,
              baseRevision: input.snapshot.revision,
              oldContent: content,
              newContent: nextContent,
              diff: `--- ${input.snapshot.path}\n+++ ${input.snapshot.path}\n+${op.payload.text}`,
              changedLines: 1,
              risk: 'low',
              metadata: { op: 'custom' },
            }]
          },
        })
        pluginCtx.registerValidator({
          id: 'test.fixture-validator',
          canValidate(input) {
            return !input.checks?.length || input.checks.includes('test.fixture-validator')
          },
          async validate(input, ctx) {
            const content = await ctx.readFile('notes/fixture.fixture')
            const ok = !!content?.includes('FIXED')
            const diagnostics = ok
              ? []
              : [{
                  severity: 'error',
                  path: 'notes/fixture.fixture',
                  source: 'test.fixture-validator',
                  message: 'fixture content must be fixed before apply',
                }]
            return {
              ok,
              diagnostics,
              checks: [{ id: 'test.fixture-validator', ok, diagnostics }],
            }
          },
        })
        pluginCtx.registerFixer({
          id: 'test.fixture-fixer',
          canFix(input) {
            return !input.checks?.length || input.checks.includes('test.fixture-fixer')
          },
          async fix(input, ctx) {
            const fixes = []
            for (const file of input.paths ?? []) {
              const content = await ctx.readFile(file)
              if (content?.includes('needs-fix')) {
                fixes.push({
                  path: file,
                  content: content.replace('needs-fix', 'FIXED'),
                  source: 'test.fixture-fixer',
                })
              }
            }
            return {
              ok: true,
              changed: fixes.length > 0,
              transactionId: input.transactionId,
              changedFiles: fixes.map((fix) => fix.path),
              fixes,
              diagnostics: [],
            }
          },
        })
      },
    }],
  })

  const read = await workspace.read({ path: 'alias.fixture' })
  assert.equal(read.snapshot.path, 'notes/fixture.fixture')
  assert.ok(read.snapshot.adapterIds.includes('test.fixture-adapter'))

  const search = await workspace.search({
    query: 'PLUGIN_ALIAS',
    include: ['**/*.fixture'],
    useRipgrep: false,
  })
  assert.equal(search.backend, 'adapters')
  assert.equal(search.hits[0].adapterId, 'test.fixture-adapter')

  const resolved = await workspace.resolveTarget({
    path: 'notes/fixture.fixture',
    target: { symbol: { kind: 'function', name: 'fixtureSymbol' } },
  })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.target.adapterId, 'test.fixture-adapter')

  const tx = await workspace.prepareEdit({
    operations: [{
      targetId: resolved.target.targetId,
      operation: {
        type: 'custom',
        adapterId: 'test.custom',
        payload: { text: 'custom-tail\n' },
      },
    }],
  })
  assert.equal(tx.metadata.preparedByPipeline, true)

  const failingValidation = await workspace.validate({
    transactionId: tx.transactionId,
    checks: ['test.fixture-validator'],
  })
  assert.equal(failingValidation.ok, false)

  const fixed = await workspace.fixTransaction({
    transactionId: tx.transactionId,
    paths: ['notes/fixture.fixture'],
    checks: ['test.fixture-fixer'],
  })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.changed, true)
  assert.deepEqual(fixed.changedFiles, ['notes/fixture.fixture'])

  const passingValidation = await workspace.validate({
    transactionId: tx.transactionId,
    checks: ['test.fixture-validator'],
  })
  assert.equal(passingValidation.ok, true)
  assert.ok(passingValidation.checks.some((check) => check.id === 'test.fixture-adapter'))

  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')
  const next = await fs.readFile(path.join(root, 'notes/fixture.fixture'), 'utf8')
  assert.match(next, /FIXED/)
  assert.match(next, /custom-tail/)

  const status = await workspace.status()
  assert.ok(status.plugins.includes('test.composite-plugin'))
  assert.ok(status.adapters.includes('test.fixture-adapter.factory'))
  assert.ok(status.validators.includes('test.fixture-validator'))
  for (const marker of [
    'pipeline:read.input',
    'pipeline:search.input',
    'pipeline:prepare.input',
    'hook:BeforeRead',
    'hook:AfterRead',
    'hook:BeforeSearch',
    'hook:AfterSearch',
    'hook:BeforeResolve',
    'hook:AfterResolve',
    'hook:BeforePrepareEdit',
    'hook:AfterPrepareEdit',
    'hook:BeforeValidate',
    'hook:AfterValidate',
    'hook:BeforeApplyEdit',
    'hook:AfterApplyEdit',
  ]) {
    assert.ok(events.includes(marker), `missing event marker ${marker}`)
  }
})

test('workspace third-party plugin template installs through public registries', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  await fs.writeFile(path.join(root, 'docs/template.tpl'), 'TemplateSymbol\nneeds-template-fix\n')
  const events = []
  const workspace = await createWorkspace({ root })

  await workspace.install({
    name: 'test.third-party-template-plugin',
    version: '1.0.0',
    setup(pluginCtx) {
      for (const event of ['BeforeRead', 'AfterRead']) {
        pluginCtx.registerHook({
          id: `test.template-hook.${event}`,
          event,
          run() {
            events.push(`hook:${event}`)
          },
        })
      }
      pluginCtx.registerPipelineStage({
        id: 'test.template-read-alias',
        phase: 'read.input',
        order: 1,
        run(input, ctx) {
          events.push(`pipeline:${ctx.phase}`)
          return input.path === 'template-alias.tpl'
            ? { ...input, path: 'docs/template.tpl' }
            : input
        },
      })
      pluginCtx.registerAdapterFactory({
        id: 'test.template-adapter.factory',
        canHandle(snapshot) {
          return snapshot.path.endsWith('.tpl')
        },
        create() {
          const adapter = {
            id: 'test.template-adapter',
            kind: 'document',
            priority: 750,
            capabilities: ['search', 'symbols', 'validate'],
            parse({ snapshot }) {
              const content = snapshot.content ?? ''
              const start = content.indexOf('TemplateSymbol')
              return {
                ok: true,
                diagnostics: [],
                symbols: start < 0
                  ? []
                  : [{
                      kind: 'template',
                      name: 'TemplateSymbol',
                      range: testRangeFromOffsets(content, start, start + 'TemplateSymbol'.length),
                    }],
              }
            },
            search({ snapshot, query, maxResults }) {
              const parsed = adapter.parse({ snapshot })
              return parsed.symbols
                .filter((symbol) => symbol.name.includes(query))
                .slice(0, maxResults ?? 20)
                .map((symbol) => ({
                  path: snapshot.path,
                  score: 8,
                  kind: 'symbol',
                  range: symbol.range,
                  snippet: symbol.name,
                  adapterId: adapter.id,
                }))
            },
            validate({ snapshot, changedContent }) {
              const content = changedContent ?? snapshot.content ?? ''
              const ok = !content.includes('adapter-error')
              const diagnostics = ok
                ? []
                : [{
                    severity: 'error',
                    path: snapshot.path,
                    source: adapter.id,
                    message: 'template adapter rejected adapter-error',
                  }]
              return {
                ok,
                diagnostics,
                checks: [{ id: adapter.id, ok, diagnostics }],
              }
            },
          }
          return adapter
        },
      })
      pluginCtx.registerValidator({
        id: 'test.template-validator',
        canValidate(input) {
          return !input.checks?.length || input.checks.includes('test.template-validator')
        },
        async validate(input, ctx) {
          const content = await ctx.readFile('docs/template.tpl')
          const ok = !!content?.includes('TEMPLATE_FIXED')
          const diagnostics = ok
            ? []
            : [{
                severity: 'error',
                path: 'docs/template.tpl',
                source: 'test.template-validator',
                message: 'template content must be fixed',
              }]
          return {
            ok,
            diagnostics,
            checks: [{ id: 'test.template-validator', ok, diagnostics }],
          }
        },
      })
      pluginCtx.registerFixer({
        id: 'test.template-fixer',
        canFix(input) {
          return !input.checks?.length || input.checks.includes('test.template-fixer')
        },
        async fix(input, ctx) {
          const fixes = []
          for (const file of input.paths ?? []) {
            const content = await ctx.readFile(file)
            if (content?.includes('needs-template-fix')) {
              fixes.push({
                path: file,
                content: content.replace('needs-template-fix', 'TEMPLATE_FIXED'),
                source: 'test.template-fixer',
              })
            }
          }
          return {
            ok: true,
            changed: fixes.length > 0,
            transactionId: input.transactionId,
            changedFiles: fixes.map((fix) => fix.path),
            fixes,
            diagnostics: [],
          }
        },
      })
    },
  })

  const read = await workspace.read({ path: 'template-alias.tpl' })
  assert.equal(read.snapshot.path, 'docs/template.tpl')
  assert.ok(read.snapshot.adapterIds.includes('test.template-adapter'))

  const search = await workspace.search({
    query: 'TemplateSymbol',
    include: ['**/*.tpl'],
    useRipgrep: false,
  })
  assert.equal(search.backend, 'adapters')
  assert.equal(search.hits[0].adapterId, 'test.template-adapter')

  const tx = await workspace.prepareEdit({
    operations: [{
      operation: {
        type: 'append_text',
        path: 'docs/template.tpl',
        text: 'plugin-operation\n',
      },
    }],
  })
  const failingValidation = await workspace.validate({
    transactionId: tx.transactionId,
    checks: ['test.template-validator'],
  })
  assert.equal(failingValidation.ok, false)
  assert.ok(failingValidation.checks.some((check) => check.id === 'test.template-adapter'))

  const fixed = await workspace.fixTransaction({
    transactionId: tx.transactionId,
    paths: ['docs/template.tpl'],
    checks: ['test.template-fixer'],
  })
  assert.equal(fixed.ok, true)
  assert.deepEqual(fixed.changedFiles, ['docs/template.tpl'])

  const passingValidation = await workspace.validate({
    transactionId: tx.transactionId,
    checks: ['test.template-validator'],
  })
  assert.equal(passingValidation.ok, true)

  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')
  assert.match(await fs.readFile(path.join(root, 'docs/template.tpl'), 'utf8'), /TEMPLATE_FIXED/)

  const status = await workspace.status()
  assert.ok(status.plugins.includes('test.third-party-template-plugin'))
  assert.ok(status.adapters.includes('test.template-adapter.factory'))
  assert.ok(status.validators.includes('test.template-validator'))
  assert.deepEqual(events, [
    'hook:BeforeRead',
    'pipeline:read.input',
    'hook:AfterRead',
  ])
})

test('workspace permission chain gates normalized visibility before provider policy', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'denied'), { recursive: true })
  await fs.mkdir(path.join(root, 'hidden'), { recursive: true })
  await fs.mkdir(path.join(root, 'visible'), { recursive: true })
  await fs.writeFile(path.join(root, 'denied/secret.txt'), 'denied\n')
  await fs.writeFile(path.join(root, 'hidden/secret.txt'), 'hidden\n')
  await fs.writeFile(path.join(root, 'visible/public.txt'), 'public\n')
  const events = []
  const workspace = await createWorkspace({
    root,
    corePolicy: { readDeny: ['denied/**'] },
    providers: {
      fileFilter: {
        shouldInclude(input) {
          events.push(`fileFilter:${input.action}:${input.path}`)
          return !input.path.startsWith('hidden/')
        },
      },
      policy: {
        decide(input) {
          events.push(`policy:${input.action}:${input.paths?.join(',') ?? '<none>'}`)
          return { allow: true, requireApproval: true, reason: 'approval after visibility' }
        },
      },
      approval: {
        approve(input) {
          events.push(`approval:${input.action}:${input.paths?.join(',') ?? '<none>'}`)
          return true
        },
      },
    },
    plugins: [{
      name: 'test.permission-alias-plugin',
      version: '0.0.0',
      setup(ctx) {
        ctx.registerPipelineStage({
          id: 'test.permission-alias-read-input',
          phase: 'read.input',
          order: 1,
          run(input) {
            events.push(`pipeline:read:${input.path}`)
            if (input.path === 'alias-hidden.txt') return { ...input, path: 'hidden/secret.txt' }
            return input
          },
        })
      },
    }],
  })

  await assert.rejects(
    () => workspace.read({ path: 'denied/secret.txt' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /读取被拒绝/.test(err.message)
  )
  assert.equal(events.some((event) => event.startsWith('policy:')), false)
  assert.equal(events.some((event) => event.startsWith('approval:')), false)

  events.length = 0
  await assert.rejects(
    () => workspace.read({ path: 'hidden/secret.txt' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /读取被拒绝/.test(err.message)
  )
  assert.ok(events.includes('fileFilter:read:hidden/secret.txt'))
  assert.equal(events.some((event) => event.startsWith('policy:')), false)
  assert.equal(events.some((event) => event.startsWith('approval:')), false)

  events.length = 0
  await assert.rejects(
    () => workspace.read({ path: 'alias-hidden.txt' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /读取被拒绝/.test(err.message)
  )
  assert.ok(events.includes('pipeline:read:alias-hidden.txt'))
  assert.ok(events.includes('fileFilter:read:hidden/secret.txt'))
  assert.equal(events.some((event) => event.startsWith('policy:')), false)
  assert.equal(events.some((event) => event.startsWith('approval:')), false)

  events.length = 0
  await workspace.read({ path: 'visible/public.txt' })
  const fileFilterIndex = events.indexOf('fileFilter:read:visible/public.txt')
  const policyIndex = events.indexOf('policy:read:visible/public.txt')
  const approvalIndex = events.indexOf('approval:read:visible/public.txt')
  assert.equal(
    events.filter((event) => event === 'fileFilter:read:visible/public.txt').length,
    1
  )
  assert.ok(fileFilterIndex >= 0)
  assert.ok(policyIndex > fileFilterIndex)
  assert.ok(approvalIndex > policyIndex)
})

test('workspace kernel rejects symlink-resolved escapes before reading, searching, or editing', { skip: process.platform === 'win32' }, async () => {
  const root = await tmp()
  const outside = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/inside.txt'), 'inside\n')
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-secret\n')
  await fs.symlink(outside, path.join(root, 'linked-outside'), 'dir')

  const workspace = await createWorkspace({
    root,
    corePolicy: { enableRipgrepSearch: false },
  })

  await assert.rejects(
    () => workspace.read({ path: 'linked-outside/secret.txt' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /越出工作区根目录/.test(err.message)
  )
  await assert.rejects(
    () => workspace.search({ root: path.relative(root, outside), query: 'outside-secret' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /越出工作区根目录/.test(err.message)
  )
  await assert.rejects(
    () => workspace.prepareEdit({
      operations: [{
        operation: {
          type: 'create_file',
          path: 'linked-outside/new.txt',
          content: 'escaped\n',
        },
      }],
    }),
    (err) => err.reason === 'PERMISSION_DENIED' && /越出工作区根目录/.test(err.message)
  )

  const files = await workspace.listFiles({ recursive: true, maxDepth: 2 })
  assert.ok(files.some((file) => file.path === 'src/inside.txt'))
  assert.equal(files.some((file) => file.path.startsWith('linked-outside')), false)
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside-secret\n')
})

test('workspace search skips nested vendor directories unless explicitly targeted', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules/dep'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/app.ts'), 'const value = "needle"\n')
  await fs.writeFile(path.join(root, 'node_modules/dep/lib.ts'), 'const value = "needle"\n')

  const workspace = await createWorkspace({
    root,
    corePolicy: { enableRipgrepSearch: false },
  })

  const implicitSearch = await workspace.search({
    query: 'needle',
    regex: false,
    maxResults: 20,
  })
  assert.ok(implicitSearch.hits.some((hit) => hit.path === 'src/app.ts'))
  assert.equal(
    implicitSearch.hits.some((hit) => hit.path.startsWith('node_modules/')),
    false
  )

  const explicitSearch = await workspace.search({
    root: 'node_modules',
    query: 'needle',
    regex: false,
    maxResults: 20,
  })
  assert.ok(explicitSearch.hits.some((hit) => hit.path === 'node_modules/dep/lib.ts'))
})

test('workspace providers enforce visibility, approval, redaction, and context sanitization', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'hidden'), { recursive: true })
  await fs.writeFile(path.join(root, 'visible.txt'), 'visible\n')
  await fs.writeFile(path.join(root, 'hidden/secret.txt'), 'hidden\n')
  await fs.writeFile(path.join(root, 'blocked.txt'), 'blocked\n')
  await fs.writeFile(path.join(root, 'needs-approval.txt'), 'approval\n')
  await fs.writeFile(path.join(root, 'secrets.env'), 'api_key=sk-test1234567890\n')
  const approvals = []
  const workspace = await createWorkspace({
    root,
    corePolicy: { enableRipgrepSearch: false },
    providers: {
      fileFilter: createFileFilterProvider({ exclude: ['hidden/**'] }),
      secretRedaction: createSecretRedactionProvider(),
      policy: {
        decide(input) {
          if (input.paths?.includes('blocked.txt')) return { allow: false, reason: 'blocked by provider policy' }
          if (input.action === 'read' && input.paths?.includes('needs-approval.txt')) return { allow: true, requireApproval: true, reason: 'human approval required' }
          return { allow: true }
        },
      },
      approval: {
        approve(input) {
          approvals.push(input)
          return false
        },
      },
      context: {
        buildEvidence(pack) {
          return {
            source: 'context-provider',
            goal: pack.task?.goal,
          }
        },
        sanitize(pack) {
          return {
            ...pack,
            metadata: {
              ...(pack.metadata ?? {}),
              sanitized: true,
            },
          }
        },
      },
    },
  })

  const files = await workspace.listFiles({ recursive: true, maxDepth: 3 })
  assert.ok(files.some((file) => file.path === 'visible.txt'))
  assert.equal(files.some((file) => file.path === 'hidden/secret.txt'), false)
  await assert.rejects(
    () => workspace.read({ path: 'hidden/secret.txt' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /读取被拒绝/.test(err.message)
  )

  const redacted = await workspace.read({ path: 'secrets.env' })
  assert.match(redacted.content, /\[REDACTED\]/)
  assert.doesNotMatch(redacted.content, /sk-test1234567890/)

  await assert.rejects(
    () => workspace.read({ path: 'blocked.txt' }),
    (err) => err.reason === 'PERMISSION_DENIED' && /blocked by provider policy/.test(err.message)
  )
  const blockedResult = await asWorkspaceResult(() => workspace.read({ path: 'blocked.txt' }), {
    caller: 'provider-test',
  })
  assert.equal(blockedResult.ok, false)
  assert.equal(blockedResult.error.reason, 'PERMISSION_DENIED')
  assert.equal(blockedResult.meta.caller, 'provider-test')

  await assert.rejects(
    () => workspace.read({ path: 'needs-approval.txt' }),
    /审批被拒绝/
  )
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].reason, 'human approval required')

  const evidence = await workspace.buildEvidencePack({
    target: { path: 'secrets.env', range: { startLine: 1, endLine: 1 } },
    include: { currentWindow: true },
    task: { goal: 'provider context' },
    metadata: { source: 'test' },
  })
  assert.equal(evidence.metadata.sanitized, true)
  assert.equal(evidence.metadata.contextProvider.source, 'context-provider')
  assert.match(evidence.freshContext.currentWindow, /\[REDACTED\]/)
  assert.equal(evidence.trust.redactedSecrets, true)
})

test('workspace validation plugin runs command validators through the command provider', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'notes.txt'), 'needs command validation\n')
  await fs.writeFile(path.join(root, 'package.json'), '{}\n')
  const calls = []
  const workspace = await createWorkspace({
    root,
    providers: {
      command: {
        run(input) {
          calls.push(input)
          return {
            exitCode: 127,
            stdout: '',
            stderr: 'fixture-check is missing',
            toolRequirements: [{
              kind: 'missing-command',
              command: input.command,
              reason: 'install fixture-check',
              sourceCommand: input.command,
            }],
          }
        },
      },
    },
    plugins: [validationPlugin({
      commands: [{
        id: 'test.command-validator',
        command: 'fixture-check',
        args: ['--strict'],
        fileExtensions: ['.txt'],
      }],
    })],
  })

  const skipped = await workspace.validate({
    paths: ['package.json'],
    checks: ['test.command-validator'],
  })
  assert.equal(skipped.ok, true)
  assert.equal(calls.length, 0)

  const result = await workspace.validate({
    paths: ['notes.txt'],
    checks: ['test.command-validator'],
  })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'fixture-check')
  assert.deepEqual(calls[0].args, ['--strict'])
  assert.equal(result.toolRequirements[0].kind, 'missing-command')
  assert.equal(result.toolRequirements[0].command, 'fixture-check')
  assert.match(result.diagnostics[0].message, /fixture-check is missing/)
})

test('recommended workspace, LSP plugin, and Velaros bridge expose optional integration paths', async () => {
  const recommendedRoot = await tmp()
  const recommended = await createRecommendedWorkspace({
    root: recommendedRoot,
    jsTs: false,
    extraPlugins: [{
      name: 'test.extra-plugin',
      version: '0.0.0',
      setup(ctx) {
        ctx.registerValidator({
          id: 'test.extra-validator',
          canValidate() {
            return true
          },
          validate() {
            return { ok: true, diagnostics: [], checks: [{ id: 'test.extra-validator', ok: true }] }
          },
        })
      },
    }],
  })
  const recommendedStatus = await recommended.status()
  assert.ok(recommendedStatus.plugins.includes('@velaros-ai/workspace/core'))
  assert.ok(recommendedStatus.plugins.includes('@velaros-ai/workspace/validation'))
  assert.ok(recommendedStatus.plugins.includes('test.extra-plugin'))
  assert.equal(recommendedStatus.plugins.includes('@velaros/workspace-typescript'), false)
  assert.ok(recommendedStatus.validators.includes('test.extra-validator'))

  const lspRoot = await tmp()
  await fs.writeFile(path.join(lspRoot, 'component.lsp'), 'export function fromLsp() { return 1 }\n')
  const lspWorkspace = await createWorkspace({
    root: lspRoot,
    plugins: [lspPlugin({
      provider: {
        id: 'fixture',
        canHandle({ path: filePath }) {
          return filePath.endsWith('.lsp')
        },
        listSymbols({ content }) {
          const snippet = 'fromLsp'
          const start = content.indexOf(snippet)
          return [{
            kind: 'function',
            name: 'fromLsp',
            startOffset: start,
            endOffset: start + snippet.length,
          }]
        },
        diagnostics({ path: filePath }) {
          return [{
            severity: 'warning',
            path: filePath,
            source: 'lsp.fixture',
            message: 'fixture warning',
          }]
        },
      },
    })],
  })
  const symbols = await lspWorkspace.listSymbols('component.lsp')
  assert.equal(symbols[0].adapterId, 'lsp.fixture')
  assert.equal(symbols[0].name, 'fromLsp')
  const resolved = await lspWorkspace.resolveTarget({
    path: 'component.lsp',
    target: { symbol: { kind: 'function', name: 'fromLsp' } },
  })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.target.adapterId, 'lsp.fixture')
  const validation = await lspWorkspace.validate({ paths: ['component.lsp'] })
  assert.equal(validation.ok, true)
  assert.ok(validation.checks.some((check) => check.id === 'lsp.fixture'))
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.message === 'fixture warning'))

  const bridgeRoot = await tmp()
  await fs.writeFile(path.join(bridgeRoot, 'bridge.txt'), 'bridge\n')
  const registeredTools = []
  const registeredModules = []
  const bridge = await createVelarosWorkspaceBridge({
    root: bridgeRoot,
    autoRegisterTools: true,
    velaros: {
      tools: {
        register(tool) {
          registeredTools.push(tool.name)
        },
      },
      modules: {
        register(module) {
          registeredModules.push(module)
        },
      },
      policy: {
        decide() {
          return { allow: false, reason: 'runtime policy should be overridden' }
        },
      },
    },
    providers: {
      policy: {
        decide() {
          return { allow: true }
        },
      },
    },
  })
  assert.ok(registeredTools.includes(wsTool.read))
  assert.deepEqual(registeredModules.map((module) => module.name), ['workspace'])
  assert.equal(registeredModules[0], bridge.asModule())
  assert.equal(bridge.asModule(), bridge.asModule())
  assert.equal((await bridge.workspace.read({ path: 'bridge.txt' })).content, 'bridge\n')
  assert.equal(bridge.asModule().mcp.listTools().tools.length, bridge.tools.length)
  assert.equal(bridge.asModule().toolSchemaBundle.tools.length, bridge.tools.length)
  assert.ok(JSON.stringify(bridge.asModule().toolSchemaBundle).length <= 40_000)
})

test('Velaros bridge tool registration is idempotent', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'bridge.txt'), 'bridge\n')
  const registeredToolNames = []
  const registrationMetadata = []
  const bridge = await createVelarosWorkspaceBridge({
    root,
    autoRegisterTools: true,
    velaros: {
      tools: {
        registerMany(tools, metadata) {
          registeredToolNames.push(...tools.map((tool) => tool.name))
          registrationMetadata.push(metadata)
        },
      },
    },
  })

  await bridge.registerTools()
  await bridge.registerTools()

  assert.equal(registeredToolNames.filter((name) => name === wsTool.read).length, 1)
  assert.equal(registeredToolNames.length, bridge.tools.length)
  assert.equal(registrationMetadata.length, 1)
  assert.equal(registrationMetadata[0].schemaBundle, bridge.toolSchemaBundle)
  assert.equal(registrationMetadata[0].schemaBundle, bridge.asModule().toolSchemaBundle)
})

test('Velaros bridge and built-in plugins source their version from package metadata', async () => {
  const pkg = await readWorkspacePackageJson()
  const sourcePaths = [
    '../src/velaros/index.ts',
    '../src/plugins/core.ts',
    '../src/plugins/jsts.ts',
    '../src/plugins/lsp.ts',
    '../src/plugins/tree-sitter.ts',
    '../src/plugins/typescript/index.ts',
    '../src/plugins/validation.ts',
  ]
  for (const sourcePath of sourcePaths) {
    const source = await fs.readFile(path.resolve(import.meta.dirname, sourcePath), 'utf8')
    assert.doesNotMatch(source, /version:\s*['"]\d+\.\d+\.\d+['"]/)
  }

  const root = await tmp()
  const bridge = await createVelarosWorkspaceBridge({ root })
  const plugins = [
    corePlugin(),
    jsTsPlugin(),
    lspPlugin({ provider: {} }),
    treeSitterPlugin(),
    typescriptPlugin(),
    validationPlugin(),
  ]

  assert.equal(bridge.asModule().version, pkg.version)
  assert.deepEqual(plugins.map((plugin) => plugin.version), plugins.map(() => pkg.version))
})

test('workspace transaction tools enforce the lifecycle described by their schemas', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const x = 1\n')
  const workspace = await createWorkspace({ root })
  const tools = new Map(createAgentTools(workspace).map((tool) => [tool.name, tool]))

  const prepared = await tools.get(wsTool.prepareEdit).execute({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'src/a.ts',
          oldText: 'export const x = 1',
          newText: 'export const x = 2',
        },
      },
    ],
  })

  await assert.rejects(
    () => tools.get(wsTool.rollback).execute({ transactionId: prepared.transactionId }),
    /只能回滚已应用的事务/
  )
  await tools.get(wsTool.applyEdit).execute({ transactionId: prepared.transactionId })
  await assert.rejects(
    () => tools.get(wsTool.applyEdit).execute({ transactionId: prepared.transactionId }),
    /事务已经应用/
  )
  await assert.rejects(
    () => tools.get(wsTool.amendEdit).execute({ transactionId: prepared.transactionId, operations: [] }),
    /只能修补尚未应用的事务/
  )
  await assert.rejects(
    () => tools.get(wsTool.validate).execute({ transactionId: 'tx_missing' }),
    /未知事务/
  )
})

test('buildEvidencePack resolves targetId into citable current window', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src/a.ts'),
    ['line 1', 'line 2', 'target line', 'line 4', 'line 5'].join('\n')
  )
  const workspace = await createWorkspace({ root })

  const resolved = await workspace.resolveTarget({
    path: 'src/a.ts',
    target: { exactSnippet: 'target line' },
    expectedMatches: 1,
  })
  assert.equal(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return

  const pack = await workspace.buildEvidencePack({
    target: { targetId: resolved.target.targetId },
    include: { currentWindow: true, windowLinesBefore: 1, windowLinesAfter: 1 },
  })

  assert.equal(pack.target?.targetId, resolved.target.targetId)
  assert.equal(pack.freshContext?.path, 'src/a.ts')
  assert.equal(pack.freshContext?.revision, resolved.target.baseRevision)
  assert.deepEqual(pack.freshContext?.targetRange, {
    startLine: 3,
    endLine: 3,
    startOffset: 14,
    endOffset: 25,
    startColumn: 1,
    endColumn: 12,
  })
  assert.deepEqual(pack.freshContext?.contextRange, { startLine: 2, endLine: 4 })
  assert.deepEqual(pack.freshContext?.citation, {
    path: 'src/a.ts',
    revision: resolved.target.baseRevision,
    range: {
      startLine: 3,
      endLine: 3,
      startOffset: 14,
      endOffset: 25,
      startColumn: 1,
      endColumn: 12,
    },
  })
  assert.match(pack.freshContext?.currentWindow ?? '', /line 2\ntarget line\nline 4/)
  assert.equal(pack.freshContext?.hasMoreBefore, true)
  assert.equal(pack.freshContext?.hasMoreAfter, true)
  assert.ok(pack.freshContext?.suggestedReads?.length >= 1)
})

test('buildEvidencePack can build citable context from path and range', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
  const workspace = await createWorkspace({ root })

  const pack = await workspace.buildEvidencePack({
    target: { path: 'notes.txt', range: { startLine: 2, endLine: 2 } },
    include: { currentWindow: true, windowLinesBefore: 1, windowLinesAfter: 1 },
  })

  assert.equal(pack.target, undefined)
  assert.equal(pack.freshContext?.path, 'notes.txt')
  assert.deepEqual(pack.freshContext?.targetRange, { startLine: 2, endLine: 2 })
  assert.deepEqual(pack.freshContext?.contextRange, { startLine: 1, endLine: 3 })
  assert.equal(pack.freshContext?.citation?.path, 'notes.txt')
  assert.match(pack.freshContext?.currentWindow ?? '', /alpha\nbeta\ngamma/)
})

test('search falls back when ripgrep command is missing and reports requirement', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const needle = "found"\n')
  const workspace = await createWorkspace({
    root,
    providers: {
      command: {
        async run(input) {
          return {
            exitCode: 127,
            stdout: '',
            stderr: 'zsh: command not found: rg',
            toolRequirements: [
              {
                kind: 'missing-command',
                command: input.command,
                reason: `${input.command} is not available on PATH.`,
                sourceCommand: input.command,
              },
            ],
          }
        },
      },
    },
  })

  const search = await workspace.search({ query: 'needle' })

  assert.equal(search.backend, 'adapters')
  assert.equal(search.hits.length, 1)
  assert.equal(search.hits[0].path, 'src/a.ts')
  assert.equal(search.toolRequirements?.[0]?.kind, 'missing-command')
  assert.equal(search.toolRequirements?.[0]?.command, 'rg')
})

test('search keeps partial ripgrep timeout results instead of falling back', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const needle = "partial"\n')
  await fs.writeFile(path.join(root, 'src/b.ts'), 'export const needle = "adapter-only"\n')
  const line = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'src/a.ts' },
      lines: { text: 'export const needle = "partial"\n' },
      line_number: 1,
      submatches: [{ start: 13, end: 19 }],
    },
  })
  const workspace = await createWorkspace({
    root,
    providers: {
      command: {
        async run() {
          return {
            exitCode: 124,
            stdout: `${line}\n`,
            stderr: 'ripgrep timed out',
            timedOut: true,
          }
        },
      },
    },
  })

  const search = await workspace.search({ query: 'needle', maxResults: 10 })

  assert.equal(search.backend, 'ripgrep')
  assert.equal(search.truncated, true)
  assert.equal(search.hits.length, 1)
  assert.equal(search.hits[0].path, 'src/a.ts')
  assert.match(search.diagnostics?.join('\n') ?? '', /timed out/i)
})

test('json patch strategy updates structured data', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"demo","version":"0.0.1"}\n')
  const workspace = await createWorkspace({ root })
  const target = await workspace.resolveTarget({
    path: 'package.json',
    target: { lineHint: { startLine: 1, endLine: 1 } },
  })
  assert.equal(target.status, 'resolved')
  const tx = await workspace.prepareEdit({
    operations: [
      {
        targetId: target.status === 'resolved' ? target.target.targetId : undefined,
        operation: {
          type: 'json_patch',
          patches: [{ op: 'replace', path: '/version', value: '0.0.2' }],
        },
      },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })
  const parsed = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(parsed.version, '0.0.2')
})

test('prepareEdit text patch without resolvable path yields NOT_SUPPORTED snapshot error', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'solo.txt'), 'hello')
  const workspace = await createWorkspace({ root })

  await assert.rejects(
    () =>
      workspace.prepareEdit({
        operations: [{ operation: { type: 'replace_text', oldText: 'hello', newText: 'HELLO' } }],
      }),
    (err) =>
      err.reason === 'NOT_SUPPORTED' &&
      typeof err.message === 'string' &&
      err.message.includes('已加载的文本 snapshot')
  )
})

test('prepareEdit rejects stale input.baseRevision without resolveTarget', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'data.txt'), 'line one\n')
  const workspace = await createWorkspace({ root })

  const read1 = await workspace.read({ path: 'data.txt' })
  const rev1 = read1.snapshot.revision

  await fs.writeFile(path.join(root, 'data.txt'), 'line one\nline two\n')

  await assert.rejects(
    () =>
      workspace.prepareEdit({
        operations: [
          {
            operation: {
              type: 'replace_text',
              path: 'data.txt',
              oldText: 'line one',
              newText: 'line ONE',
            },
          },
        ],
        baseRevision: rev1,
      }),
    (err) => err.reason === 'BASE_REVISION_MISMATCH'
  )

  const read2 = await workspace.read({ path: 'data.txt' })
  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'data.txt',
          oldText: 'line one',
          newText: 'line ONE',
        },
      },
    ],
    baseRevision: read2.snapshot.revision,
  })
  assert.equal(tx.status, 'prepared')
  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')
})

test('default revisionStrategy is metadata: snapshot skips content hash but still tracks edits', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'meta.txt'), 'alpha\n')
  const workspace = await createWorkspace({ root })
  assert.equal(workspace.policy.revisionStrategy, 'metadata')

  const read1 = await workspace.read({ path: 'meta.txt' })
  const rev1 = read1.snapshot.revision
  assert.ok(rev1)
  // metadata 模式下 sha256 是元数据指纹，而非内容哈希。
  assert.notEqual(read1.snapshot.sha256, sha256Hex('alpha\n'))

  const tx = await workspace.prepareEdit({
    operations: [{ operation: { type: 'replace_text', path: 'meta.txt', oldText: 'alpha', newText: 'beta-text' } }],
    baseRevision: rev1,
  })
  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')

  const read2 = await workspace.read({ path: 'meta.txt' })
  // 内容/大小变化 -> revision 变化，正常编辑流转可被识别。
  assert.notEqual(read2.snapshot.revision, rev1)
})

test('content revisionStrategy can be selected and exposes the real content hash', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'exact.txt'), 'alpha\n')
  const workspace = await createWorkspace({ root, corePolicy: { revisionStrategy: 'content' } })
  assert.equal(workspace.policy.revisionStrategy, 'content')

  const read1 = await workspace.read({ path: 'exact.txt' })
  // content 模式下 sha256 必须等于文件内容的真实哈希。
  assert.equal(read1.snapshot.sha256, sha256Hex('alpha\n'))

  const tx = await workspace.prepareEdit({
    operations: [{ operation: { type: 'replace_text', path: 'exact.txt', oldText: 'alpha', newText: 'omega' } }],
    baseRevision: read1.snapshot.revision,
  })
  const applied = await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(applied.status, 'applied')
  const read2 = await workspace.read({ path: 'exact.txt' })
  assert.equal(read2.snapshot.sha256, sha256Hex('omega\n'))
  assert.notEqual(read2.snapshot.revision, read1.snapshot.revision)
})

test('metadata revisionStrategy misses a same-size change pinned to the same mtime (documented limitation)', async () => {
  const root = await tmp()
  const file = path.join(root, 'pin.txt')
  await fs.writeFile(file, 'AAAA')
  const fixed = new Date('2026-01-01T00:00:00.000Z')
  await fs.utimes(file, fixed, fixed)

  const workspace = await createWorkspace({ root })
  assert.equal(workspace.policy.revisionStrategy, 'metadata')
  const rev1 = (await workspace.read({ path: 'pin.txt' })).snapshot.revision

  // 同字节数改写，并把 mtime 钉回同一时刻：metadata 模式只看 path+mtimeNs+size，
  // 因此察觉不到这次内容变化。这是为跳过整文件哈希而接受的已知风险，固化在此防回归。
  await fs.writeFile(file, 'BBBB')
  await fs.utimes(file, fixed, fixed)
  const rev2 = (await workspace.read({ path: 'pin.txt' })).snapshot.revision
  assert.equal(rev2, rev1)
})

test('content revisionStrategy detects the same-size same-mtime change that metadata misses', async () => {
  const root = await tmp()
  const file = path.join(root, 'pin.txt')
  await fs.writeFile(file, 'AAAA')
  const fixed = new Date('2026-01-01T00:00:00.000Z')
  await fs.utimes(file, fixed, fixed)

  const workspace = await createWorkspace({ root, corePolicy: { revisionStrategy: 'content' } })
  const rev1 = (await workspace.read({ path: 'pin.txt' })).snapshot.revision

  await fs.writeFile(file, 'BBBB')
  await fs.utimes(file, fixed, fixed)
  const rev2 = (await workspace.read({ path: 'pin.txt' })).snapshot.revision
  // content 模式重新哈希内容，能识别 metadata 模式漏掉的等长同时刻改写。
  assert.notEqual(rev2, rev1)
})

test('runBatch atomic surfaces rollback failures instead of swallowing them', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [{ operation: { type: 'replace_text', path: 'a.txt', oldText: 'a', newText: 'A' } }],
  })

  // 强制回滚失败，验证 atomic 回滚阶段把失败上报到 rollbackFailures，而不是静默吞掉。
  workspace.rollback = async () => {
    throw new Error('rollback boom')
  }

  const result = await workspace.runBatch({
    atomic: true,
    stopOnError: false,
    tasks: [
      { id: 'apply', op: { kind: 'apply', input: { transactionId: tx.transactionId } } },
      { id: 'fail', op: { kind: 'custom', run: async () => { throw new Error('task boom') } } },
    ],
  })

  assert.equal(result.ok, false)
  assert.ok(Array.isArray(result.rollbackFailures))
  assert.equal(result.rollbackFailures.length, 1)
  assert.equal(result.rollbackFailures[0].transactionId, tx.transactionId)
  // 回滚失败的事务不应出现在 rolledBackTransactions（避免误报已撤销）。
  assert.equal(result.rolledBackTransactions.includes(tx.transactionId), false)
})

test('applyEdit queues same-file writers and reports stale follower revision', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'shared.txt'), 'one\n')
  const workspace = await createWorkspace({ root })

  const firstTx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'shared.txt',
          oldText: 'one',
          newText: 'two',
        },
      },
    ],
  })
  const secondTx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'shared.txt',
          oldText: 'one',
          newText: 'three',
        },
      },
    ],
  })

  let releaseWrite
  let enteredWrite
  const firstWriteEntered = new Promise((resolve) => {
    enteredWrite = resolve
  })
  const releaseFirstWrite = new Promise((resolve) => {
    releaseWrite = resolve
  })
  const originalWrite = workspace.store.write.bind(workspace.store)
  let delayedFirstWrite = false
  workspace.store.write = async (...args) => {
    if (!delayedFirstWrite && args[0] === 'shared.txt') {
      delayedFirstWrite = true
      enteredWrite()
      await releaseFirstWrite
    }
    return originalWrite(...args)
  }

  const firstApply = workspace.applyEdit({ transactionId: firstTx.transactionId })
  await firstWriteEntered

  let secondSettled = false
  const secondApply = workspace.applyEdit({ transactionId: secondTx.transactionId }).finally(() => {
    secondSettled = true
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(secondSettled, false)

  releaseWrite()
  const firstResult = await firstApply
  assert.equal(firstResult.status, 'applied')

  await assert.rejects(
    secondApply,
    (err) =>
      err.reason === 'BASE_REVISION_MISMATCH' &&
      err.suggestedNextAction ===
        '请重新读取受影响文件，并使用最新 snapshot.revision 重试。'
  )
  assert.equal(await fs.readFile(path.join(root, 'shared.txt'), 'utf8'), 'two\n')
})

test('applyEdit safely rebases queued non-overlapping text edits', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'shared.txt'), 'alpha\nbeta\n')
  const workspace = await createWorkspace({ root })

  const firstTx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'shared.txt',
          oldText: 'alpha',
          newText: 'ALPHA',
        },
      },
    ],
  })
  const secondTx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'shared.txt',
          oldText: 'beta',
          newText: 'BETA',
        },
      },
    ],
  })

  let releaseWrite
  let enteredWrite
  const firstWriteEntered = new Promise((resolve) => {
    enteredWrite = resolve
  })
  const releaseFirstWrite = new Promise((resolve) => {
    releaseWrite = resolve
  })
  const originalWrite = workspace.store.write.bind(workspace.store)
  let delayedFirstWrite = false
  workspace.store.write = async (...args) => {
    if (!delayedFirstWrite && args[0] === 'shared.txt') {
      delayedFirstWrite = true
      enteredWrite()
      await releaseFirstWrite
    }
    return originalWrite(...args)
  }

  const firstApply = workspace.applyEdit({ transactionId: firstTx.transactionId })
  await firstWriteEntered

  const secondApply = workspace.applyEdit({ transactionId: secondTx.transactionId })
  releaseWrite()

  await firstApply
  const secondResult = await secondApply

  assert.deepEqual(secondResult.rebasedFiles, ['shared.txt'])
  assert.equal(await fs.readFile(path.join(root, 'shared.txt'), 'utf8'), 'ALPHA\nBETA\n')
})

test('append_text and insert_text_at_anchor remain queue friendly after external edits', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'notes.txt'), 'middle\n')
  const workspace = await createWorkspace({ root })

  const appendTx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'append_text',
          path: 'notes.txt',
          text: 'tail\n',
        },
      },
    ],
  })
  await fs.writeFile(path.join(root, 'notes.txt'), 'head\nmiddle\n')
  const appendResult = await workspace.applyEdit({ transactionId: appendTx.transactionId })
  assert.deepEqual(appendResult.rebasedFiles, ['notes.txt'])
  assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'head\nmiddle\ntail\n')

  const anchorTx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'insert_text_at_anchor',
          path: 'notes.txt',
          anchorText: 'middle\n',
          position: 'after',
          text: 'after-middle\n',
        },
      },
    ],
  })
  await fs.writeFile(path.join(root, 'notes.txt'), 'head\nprefix\nmiddle\ntail\n')
  const anchorResult = await workspace.applyEdit({ transactionId: anchorTx.transactionId })
  assert.deepEqual(anchorResult.rebasedFiles, ['notes.txt'])
  assert.equal(
    await fs.readFile(path.join(root, 'notes.txt'), 'utf8'),
    'head\nprefix\nmiddle\nafter-middle\ntail\n'
  )
})

test('batch scheduler supports dependencies and concurrency', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.txt'), 'alpha beta')
  await fs.writeFile(path.join(root, 'src/b.txt'), 'beta gamma')
  const workspace = await createWorkspace({ root })
  const batch = await workspace.runBatch({
    concurrency: 2,
    tasks: [
      { id: 'read-a', op: { kind: 'read', input: { path: 'src/a.txt' } } },
      {
        id: 'search-beta',
        dependsOn: ['read-a'],
        op: { kind: 'search', input: { query: 'beta' } },
      },
    ],
  })
  assert.equal(batch.ok, true)
  assert.equal(batch.results.length, 2)
})

test('batch scheduler blocks dependents of failed tasks while continuing independent work', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  let dependentRan = false
  let independentRan = false

  const batch = await workspace.runBatch({
    stopOnError: false,
    tasks: [
      {
        id: 'fail',
        op: {
          kind: 'custom',
          run() {
            throw new Error('boom')
          },
        },
      },
      {
        id: 'dependent',
        dependsOn: ['fail'],
        op: {
          kind: 'custom',
          run() {
            dependentRan = true
          },
        },
      },
      {
        id: 'independent',
        op: {
          kind: 'custom',
          run() {
            independentRan = true
          },
        },
      },
    ],
  })

  const dependent = batch.results.find((result) => result.id === 'dependent')
  assert.equal(batch.ok, false)
  assert.equal(dependentRan, false)
  assert.equal(independentRan, true)
  assert.equal(dependent.ok, false)
  assert.equal(dependent.error.code, 'DEPENDENCY_FAILED')
})

test('batch worker pool caps concurrency and continuously backfills slots', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  let active = 0
  let maxActive = 0
  let completed = 0
  const makeTask = (id) => ({
    id,
    op: {
      kind: 'custom',
      async run() {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        completed += 1
      },
    },
  })

  const batch = await workspace.runBatch({
    concurrency: 3,
    tasks: Array.from({ length: 9 }, (_unused, index) => makeTask(`t${index}`)),
  })

  assert.equal(batch.ok, true)
  // 全部任务都跑完 → 槽位被持续回填（不是「整波等齐」）。
  assert.equal(completed, 9)
  assert.equal(batch.results.length, 9)
  // 并发上限被尊重，且确实并行（不是退化成串行）。
  assert.ok(maxActive <= 3, `maxActive ${maxActive} 超过并发上限`)
  assert.ok(maxActive >= 2, `maxActive ${maxActive} 未体现并行`)

  // 工作池指标随结果返回。
  assert.ok(batch.metrics)
  assert.equal(batch.metrics.totalTasks, 9)
  assert.equal(batch.metrics.concurrencyLimit, 3)
  assert.ok(batch.metrics.peakActive >= 2 && batch.metrics.peakActive <= 3)
  assert.ok(batch.metrics.maxQueuedReady >= 1) // 9 任务 / 并发 3，必有就绪任务在排队
  assert.ok(batch.metrics.durationMs >= 0)

  // status() 暴露最近一次批次指标，且没有遗留在跑的批次。
  const status = await workspace.status()
  assert.equal(status.runningBatches, 0)
  assert.deepEqual(status.lastBatch, batch.metrics)
})

test('batch default concurrency uses the policy cap', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const batch = await workspace.runBatch({
    tasks: Array.from({ length: 5 }, (_unused, index) => ({
      id: `t${index}`,
      op: { kind: 'custom', run() {} },
    })),
  })
  assert.equal(batch.ok, true)
  // 未显式传 concurrency → 默认取 policy.maxConcurrentBatchTasks（默认 8）。
  assert.equal(batch.metrics.concurrencyLimit, 8)
})

test('batch scheduler reports unsatisfiable or cyclic dependencies', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })

  const batch = await workspace.runBatch({
    stopOnError: false,
    tasks: [
      { id: 'a', dependsOn: ['b'], op: { kind: 'custom', run() {} } },
      { id: 'b', dependsOn: ['a'], op: { kind: 'custom', run() {} } },
    ],
  })

  assert.equal(batch.ok, false)
  assert.equal(batch.results.length, 2)
  assert.ok(batch.results.every((result) => !result.ok))
})

test('applyEdit is atomic: a mid-commit write failure restores already-written files', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  // x.ts 是一个文件；后续把它当作目录写子文件会触发 ENOTDIR，从而让第二个补丁在写盘阶段失败。
  await fs.writeFile(path.join(root, 'src/x.ts'), 'OLD\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'src/x.ts',
          oldText: 'OLD',
          newText: 'NEW',
        },
      },
      {
        operation: {
          type: 'create_file',
          path: 'src/x.ts/child.ts',
          content: 'child',
        },
      },
    ],
  })
  assert.equal(tx.status, 'prepared')

  await assert.rejects(() => workspace.applyEdit({ transactionId: tx.transactionId }))

  // 第一个文件必须被还原为旧内容，工作区不能留下「半改」状态。
  assert.equal(await fs.readFile(path.join(root, 'src/x.ts'), 'utf8'), 'OLD\n')
  const status = await workspace.status()
  assert.equal(status.locks.length, 0)
})

test('applyEdit rolls back earlier writes when a later patch hits a base revision mismatch', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'const a = 1\n')
  await fs.writeFile(path.join(root, 'src/b.ts'), 'const b = 1\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      { operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' } },
      { operation: { type: 'replace_text', path: 'src/b.ts', oldText: 'const b = 1', newText: 'const b = 2' } },
    ],
  })

  // 在 apply 前从外部改动 b.ts，使其内容与 revision 漂移且无法 rebase（oldText 不再存在）。
  await fs.writeFile(path.join(root, 'src/b.ts'), 'const b = 999\n')

  await assert.rejects(() => workspace.applyEdit({ transactionId: tx.transactionId }))

  // a.ts 先被写入又被回滚，最终仍是原始内容，工作区不留「半改」状态。
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'const a = 1\n')
  // b.ts 的外部改动不应被覆盖。
  assert.equal(await fs.readFile(path.join(root, 'src/b.ts'), 'utf8'), 'const b = 999\n')
})

test('kernel bounds retained terminal transactions to avoid unbounded growth', async () => {
  const root = await tmp()
  const workspace = await createWorkspace({ root })
  const iterations = 230

  for (let index = 0; index < iterations; index += 1) {
    const tx = await workspace.prepareEdit({
      operations: [
        { operation: { type: 'create_file', path: `notes/file-${index}.txt`, content: `note ${index}\n` } },
      ],
    })
    await workspace.applyEdit({ transactionId: tx.transactionId })
  }

  const status = await workspace.status()
  // 已结束事务保留上限为 200；事务 Map 不应随应用次数无界增长。
  assert.ok(
    status.transactions <= 200,
    `expected retained transactions <= 200, got ${status.transactions}`
  )
})

test('toAbs rejects sibling paths that share the root name prefix', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'inside.txt'), 'ok\n')
  const workspace = await createWorkspace({ root })
  // 正常根内读取仍然工作。
  const inside = await workspace.read({ path: 'inside.txt' })
  assert.equal(inside.content, 'ok\n')
  // 兄弟目录 `<root>-evil` 经 ../ 解析后与 root 共享前缀；裸 startsWith 会误判为「在内」，
  // 带分隔符边界后必须拒绝。
  const base = path.basename(root)
  await assert.rejects(
    () => workspace.read({ path: `../${base}-evil/secret.txt` }),
    /越出工作区根目录/
  )
})

test('discardTransaction drops a prepared transaction so it no longer applies or shows in diff', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'a.txt'), 'hello\n')
  const workspace = await createWorkspace({ root })
  const tx = await workspace.prepareEdit({
    operations: [{ operation: { type: 'replace_text', path: 'a.txt', oldText: 'hello', newText: 'bye' } }],
  })
  const before = await workspace.diff()
  assert.ok(before.diff.includes('bye'))

  const discarded = workspace.discardTransaction(tx.transactionId)
  assert.equal(discarded.discarded, true)

  // 丢弃后不再出现在 diff() 合并里，也不能再 apply。
  const after = await workspace.diff()
  assert.ok(!after.diff.includes('bye'))
  await assert.rejects(() => workspace.applyEdit({ transactionId: tx.transactionId }), /未知事务/)

  // 磁盘内容未变。
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'hello\n')
})

test('delete_text honors expectedMatches instead of hardcoding 1', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'd.txt'), 'x\nDROP\ny\nDROP\n')
  const workspace = await createWorkspace({ root })

  // 默认 expected=1，两个匹配 → 歧义报错（与 replace_text 一致）。
  await assert.rejects(
    () => workspace.prepareEdit({
      operations: [{ operation: { type: 'delete_text', path: 'd.txt', oldText: 'DROP' } }],
    }),
    /delete_text 预期 1 个匹配，实际找到 2 个/
  )

  // 显式给 constraints.expectedMatches=2 后通过校验（不再无视该参数）。
  const tx = await workspace.prepareEdit({
    operations: [{ operation: { type: 'delete_text', path: 'd.txt', oldText: 'DROP' }, constraints: { expectedMatches: 2 } }],
  })
  assert.equal(tx.status, 'prepared')
})

test('rollback restores every changed file (atomic capture path)', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/a.ts'), 'const a = 1\n')
  await fs.writeFile(path.join(root, 'src/b.ts'), 'const b = 1\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      { operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' } },
      { operation: { type: 'replace_text', path: 'src/b.ts', oldText: 'const b = 1', newText: 'const b = 2' } },
    ],
  })
  await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'const a = 2\n')

  await workspace.rollback({ transactionId: tx.transactionId })

  // 两个文件都必须还原为旧正文，且不会被 oldContent ?? "" 截断为空。
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'const a = 1\n')
  assert.equal(await fs.readFile(path.join(root, 'src/b.ts'), 'utf8'), 'const b = 1\n')
})

test('applyEdit can restore a rolled-back transaction', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'note.txt'), 'before\n')
  const workspace = await createWorkspace({ root })

  const tx = await workspace.prepareEdit({
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'note.txt',
          oldText: 'before',
          newText: 'after',
        },
      },
    ],
  })

  await workspace.applyEdit({ transactionId: tx.transactionId })
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'after\n')

  await workspace.rollback({ transactionId: tx.transactionId })
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'before\n')

  await workspace.applyEdit({ transactionId: tx.transactionId })

  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'after\n')
})
