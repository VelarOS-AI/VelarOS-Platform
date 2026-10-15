import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { PassThrough, pipeline } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as immediate } from 'node:timers/promises'

const root = resolve(process.argv[2] ?? process.cwd())
const require = createRequire(resolve(root, 'package.json'))
const tar = require(root)
const keys = ['maxEntries', 'maxEntrySize', 'maxTotalSize']

// 独立生成标准 TAR 字节，不借用被测包的 pack 或 headers 实现。
function header(name, size, type = '0') {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100)
  const octal = (offset, length, value) =>
    b.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length)
  octal(100, 8, 0o644)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 0)
  b.fill(32, 148, 156)
  b.write(type, 156, 1)
  b.write('ustar\0', 257)
  b.write('00', 263)
  const sum = b.reduce((a, v) => a + v, 0)
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return b
}
const padded = (body) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
const entry = (name, body = '', type = '0') => {
  const bytes = Buffer.from(body)
  return Buffer.concat([header(name, bytes.length, type), padded(bytes)])
}
const archive = (...parts) => Buffer.concat([...parts, Buffer.alloc(1024)])
function pax(values, type = 'x') {
  const body = Buffer.from(
    Object.entries(values)
      .map(([key, value]) => {
        const tail = ` ${key}=${value}\n`
        let length = Buffer.byteLength(tail) + 1
        while (String(length).length + Buffer.byteLength(tail) !== length)
          length = String(length).length + Buffer.byteLength(tail)
        return `${length}${tail}`
      })
      .join('')
  )
  return entry('PaxHeader', body, type)
}

async function collect(bytes, options = {}, chunkSize = bytes.length, mutate) {
  const stream = tar.extract(options),
    entries = [],
    errors = []
  const settled = Promise.withResolvers()
  stream.on('error', (error) => {
    errors.push(error)
    settled.resolve()
  })
  stream.on('finish', () => settled.resolve())
  stream.on('entry', (header, body, next) => {
    const item = { name: header.name, size: header.size, data: [] }
    entries.push(item)
    body.on('error', () => {})
    body.on('data', (data) => item.data.push(data))
    body.on('end', next)
  })
  mutate?.()
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    stream.write(bytes.subarray(offset, offset + chunkSize))
  stream.end()
  await settled.promise
  await immediate()
  return { entries: entries.map((e) => ({ ...e, data: Buffer.concat(e.data).toString() })), errors }
}
function failure(result, limit, maximum, actual, entryName) {
  assert.equal(result.errors.length, 1)
  const error = result.errors[0]
  assert(error instanceof tar.ExtractLimitError)
  assert(error instanceof Error)
  assert.equal(error.name, 'ExtractLimitError')
  assert.equal(error.code, 'TAR_EXTRACT_LIMIT')
  assert.equal(error.limit, limit)
  assert.equal(error.maximum, maximum)
  assert.equal(error.actual, actual)
  assert.equal(error.entryName, entryName)
}

test('ExtractLimitError is publicly exported', () => {
  assert.equal(typeof tar.ExtractLimitError, 'function')
  const error = new tar.ExtractLimitError('maxEntries', 2, 3, 'item')
  assert(error instanceof Error)
  assert.deepEqual(
    [error.name, error.code, error.limit, error.maximum, error.actual, error.entryName],
    ['ExtractLimitError', 'TAR_EXTRACT_LIMIT', 'maxEntries', 2, 3, 'item']
  )
})

for (const key of keys) {
  test(`${key} rejects invalid values synchronously without coercion`, () => {
    let coerced = false
    for (const value of [
      -1,
      0.5,
      NaN,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
      true,
      1n,
      {
        valueOf() {
          coerced = true
          return 1
        },
      },
      Symbol('limit'),
    ])
      assert.throws(() => tar.extract({ [key]: value }), TypeError)
    assert.equal(coerced, false)
  })
  test(`${key} accepts zero, safe integers, undefined and Infinity`, async () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER, undefined, Infinity]) {
      const result = await collect(archive(), { [key]: value })
      assert.deepEqual(result.errors, [])
      assert.deepEqual(result.entries, [])
    }
  })
}

