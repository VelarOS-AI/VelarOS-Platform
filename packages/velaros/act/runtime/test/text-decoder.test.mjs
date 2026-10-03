import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ScriptTurnDecoder } from '../../../dist/act/runtime/impl/ScriptTurnDecoder.js'

const marker = '@@s12345678'
const block = (header, body = '') => `${marker} ${header}\n${body}${body ? '\n' : ''}${marker}\n`
const decode = (text, options = {}, inputs = {}) => {
  const d = new ScriptTurnDecoder(marker, options, inputs)
  d.push(text)
  return d.finish()
}
const source = "import {output} from 'velaros';output(1);"
const raw = 'const message = `Hello, ${name}`;\n```js\n"quote" \\ backslash\n```\n'
const text = `Before\n\`\`\`js\nexecute()\n\`\`\`\n${block('blobs("payload")', raw)}${block('observe', source)}${block('execute({async:true, retain:1, input:{x:[1,true,null]}})', source)}After\n${marker} done()\nFinished.`

test('INV-12 every stream split preserves Markdown, opaque payload and program preview exactly', () => {
  const expected = decode(text)
  assert.equal(expected.done, true)
  assert.equal(expected.submission.executions[0].program.blobs.payload, raw)
  assert.equal(expected.submission.executions[0].async, true)
  for (let at = 0; at <= text.length; at++) {
    const d = new ScriptTurnDecoder(marker)
    const events = [...d.push(text.slice(0, at)), ...d.push(text.slice(at))]
    const result = d.finish()
    events.push(...result.events)
    assert.deepEqual({ ...result, events: [] }, { ...expected, events: [] }, `split ${at}`)
    assert.equal(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
      expected.message
    )
    assert.equal(
      events
        .filter((e) => e.type === 'program' && e.index === 0 && e.phase === 'delta')
        .map((e) => e.text)
        .join(''),
      raw
    )
  }
  const d = new ScriptTurnDecoder(marker)
  for (const char of text) d.push(char)
  assert.equal(d.finish().submission.executions.length, 1)
})

test('CRLF, no final newline, blank payload and marker-like lines are unambiguous', () => {
  const result = decode(
    `${marker} blobs('empty')\r\n${marker}\r\n${marker} execute\r\n${source}\r\n${marker}\r\n${marker} done`
  )
  assert.equal(result.submission.executions[0].program.blobs.empty, '')
  assert.equal(result.submission.executions[0].program.source, source)
  assert.equal(decode('@@s12345678x execute()\ntext').submission, undefined)
  assert.equal(decode(`${block('execute', source)}${marker} done\nmore text`).message, 'more text')
})

test('eight-digit and archived markers preserve exact matching across stream splits', () => {
  for (const tag of [
    '@@s1a2b3c4d',
    '@@s00000000',
    '@@s123456780',
    '@@s3w5e11264sgsf',
    '@@s02d79a2765954e4aa16f1931a268b184',
    '@@scope_1a2b3c4d',
  ]) {
    const options = tag.startsWith('@@scope_') ? { markerPrefix: '@@scope_' } : {}
    const response = `${tag} execute()\n${source}\n${tag}\n${tag} done\nVerified.`
    for (let split = 0; split <= response.length; split++) {
      const decoder = new ScriptTurnDecoder(tag, options)
      decoder.push(response.slice(0, split))
      decoder.push(response.slice(split))
      const result = decoder.finish()
      assert.equal(result.done, true)
      assert.equal(result.message, 'Verified.')
      assert.equal(result.submission.executions[0].program.source, source)
    }
    const wrong = `${tag.slice(0, -1)}${tag.endsWith('a') ? 'b' : 'a'}`
    const decoder = new ScriptTurnDecoder(tag, options)
    decoder.push(`${tag} execute()\n${source}\n${wrong}\n`)
    assert.throws(() => decoder.finish(), /控制段缺少闭合标记/u)
  }
})

