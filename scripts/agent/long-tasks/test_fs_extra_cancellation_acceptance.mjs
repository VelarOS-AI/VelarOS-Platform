import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import * as native from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(process.cwd())
const require = createRequire(join(root, 'package.json'))
const graceful = require('graceful-fs')
const source = join(root, 'lib') + sep
const methods = [
  'copy',
  'move',
  'remove',
  'emptyDir',
  'ensureFile',
  'ensureLink',
  'ensureSymlink',
  'ensureDir',
  'outputFile',
  'readJson',
  'writeJson',
  'outputJson',
]

function load() {
  for (const key of Object.keys(require.cache))
    if (key.startsWith(source)) delete require.cache[key]
  return require(join(root, 'lib/index.js'))
}

async function fixture(fn) {
  const dir = await native.mkdtemp(join(tmpdir(), 'fs-extra-cancellation-'))
  await native.mkdir(join(dir, 'input/sub'), { recursive: true })
  await native.writeFile(join(dir, 'input/a.txt'), 'alpha\n')
  await native.writeFile(join(dir, 'input/sub/b.txt'), 'βeta\n')
  await native.writeFile(join(dir, 'data.json'), '{"value":7}\n')
  try {
    return await fn(dir)
  } finally {
    await native.rm(dir, { recursive: true, force: true })
  }
}

function argumentsFor(name, dir, options) {
  const input = join(dir, 'input')
  const out = join(dir, 'output')
  switch (name) {
    case 'copy':
    case 'move':
      return [input, join(out, 'tree'), options]
    case 'remove':
    case 'emptyDir':
      return [input, options]
    case 'ensureFile':
      return [join(out, 'file'), options]
    case 'ensureLink':
    case 'ensureSymlink':
      return [join(input, 'a.txt'), join(out, 'link'), options]
    case 'ensureDir':
      return [join(out, 'directory'), options]
    case 'outputFile':
      return [join(out, 'file'), 'payload\n', options]
    case 'readJson':
      return [join(dir, 'data.json'), options]
    case 'writeJson':
      return [join(dir, 'data.json'), { value: 8 }, options]
    case 'outputJson':
      return [join(out, 'data.json'), { value: 8 }, options]
    default:
      throw new Error(`Unexpected operation: ${name}`)
  }
}

async function snapshot(dir) {
  const result = []
  async function visit(relative) {
    for (const name of (await native.readdir(join(dir, relative))).sort()) {
      const rel = join(relative, name)
      const stat = await native.lstat(join(dir, rel))
      if (stat.isDirectory()) {
        result.push([rel, 'directory'])
        await visit(rel)
      } else if (stat.isSymbolicLink())
        result.push([rel, 'link', await native.readlink(join(dir, rel))])
      else result.push([rel, 'file', (await native.readFile(join(dir, rel))).toString('base64')])
    }
  }
  await visit('')
  return result
}

async function failure(promise) {
  assert.equal(typeof promise?.then, 'function', 'Promise form must return a promise')
  const result = await promise.then(
    (value) => ({ fulfilled: true, value }),
    (error) => ({ error })
  )
  assert.equal(
    result.fulfilled,
    undefined,
    'pre-aborted operation must reject with the original reason'
  )
  return result.error
}

async function callbackCall(api, name, args) {
  let synchronous = true
  const calls = []
  let timer
  const settled = new Promise((resolveResult, rejectResult) => {
    timer = setTimeout(() => rejectResult(new Error('callback was not called')), 3000)
    api[name](...args, (error, value) => {
      calls.push({ error, value, synchronous })
      resolveResult()
    })
    synchronous = false
  })
  try {
    await settled
    await nextTurn()
  } finally {
    clearTimeout(timer)
  }
  assert.equal(calls.length, 1, 'callback must run once')
  assert.equal(calls[0].synchronous, false, 'callback errors must be asynchronous')
  return calls[0]
}

function cancelled(reason = { cancelled: 'this operation' }) {
  const controller = new AbortController()
  controller.abort(reason)
  return { signal: controller.signal, reason }
}

async function patches(replacements, fn) {
  const originals = {}
  for (const [name, replace] of Object.entries(replacements)) {
    originals[name] = graceful[name]
    graceful[name] = replace(originals[name])
  }
  try {
    return await fn(load())
  } finally {
    for (const [name, value] of Object.entries(originals)) graceful[name] = value
    load()
  }
}