test('validation stops in documented option order', () => {
  const visited = []
  assert.throws(
    () =>
      tar.extract({
        get maxEntries() {
          visited.push('entries')
          return -1
        },
        get maxEntrySize() {
          throw Error('read too far')
        },
      }),
    TypeError
  )
  assert.deepEqual(visited, ['entries'])
  assert.throws(
    () =>
      tar.extract({
        maxEntries: 1,
        get maxEntrySize() {
          visited.push('size')
          return -1
        },
        get maxTotalSize() {
          throw Error('read too far')
        },
      }),
    TypeError
  )
  assert.deepEqual(visited, ['entries', 'size'])
})

test('maxEntries counts empty files, directories and links but not end markers', async () => {
  const data = archive(
    entry('empty'),
    entry('folder/', '', '5'),
    entry('link', '', '2'),
    entry('later', 'x')
  )
  const result = await collect(data, { maxEntries: 2 })
  assert.deepEqual(
    result.entries.map((e) => e.name),
    ['empty', 'folder/']
  )
  failure(result, 'maxEntries', 2, 3, 'link')
  failure(await collect(data, { maxEntries: 0 }), 'maxEntries', 0, 1, 'empty')
})

test('size and total bounds are inclusive and exclude TAR padding', async () => {
  const data = archive(entry('one', '123'), entry('two', '4567'), entry('empty'))
  const result = await collect(data, { maxEntries: 3, maxEntrySize: 4, maxTotalSize: 7 })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(
    result.entries.map((e) => e.data),
    ['123', '4567', '']
  )
})

test('entry-size and total errors retain accepted entries and stop later entries', async () => {
  const data = archive(entry('one', '123'), entry('two', '4567'), entry('three', 'x'))
  for (const [options, limit, maximum, actual] of [
    [{ maxEntrySize: 3 }, 'maxEntrySize', 3, 4],
    [{ maxTotalSize: 6 }, 'maxTotalSize', 6, 7],
  ]) {
    const result = await collect(data, options)
    failure(result, limit, maximum, actual, 'two')
    assert.deepEqual(result.entries, [{ name: 'one', size: 3, data: '123' }])
  }
})

test('zero byte budgets allow zero-sized entries and reject nonempty entries', async () => {
  const result = await collect(
    archive(entry('empty'), entry('folder/', '', '5'), entry('one', 'x')),
    { maxEntrySize: 0, maxTotalSize: 0 }
  )
  assert.equal(result.entries.length, 2)
  failure(result, 'maxEntrySize', 0, 1, 'one')
})

test('limit precedence is stable', async () => {
  const data = archive(entry('one', '123'))
  failure(
    await collect(data, { maxEntries: 0, maxEntrySize: 0, maxTotalSize: 0 }),
    'maxEntries',
    0,
    1,
    'one'
  )
  failure(
    await collect(data, { maxEntries: 1, maxEntrySize: 2, maxTotalSize: 0 }),
    'maxEntrySize',
    2,
    3,
    'one'
  )
})

test('limits are snapshotted and extractor counters are independent', async () => {
  const options = { maxEntries: 1, maxTotalSize: 1 }
  const data = archive(entry('one', 'a'), entry('two', 'b'))
  const result = await collect(data, options, data.length, () => {
    options.maxEntries = 9
    options.maxTotalSize = 99
  })
  failure(result, 'maxEntries', 1, 2, 'two')
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      (await collect(archive(entry('one', 'a')), { maxEntries: 1, maxTotalSize: 1 })).errors,
      []
    )
})

test('PAX metadata is excluded and effective name and size drive rejection', async () => {
  const data = archive(
    pax({ path: 'effective-name', size: 5 }),
    header('raw-name', 1),
    padded(Buffer.from('12345'))
  )
  const result = await collect(data, { maxEntries: 1, maxEntrySize: 4 })
  failure(result, 'maxEntrySize', 4, 5, 'effective-name')
  assert.deepEqual(result.entries, [])
})

