import { type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import { nodeExecutable } from '@velaros-ai/script'

import { ExternalLanguageServerClient } from '../impl/language/ExternalLanguageServerClient'
import { createExternalLanguageService } from '../index'

const roots: string[] = []

/** 真实 Node stdio 往返：初始化可由文件屏障暂停，只发一轮诊断，hover 可保持在飞直至 stop。 */
async function fixture(
  holdHover = false,
  mode: 'normal' | 'tail' | 'response-tail' | 'stubborn' = 'normal',
  pauseInitialize = false
) {
  const executable = nodeExecutable.resolve()
  if (!executable) throw new AppError('UNAVAILABLE', 'stdio 生命周期 fixture 需要真实 Node。')
  const root = await mkdtemp(join(tmpdir(), 'velaros-project-lsp-lifecycle-'))
  roots.push(root)
  await writeFile(join(root, 'sample.foo'), 'example')
  const script = join(root, 'server.mjs')
  const tailProgram = `
const { existsSync, writeFileSync } = require('node:fs')
const deadline = setTimeout(() => {
  writeFileSync(2, 'tail deadline: exit-seen was not released\\n')
  process.exit(2)
}, 2000)
const poll = setInterval(() => {
  if (!existsSync('exit-seen')) return
  clearInterval(poll)
  clearTimeout(deadline)
  ${
    mode === 'response-tail'
      ? `const body = JSON.stringify({ jsonrpc: '2.0', id: __RESPONSE_ID__, result: { contents: 'after exit' } })
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
  process.stderr.write('last response stderr\\n')`
      : `process.stdout.write('last stdout\\n')
  process.stderr.write('last stderr\\n')`
  }
}, 10)
writeFileSync('tail-ready', String(process.pid))
`
  await writeFile(
    script,
    `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
appendFileSync('starts', 'started\\n')
if (${JSON.stringify(mode)} === 'stubborn') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
let buffer = Buffer.alloc(0)
let initialized = false
let published = false
function send(value) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value })
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
function exitAfterTailReady(program) {
  const tail = spawn(process.execPath, ['-e', program], {
    detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit']
  })
  tail.unref()
  tail.once('error', error => {
    writeFileSync(2, 'tail spawn failed: ' + error.stack + '\\n')
    process.exit(1)
  })
  const deadline = setTimeout(() => {
    writeFileSync(2, 'tail startup deadline: tail-ready was not published\\n')
    process.exit(1)
  }, 2000)
  const poll = setInterval(() => {
    if (!existsSync('tail-ready')) return
    clearInterval(poll)
    clearTimeout(deadline)
    process.exit(0)
  }, 10)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n')
    if (end < 0) return
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === 'initialize') {
      writeFileSync('initializing', '')
      if (${pauseInitialize} && !existsSync('initialize-released')) continue
      setTimeout(() => send({ id: message.id, result: { capabilities: {} } }), 100)
    } else if (message.method === 'initialized') initialized = true
    else if (message.method === 'textDocument/didOpen' && !published) {
      published = true
      writeFileSync('opened.json', JSON.stringify(message.params.textDocument.text))
      setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: {
        uri: message.params.textDocument.uri, diagnostics: []
      } }), 100)
    } else if (message.method === 'textDocument/hover') {
      writeFileSync('hovering', '')
      if (${JSON.stringify(mode)} === 'response-tail') {
        exitAfterTailReady(${JSON.stringify(tailProgram)}.replace('__RESPONSE_ID__', String(message.id)))
        return
      }
      if (!${holdHover}) send({ id: message.id, result: { contents: initialized ? 'ready' : 'too early' } })
    } else if (message.method === 'shutdown') {
      writeFileSync('shutdown', '')
      if (${JSON.stringify(mode)} !== 'stubborn') send({ id: message.id, result: null })
    } else if (message.method === 'exit') {
      if (${JSON.stringify(mode)} === 'tail') {
        exitAfterTailReady(${JSON.stringify(tailProgram)})
        return
      }
      process.exit(0)
    }
  }
})
`
  )
  return {
    root,
    spec: {
      id: 'fixture',
      command: executable,
      args: [script],
      extensions: ['.foo'],
      languageId: 'foo',
    },
  }
}

/** 尾流语义整体交给真实 Node，并由真实孙进程持有输出管道跨过服务进程退出。 */
async function runTailFixtureInNode(mode: 'tail' | 'response-tail'): Promise<void> {
  const { root, spec } = await fixture(false, mode)
  const clientModule = new URL(
    '../../dist/project/impl/language/ExternalLanguageServerClient.js',
    import.meta.url
  )
  const runner = join(root, 'runner.mjs')
  await writeFile(
    runner,
    `
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExternalLanguageServerClient } from ${JSON.stringify(clientModule.href)}
const root = ${JSON.stringify(root)}
const mode = ${JSON.stringify(mode)}
const client = new ExternalLanguageServerClient(root, ${JSON.stringify(spec)})
try {
  await client.start()
  const child = Reflect.get(client, 'child')
  let exited = false
  let closed = false
  let stdout = ''
  let stderr = ''
  const output = () => 'stdout=' + JSON.stringify(stdout) + '; stderr=' + JSON.stringify(stderr)
  const exitedEvent = new Promise(resolveExited => {
    child.once('exit', () => { exited = true; resolveExited() })
  })
  child.once('close', () => { closed = true })
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  if (mode === 'tail') {
    const stopping = client.stop()
    void stopping.catch(() => {})
    await exitedEvent
    assert.equal(exited, true)
    assert.equal(closed, false, 'exit 时继承的真实输出管道仍应打开；' + output())
    await writeFile(join(root, 'exit-seen'), '')
    await stopping
    assert.ok(stdout.includes('last stdout\\n'), output())
    assert.ok(stderr.includes('last stderr\\n'), output())
  } else {
    const response = client.hover(join(root, 'sample.foo'), 1, 1).then(
      value => ({ value }), error => ({ error })
    )
    await exitedEvent
    assert.equal(exited, true)
    assert.equal(closed, false, '尾回执发出前真实输出管道仍应打开；' + output())
    const refusal = await client.hover(join(root, 'sample.foo'), 1, 1).then(
      () => null, error => error
    )
    assert.equal(refusal?.code, 'CLOSED', output())
    await writeFile(join(root, 'exit-seen'), '')
    const outcome = await response
    assert.equal(outcome.error, undefined, output())
    assert.equal(outcome.value?.display, 'after exit', output())
    await client.stop()
    assert.ok(stderr.includes('last response stderr\\n'), output())
  }
  assert.equal(closed, true, output())
  assert.equal(Reflect.get(client, 'child'), null, output())
} finally {
  await writeFile(join(root, 'exit-seen'), '')
  await client.stop()
}
`
  )
  const result = spawnSync(spec.command, [runner], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`).toBe(0)
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`fixture 没有到达预期阶段：${path}`)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ExternalLanguageService', () => {
  test('并发首次查询共用一个完成握手的进程', async () => {
    const { root, spec } = await fixture()
    const service = createExternalLanguageService(root, [spec])
    try {
      const values = await Promise.all([
        service.hover('sample.foo', 1, 1),
        service.hover('sample.foo', 1, 1),
      ])
      expect(values.map((value) => value?.display)).toEqual(['ready', 'ready'])
      expect(await readFile(join(root, 'starts'), 'utf8')).toBe('started\n')
    } finally {
      await service.stop()
    }
  })

  test('同一文件的多个诊断等待者都由一轮通知收尾', async () => {
    const { root, spec } = await fixture()
    const client = new ExternalLanguageServerClient(root, spec)
    try {
      await client.start()
      const outcomes = await Promise.all([
        client.diagnostics(join(root, 'sample.foo')),
        client.diagnostics(join(root, 'sample.foo')),
      ])
      expect(outcomes).toEqual([
        { diagnostics: [], timedOut: false },
        { diagnostics: [], timedOut: false },
      ])
    } finally {
      await client.stop()
    }
  })

  test('外部服务接收解码后的 UTF-16 原文', async () => {
    const { root, spec } = await fixture()
    const text = 'const 中文 = "🙂"\n'
    await writeFile(
      join(root, 'sample.foo'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    )
    const service = createExternalLanguageService(root, [spec])
    try {
      await service.hover('sample.foo', 1, 1)
      expect(JSON.parse(await readFile(join(root, 'opened.json'), 'utf8'))).toBe(text)
    } finally {
      await service.stop()
    }
  })

  test('stop 也回收仍在初始化的进程', async () => {
    const { root, spec } = await fixture(false, 'normal', true)
    const service = createExternalLanguageService(root, [spec])
    const pending = service.hover('sample.foo', 1, 1)
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    try {
      await waitForFile(join(root, 'initializing'))
      await service.stop()
      expect(await failure).toMatchObject({ code: 'CLOSED' })
      expect(service.status()).toMatchObject({ state: 'idle', openFiles: 0 })
    } finally {
      await service.stop()
    }
  })

  test('stop 等到进程退出后继承的 stdout/stderr 都排空并真实 close', async () => {
    await runTailFixtureInNode('tail')
  })

  test('exit 后 close 前的真实回执仍兑现，在排空期间拒绝新请求', async () => {
    await runTailFixtureInNode('response-tail')
  })

  test('不合作的 shutdown 经过终止升级后也等待真实 close', async () => {
    const { root, spec } = await fixture(false, 'stubborn')
    const client = new ExternalLanguageServerClient(root, spec)
    try {
      await client.start()
      const child = Reflect.get(client, 'child') as ChildProcessWithoutNullStreams
      let closed = false
      child.once('close', () => {
        closed = true
      })
      await client.stop()
      expect(closed).toBe(true)
      expect(await Bun.file(join(root, 'shutdown')).exists()).toBe(true)
      if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
      expect(Reflect.get(client, 'child')).toBeNull()
    } finally {
      await client.stop()
    }
  }, 10_000)

  test('stop 排空在飞请求，重复 stop 共用清理', async () => {
    const { root, spec } = await fixture(true)
    const service = createExternalLanguageService(root, [spec])
    const pending = service.hover('sample.foo', 1, 1)
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    try {
      await waitForFile(join(root, 'hovering'))
      await Promise.all([service.stop(), service.stop()])
      expect(await failure).toMatchObject({ code: 'CLOSED' })
      expect(service.status()).toMatchObject({ state: 'idle', openFiles: 0 })
    } finally {
      await service.stop()
    }
  })

  test('取消启动不把规格永久标成 unavailable', async () => {
    const { root, spec } = await fixture(false, 'normal', true)
    const service = createExternalLanguageService(root, [spec])
    const controller = new AbortController()
    const pending = service.hover('sample.foo', 1, 1, controller.signal)
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    )
    try {
      await waitForFile(join(root, 'initializing'))
      controller.abort()
      expect(await failure).toMatchObject({ name: 'AbortError' })
      await writeFile(join(root, 'initialize-released'), '')
      expect((await service.hover('sample.foo', 1, 1))?.display).toBe('ready')
    } finally {
      await service.stop()
    }
  })

  test('清理失败保留客户端的 error，重试成功才回到 idle', async () => {
    const { root, spec } = await fixture()
    const service = createExternalLanguageService(root, [spec])
    const client = new ExternalLanguageServerClient(root, spec)
    const stop = client.stop.bind(client)
    const cleanupError = new AppError('UNAVAILABLE', '进程或输出管道尚未关闭，清理未完成。')
    client.status = () => ({
      state: 'error',
      server: spec.id,
      openFiles: 1,
      error: cleanupError.message,
      diagnosticsTimedOutFiles: 0,
      diagnosticsComplete: true,
    })
    client.stop = async () => {
      throw cleanupError
    }
    const clients = Reflect.get(service, 'clients') as Map<string, ExternalLanguageServerClient>
    clients.set(spec.id, client)
    try {
      await expect(service.stop()).rejects.toBe(cleanupError)
      expect(service.status()).toMatchObject({
        state: 'error',
        error: cleanupError.message,
        openFiles: 1,
      })
      expect(clients.get(spec.id)).toBe(client)
    } finally {
      client.stop = stop
      await service.stop()
    }
    expect(service.status()).toMatchObject({ state: 'idle', error: null, openFiles: 0 })
  })

  test('keeps stdio LSP discovery bounded to the injected project and specs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-development-lsp-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'velaros-development-lsp-outside-'))
    roots.push(root, outsideRoot)
    await writeFile(join(root, 'sample.foo'), 'example')
    const outsideFile = join(outsideRoot, 'outside.foo')
    await writeFile(outsideFile, 'outside')
    const service = createExternalLanguageService(root, [
      {
        id: 'missing-test-server',
        command: 'velaros-definitely-missing-language-server',
        args: [],
        extensions: ['.foo'],
        languageId: 'foo',
      },
    ])
    expect(service.supports('sample.foo')).toBe(true)
    expect(await service.diagnostics(['sample.foo'])).toEqual([])
    expect(service.status()).toMatchObject({
      state: 'unavailable',
      server: 'external',
      // 语言服务根本没启动起来，不算「等到超时」：结果仍然是完整的（就是没有诊断能力）。
      diagnosticsComplete: true,
      diagnosticsTimedOutFiles: 0,
    })
    await expect(service.hover(outsideFile, 1, 1)).rejects.toThrow('越出了项目边界')
    await service.stop()
  })
})
