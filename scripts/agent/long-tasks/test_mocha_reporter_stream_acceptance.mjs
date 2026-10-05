// 独立公开行为验收：每例在新 Node 进程中加载参与者的项目，不依赖其新增测试。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

const reporters = [
  'base',
  'spec',
  'dot',
  'list',
  'min',
  'progress',
  'landing',
  'nyan',
  'tap',
  'doc',
  'markdown',
  'json',
  'json-stream',
  'xunit',
]

function probe(input) {
  const { EventEmitter } = require('node:events')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  let stdout = '',
    stderr = ''
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (value) => {
    stdout += value
    return true
  }
  process.stderr.write = (value) => {
    stderr += value
    return true
  }
  const Mocha = require(path.join(process.cwd(), 'index.js'))
  const Base = require(path.join(process.cwd(), 'lib/reporters/base.js'))
  const Reporter = require(path.join(process.cwd(), 'lib/reporters', input.reporter + '.js'))
  Base.useColors = false
  const references = [
    process.stdout.write,
    process.stderr.write,
    console.log,
    console.error,
    Base.consoleLog,
    Base.cursor,
    Base.cursor.hide,
    Base.list,
  ]
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/gu
  function makeSink(tty = false, columns = 75) {
    const value = {
      text: '',
      isTTY: tty,
      columns,
      ended: 0,
      writes: 0,
      write(text) {
        if (this !== value) throw new Error('write receiver lost')
        this.text += text
        this.writes++
        return false
      },
      end() {
        this.ended++
      },
      close() {
        this.ended++
      },
      destroy() {
        this.ended++
      },
    }
    return value
  }
  function runState(label) {
    const root = new Mocha.Suite('', new Mocha.Context())
    const suite = Mocha.Suite.create(root, label + ' suite 中文 %s')
    const runner = new EventEmitter()
    runner.suite = root
    runner.total = 3
    runner.grepTotal = () => 3
    runner.stats = {
      suites: 1,
      tests: 3,
      passes: 1,
      pending: 1,
      failures: 1,
      duration: 12,
      start: new Date(0),
      end: new Date(12),
    }
    const tests = ['pass', 'pending', 'fail'].map((state) => {
      const item = new Mocha.Test(label + ' ' + state + ' %d 中文', function example() {})
      suite.addTest(item)
      item.file = '/fixture/example.js'
      item.duration = 3
      item.state = state === 'pass' ? 'passed' : state === 'fail' ? 'failed' : 'pending'
      return item
    })
    const error = new Error(label + ' failure detail')
    error.actual = 'actual-value'
    error.expected = 'expected-value'
    error.showDiff = true
    error.stack = 'Error: ' + error.message + '\n    at fixture.js:1:1'
    const events = [
      ['start'],
      ['suite', root],
      ['suite', suite],
      ['test', tests[0]],
      ['pass', tests[0]],
      ['test end', tests[0]],
      ['pending', tests[1]],
      ['test end', tests[1]],
      ['test', tests[2]],
      ['fail', tests[2], error],
      ['test end', tests[2]],
      ['suite end', suite],
      ['suite end', root],
      ['end'],
    ]
    return { runner, events }
  }
  function report(state, options) {
    const value = new Reporter(state.runner, options)
    if (input.reporter === 'base') state.runner.once('end', () => value.epilogue())
    return value
  }
  function emit(state) {
    for (const event of state.events) state.runner.emit(...event)
  }
  function unchanged() {
    return references.every(
      (value, index) =>
        value ===
        [
          process.stdout.write,
          process.stderr.write,
          console.log,
          console.error,
          Base.consoleLog,
          Base.cursor,
          Base.cursor.hide,
          Base.list,
        ][index]
    )
  }
  async function main() {
    if (input.mode === 'invalid') {
      const result = []
      for (const stream of [null, 0, 'stdout', {}, { write: 1 }]) {
        const state = runState('invalid')
        let error
        try {
          report(state, { reporterOption: { stream } })
        } catch (value) {
          error = { type: value.constructor.name, message: value.message }
        }
        result.push({ error, listeners: state.runner.eventNames().length, stdout, stderr })
      }
      return result
    }
    if (input.mode === 'interleave') {
      const a = makeSink(),
        b = makeSink()
      const sa = runState('ALPHA'),
        sb = runState('BETA')
      const ra = report(sa, { reporterOption: { stream: a } }),
        rb = report(sb, { reporterOptions: { stream: b } })
      let independent = unchanged()
      for (let index = 0; index < sa.events.length; index++) {
        const beforeB = b.text
        sa.runner.emit(...sa.events[index])
        independent &&= b.text === beforeB && unchanged()
        const beforeA = a.text
        sb.runner.emit(...sb.events[index])
        independent &&= a.text === beforeA && unchanged()
      }
      let done = []
      for (const instance of [ra, rb])
        if (instance.done) instance.done(7, (value) => done.push(value))
      return { a: a.text, b: b.text, ended: a.ended + b.ended, independent, stdout, stderr, done }
    }
    if (input.mode === 'terminal') {
      const target = makeSink(input.tty, input.columns)
      const state = runState('terminal')
      report(state, { reporterOption: { stream: target } })
      emit(state)
      return { text: target.text, controls: target.text.match(ansi) ?? [], stdout, stderr }
    }
    if (input.mode === 'error') {
      const sentinel = new Error('sink deliberately failed')
      const state = runState('error')
      let received
      try {
        report(state, {
          reporterOption: {
            stream: {
              write() {
                throw sentinel
              },
            },
          },
        })
        emit(state)
      } catch (value) {
        received = value
      }
      return { same: received === sentinel, unchanged: unchanged() }
    }
    if (input.mode === 'file') {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocha-stream-grade-'))
      const output = path.join(root, 'nested/report.txt')
      try {
        const target = makeSink()
        const state = runState('file')
        let error
        let instance
        const options = { output, ...(input.conflict ? { stream: target } : {}) }
        try {
          instance = report(state, { reporterOption: options, reporterOptions: options })
          emit(state)
          if (instance.done) await new Promise((resolve) => instance.done(4, resolve))
        } catch (value) {
          error = { type: value.constructor.name, message: value.message }
        }
        return {
          error,
          exists: fs.existsSync(path.dirname(output)),
          content: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : null,
          text: target.text,
          stdout,
          stderr,
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
    if (input.mode === 'public') {
      const target = makeSink()
      const mocha =
        input.route === 'setter'
          ? new Mocha()
          : new Mocha({ reporter: input.reporter, [input.route]: { stream: target } })
      if (input.route === 'setter') mocha.reporter(input.reporter, { stream: target })
      mocha.suite.addTest(new Mocha.Test('public API 中文', function () {}))
      const failures = await new Promise((resolve) => mocha.run(resolve))
      return { text: target.text, stdout, stderr, failures, ended: target.ended }
    }
    throw new Error('Unknown probe')
  }
  main().then(
    (value) => original(JSON.stringify(value)),
    (error) => {
      original(JSON.stringify({ probeError: error.stack }))
      process.exitCode = 1
    }
  )
}

function run(value) {
  return JSON.parse(
    execFileSync(process.execPath, ['-e', `(${probe.toString()})(${JSON.stringify(value)})`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 2_000_000,
    })
  )
}

for (const reporter of reporters) {
  test(`${reporter}: interleaved streams keep all output and lifecycle local`, () => {
    const result = run({ mode: 'interleave', reporter })
    assert(result.a.length > 0 && result.b.length > 0, 'reporter output must reach its own stream')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert(result.independent)
    assert.equal(result.ended, 0)
    assert(!result.a.includes('BETA') && !result.b.includes('ALPHA'))
    if (reporter === 'xunit') assert.deepEqual(result.done, [7, 7])
    if (reporter === 'json') {
      const doc = JSON.parse(result.a)
      assert.equal(doc.stats.tests, 3)
      assert.equal(doc.failures.length, 1)
      assert.equal(doc.pending.length, 1)
    }
    if (reporter === 'json-stream')
      assert.deepEqual(
        result.a
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)[0]),
        ['start', 'pass', 'fail', 'end']
      )
    if (['base', 'spec', 'list', 'min', 'dot'].includes(reporter)) {
      assert(result.a.includes('ALPHA failure detail'))
      assert(result.a.includes('expected-value'))
    }
  })
  test(`${reporter}: invalid explicit stream fails before listener registration`, () => {
    for (const result of run({ mode: 'invalid', reporter })) {
      assert.equal(result.error?.type, 'TypeError')
      assert.match(result.error.message, /stream/iu)
      assert.equal(result.listeners, 0)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
    }
  })
}

for (const reporter of ['min', 'list', 'progress', 'landing', 'nyan']) {
  for (const tty of [false, true])
    test(`${reporter}: explicit destination controls terminal mode ${tty}`, () => {
      const result = run({ mode: 'terminal', reporter, tty, columns: 40 })
      assert(result.text.length > 0, 'reporter output must reach its own stream')
      assert.equal(result.stdout, '')
      if (tty) assert(result.controls.length > 0)
      else assert.equal(result.controls.length, 0)
    })
}
for (const reporter of ['dot', 'progress', 'landing', 'nyan']) {
  test(`${reporter}: narrow destinations do not crash`, () => {
    for (const columns of [1, 3]) {
      const result = run({ mode: 'terminal', reporter, tty: true, columns })
      assert(result.text.length > 0, 'reporter output must reach its own stream')
      assert.equal(result.stdout, '')
    }
  })
}
for (const reporter of ['progress', 'landing']) {
  test(`${reporter}: destination width changes interactive layout`, () => {
    const narrow = run({ mode: 'terminal', reporter, tty: true, columns: 40 })
    const wide = run({ mode: 'terminal', reporter, tty: true, columns: 100 })
    assert(
      narrow.text.length > 0 && wide.text.length > narrow.text.length,
      'layout must use stream columns'
    )
  })
}
for (const reporter of ['spec', 'json', 'json-stream', 'xunit', 'tap']) {
  test(`${reporter}: write exceptions retain identity`, () => {
    const result = run({ mode: 'error', reporter })
    assert(result.same)
    assert(result.unchanged)
  })
}
for (const reporter of ['json', 'xunit']) {
  test(`${reporter}: explicit file and stream conflict before filesystem changes`, () => {
    const result = run({ mode: 'file', reporter, conflict: true })
    assert.equal(result.error?.type, 'TypeError')
    assert.match(result.error.message, /stream/iu)
    assert.match(result.error.message, /output/iu)
    assert.equal(result.exists, false)
    assert.equal(result.text, '')
  })
  test(`${reporter}: existing file output remains supported`, () => {
    const result = run({ mode: 'file', reporter, conflict: false })
    assert.equal(result.error, undefined)
    assert(result.content?.length > 0)
    assert.equal(result.stdout, '')
  })
}
for (const route of ['reporterOption', 'reporterOptions', 'setter']) {
  test(`public Mocha route ${route} reaches its selected stream`, () => {
    const result = run({ mode: 'public', reporter: 'spec', route })
    assert.equal(result.failures, 0)
    assert(result.text.includes('public API 中文'), 'reporter output must reach its own stream')
    assert.equal(result.stdout, '')
    assert.equal(result.ended, 0)
  })
}
