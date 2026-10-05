import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  readlinkSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { test } from 'node:test'

const require = createRequire(join(process.cwd(), 'package.json'))
const shell = require('./shell.js')
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

function instance(options) {
  assert.equal(typeof shell.create, 'function', 'Independent ShellJS instances must be available')
  return shell.create(options)
}

function scenario(name, body) {
  test(name, { timeout: 15000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-instance-')))
    const a = join(root, 'one space'),
      b = join(root, 'two space')
    const cwd = process.cwd(),
      chdir = process.chdir,
      silent = shell.config.silent
    const previous = process.env.OLDPWD
    for (const dir of [a, b]) {
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'a.txt'), dir === a ? 'alpha\nbeta\nbeta\n' : 'other\n')
      writeFileSync(join(dir, 'b.txt'), 'bravo\n')
      writeFileSync(join(dir, 'sub/nested.txt'), 'nested\n')
    }
    shell.config.silent = true
    process.chdir = () => {
      throw new Error('Instance command changed process cwd')
    }
    try {
      const one = instance({ cwd: a }),
        two = instance({ cwd: b })
      await body({ root, a, b, one, two })
      assert.equal(process.cwd(), cwd)
      assert.equal(process.env.OLDPWD, previous)
    } finally {
      process.chdir = chdir
      if (process.cwd() !== cwd) chdir(cwd)
      shell.config.silent = silent
      if (previous === undefined) delete process.env.OLDPWD
      else process.env.OLDPWD = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('baseline: default export and absolute operands keep ordinary behavior', () => {
  const value = shell.cat(join(process.cwd(), 'package.json'))
  assert.equal(value.code, 0)
  assert.equal(JSON.parse(value.stdout).name, 'shelljs')
  assert.equal(String(shell.pwd()), process.cwd())
})

for (const [name, options] of [
  ['null', null],
  ['array', []],
  ['number', 2],
  ['cwd number', { cwd: 2 }],
  ['cwd empty', { cwd: '' }],
  ['config null', { config: null }],
  ['config array', { config: [] }],
  ['env null', { env: null }],
  ['env array', { env: [] }],
])
  test(`creation validates ${name}`, () => {
    assert.equal(typeof shell.create, 'function', 'Independent ShellJS instances must be available')
    assert.throws(() => shell.create(options), TypeError)
  })

scenario('creation checks the directory without mutating the parent', ({ root, one, a }) => {
  assert.throws(() => instance({ cwd: join(root, 'absent') }))
  assert.throws(() => instance({ cwd: join(a, 'a.txt') }))
  assert.equal(String(one.pwd()), a)
  assert.equal(String(instance().pwd()), process.cwd())
  assert.equal(String(instance(undefined).pwd()), process.cwd())
})

scenario('nested creation resolves relative cwd and snapshots parent state', ({ one, two, a }) => {
  one.env.SHELLJS_INSTANCE = 'parent'
  one.config.noglob = true
  const child = one.create({ cwd: 'sub' }),
    sibling = one.create()
  one.cd('sub')
  one.env.SHELLJS_INSTANCE = 'changed'
  one.config.noglob = false
  assert.equal(String(child.pwd()), join(a, 'sub'))
  assert.equal(String(sibling.pwd()), a)
  assert.equal(child.env.SHELLJS_INSTANCE, 'parent')
  assert.equal(child.config.noglob, true)
  assert.equal(two.env.SHELLJS_INSTANCE, undefined)
})

const reads = [
  ['cat', (s) => s.cat('a.txt'), 'alpha\nbeta\nbeta\n'],
  ['grep', (s) => s.grep('alpha', 'a.txt'), 'alpha\n'],
  ['head', (s) => s.head({ '-n': 1 }, 'a.txt'), 'alpha\n'],
  ['tail', (s) => s.tail({ '-n': 1 }, 'a.txt'), 'beta\n'],
  ['sed', (s) => s.sed('alpha', 'first', 'a.txt'), 'first\nbeta\nbeta\n'],
  ['sort', (s) => s.sort('-r', 'a.txt'), 'beta\nbeta\nalpha\n'],
  ['uniq', (s) => s.uniq('a.txt'), 'alpha\nbeta\n'],
]
for (const [name, run, expected] of reads)
  scenario(`relative read command ${name}`, ({ one, two, b }) => {
    const result = run(one)
    assert.equal(result.stdout, expected)
    assert.equal(result.code, 0)
    assert.equal(String(two.pwd()), b)
  })

scenario('cat arrays and globs retain order and use the instance directory', ({ one }) => {
  assert.equal(one.cat(['b.txt', 'a.txt']).stdout, 'bravo\nalpha\nbeta\nbeta\n')
  assert.equal(one.cat('*.txt').stdout, 'alpha\nbeta\nbeta\nbravo\n')
})
scenario('absolute operands remain usable across instances', ({ one, b }) => {
  assert.equal(one.cat(join(b, 'a.txt')).stdout, 'other\n')
})
scenario('ls relative and structured output preserve names', ({ one }) => {
  assert.deepEqual(Array.from(one.ls('*.txt')), ['a.txt', 'b.txt'])
  assert.deepEqual(
    Array.from(one.ls('-l', 'a.txt'), (x) => x.name),
    ['a.txt']
  )
  assert(one.ls('-R', 'sub').includes('nested.txt'))
})
scenario('find recursive output preserves relative prefixes', ({ one }) => {
  assert.deepEqual(Array.from(one.find('sub')).sort(), ['sub', 'sub/nested.txt'])
})
scenario('grep file-name output preserves relative operands', ({ one }) => {
  assert.equal(one.grep('-l', 'a', ['a.txt', 'b.txt']).stdout, 'a.txt\nb.txt\n')
})
scenario('test flags use the owner directory', ({ one, two }) => {
  one.touch('only-one')
  assert.equal(one.test('-f', 'only-one'), true)
  assert.equal(two.test('-e', 'only-one'), false)
  assert.equal(one.test('-d', 'sub'), true)
})

const writes = [
  [
    'mkdir',
    (s) => s.mkdir('-p', 'created/deep'),
    (a) => assert(statSync(join(a, 'created/deep')).isDirectory()),
  ],
  [
    'touch',
    (s) => s.touch(['fresh-a', 'fresh-b']),
    (a) => assert(existsSync(join(a, 'fresh-a')) && existsSync(join(a, 'fresh-b'))),
  ],
  [
    'chmod',
    (s) => s.chmod('600', 'a.txt'),
    (a) => assert.equal(statSync(join(a, 'a.txt')).mode & 0o777, 0o600),
  ],
  [
    'cp',
    (s) => s.cp('a.txt', 'copy.txt'),
    (a) => assert.equal(readFileSync(join(a, 'copy.txt'), 'utf8'), 'alpha\nbeta\nbeta\n'),
  ],
  [
    'mv',
    (s) => s.mv('a.txt', 'moved.txt'),
    (a) => assert(!existsSync(join(a, 'a.txt')) && existsSync(join(a, 'moved.txt'))),
  ],
  ['rm', (s) => s.rm('a.txt'), (a) => assert(!existsSync(join(a, 'a.txt')))],
  [
    'sed in place',
    (s) => s.sed('-i', 'alpha', 'first', 'a.txt'),
    (a) => assert.equal(readFileSync(join(a, 'a.txt'), 'utf8'), 'first\nbeta\nbeta\n'),
  ],
  [
    'ln hard',
    (s) => s.ln('a.txt', 'hard.txt'),
    (a) => assert.equal(statSync(join(a, 'a.txt')).ino, statSync(join(a, 'hard.txt')).ino),
  ],
  [
    'ln symbolic',
    (s) => s.ln('-s', '../a.txt', 'sub/symbol.txt'),
    (a) => {
      assert.equal(readlinkSync(join(a, 'sub/symbol.txt')), '../a.txt')
      assert.equal(readFileSync(join(a, 'sub/symbol.txt'), 'utf8'), 'alpha\nbeta\nbeta\n')
    },
  ],
  [
    'to',
    (s) => s.ShellString('payload').to('out.txt'),
    (a) => assert.equal(readFileSync(join(a, 'out.txt'), 'utf8'), 'payload'),
  ],
  [
    'toEnd',
    (s) => s.ShellString('tail').toEnd('b.txt'),
    (a) => assert.equal(readFileSync(join(a, 'b.txt'), 'utf8'), 'bravo\ntail'),
  ],
]
for (const [name, run, verify] of writes)
  scenario(`relative write command ${name}`, ({ one, a, b }) => {
    const result = run(one)
    assert.equal(result.code, ['to', 'toEnd'].includes(name) ? undefined : 0)
    verify(a)
    assert.equal(readFileSync(join(b, 'a.txt'), 'utf8'), 'other\n')
    assert.equal(readFileSync(join(b, 'b.txt'), 'utf8'), 'bravo\n')
  })
scenario('cp and rm recursive glob paths remain local', ({ one, a, b }) => {
  one.mkdir('copies')
  assert.equal(one.cp('*.txt', 'copies').code, 0)
  assert.equal(one.cp('-R', 'sub', 'copies').code, 0)
  assert(existsSync(join(a, 'copies/sub/nested.txt')))
  assert.equal(one.rm('-rf', 'copies').code, 0)
  assert(!existsSync(join(a, 'copies')))
  assert(existsSync(join(b, 'sub/nested.txt')))
})

scenario('cd and previous cwd are instance-local', ({ one, two, a, b }) => {
  assert.equal(one.cd('sub').code, 0)
  assert.equal(String(one.pwd()), join(a, 'sub'))
  assert.equal(one.env.OLDPWD, a)
  assert.equal(String(two.pwd()), b)
  assert.equal(one.cd('-').code, 0)
  assert.equal(String(one.pwd()), a)
  assert.equal(one.cd('absent').code, 1)
  assert.equal(String(one.pwd()), a)
})
scenario('cd home remains local', ({ one, two, b }) => {
  assert.equal(one.cd().code, 0)
  assert.equal(String(one.pwd()), realpathSync(homedir()))
  assert.equal(String(two.pwd()), b)
})
scenario('directory stacks and stack flags remain separate', ({ one, two, a, b }) => {
  one.pushd('sub')
  assert.deepEqual(Array.from(one.dirs()), [join(a, 'sub'), a])
  assert.deepEqual(Array.from(two.dirs()), [b])
  one.popd()
  assert.equal(String(one.pwd()), a)
  one.pushd('-n', 'sub')
  assert.equal(String(one.pwd()), a)
  one.dirs('-c')
  assert.deepEqual(Array.from(one.dirs()), [a])
})
scenario('error state and successful reset belong to each instance', ({ one, two }) => {
  const value = one.cat('missing-file')
  assert.notEqual(value.code, 0)
  const error = one.error(),
    code = one.errorCode()
  assert.match(error, /missing-file/u)
  two.cat('a.txt')
  assert.equal(two.error(), null)
  assert.equal(two.errorCode(), 0)
  assert.equal(one.error(), error)
  assert.equal(one.errorCode(), code)
  one.cat('a.txt')
  assert.equal(one.error(), null)
  assert.equal(one.errorCode(), 0)
})
scenario('fatal errors, set flags and config reset are isolated', ({ one, two }) => {
  one.set('-e')
  assert.equal(one.config.fatal, true)
  assert.equal(two.config.fatal, false)
  assert.throws(() => one.cat('missing-file'))
  assert.doesNotThrow(() => two.cat('missing-file'))
  one.config.reset()
  assert.equal(one.config.fatal, false)
  one.set('-f')
  assert.equal(one.config.noglob, true)
  assert.equal(two.config.noglob, false)
})
scenario('configuration and environment copies preserve caller-owned objects', ({ a, two }) => {
  const config = { silent: true, globOptions: { dot: true } },
    env = { SHELLJS_INSTANCE: 'custom' }
  const options = { cwd: a, config, env },
    before = JSON.stringify(options)
  const one = instance(options)
  one.config.globOptions.dot = false
  one.env.SHELLJS_INSTANCE = 'changed'
  assert.equal(JSON.stringify(options), before)
  assert.notEqual(one.config, two.config)
  assert.notEqual(one.config.globOptions, two.config.globOptions)
  assert.equal(two.env.SHELLJS_INSTANCE, undefined)
})
scenario('which uses relative instance PATH entries', ({ one, two, a }) => {
  writeFileSync(join(a, 'local-tool'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(a, 'local-tool'), 0o755)
  one.env.PATH = `.${delimiter}${process.env.PATH}`
  two.env.PATH = one.env.PATH
  assert.equal(String(one.which('local-tool')), join(a, 'local-tool'))
  assert.equal(two.which('local-tool'), null)
})

scenario('detached commands keep their instance', ({ one, two, a }) => {
  const { cat, cd, pwd } = one
  two.cat('a.txt')
  assert.equal(cat('a.txt').stdout, 'alpha\nbeta\nbeta\n')
  cd('sub')
  assert.equal(String(pwd()), join(a, 'sub'))
})
scenario('delayed ShellString pipes use the owner current directory', ({ one, two, a, b }) => {
  const first = one.cat('a.txt'),
    second = new one.ShellString('data')
  two.cd('sub')
  one.cd('sub')
  assert.equal(first.grep('alpha').to('piped.txt').code, 0)
  assert.equal(second.to('constructed.txt').code, undefined)
  assert.equal(readFileSync(join(a, 'sub/piped.txt'), 'utf8'), 'alpha\n')
  assert.equal(readFileSync(join(a, 'sub/constructed.txt'), 'utf8'), 'data')
  assert(!existsSync(join(b, 'sub/piped.txt')))
})
scenario('pipe data, options and replacement literals are not treated as paths', ({ one }) => {
  assert.equal(
    one.ShellString('x/y\nx/y\nz\n').grep('x/y').sed('x/y', 'a/b').sort().uniq().stdout,
    'a/b\n'
  )
})
scenario(
  'reentrant sed callback can use another instance without losing state',
  ({ one, two, a, b }) => {
    const current = process.cwd()
    const result = one.sed(
      '-i',
      'alpha',
      () => {
        assert.equal(process.cwd(), current)
        assert.equal(two.cat('a.txt').stdout, 'other\n')
        two.cd('sub')
        two.ShellString('inner').to('inner.txt')
        return 'outer'
      },
      'a.txt'
    )
    assert.equal(result.code, 0)
    assert.equal(readFileSync(join(a, 'a.txt'), 'utf8'), 'outer\nbeta\nbeta\n')
    assert.equal(readFileSync(join(b, 'sub/inner.txt'), 'utf8'), 'inner')
    assert.equal(String(one.pwd()), a)
  }
)

const childScript =
  'process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.SHELLJS_INSTANCE}))'
const pipeScript =
  'process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.SHELLJS_INSTANCE,input:require("fs").readFileSync(0,"utf8")}))'
for (const kind of ['exec', 'cmd']) {
  scenario(`${kind} uses instance cwd and environment`, ({ one, two, a, b }) => {
    one.env.SHELLJS_INSTANCE = 'one'
    two.env.SHELLJS_INSTANCE = 'two'
    const run = (s) =>
      kind === 'exec'
        ? s.exec(`${quote(process.execPath)} -e ${quote(childScript)}`, { silent: true })
        : s.cmd(process.execPath, '-e', childScript)
    const x = run(one),
      y = run(two)
    assert.equal(x.code, 0)
    assert.equal(y.code, 0)
    assert.deepEqual(JSON.parse(x.stdout), { cwd: a, value: 'one' })
    assert.deepEqual(JSON.parse(y.stdout), { cwd: b, value: 'two' })
  })
  scenario(
    `${kind} explicit cwd is relative to the instance and invocation-local`,
    ({ one, a }) => {
      const args = { cwd: 'sub', env: { SHELLJS_INSTANCE: 'override' }, silent: true }
      const result =
        kind === 'exec'
          ? one.exec(`${quote(process.execPath)} -e ${quote(childScript)}`, args)
          : one.cmd(process.execPath, '-e', childScript, args)
      assert.equal(result.code, 0)
      assert.deepEqual(JSON.parse(result.stdout), { cwd: join(a, 'sub'), value: 'override' })
      assert.equal(String(one.pwd()), a)
      assert.equal(args.cwd, 'sub')
    }
  )
  scenario(`${kind} ShellString piping keeps the owner and data`, ({ one, two, a }) => {
    const pipe = one.ShellString('literal data')
    two.cd('sub')
    one.env.SHELLJS_INSTANCE = 'pipe'
    const result =
      kind === 'exec'
        ? pipe.exec(`${quote(process.execPath)} -e ${quote(pipeScript)}`, { silent: true })
        : pipe.cmd(process.execPath, '-e', pipeScript)
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), { cwd: a, value: 'pipe', input: 'literal data' })
  })
}
scenario(
  'async exec snapshots state, returns handles and permits simultaneous instances',
  async ({ one, two, a, b }) => {
    const script =
      'setTimeout(()=>process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.SHELLJS_INSTANCE})),30)'
    const command = `${quote(process.execPath)} -e ${quote(script)}`
    const run = (s, expected) =>
      new Promise((resolve, reject) => {
        const child = s.exec(command, { silent: true }, (code, stdout, stderr) => {
          try {
            assert.equal(code, 0)
            assert.equal(stderr, '')
            assert.deepEqual(JSON.parse(stdout), expected)
            resolve()
          } catch (error) {
            reject(error)
          }
        })
        assert.equal(typeof child.kill, 'function')
        assert(child.pid > 0)
      })
    one.env.SHELLJS_INSTANCE = 'one'
    two.env.SHELLJS_INSTANCE = 'two'
    const pending = [run(one, { cwd: a, value: 'one' }), run(two, { cwd: b, value: 'two' })]
    one.cd('sub')
    two.cd('sub')
    one.env.SHELLJS_INSTANCE = 'later'
    two.env.SHELLJS_INSTANCE = 'later'
    await Promise.all(pending)
  }
)
scenario('exec stderr and nonzero status remain ordinary and isolated', ({ one, two }) => {
  const script = 'process.stderr.write("failure");process.exitCode=7'
  const value = one.exec(`${quote(process.execPath)} -e ${quote(script)}`, { silent: true })
  assert.equal(value.code, 7)
  assert.equal(value.stderr, 'failure')
  assert.equal(two.errorCode(), 0)
})