test('PAX can reduce raw size before checking and metadata does not use total budget', async () => {
  const data = archive(pax({ size: 2 }), header('one', 100), padded(Buffer.from('ab')))
  const result = await collect(data, { maxEntries: 1, maxEntrySize: 2, maxTotalSize: 2 })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.entries, [{ name: 'one', size: 2, data: 'ab' }])
})

test('GNU and global/local PAX records are not application entries or payload bytes', async () => {
  const name = 'long/'.repeat(35) + 'file'
  const data = archive(
    pax({ comment: 'global' }, 'g'),
    pax({ comment: 'local' }),
    entry('LongName', `${name}\0`, 'L'),
    entry('LongLink', 'target\0', 'K'),
    entry('placeholder', 'x')
  )
  const result = await collect(data, { maxEntries: 1, maxEntrySize: 1, maxTotalSize: 1 }, 7)
  assert.deepEqual(result.errors, [])
  assert.equal(result.entries[0].name, name)
  failure(await collect(data, { maxEntries: 0 }), 'maxEntries', 0, 1, name)
})

test('effective unsafe and negative sizes fail before limit checks when bounded', async () => {
  for (const size of ['-1', '9007199254740992', 'Infinity']) {
    const result = await collect(archive(pax({ size }), header('invalid', 0)), { maxEntries: 0 })
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'TAR_INVALID_SIZE')
    assert.deepEqual(result.entries, [])
  }
})

test('chunk boundaries do not change bounded outcomes', async () => {
  const data = archive(entry('a', '12'), entry('b', '345'), entry('c', '6789'))
  for (const chunkSize of [1, 17, 511, 512, 513, data.length]) {
    const result = await collect(data, { maxTotalSize: 5 }, chunkSize)
    failure(result, 'maxTotalSize', 5, 9, 'c')
    assert.deepEqual(
      result.entries.map((e) => e.data),
      ['12', '345']
    )
  }
})

test(
  'offending header rejects before body or input end and settles the pipeline',
  { timeout: 2500 },
  async () => {
    const stream = tar.extract({ maxEntrySize: 3 })
    let emitted = 0
    stream.on('entry', () => emitted++)
    const errorEvent = Promise.withResolvers(),
      pipelineResult = Promise.withResolvers()
    stream.once('error', errorEvent.resolve)
    const input = new PassThrough()
    pipeline(input, stream, pipelineResult.resolve)
    input.write(header('too-large', 4))
    const timeout = setTimeout(() => stream.destroy(Error('header rejection timed out')), 1500)
    try {
      const error = await errorEvent.promise
      assert.equal(await pipelineResult.promise, error)
      assert(error instanceof tar.ExtractLimitError)
      assert.equal(emitted, 0)
      assert.equal(error.entryName, 'too-large')
    } finally {
      clearTimeout(timeout)
      stream.destroy()
    }
  }
)

test(
  'async iteration observes the same entry boundary and typed error',
  { timeout: 2500 },
  async () => {
    const stream = tar.extract({ maxEntries: 1 }),
      names = []
    stream.end(archive(entry('first', 'a'), entry('second', 'b')))
    let error
    try {
      for await (const body of stream) {
        names.push(body.header.name)
        for await (const _chunk of body) {
        }
      }
    } catch (caught) {
      error = caught
    }
    assert.deepEqual(names, ['first'])
    assert(error instanceof tar.ExtractLimitError)
    assert.equal(error.limit, 'maxEntries')
    assert.equal(error.entryName, 'second')
  }
)

test('omitted limits preserve normal extraction and existing writable options', async () => {
  const data = archive(entry('one', 'a'), entry('two', 'bb'))
  for (const options of [
    {},
    { maxEntries: Infinity, maxEntrySize: Infinity, maxTotalSize: Infinity, highWaterMark: 1 },
  ]) {
    const result = await collect(data, options, 3)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(
      result.entries.map((e) => e.data),
      ['a', 'bb']
    )
  }
})