test('INV-66 closing marker permits trailing spaces across stream splits without trimming payload', () => {
  const payload = `${source}  \n  `
  for (const ending of ['', '\n', '\r\n']) {
    for (const spaces of [' ', '   ']) {
      const response = `${marker} execute()\n${payload}\n${marker}${spaces}${ending}`
      for (let split = 0; split <= response.length; split++) {
        const decoder = new ScriptTurnDecoder(marker)
        const events = [
          ...decoder.push(response.slice(0, split)),
          ...decoder.push(response.slice(split)),
        ]
        const result = decoder.finish()
        events.push(...result.events)
        assert.equal(result.submission.executions[0].program.source, payload)
        assert.equal(result.message, '')
        assert.equal(
          events.filter((event) => event.type === 'program' && event.phase === 'end').length,
          1
        )
        assert.equal(
          events
            .filter((event) => event.type === 'program' && event.phase === 'delta')
            .map((event) => event.text)
            .join(''),
          payload
        )
      }
    }
  }
  const blob = `${marker} blobs('raw')\n${payload}\n${marker}  \n`
  assert.equal(
    decode(blob + block('execute', source)).submission.executions[0].program.blobs.raw,
    payload
  )
  for (const suffix of [' execute()', ' unexpected', ' \t', ' \u00a0']) {
    assert.throws(() => decode(`${marker} execute()\n${source}\n${marker}${suffix}\n`), {
      code: 'SCRIPT_PROTOCOL',
    })
  }
  assert.throws(() => decode(`${marker}  \n`), { code: 'SCRIPT_PROTOCOL' })
  assert.throws(
    () =>
      decode(`${marker} execute()\n${source}\n${marker}${' '.repeat(64)}\n`, {
        maxHeaderChars: 32,
      }),
    /预算/
  )
})

test('configuration, reference edits, full bundles and immutable host parameters use one decoder', () => {
  const inputs = { target: { path: 'original' } }
  const d = new ScriptTurnDecoder(marker, { names: { execute: 'run', done: 'finish' } }, inputs)
  inputs.target.path = 'changed'
  d.push(`${block('run({inputRef:"host:target"})', source)}${marker} finish`)
  assert.equal(d.finish().submission.executions[0].program.input.path, 'original')
  assert.deepEqual(
    decode(block('observe({edits:[{oldText:"a",newText:"b"}]})')).submission.observe.edits,
    [{ oldText: 'a', newText: 'b' }]
  )
  assert.equal(decode(block('observe({clear:true})')).submission.observe, null)
  const program = {
    source,
    modules: { './data.js': 'export const a=1' },
    input: { a: 1 },
    blobs: { inline: 'text' },
  }
  assert.deepEqual(
    decode(block('execute({format:"program"})', JSON.stringify(program))).submission.executions[0]
      .program,
    { ...program, retainTurns: 'segment' }
  )
})

for (const [name, input] of [
  ['unclosed', `${marker} execute\n${source}`],
  ['nested', `${marker} blobs('x')\n${block('execute', source)}`],
  ['unknown', block('unknown', source)],
  ['expression', block('execute({input: process.exit()})', source)],
  ['spread', block('execute({...x})', source)],
  ['getter', block('execute({get x(){return 1}})', source)],
  ['duplicate argument', block('execute({retain:1,retain:2})', source)],
  ['duplicate blob', block('blobs("x")', '1') + block('blobs("x")', '2')],
  ['done with a non-string argument', `${marker} done(1)`],
  ['done with two arguments', `${marker} done("a", "b")`],
  ['done with a blank reason', `${marker} done("  ")`],
  ['done with an object', `${marker} done({reason:"x"})`],
  ['done twice', `${marker} done\n${marker} done()`],
  ['control after done', `${marker} done\n${block('execute', source)}`],
  ['two observers', block('observe', source) + block('observe', source)],
  ['async observer', block('observe({async:false})', source)],
  ['bad lease', block('execute({retain:0})', source)],
  ['parameter collision', block('execute({input:1,inputRef:"host:p"})', source)],
  ['unexpected field', block('execute({bogus:true})', source)],
  ['clear with content', block('observe({clear:true})', source)],
  ['missing blob name', block('blobs', 'x')],
  ['extra expression', block('execute(); done()', source)],
])
  test(`rejects ${name} before a submission exists`, () =>
    assert.throws(() => decode(input), { code: 'SCRIPT_PROTOCOL' }))

test('done may carry one completion reason for the active goal', () => {
  const result = decode(`答复\n${marker} done("已回答用户的问题")`)
  assert.equal(result.done, true)
  assert.equal(result.completion, '已回答用户的问题')
  assert.equal(result.message, '答复\n')
  assert.equal('completion' in decode(`${marker} done`), false)
  assert.throws(() => decode(`${marker} done("${'x'.repeat(4001)}")`), { code: 'SCRIPT_PROTOCOL' })
})

test('response, header, block budgets and decoder reset are bounded', () => {
  assert.throws(() => decode(text, { maxChars: 5 }), /预算/)
  assert.throws(
    () => decode(block('execute({input:"long"})', source), { maxHeaderChars: 20 }),
    /预算/
  )
  assert.throws(
    () => decode(block('execute', source) + block('execute', source), { maxBlocks: 1 }),
    /数量/
  )
  const d = new ScriptTurnDecoder(marker)
  d.push(`${marker} execute\n`)
  assert.throws(() => d.finish())
  d.reset()
  d.push(`${marker} done`)
  assert.equal(d.finish().done, true)
})

