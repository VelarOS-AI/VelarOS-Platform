// 用途：以真实分块、背压和取消竞争验收浏览器安全的流式 DSV 导入。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import nodeTest from 'node:test'
import { pathToFileURL } from 'node:url'

const api = await import(pathToFileURL(resolve('src/index.js')))
const test = (name, body) => nodeTest(name, { timeout: 8000 }, body)
const feature = () => {
  for (const name of [
    'csvParseStream',
    'csvParseRowsStream',
    'tsvParseStream',
    'tsvParseRowsStream',
  ])
    assert.equal(typeof api[name], 'function', 'Streaming DSV public APIs must exist')
  for (const name of ['parseRowsStream', 'parseStream'])
    assert.equal(
      typeof api.dsvFormat('|')[name],
      'function',
      'Streaming DSV public APIs must exist'
    )
}
async function collect(iterable) {
  const out = []
  for await (const row of iterable) out.push(row)
  return out
}
async function* chunks(parts) {
  for (const part of parts) yield part
}
const code = (expected) => (error) => error?.code === expected
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function bounded(value) {
  let timer
  try {
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Stream failed to settle')), 1200)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function source(values) {
  let index = 0
  return {
    pulls: 0,
    closed: 0,
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      this.pulls++
      return index < values.length ? { value: values[index++], done: false } : { done: true }
    },
    async return() {
      this.closed++
      return { done: true }
    },
  }
}