for (const name of methods) {
  for (const form of ['promise', 'callback']) {
    test(
      `${name}: pre-abort preserves reason and has no side effects (${form})`,
      { timeout: 6000 },
      async () =>
        fixture(async (dir) => {
          const api = load()
          const { signal, reason } = cancelled()
          const before = await snapshot(dir)
          const args = argumentsFor(name, dir, { signal })
          const error =
            form === 'promise'
              ? await failure(api[name](...args))
              : (await callbackCall(api, name, args)).error
          assert.equal(error, reason, 'pre-aborted operation must reject with the original reason')
          assert.deepEqual(await snapshot(dir), before, 'pre-abort must not mutate the tree')
        })
    )
  }

  test(`${name}: invalid signals reject asynchronously`, { timeout: 6000 }, async () =>
    fixture(async (dir) => {
      const api = load()
      for (const signal of [
        null,
        false,
        1,
        'abort',
        {},
        { aborted: true },
        { aborted: false, addEventListener() {} },
      ]) {
        const args = argumentsFor(name, dir, { signal })
        const error = await failure(api[name](...args))
        assert(error instanceof TypeError)
        assert.match(error.message, /signal/i)
        const called = await callbackCall(api, name, args)
        assert(called.error instanceof TypeError)
        assert.match(called.error.message, /signal/i)
      }
    })
  )

  test(
    `${name}: live signals preserve success and leave no listeners`,
    { timeout: 6000 },
    async () => {
      const api = load()
      for (const form of ['promise', 'callback'])
        await fixture(async (dir) => {
          const controller = new AbortController()
          const signal = controller.signal
          const args = argumentsFor(name, dir, { signal })
          if (form === 'promise') await api[name](...args)
          else assert.equal((await callbackCall(api, name, args)).error, null)
          await nextTurn()
          assert.equal(
            getEventListeners(signal, 'abort').length,
            0,
            'settled operation must release listeners'
          )
          if (name === 'readJson')
            assert.deepEqual(await api.readJson(join(dir, 'data.json')), { value: 7 })
          if (name === 'copy')
            assert.equal(
              await native.readFile(join(dir, 'output/tree/sub/b.txt'), 'utf8'),
              'βeta\n'
            )
          if (name === 'move') {
            assert.equal(await native.readFile(join(dir, 'output/tree/a.txt'), 'utf8'), 'alpha\n')
            await assert.rejects(native.stat(join(dir, 'input')), { code: 'ENOENT' })
          }
          if (name === 'emptyDir') assert.deepEqual(await native.readdir(join(dir, 'input')), [])
        })
    }
  )
}

const aliases = {
  emptydir: 'emptyDir',
  createFile: 'ensureFile',
  createLink: 'ensureLink',
  createSymlink: 'ensureSymlink',
  mkdirs: 'ensureDir',
  mkdirp: 'ensureDir',
  readJSON: 'readJson',
  writeJSON: 'writeJson',
  outputJSON: 'outputJson',
}

for (const entry of ['commonjs', 'esm-named', 'esm-default']) {
  test(`${entry}: all aliases and operations expose cancellation`, { timeout: 10000 }, async () =>
    fixture(async (dir) => {
      const module =
        entry === 'commonjs' ? load() : await import(pathToFileURL(join(root, 'lib/esm.mjs')).href)
      const api = entry === 'esm-default' ? module.default : module
      const { signal, reason } = cancelled('abort through public entry')
      for (const name of [...methods, ...Object.keys(aliases)]) {
        assert.equal(
          await failure(api[name](...argumentsFor(aliases[name] ?? name, dir, { signal }))),
          reason
        )
      }
    })
  )
}

test('legacy signals without reason produce AbortError/ABORT_ERR', async () =>
  fixture(async (dir) => {
    const api = load()
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} }
    for (const name of methods) {
      const error = await failure(api[name](...argumentsFor(name, dir, { signal })))
      assert(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      assert.equal(error.code, 'ABORT_ERR')
    }
  }))

test('arbitrary cancellation reasons preserve identity', async () =>
  fixture(async (dir) => {
    const api = load()
    for (const reason of [
      null,
      false,
      0,
      'stop',
      { code: 'user' },
      new Error('user cancellation'),
    ]) {
      const { signal } = cancelled(reason)
      for (const name of methods)
        assert.equal(await failure(api[name](...argumentsFor(name, dir, { signal }))), reason)
    }
  }))

