/**
 * @test-meta
 * title: 工作区生产编辑路径
 * summary: 发布契约：验证内置脚本解析、树解析与生产环境编辑桥接。
 * area: packages
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { test } from 'bun:test'

import { createWorkspace } from '../dist/index.js'
import { treeSitterPlugin } from '../dist/plugins/tree-sitter.js'
import { createVelarosWorkspaceBridge } from '../dist/velaros/index.js'

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'velaros-prod-'))
}

test('built-in JS/TS fallback resolves and replaces JS symbols without external parser', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'service.js'), `export class Service {
  refreshToken(token) {
    return token + ':old'
  }
}
`)
  const ws = await createWorkspace({ root })
  const resolved = await ws.resolveTarget({ path: 'service.js', target: { symbol: { kind: 'method', container: 'Service', name: 'refreshToken' } } })
  assert.equal(resolved.status, 'resolved')
  const tx = await ws.prepareEdit({ operations: [{ targetId: resolved.target.targetId, operation: { type: 'replace_symbol', replacement: `refreshToken(token) {
    if (!token) return ''
    return token + ':new'
  }` } }] })
  await ws.applyEdit({ transactionId: tx.transactionId })
  const next = await fs.readFile(path.join(root, 'service.js'), 'utf8')
  assert.match(next, /:new/)
})

test('built-in JS/TS fallback inserts around symbols exposed by the tool schema', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'module.js'), `export function target() {
  return 1
}
`)
  const ws = await createWorkspace({ root })
  const resolved = await ws.resolveTarget({
    path: 'module.js',
    target: { symbol: { kind: 'function', name: 'target' } },
  })
  assert.equal(resolved.status, 'resolved')

  const tx = await ws.prepareEdit({
    operations: [{
      targetId: resolved.target.targetId,
      operation: {
        type: 'insert_around_symbol',
        position: 'before',
        text: '// before target\n',
      },
    }],
  })
  await ws.applyEdit({ transactionId: tx.transactionId })

  const next = await fs.readFile(path.join(root, 'module.js'), 'utf8')
  assert.match(next, /^\/\/ before target\nexport function target/)
})

test('tree-sitter provider plugin can own symbol resolution via standard adapter contract', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'module.ts'), `export function target() {
  return 1
}
`)
  const provider = {
    id: 'fixture',
    listSymbols({ content }) {
      const start = content.indexOf('export function target')
      return [{ kind: 'function', name: 'target', startOffset: start, endOffset: content.length }]
    }
  }
  const ws = await createWorkspace({ root, plugins: [treeSitterPlugin({ provider })] })
  const resolved = await ws.resolveTarget({ path: 'module.ts', target: { symbol: { kind: 'function', name: 'target' } } })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.target.adapterId, 'treesitter.fixture')
})

test('prepare-then-apply batch detects prepared transaction conflicts', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha beta gamma')
  const ws = await createWorkspace({ root })
  const target = await ws.resolveTarget({ path: 'a.txt', target: { exactSnippet: 'beta' } })
  assert.equal(target.status, 'resolved')
  const batch = await ws.runBatch({
    mode: 'prepare-then-apply',
    conflictCheck: true,
    tasks: [
      { id: 'prep-1', op: { kind: 'prepare', input: { operations: [{ targetId: target.target.targetId, operation: { type: 'replace_text', oldText: 'beta', newText: 'BETA' } }] } } },
      { id: 'prep-2', op: { kind: 'prepare', input: { operations: [{ targetId: target.target.targetId, operation: { type: 'replace_text', oldText: 'beta', newText: 'Beta' } }] } } },
    ],
  })
  assert.equal(batch.ok, false)
  assert.ok(batch.conflicts?.length >= 1)
})

test('Velaros bridge maps runtime providers and auto-registers agent tools', async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, 'a.txt'), 'hello')
  const registered = []
  const bridge = await createVelarosWorkspaceBridge({
    root,
    autoRegisterTools: true,
    velaros: {
      tools: { registerMany(tools) { registered.push(...tools) } },
      policy: { decide() { return { allow: true } } },
    }
  })
  assert.ok(registered.some((tool) => tool.name === 'ws_read'))
  const read = await bridge.workspace.read({ path: 'a.txt' })
  assert.equal(read.content, 'hello')
  assert.equal(bridge.asModule().name, 'workspace')
})