test('Streaming DSV public APIs must exist', feature)
test('CSV, TSV and custom delimiters preserve synchronous well-formed results', async () => {
  feature()
  for (const [delimiter, text] of [
    [',', 'a,b\n1,2\n3,4\n'],
    ['\t', 'a\tb\n1\t2'],
    ['|', 'a|b\n"x|y"|z'],
  ]) {
    const dsv = api.dsvFormat(delimiter)
    assert.deepEqual(await collect(dsv.parseRowsStream([text])), dsv.parseRows(text))
    assert.deepEqual(await collect(dsv.parseStream([text])), Array.from(dsv.parse(text)))
  }
  assert.deepEqual(await collect(api.tsvParseRowsStream(['a\tb\n'])), [['a', 'b']])
  assert.deepEqual(await collect(api.tsvParseStream(['a\tb\n1\t2'])), [{ a: '1', b: '2' }])
})
test('every string cut preserves quotes, embedded CRLF and surrogate boundaries', async () => {
  feature()
  const text = 'name,note,empty\r\n"雪😀","a\r\nb, \"\"quoted\"\"",\r\nlast,x,z\r\n'
  const expected = api.csvParseRows(text)
  for (let cut = 0; cut <= text.length; cut++)
    assert.deepEqual(
      await collect(api.csvParseRowsStream(chunks([text.slice(0, cut), text.slice(cut)]))),
      expected,
      `cut ${cut}`
    )
  assert.deepEqual(await collect(api.csvParseRowsStream(chunks(text.split('')))), expected)
})
test('every UTF-8 byte cut and one-byte chunks preserve Unicode and BOM', async () => {
  feature()
  const text = '\ufeffname,note\r\n雪😀,"quoted\r\ntext"\r\n',
    bytes = new TextEncoder().encode(text)
  const expected = [
    ['name', 'note'],
    ['雪😀', 'quoted\r\ntext'],
  ]
  for (let cut = 0; cut <= bytes.length; cut++)
    assert.deepEqual(
      await collect(api.csvParseRowsStream([bytes.slice(0, cut), bytes.slice(cut)])),
      expected,
      `byte cut ${cut}`
    )
  assert.deepEqual(
    await collect(api.csvParseRowsStream([...bytes].map((x) => Uint8Array.of(x)))),
    expected
  )
})
test('empty records, trailing separators and BOM position are preserved', async () => {
  feature()
  for (const text of ['', '\n', '\r\n', 'a,', ',\n', 'a\r\nb\r', '""\n', 'x,\ufeffy'])
    assert.deepEqual(
      await collect(api.csvParseRowsStream(text.split(''))),
      api.csvParseRows(text),
      JSON.stringify(text)
    )
  assert.deepEqual(await collect(api.csvParseRowsStream(['\ufeff'])), [])
})
test('headers are safe own properties and duplicate/missing/extra cells follow the contract', async () => {
  feature()
  const rows = await collect(
    api.csvParseStream(['__proto__,constructor,prototype,a,a\nx,y,z,first,last,ignored\nq'])
  )
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype)
  assert.equal(Object.hasOwn(rows[0], '__proto__'), true)
  assert.deepEqual(Object.keys(rows[0]), ['__proto__', 'constructor', 'prototype', 'a'])
  assert.equal(rows[0].__proto__, 'x')
  assert.equal(rows[0].a, 'last')
  assert.equal(rows[1].constructor, '')
  assert.equal(rows[1].a, '')
})
test('async row conversion, filtering and logical indexes are consistent', async () => {
  feature()
  const calls = [],
    columns = []
  const out = await collect(
    api.csvParseStream(['a,b\n1,2\n3,4\n5,6'], {
      async onColumns(value) {
        await Promise.resolve()
        columns.push(value.slice())
      },
      async row(value, index, header) {
        await Promise.resolve()
        calls.push([index, header.slice()])
        return index === 1 ? null : { sum: +value.a + +value.b }
      },
    })
  )
  assert.deepEqual(out, [{ sum: 3 }, { sum: 11 }])
  assert.deepEqual(columns, [['a', 'b']])
  assert.deepEqual(calls, [
    [0, ['a', 'b']],
    [1, ['a', 'b']],
    [2, ['a', 'b']],
  ])
  const indexes = []
  assert.deepEqual(
    await collect(
      api.csvParseRowsStream(['x\ny\nz'], {
        row: async (row, index) => {
          indexes.push(index)
          return index === 0 ? undefined : row[0]
        },
      })
    ),
    ['y', 'z']
  )
  assert.deepEqual(indexes, [0, 1, 2])
})
test('empty input does not acquire a header or invoke header callbacks', async () => {
  feature()
  let calls = 0
  assert.deepEqual(
    await collect(
      api.csvParseStream(['', new Uint8Array()], {
        onColumns() {
          calls++
        },
      })
    ),
    []
  )
  assert.equal(calls, 0)
})
test('iteration is lazy and yields available rows without reading ahead', async () => {
  feature()
  const input = source(['a,b\n1,2\n3,4\n']),
    iterator = api.csvParseStream(input)
  assert.equal(input.pulls, 0)
  assert.deepEqual(await iterator.next(), { done: false, value: { a: '1', b: '2' } })
  await delay(10)
  assert.equal(input.pulls, 1)
  assert.deepEqual(await iterator.next(), { done: false, value: { a: '3', b: '4' } })
  assert.equal(input.pulls, 1)
  assert.equal((await iterator.next()).done, true)
  assert.equal(input.closed, 0)
})
test('a row ending with CR is delivered before the next uncooperative pull', async () => {
  feature()
  const pending = deferred(),
    input = source(['one\r'])
  const next = input.next.bind(input)
  input.next = () => (input.pulls === 0 ? next() : pending.promise)
  const iterator = api.csvParseRowsStream(input)
  assert.deepEqual(await bounded(iterator.next()), { value: ['one'], done: false })
  assert.equal(input.pulls, 1)
  await iterator.return()
  assert.equal(input.closed, 1)
})
test('an awaited row mapper applies backpressure to upstream chunks', async () => {
  feature()
  const gate = deferred(),
    entered = deferred(),
    input = source(['a\n1\n', '2\n'])
  const iterator = api.csvParseStream(input, {
    row: async (value) => {
      entered.resolve()
      await gate.promise
      return value
    },
  })
  const first = iterator.next()
  await bounded(entered.promise)
  await delay(10)
  assert.equal(input.pulls, 1)
  gate.resolve()
  assert.deepEqual(await first, { done: false, value: { a: '1' } })
  await iterator.return()
  assert.equal(input.closed, 1)
})
test('an awaited header callback applies backpressure before data pulls', async () => {
  feature()
  const gate = deferred(),
    entered = deferred(),
    input = source(['a,b\n', '1,2\n'])
  const iterator = api.csvParseStream(input, {
    onColumns: async () => {
      entered.resolve()
      await gate.promise
    },
  })
  const first = iterator.next()
  await bounded(entered.promise)
  await delay(10)
  assert.equal(input.pulls, 1)
  gate.resolve()
  assert.deepEqual((await first).value, { a: '1', b: '2' })
  await iterator.return()
})
test('consumer break and explicit return close upstream exactly once', async () => {
  feature()
  const input = source(['a\nb\nc'])
  for await (const row of api.csvParseRowsStream(input)) {
    assert.deepEqual(row, ['a'])
    break
  }
  assert.equal(input.closed, 1)
  const next = source(['x\ny']),
    iterator = api.csvParseRowsStream(next)
  await iterator.next()
  await iterator.return()
  await iterator.return()
  assert.equal(next.closed, 1)
})
test('pre-abort preserves exact reason without acquiring source or callbacks', async () => {
  feature()
  const controller = new AbortController(),
    reason = { abort: 7 }
  controller.abort(reason)
  let acquired = 0,
    callbacks = 0
  const input = {
    [Symbol.asyncIterator]() {
      acquired++
      throw new Error('must not acquire')
    },
  }
  await assert.rejects(
    bounded(
      api
        .csvParseStream(input, {
          signal: controller.signal,
          onColumns() {
            callbacks++
          },
        })
        .next()
    ),
    (e) => e === reason
  )
  assert.equal(acquired, 0)
  assert.equal(callbacks, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('abort during a pending upstream pull settles despite uncooperative return', async () => {
  feature()
  const controller = new AbortController(),
    reason = { abort: 'pull' },
    pending = deferred(),
    called = deferred()
  let closes = 0
  const input = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      called.resolve()
      return pending.promise
    },
    return() {
      closes++
      return new Promise(() => {})
    },
  }
  const iterator = api.csvParseRowsStream(input, { signal: controller.signal }),
    first = iterator.next()
  await bounded(called.promise)
  controller.abort(reason)
  await assert.rejects(bounded(first), (e) => e === reason)
  assert.equal(closes, 1)
  pending.reject(new Error('late source rejection'))
  await delay(10)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('abort during mapper prevents late rows and consumes late callback rejection', async () => {
  feature()
  const controller = new AbortController(),
    reason = { abort: 'row' },
    pending = deferred(),
    entered = deferred(),
    input = source(['a\n1\n2\n'])
  let calls = 0
  const iterator = api.csvParseStream(input, {
      signal: controller.signal,
      row() {
        calls++
        entered.resolve()
        return pending.promise
      },
    }),
    first = iterator.next()
  await bounded(entered.promise)
  controller.abort(reason)
  await assert.rejects(bounded(first), (e) => e === reason)
  assert.equal(input.closed, 1)
  pending.reject(new Error('late mapper rejection'))
  await delay(10)
  assert.equal(calls, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('abort during header callback closes upstream and skips data callbacks', async () => {
  feature()
  const controller = new AbortController(),
    reason = { abort: 'header' },
    pending = deferred(),
    entered = deferred(),
    input = source(['a\n1\n'])
  let calls = 0
  const first = api
    .csvParseStream(input, {
      signal: controller.signal,
      onColumns() {
        entered.resolve()
        return pending.promise
      },
      row() {
        calls++
      },
    })
    .next()
  await bounded(entered.promise)
  controller.abort(reason)
  await assert.rejects(bounded(first), (e) => e === reason)
  assert.equal(input.closed, 1)
  pending.reject(new Error('late header rejection'))
  await delay(10)
  assert.equal(calls, 0)
})
test('original mapper and source exceptions propagate and close once', async () => {
  feature()
  const reason = { original: true },
    input = source(['a\n1\n'])
  await assert.rejects(
    collect(
      api.csvParseStream(input, {
        row() {
          throw reason
        },
      })
    ),
    (e) => e === reason
  )
  assert.equal(input.closed, 1)
  const failing = source([])
  failing.next = async () => {
    throw reason
  }
  await assert.rejects(collect(api.csvParseRowsStream(failing)), (e) => e === reason)
  assert.equal(failing.closed, 1)
})
test('normal exhaustion releases listeners and does not call iterator return', async () => {
  feature()
  const controller = new AbortController(),
    input = source(['a\n1\n'])
  assert.deepEqual(await collect(api.csvParseStream(input, { signal: controller.signal })), [
    { a: '1' },
  ])
  assert.equal(input.closed, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('syntax errors are incremental and physical coordinates survive chunk cuts', async () => {
  feature()
  const text = 'a,b\n"x\nq"x,2'
  for (let cut = 0; cut <= text.length; cut++) {
    const input = source([text.slice(0, cut), text.slice(cut)])
    await assert.rejects(
      collect(api.csvParseRowsStream(input)),
      (error) =>
        error.code === 'DSV_SYNTAX' &&
        error.line === 3 &&
        error.column === 3 &&
        error.rowIndex === 1
    )
    assert.equal(input.closed, 1)
  }
  for (const invalid of ['"unterminated', 'ab"c', '"x"z', 'a,"x" "y"'])
    await assert.rejects(
      collect(api.csvParseRowsStream(invalid.split(''))),
      (error) =>
        error.code === 'DSV_SYNTAX' &&
        Number.isInteger(error.line) &&
        error.line >= 1 &&
        Number.isInteger(error.column) &&
        error.column >= 1 &&
        Number.isInteger(error.rowIndex)
    )
})
test('malformed row is never emitted after a valid prior row', async () => {
  feature()
  const iterator = api.csvParseRowsStream(['good,row\n"bad"x,next'])
  assert.deepEqual((await iterator.next()).value, ['good', 'row'])
  await assert.rejects(iterator.next(), code('DSV_SYNTAX'))
})
test('invalid UTF-8, bad chunk types and mixed modes reject usefully', async () => {
  feature()
  await assert.rejects(
    collect(api.csvParseRowsStream([Uint8Array.of(0xc3, 0x28)])),
    code('DSV_UTF8')
  )
  await assert.rejects(
    collect(api.csvParseRowsStream([Uint8Array.of(0xe2, 0x82)])),
    code('DSV_UTF8')
  )
  for (const value of [[12], [{}], ['a', Uint8Array.of(10)], [Uint8Array.of(97), '\n']])
    await assert.rejects(collect(api.csvParseRowsStream(value)), code('DSV_INVALID'))
  assert.deepEqual(
    await collect(api.csvParseRowsStream([new Uint8Array(), 'a\n', new Uint8Array()])),
    [['a']]
  )
})
test('field and raw-record limits honor exact boundaries', async () => {
  feature()
  assert.deepEqual(
    await collect(api.csvParseRowsStream(['"a""b",c\r\n'], { maxFieldLength: 3, maxRowLength: 8 })),
    [['a"b', 'c']]
  )
  await assert.rejects(
    collect(api.csvParseRowsStream(['"a""b",c\r\n'], { maxFieldLength: 2 })),
    code('DSV_LIMIT')
  )
  await assert.rejects(
    collect(api.csvParseRowsStream(['"a""b",c\r\n'], { maxRowLength: 7 })),
    code('DSV_LIMIT')
  )
  assert.deepEqual(await collect(api.csvParseRowsStream(['"a\nb"\n'], { maxRowLength: 5 })), [
    ['a\nb'],
  ])
})
test('row limit is counted before filtering and excludes the header', async () => {
  feature()
  assert.deepEqual(await collect(api.csvParseStream(['a\n1\n2'], { maxRows: 2 })), [
    { a: '1' },
    { a: '2' },
  ])
  const input = source(['a\n1\n', '2\n', 'never pull this'])
  let calls = 0
  await assert.rejects(
    collect(
      api.csvParseStream(input, {
        maxRows: 1,
        row() {
          calls++
          return null
        },
      })
    ),
    code('DSV_LIMIT')
  )
  assert.equal(calls, 1)
  assert(input.pulls <= 2)
  assert.equal(input.closed, 1)
  await assert.rejects(collect(api.csvParseRowsStream(['x\ny'], { maxRows: 1 })), code('DSV_LIMIT'))
})
test('invalid options and delimiters are rejected without changing old APIs', async () => {
  feature()
  for (const options of [
    { unknown: true },
    { row: 12 },
    { maxRows: 0 },
    { maxRows: 1.2 },
    { maxRowLength: -1 },
    { maxFieldLength: Infinity },
  ])
    await assert.rejects(collect(api.csvParseRowsStream(['a'], options)), code('DSV_INVALID'))
  await assert.rejects(
    collect(api.csvParseRowsStream(['a'], { onColumns() {} })),
    code('DSV_INVALID')
  )
  for (const delimiter of ['', '::', '"', '\n', '\r', '😀'])
    await assert.rejects(
      collect(api.dsvFormat(delimiter).parseRowsStream(['x'])),
      code('DSV_INVALID')
    )
})
test('Node and Web readable stream inputs work with byte chunks', async () => {
  feature()
  const { Readable } = await import('node:stream')
  assert.deepEqual(
    await collect(api.csvParseStream(Readable.from([Buffer.from('a,b\n'), Buffer.from('1,2')]))),
    [{ a: '1', b: '2' }]
  )
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('a\n雪'))
      controller.close()
    },
  })
  assert.deepEqual(await collect(api.csvParseStream(input)), [{ a: '雪' }])
})
test('new parsing works when dynamic code generation is disabled', async () => {
  feature()
  const originalFunction = globalThis.Function,
    originalEval = globalThis.eval
  globalThis.Function = function () {
    throw new Error('CSP disallows Function')
  }
  globalThis.eval = () => {
    throw new Error('CSP disallows eval')
  }
  try {
    assert.deepEqual(await collect(api.csvParseStream(['first name,amount\nAda,2'])), [
      { 'first name': 'Ada', amount: '2' },
    ])
  } finally {
    globalThis.Function = originalFunction
    globalThis.eval = originalEval
  }
})
test('documentation and runnable offline demonstration are delivered', async () => {
  feature()
  const apiName = /\b(?:parse(?:Rows)?Stream|(?:csv|tsv)Parse(?:Rows)?Stream)\b/u
  const readme = await readFile(resolve('README.md'), 'utf8')
  const guide = await readFile(resolve('docs/streaming.md'), 'utf8')
  assert.match(guide, apiName)
  // README 可以直接介绍 API，也可以把读者引向完整指南，不约束同义的文档组织方式。
  assert.ok(
    apiName.test(readme) || readme.includes('docs/streaming.md'),
    'README must introduce a streaming API or refer to its guide'
  )
  const example = resolve('examples/streaming-import.js')
  const result = spawnSync(process.execPath, [example], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.error, undefined)
  // 原有测试会在评分副本中恢复；新增测试的完整交付另由源码归档和执行回执核查。
})