test('work decision requirement is checked at finish and respects configured declaration names', () => {
  let required = false
  const decoder = new ScriptTurnDecoder(
    marker,
    { names: { execute: 'run', done: 'finish' }, allowed: ['execute', 'done'] },
    {},
    () => required
  )
  decoder.push('Continue processing.')
  required = true
  assert.throws(
    () => decoder.finish(),
    (error) => {
      assert.equal(error.code, 'SCRIPT_PROTOCOL')
      assert.match(error.message, /run \/ finish/)
      assert(error.message.includes(`第一行直接输出：\n${marker} run()`))
      assert(error.message.includes(`独立一行写闭合标记：\n${marker}`))
      assert(error.message.includes(`${marker} finish("完成依据")`))
      assert.doesNotMatch(error.message, /observe|execute|done/)
      return true
    }
  )
  const plain = new ScriptTurnDecoder(marker)
  plain.push('Markdown remains parseable.')
  assert.equal(plain.finish().message, 'Markdown remains parseable.')
})

test('decision repair only suggests controls allowed in the current scope', () => {
  const decoder = new ScriptTurnDecoder(marker, { allowed: ['observe'] }, {}, () => true)
  decoder.push('I will inspect the project.')
  assert.throws(
    () => decoder.finish(),
    (error) => {
      assert(error.message.includes(`${marker} observe()`))
      assert.match(error.message, /只读/)
      assert.doesNotMatch(error.message, /execute|done/)
      return true
    }
  )
})

test('an incorrect closing marker stays rejected and reports the exact current marker', () => {
  for (const header of ['execute()', 'blobs("payload")', 'observe()']) {
    assert.throws(
      () => decode(`${marker} ${header}\n${source}\n${marker.slice(0, -1)}9\n`),
      (error) => {
        assert.equal(error.code, 'SCRIPT_PROTOCOL')
        assert(error.message.includes(`闭合行必须逐字为：\n${marker}\n`))
        assert.match(error.message, /重新输出完整响应/)
        assert.match(error.message, /不能只补闭合行/)
        return true
      }
    )
  }
})

test('INV-63 a new header before closure names the active declaration and exact repair boundary', () => {
  for (const [kind, options] of [
    ['blobs', {}],
    ['execute', {}],
    ['observe', {}],
    ['blobs', { names: { blobs: 'raw', execute: 'run' } }],
  ]) {
    const name = options.names?.[kind] ?? kind
    const next = options.names?.execute ?? 'execute'
    const decoder = new ScriptTurnDecoder(marker, options)
    const text = `${marker} ${name}(${kind === 'blobs' ? '"payload"' : ''})\nPRIVATE_BLOB_BODY\n${marker} ${next}()\n`
    assert.throws(
      () => {
        for (const character of text) decoder.push(character)
      },
      (error) => {
        assert.equal(error.code, 'SCRIPT_PROTOCOL')
        assert(error.message.includes(`上一 ${name} 控制段`))
        assert(error.message.includes(`闭合行必须逐字为：\n${marker}\n`))
        assert.match(error.message, /重新输出完整响应/)
        assert.match(error.message, /下一控制头不能代替闭合行/)
        assert(!error.message.includes('PRIVATE_BLOB_BODY'))
        return true
      }
    )
  }
  assert(new ScriptTurnDecoder(marker).instructions.includes('blobs 原文结束后也必须'))
  assert(
    !new ScriptTurnDecoder(marker, { allowed: ['execute'] }).instructions.includes(
      '原文结束后也必须'
    )
  )
})

test('normal work instructions begin with an allowed control and honor custom names', () => {
  for (const [allowed, names, expected] of [
    [['execute', 'done'], { execute: 'run', done: 'finish' }, 'run'],
    [['observe'], { observe: 'inspect' }, 'inspect'],
  ]) {
    const decoder = new ScriptTurnDecoder(marker, { allowed, names })
    assert.equal(decoder.instructions.split(`\n${marker} ${expected}()\n`).length - 1, 1)
    assert.doesNotMatch(decoder.instructions, /output\(1\)/)
    assert.match(decoder.instructions, /省略执行前的进度说明/)
  }
  assert.doesNotMatch(
    new ScriptTurnDecoder(marker, { allowed: ['done'] }).instructions,
    /继续工作时/
  )
})

test('text executions default to segment retention while explicit and host durations take precedence', () => {
  const program = (header, options) =>
    decode(block(header, source), options).submission.executions[0].program
  assert.equal(program('execute').retainTurns, 'segment')
  assert.equal(program('execute({retain:1})').retainTurns, 1)
  assert.equal(program('execute', { defaultRetain: 4 }).retainTurns, 4)
  assert.equal(program('execute({retain:1})', { defaultRetain: 4 }).retainTurns, 1)
})
