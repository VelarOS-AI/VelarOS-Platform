// 用途：经公开 computer 入口验收扩展操作、生成合同和原生共享 helper 的失败边界，路径镜像能力单元。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { computerOperations, createComputerRuntime } from '@velaros-ai/velaros/computer'
import { VelarComputerModule } from '@velaros-ai/velaros/computer/contracts'

const point = { x: 10, y: 20, snapshotId: 'screen_fixture_01', coordinateSpace: 'primary-display' }
const operations = [
  ['scroll', { at: point, deltaY: 2 }, 'scroll'],
  ['drag', { from: point, to: point }, 'drag'],
  ['mouseDown', { at: point }, 'mouse_down'],
  ['mouseUp', {}, 'mouse_up'],
  ['keyDown', { key: 'ctrl' }, 'key_down'],
  ['keyUp', { key: 'ctrl' }, 'key_up'],
  ['uiTree', { windowId: 'window_fixture' }, 'ui_tree'],
  ['invokeElement', { treeId: 'tree_fixture', elementId: 'element_1' }, 'invoke_element'],
  [
    'setElementValue',
    { treeId: 'tree_fixture', elementId: 'element_1', value: '中文+{}' },
    'set_element_value',
  ],
]

function desk(responses = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const requests = []
  child.stdin = Object.assign(new EventEmitter(), {
    write(line) {
      const request = JSON.parse(line)
      requests.push(request)
      const result =
        responses[request.command] ??
        (request.command === 'check'
          ? { platform: 'fixture', accessibility: true, screenRecording: true }
          : { command: request.command })
      queueMicrotask(() =>
        child.stdout.emit('data', JSON.stringify({ id: request.id, ok: true, result }) + '\n')
      )
    },
    end() {
      queueMicrotask(() => child.emit('exit', 0))
    },
  })
  child.kill = () => true
  const runtime = createComputerRuntime({
    resolveHelper: () => ({}),
    spawnProcess: () => {
      queueMicrotask(() =>
        child.stdout.emit('data', '{"id":0,"ok":true,"result":{"ready":true}}\n')
      )
      return child
    },
  })
  return {
    runtime,
    requests,
    context: { abortSignal: new AbortController().signal, computer: runtime },
  }
}

test('generated surface declares and authorizes every new operation; real port dispatch preserves input', async () => {
  for (const [name, input, command] of operations) {
    assert.ok(VelarComputerModule.methods.includes(name))
    assert.equal(VelarComputerModule.operations[name].effects, name === 'uiTree' ? 'none' : 'write')
    const desktop = desk()
    try {
      assert.deepEqual(await computerOperations[name](input, desktop.context), { command })
      assert.equal(desktop.requests.at(-1).command, command)
      for (const [key, value] of Object.entries(input))
        assert.deepEqual(desktop.requests.at(-1).payload[key], value)
    } finally {
      desktop.runtime.dispose()
    }
  }
})

test('invalid extended inputs and already-cancelled calls never start the helper', async () => {
  const desktop = desk()
  try {
    const invalid = [
      ['scroll', { at: point, deltaY: 101 }],
      ['scroll', { at: point }],
      ['drag', { from: point, to: { x: 0, y: 0 }, durationMs: 100 }],
      ['drag', { from: point, to: point, durationMs: 3001 }],
      ['mouseDown', { at: point, button: 'back' }],
      ['keyDown', { key: 'ctrl+a' }],
      ['uiTree', { windowId: 'window_fixture', maxNodes: 501 }],
      ['record', { path: 'relative.mp4', durationMs: 500 }],
      [
        'record',
        { path: fileURLToPath(new URL('./video.mp4', import.meta.url)), durationMs: 5001 },
      ],
      ['invokeElement', { treeId: 'tree fixture', elementId: 'element_1' }],
    ]
    for (const [name, input] of invalid)
      await assert.rejects(computerOperations[name](input, desktop.context), { code: 'VALIDATION' })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      computerOperations.drag(
        { from: point, to: point },
        { ...desktop.context, abortSignal: controller.signal }
      )
    )
    assert.equal(desktop.requests.length, 0)
  } finally {
    desktop.runtime.dispose()
  }
})

test('window screenshot pixels use the image channel and never leak into metadata', async () => {
  const desktop = desk({
    screenshot_window: {
      base64: 'cGl4ZWxz',
      format: 'jpeg',
      windowId: 'window_fixture',
      snapshotId: 'screen_window_fixture',
      width: 40,
      height: 30,
    },
  })
  const images = []
  try {
    const result = await computerOperations.screenshotWindow(
      { windowId: 'window_fixture' },
      { ...desktop.context, attachImage: (image) => images.push(image) }
    )
    assert.equal(result.snapshotId, 'screen_window_fixture')
    assert.equal(result.base64, undefined)
    assert.equal(images[0].data, 'cGl4ZWxz')
    assert.equal(images[0].mediaType, 'image/jpeg')
  } finally {
    desktop.runtime.dispose()
  }
})

test('disposing during startup settles the caller before a handshake arrives', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} })
  child.kill = () => true
  const runtime = createComputerRuntime({ resolveHelper: () => ({}), spawnProcess: () => child })
  const pending = assert.rejects(runtime.screenSize(), { code: 'COMPUTER_SIDECAR_DISPOSED' })
  await new Promise((resolve) => setImmediate(resolve))
  runtime.dispose()
  await pending
  child.stdout.emit('data', '{"id":0,"ok":true,"result":{"ready":true}}\n')
  assert.equal(runtime.isReady(), false)
})

test('a hung native request is retired and late old-process events cannot tear down its replacement', async () => {
  const children = []
  const written = []
  const runtime = createComputerRuntime({
    resolveHelper: () => ({}),
    requestTimeoutMs: 30,
    spawnProcess: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const ordinal = children.length
      child.stdin = Object.assign(new EventEmitter(), {
        write(line) {
          const request = JSON.parse(line)
          written.push(request.command)
          if (ordinal > 0)
            queueMicrotask(() =>
              child.stdout.emit(
                'data',
                JSON.stringify({ id: request.id, ok: true, result: { width: 100 } }) + '\n'
              )
            )
        },
        end() {
          if (ordinal > 0) queueMicrotask(() => child.emit('exit', 0))
        },
      })
      child.kill = () => true
      children.push(child)
      queueMicrotask(() =>
        child.stdout.emit('data', '{"id":0,"ok":true,"result":{"ready":true}}\n')
      )
      return child
    },
  })
  try {
    const pending = assert.rejects(runtime.screenSize(), { code: 'TIMEOUT' })
    const queued = assert.rejects(runtime.click(10, 20, { coordinateSpace: 'global' }), {
      code: 'COMPUTER_SIDECAR_EXITED',
    })
    const controller = new AbortController()
    const cancelled = assert.rejects(runtime.typeText('must not type', controller.signal), {
      name: 'AbortError',
    })
    controller.abort()
    await pending
    await queued
    await cancelled
    assert.deepEqual(written, ['screen_size'])
    assert.equal(runtime.isReady(), false)
    assert.deepEqual(await runtime.screenSize(), { width: 100 })
    children[0].emit('exit', 1)
    assert.equal(runtime.isReady(), true)
    assert.deepEqual(await runtime.screenSize(), { width: 100 })
  } finally {
    runtime.dispose()
  }
})

test('native helper behavior is exercised without controlling the user desktop', () => {
  const python = process.env.VELAROS_COMPUTER_TEST_PYTHON || 'python'
  const result = spawnSync(
    python,
    [fileURLToPath(new URL('./extended_helpers.py', import.meta.url)), '-v'],
    {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
})