test('pre-abort precedes filesystem access and user filters', async () =>
  fixture(async (dir) => {
    const { signal, reason } = cancelled()
    let io = 0
    let filters = 0
    const names = [
      'stat',
      'lstat',
      'access',
      'mkdir',
      'readFile',
      'writeFile',
      'readdir',
      'opendir',
      'rm',
      'rename',
      'link',
      'symlink',
    ]
    await patches(
      Object.fromEntries(
        names.map((name) => [
          name,
          (original) =>
            function (...args) {
              io++
              return original.apply(this, args)
            },
        ])
      ),
      async (api) => {
        for (const name of methods) {
          const args = argumentsFor(name, dir, {
            signal,
            filter() {
              filters++
              return true
            },
          })
          assert.equal(await failure(api[name](...args)), reason)
        }
      }
    )
    assert.equal(io, 0, 'pre-abort must precede all filesystem calls')
    assert.equal(filters, 0)
  }))

test('JSON pre-abort precedes toJSON and replacer', async () =>
  fixture(async (dir) => {
    const api = load()
    const { signal, reason } = cancelled()
    let calls = 0
    const value = {
      toJSON() {
        calls++
        return { value: 9 }
      },
    }
    for (const name of ['writeJson', 'writeJSON', 'outputJson', 'outputJSON']) {
      assert.equal(
        await failure(
          api[name](join(dir, 'data.json'), value, {
            signal,
            replacer(key, value) {
              calls++
              return value
            },
          })
        ),
        reason
      )
    }
    assert.equal(calls, 0)
  }))

test('copy checks cancellation after an awaited root filter', { timeout: 6000 }, async () =>
  fixture(async (dir) => {
    const api = load()
    const controller = new AbortController()
    const reason = { stage: 'root-filter' }
    const before = await snapshot(dir)
    const error = await failure(
      api.copy(join(dir, 'input'), join(dir, 'output/tree'), {
        signal: controller.signal,
        async filter() {
          await nextTurn()
          controller.abort(reason)
          return true
        },
      })
    )
    assert.equal(error, reason)
    assert.deepEqual(await snapshot(dir), before)
  })
)

test(
  'copy checks cancellation inside recursive asynchronous filters',
  { timeout: 6000 },
  async () =>
    fixture(async (dir) => {
      const controller = new AbortController()
      const reason = { stage: 'child-filter' }
      let writes = 0
      await patches(
        {
          copyFile: (original) =>
            function (...args) {
              writes++
              return original.apply(this, args)
            },
        },
        async (hooked) => {
          assert.equal(
            await failure(
              hooked.copy(join(dir, 'input'), join(dir, 'output/tree'), {
                signal: controller.signal,
                async filter(path) {
                  if (path !== join(dir, 'input')) {
                    await nextTurn()
                    controller.abort(reason)
                  }
                  return true
                },
              })
            ),
            reason
          )
        }
      )
      assert.equal(writes, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    })
)

test(
  'copy cancellation waits for started I/O and leaves no late mutation',
  { timeout: 8000 },
  async () =>
    fixture(async (dir) => {
      const controller = new AbortController()
      const reason = { stage: 'copy-in-flight' }
      let entered
      const started = new Promise((resolve) => {
        entered = resolve
      })
      let release
      let completed = 0
      let calls = 0
      await patches(
        {
          copyFile: (original) =>
            function (...args) {
              calls++
              const callback = args.pop()
              const invoke = () =>
                original.call(this, ...args, (...result) => {
                  completed++
                  callback(...result)
                })
              if (!release) {
                release = invoke
                entered()
              } else invoke()
            },
        },
        async (api) => {
          let settled = false
          const outcome = api
            .copy(join(dir, 'input'), join(dir, 'output/tree'), { signal: controller.signal })
            .then(
              (value) => ({ value }),
              (error) => ({ error })
            )
            .finally(() => {
              settled = true
            })
          await started
          controller.abort(reason)
          await nextTurn()
          await nextTurn()
          const early = settled
          release()
          const result = await outcome
          assert.equal(early, false, 'must await in-flight I/O before settling')
          assert.equal(result.error, reason)
          assert.equal(completed, calls)
          const state = await snapshot(dir)
          await nextTurn()
          await nextTurn()
          assert.deepEqual(await snapshot(dir), state)
        }
      )
    })
)

test(
  'independent concurrent operations retain their own cancellation',
  { timeout: 6000 },
  async () =>
    fixture(async (dir) => {
      const api = load()
      const stopped = new AbortController()
      const live = new AbortController()
      const reason = { stage: 'one-copy-only' }
      const results = await Promise.allSettled([
        api.copy(join(dir, 'input'), join(dir, 'cancelled'), {
          signal: stopped.signal,
          async filter() {
            await nextTurn()
            stopped.abort(reason)
            return true
          },
        }),
        api.copy(join(dir, 'input'), join(dir, 'completed'), { signal: live.signal }),
      ])
      assert.equal(results[0].status, 'rejected')
      assert.equal(results[0].reason, reason)
      assert.equal(results[1].status, 'fulfilled')
      assert.equal(await native.readFile(join(dir, 'completed/sub/b.txt'), 'utf8'), 'βeta\n')
    })
)

test('emptyDir checks after readdir before starting removals', { timeout: 6000 }, async () =>
  fixture(async (dir) => {
    const controller = new AbortController()
    const reason = { stage: 'readdir' }
    const before = await snapshot(dir)
    await patches(
      {
        readdir: (original) =>
          function (...args) {
            const callback = args.pop()
            return original.call(this, ...args, (...result) => {
              controller.abort(reason)
              callback(...result)
            })
          },
      },
      async (api) => {
        assert.equal(
          await failure(api.emptyDir(join(dir, 'input'), { signal: controller.signal })),
          reason
        )
      }
    )
    assert.deepEqual(await snapshot(dir), before)
  })
)

test('emptyDir waits for a native removal already submitted', { timeout: 8000 }, async () =>
  fixture(async (dir) => {
    const controller = new AbortController()
    const reason = { stage: 'remove-in-flight' }
    let entered
    const started = new Promise((resolve) => {
      entered = resolve
    })
    let release
    let completed = 0
    let calls = 0
    await patches(
      {
        rm: (original) =>
          function (...args) {
            calls++
            const callback = args.pop()
            const invoke = () =>
              original.call(this, ...args, (...result) => {
                completed++
                callback(...result)
              })
            if (!release) {
              release = invoke
              entered()
            } else invoke()
          },
      },
      async (api) => {
        let settled = false
        const outcome = api
          .emptyDir(join(dir, 'input'), { signal: controller.signal })
          .then(
            (value) => ({ value }),
            (error) => ({ error })
          )
          .finally(() => {
            settled = true
          })
        await started
        controller.abort(reason)
        await nextTurn()
        await nextTurn()
        const early = settled
        release()
        const result = await outcome
        assert.equal(early, false)
        assert.equal(result.error, reason)
        assert.equal(completed, calls)
        assert((await native.stat(join(dir, 'input'))).isDirectory())
      }
    )
  })
)

test('move cancellation during EXDEV copy preserves the source', { timeout: 6000 }, async () =>
  fixture(async (dir) => {
    const controller = new AbortController()
    const reason = { stage: 'exdev-copy' }
    let renamed = 0
    await patches(
      {
        rename: () =>
          function (...args) {
            renamed++
            queueMicrotask(() =>
              args.at(-1)(Object.assign(new Error('cross device'), { code: 'EXDEV' }))
            )
          },
        copyFile: (original) =>
          function (...args) {
            const callback = args.pop()
            return original.call(this, ...args, (...result) => {
              controller.abort(reason)
              callback(...result)
            })
          },
      },
      async (api) => {
        assert.equal(
          await failure(
            api.move(join(dir, 'input'), join(dir, 'output/tree'), { signal: controller.signal })
          ),
          reason
        )
      }
    )
    assert.equal(renamed, 1)
    assert.equal(await native.readFile(join(dir, 'input/a.txt'), 'utf8'), 'alpha\n')
    assert.equal(await native.readFile(join(dir, 'input/sub/b.txt'), 'utf8'), 'βeta\n')
  })
)

test(
  'move checks cancellation after overwrite removal before rename',
  { timeout: 6000 },
  async () =>
    fixture(async (dir) => {
      const controller = new AbortController()
      const reason = { stage: 'overwrite' }
      const target = join(dir, 'existing')
      await native.mkdir(target)
      let renames = 0
      await patches(
        {
          rm: (original) =>
            function (...args) {
              const callback = args.pop()
              return original.call(this, ...args, (...result) => {
                controller.abort(reason)
                callback(...result)
              })
            },
          rename: (original) =>
            function (...args) {
              renames++
              return original.apply(this, args)
            },
        },
        async (api) => {
          assert.equal(
            await failure(
              api.move(join(dir, 'input'), target, { signal: controller.signal, overwrite: true })
            ),
            reason
          )
        }
      )
      assert.equal(renames, 0)
      assert((await native.stat(join(dir, 'input'))).isDirectory())
    })
)

for (const name of ['outputFile', 'outputJson', 'ensureFile', 'ensureLink', 'ensureSymlink']) {
  test(
    `${name}: cancellation after parent creation prevents following writes`,
    { timeout: 6000 },
    async () =>
      fixture(async (dir) => {
        const controller = new AbortController()
        const reason = { stage: 'mkdir', name }
        let subsequent = 0
        const mutating = Object.fromEntries(
          ['writeFile', 'link', 'symlink'].map((method) => [
            method,
            (original) =>
              function (...args) {
                subsequent++
                return original.apply(this, args)
              },
          ])
        )
        await patches(
          {
            ...mutating,
            mkdir: (original) =>
              function (...args) {
                const callback = args.pop()
                return original.call(this, ...args, (...result) => {
                  controller.abort(reason)
                  callback(...result)
                })
              },
          },
          async (api) => {
            assert.equal(
              await failure(api[name](...argumentsFor(name, dir, { signal: controller.signal }))),
              reason
            )
          }
        )
        assert.equal(subsequent, 0)
      })
  )
}

test('readJson throws:false preserves cancellation from a custom filesystem', async () =>
  fixture(async (dir) => {
    const api = load()
    const controller = new AbortController()
    const reason = { stage: 'custom-read' }
    let calls = 0
    const fs = {
      readFile(file, options, callback) {
        calls++
        queueMicrotask(() => {
          controller.abort(reason)
          callback(null, Buffer.from('{"value":2}'))
        })
      },
    }
    assert.equal(
      await failure(
        api.readJson(join(dir, 'data.json'), { signal: controller.signal, throws: false, fs })
      ),
      reason
    )
    assert.equal(calls, 1)
  }))

test('writeJson custom filesystem retains formatting and reports cancellation', async () =>
  fixture(async (dir) => {
    const api = load()
    const controller = new AbortController()
    const reason = { stage: 'custom-write' }
    let received
    const fs = {
      writeFile(file, value, options, callback) {
        received = value
        queueMicrotask(() => {
          controller.abort(reason)
          callback(null)
        })
      },
    }
    assert.equal(
      await failure(
        api.writeJson(
          join(dir, 'data.json'),
          { value: 2 },
          { signal: controller.signal, spaces: 2, EOL: '\r\n', fs }
        )
      ),
      reason
    )
    assert.equal(received, '{\r\n  "value": 2\r\n}\r\n')
  }))

test('ordinary filesystem failures preserve error and release signal listeners', async () =>
  fixture(async (dir) => {
    const api = load()
    const controller = new AbortController()
    const signal = controller.signal
    for (const action of [
      () => api.copy(join(dir, 'missing'), join(dir, 'out'), { signal }),
      () => api.readJson(join(dir, 'missing'), { signal }),
    ]) {
      assert.equal((await failure(action())).code, 'ENOENT')
      await nextTurn()
      assert.equal(getEventListeners(signal, 'abort').length, 0)
    }
  }))

test(
  'encoding, mode, filter and symlink legacy forms remain compatible',
  { timeout: 6000 },
  async () =>
    fixture(async (dir) => {
      const api = load()
      await api.outputFile(join(dir, 'encoding/file'), 'café', 'utf8')
      assert.equal(await native.readFile(join(dir, 'encoding/file'), 'utf8'), 'café')
      await api.ensureDir(join(dir, 'mode'), 0o700)
      assert.equal((await native.stat(join(dir, 'mode'))).mode & 0o777, 0o700)
      await api.ensureSymlink(join(dir, 'input/a.txt'), join(dir, 'legacy-link'), 'file')
      assert.equal(await native.readFile(join(dir, 'legacy-link'), 'utf8'), 'alpha\n')
      assert.equal(
        (
          await callbackCall(api, 'copy', [
            join(dir, 'input'),
            join(dir, 'filtered'),
            (path) => !path.endsWith('b.txt'),
          ])
        ).error,
        null
      )
      await assert.rejects(native.stat(join(dir, 'filtered/sub/b.txt')), { code: 'ENOENT' })
      await native.writeFile(join(dir, 'bad.json'), '{bad')
      assert.equal(await api.readJson(join(dir, 'bad.json'), { throws: false }), null)
      assert.deepEqual(await api.readJson(join(dir, 'data.json'), 'utf8'), { value: 7 })
    })
)

test('synchronous helpers retain existing behavior alongside cancellation options', async () =>
  fixture(async (dir) => {
    const api = load()
    const { signal } = cancelled()
    api.copySync(join(dir, 'input'), join(dir, 'sync-copy'), { signal })
    assert.equal(await native.readFile(join(dir, 'sync-copy/a.txt'), 'utf8'), 'alpha\n')
    api.outputJsonSync(join(dir, 'sync/data.json'), { value: 3 }, { spaces: 2 })
    assert.deepEqual(api.readJsonSync(join(dir, 'sync/data.json')), { value: 3 })
    api.ensureFileSync(join(dir, 'sync/file'))
    api.emptyDirSync(join(dir, 'sync'))
    assert.deepEqual(await native.readdir(join(dir, 'sync')), [])
  }))
