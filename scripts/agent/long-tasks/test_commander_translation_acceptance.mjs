import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const workspace = process.cwd()
const require = createRequire(join(workspace, 'package.json'))
const api = require(join(workspace, 'index.js'))
const marker = (key, language = 'T') => `[[${language}:${key}]]`

function make(name = 'tool') {
  const output = { out: '', err: '' }
  const command = new api.Command(name).exitOverride().configureOutput({
    writeOut: (text) => {
      output.out += text
    },
    writeErr: (text) => {
      output.err += text
    },
    getOutHasColors: () => false,
    getErrHasColors: () => false,
    getOutHelpWidth: () => 120,
    getErrHelpWidth: () => 120,
  })
  return { command, output }
}

function configure(command, translate) {
  assert.equal(
    typeof command.configureI18n,
    'function',
    'command-scoped translation must be available'
  )
  assert.equal(command.configureI18n({ translate }), command)
  return command
}

function translated(command, language = 'T', edit) {
  const calls = []
  const translate = (key, values) => {
    assert.equal(typeof key, 'string')
    assert(values && typeof values === 'object' && !Array.isArray(values))
    calls.push({ key, values: structuredClone(values) })
    return edit ? edit(key, values) : marker(key, language)
  }
  configure(command, translate)
  return { calls, translate }
}

function saw(calls, key, values) {
  const selected = calls.filter((call) => call.key === key)
  assert(selected.length, `translation key ${key} must be reached`)
  if (values !== undefined)
    assert(
      selected.some((call) => {
        try {
          assert.deepEqual(call.values, values)
          return true
        } catch {
          return false
        }
      }),
      `translation values for ${key} must preserve source data`
    )
}

function parseError(command, args, code) {
  try {
    command.parse(args, { from: 'user' })
  } catch (error) {
    assert(error instanceof api.CommanderError)
    assert.equal(error.code, code)
    assert.equal(error.exitCode, 1)
    return error
  }
  assert.fail('parse must reject invalid input')
}

test('baseline: default help and custom action output remain available', () => {
  const { command, output } = make()
  command.option('--red', 'custom option').action(() => {
    output.out += 'custom action'
  })
  assert.match(command.helpInformation(), /Usage: tool/)
  command.parse(['--red'], { from: 'user' })
  assert.equal(output.out, 'custom action')
})

test('configuration is fluent and getter returns the effective translator', () => {
  const { command } = make()
  const { translate } = translated(command)
  assert.equal(command.configureI18n().translate, translate)
})

for (const [name, setting] of Object.entries({
  array: [],
  primitive: true,
  function: () => '',
  missing: {},
  nullTranslator: { translate: null },
  numberTranslator: { translate: 1 },
}))
  test(`configuration rejects ${name}`, () => {
    const { command } = make()
    configure(command, () => undefined)
    assert.throws(() => command.configureI18n(setting), TypeError)
  })

for (const [name, value] of Object.entries({
  null: null,
  boolean: false,
  number: 3,
  object: {},
  promise: Promise.resolve('text'),
}))
  test(`translation rejects ${name} result`, () => {
    const { command, output } = make()
    assert.throws(() => {
      configure(command, () => value)
      command.outputHelp()
    }, TypeError)
    assert.equal(output.out, '')
  })

test('translation callback exceptions keep identity', () => {
  const { command } = make()
  const failure = new Error('caller translation failure')
  configure(command, () => {
    throw failure
  })
  assert.throws(
    () => command.helpInformation(),
    (error) => error === failure
  )
})

test('undefined translation retains byte-identical stock help', () => {
  const create = () =>
    make().command.option('--red', 'red value').argument('[file]', 'input file').version('1.2.3')
  const ordinary = create().helpInformation()
  const command = create()
  configure(command, () => undefined)
  assert.equal(command.helpInformation(), ordinary)
})

const helpCases = [
  ['help.usage', (c) => c, {}],
  ['help.arguments', (c) => c.argument('[file]', 'file description'), {}],
  ['help.options', (c) => c.option('--red', 'red description'), {}],
  [
    'help.commands',
    (c) => {
      c.command('build').description('build description')
      return c
    },
    {},
  ],
  ['help.helpDescription', (c) => c, {}],
  ['help.versionDescription', (c) => c.version('1.2.3'), {}],
  [
    'help.default',
    (c) => c.addOption(new api.Option('--size <n>', 'size').default('medium')),
    { value: '"medium"' },
  ],
  [
    'help.choices',
    (c) => c.addOption(new api.Option('--color <s>', 'color').choices(['red', 'green'])),
    { values: ['red', 'green'] },
  ],
  [
    'help.env',
    (c) => c.addOption(new api.Option('--file <s>', 'file').env('COMMANDER_I18N_FILE')),
    { name: 'COMMANDER_I18N_FILE' },
  ],
  [
    'help.preset',
    (c) => c.addOption(new api.Option('--color [s]', 'color').preset('auto')),
    { value: '"auto"' },
  ],
]
for (const [key, setup, values] of helpCases)
  test(`help routes ${key}`, () => {
    const command = setup(make().command)
    const { calls } = translated(command)
    const help = command.helpInformation()
    saw(calls, key, values)
    assert(help.includes(marker(key)), `translated ${key} must reach output`)
  })

for (const kind of ['default', 'choices'])
  test(`argument help translates ${kind} annotations`, () => {
    const { command } = make()
    const argument = new api.Argument('[color]', 'color')
    if (kind === 'default') argument.default('red')
    else argument.choices(['red', 'blue'])
    command.addArgument(argument)
    const { calls } = translated(command)
    assert(command.helpInformation().includes(marker(`help.${kind}`)))
    saw(
      calls,
      `help.${kind}`,
      kind === 'default' ? { value: '"red"' } : { values: ['red', 'blue'] }
    )
  })

test('child help translates global option heading in child language', () => {
  const root = make('root').command.option('--global', 'global value')
  const child = root.command('sub').configureHelp({ showGlobalOptions: true })
  const { calls } = translated(child, 'child')
  assert(child.helpInformation().includes(marker('help.globalOptions', 'child')))
  saw(calls, 'help.globalOptions', {})
})

test('existing nested and attached commands inherit later parent configuration', () => {
  const root = make('root').command
  const child = root.command('child')
  const grandchild = child.command('leaf')
  const attached = make('attached').command
  root.addCommand(attached)
  const first = translated(root, 'one')
  for (const cmd of [child, grandchild, attached]) {
    assert(cmd.helpInformation().includes(marker('help.usage', 'one')))
    assert.equal(cmd.configureI18n().translate, first.translate)
  }
  translated(root, 'two')
  for (const cmd of [child, grandchild, attached]) {
    const help = cmd.helpInformation()
    assert(help.includes(marker('help.usage', 'two')))
    assert(help.includes(marker('help.helpDescription', 'two')))
    assert(!help.includes(marker('help.helpDescription', 'one')))
  }
})

test('local override and explicit English subtree survive parent updates', () => {
  const root = make('root').command
  const local = root.command('local')
  const english = root.command('english')
  const leaf = english.command('leaf')
  translated(root, 'root')
  translated(local, 'local')
  assert.equal(english.configureI18n(null), english)
  translated(root, 'updated')
  assert(local.helpInformation().includes(marker('help.usage', 'local')))
  for (const cmd of [english, leaf]) {
    assert.match(cmd.helpInformation(), /^Usage:/)
    assert(!cmd.helpInformation().includes('[[updated:'))
  }
})

test('independent command trees and repeated rendering preserve metadata and globals', () => {
  const left = make('left')
    .command.version('1.0')
    .addOption(new api.Option('--color <s>', 'custom').choices(['red', 'blue']).default('red'))
  const right = make('right').command.version('2.0')
  const before = JSON.stringify(left.options)
  const globals = [
    process.stdout.write,
    process.stderr.write,
    console.log,
    api.Command.prototype.parse,
    api.Help.prototype.formatHelp,
  ]
  translated(left, 'left')
  translated(right, 'right')
  for (let i = 0; i < 3; i++) {
    assert(left.helpInformation().includes(marker('help.usage', 'left')))
    assert(right.helpInformation().includes(marker('help.usage', 'right')))
  }
  assert.equal(JSON.stringify(left.options), before)
  assert.deepEqual(
    [
      process.stdout.write,
      process.stderr.write,
      console.log,
      api.Command.prototype.parse,
      api.Help.prototype.formatHelp,
    ],
    globals
  )
})

test('caller descriptions, usage, matching custom group labels and hooks stay verbatim', () => {
  const { command, output } = make()
  command
    .description('Options: user description')
    .usage('USER USAGE')
    .addOption(new api.Option('--custom', 'display help for command').helpGroup('Options:'))
    .helpOption('--assist', 'custom assist')
    .version('9', '--release', 'custom release')
    .addHelpText('before', 'CUSTOM BEFORE')
    .addHelpText('after', 'CUSTOM AFTER')
  translated(command)
  command.outputHelp()
  for (const text of [
    'Options: user description',
    'USER USAGE',
    'Options:',
    'display help for command',
    'custom assist',
    'custom release',
    'CUSTOM BEFORE',
    'CUSTOM AFTER',
  ])
    assert(output.out.includes(text), `custom text ${text} must be preserved`)
  assert(!output.out.includes(marker('help.helpDescription')))
  assert(!output.out.includes(marker('help.versionDescription')))
})

test('custom Help subclass and styles still receive translated built-ins', () => {
  class Styled extends api.Help {
    styleTitle(text) {
      return `<title>${text}</title>`
    }
  }
  const { command } = make()
  command.createHelp = () => new Styled()
  translated(command)
  assert(command.helpInformation().includes(`<title>${marker('help.usage')}</title>`))
})

const errorCases = [
  [
    'missing argument',
    'error.missingArgument',
    'commander.missingArgument',
    (c) => c.argument('<file>'),
    [],
    { name: 'file' },
  ],
  [
    'missing option value',
    'error.optionMissingArgument',
    'commander.optionMissingArgument',
    (c) => c.option('--file <path>'),
    ['--file'],
    { flags: '--file <path>' },
  ],
  [
    'required option',
    'error.mandatoryOption',
    'commander.missingMandatoryOptionValue',
    (c) => c.requiredOption('--token <value>'),
    [],
    { flags: '--token <value>' },
  ],
  [
    'unknown option',
    'error.unknownOption',
    'commander.unknownOption',
    (c) => c.showSuggestionAfterError(false),
    ['--unknown'],
    { flag: '--unknown' },
  ],
  [
    'unknown command',
    'error.unknownCommand',
    'commander.unknownCommand',
    (c) => {
      c.command('build')
      c.showSuggestionAfterError(false)
      return c
    },
    ['unknown'],
    { name: 'unknown' },
  ],
  [
    'excess arguments',
    'error.excessArguments',
    'commander.excessArguments',
    (c) => c.argument('[one]'),
    ['one', 'two'],
    { expected: 1, received: 2, command: 'tool' },
  ],
  [
    'option conflict',
    'error.conflictingOptions',
    'commander.conflictingOption',
    (c) => c.addOption(new api.Option('--left').conflicts('right')).option('--right'),
    ['--left', '--right'],
    { option: '--left', conflictingOption: '--right' },
  ],
  [
    'custom argument parser',
    'error.invalidArgument',
    'commander.invalidArgument',
    (c) =>
      c.addArgument(
        new api.Argument('<file>').argParser(() => {
          throw new api.InvalidArgumentError('custom detail')
        })
      ),
    ['世界'],
    { name: 'file', value: '世界', message: 'custom detail' },
  ],
  [
    'custom option parser',
    'error.invalidOptionArgument',
    'commander.invalidArgument',
    (c) =>
      c.addOption(
        new api.Option('--size <n>').argParser(() => {
          throw new api.InvalidArgumentError('custom detail')
        })
      ),
    ['--size', '世界'],
    { flags: '--size <n>', value: '世界', message: 'custom detail' },
  ],
]
for (const [name, key, code, setup, args, values] of errorCases)
  test(`diagnostic routes ${name} without changing its error code`, () => {
    const { command, output } = make()
    setup(command)
    const { calls } = translated(command)
    const error = parseError(command, args, code)
    saw(calls, key, values)
    assert(error.message.includes(marker(key)))
    assert(output.err.includes(marker(key)))
  })

test('environment parser diagnostic keeps source and custom message', () => {
  const name = 'COMMANDER_I18N_TEST_SIZE'
  const previous = process.env[name]
  process.env[name] = '世界'
  try {
    const { command } = make()
    command.addOption(
      new api.Option('--size <n>').env(name).argParser(() => {
        throw new api.InvalidArgumentError('custom env detail')
      })
    )
    const { calls } = translated(command)
    parseError(command, [], 'commander.invalidArgument')
    saw(calls, 'error.invalidEnvOption', { name, value: '世界', message: 'custom env detail' })
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

for (const kind of ['option', 'argument'])
  test(`${kind} choices translate before their diagnostic wrapper`, () => {
    const { command } = make()
    if (kind === 'option')
      command.addOption(new api.Option('--color <value>').choices(['red', 'blue']))
    else command.addArgument(new api.Argument('<color>').choices(['red', 'blue']))
    const { calls } = translated(command)
    parseError(
      command,
      kind === 'option' ? ['--color', 'green'] : ['green'],
      'commander.invalidArgument'
    )
    saw(calls, 'error.invalidChoice', { value: 'green', choices: ['red', 'blue'] })
    const wrapper = calls.find(
      (c) => c.key === (kind === 'option' ? 'error.invalidOptionArgument' : 'error.invalidArgument')
    )
    assert.equal(wrapper?.values.message, marker('error.invalidChoice'))
  })

for (const kind of ['option', 'command'])
  test(`${kind} suggestions are localized separately and respect disabling`, () => {
    for (const enabled of [true, false]) {
      const { command } = make()
      if (kind === 'option') command.option('--verbose')
      else command.command('build')
      command.showSuggestionAfterError(enabled)
      const { calls } = translated(command)
      const error = parseError(
        command,
        [kind === 'option' ? '--verboze' : 'buidl'],
        kind === 'option' ? 'commander.unknownOption' : 'commander.unknownCommand'
      )
      assert.equal(
        calls.some((c) => c.key === 'error.suggestion'),
        enabled
      )
      if (enabled) {
        saw(calls, 'error.suggestion', { candidates: [kind === 'option' ? '--verbose' : 'build'] })
        assert(error.message.includes(marker('error.suggestion')))
      }
    }
  })

test('translation values are detached from choices and defaults', () => {
  const { command } = make()
  const option = new api.Option('--color <s>').choices(['red', 'blue']).default('red')
  command.addOption(option)
  configure(command, (_key, values) => {
    for (const value of Object.values(values))
      if (Array.isArray(value)) {
        try {
          value.splice(0, value.length, 'changed')
        } catch (error) {
          assert(error instanceof TypeError)
        }
      }
    return undefined
  })
  command.helpInformation()
  assert.deepEqual(option.argChoices, ['red', 'blue'])
  command.parse(['--color', 'blue'], { from: 'user' })
  assert.equal(command.opts().color, 'blue')
  assert.equal(option.defaultValue, 'red')
})

test('custom error text and outputError routing remain caller-owned', () => {
  const { command, output } = make()
  const routed = []
  command.configureOutput({
    outputError: (text, write) => {
      routed.push(text)
      write(`ROUTED:${text}`)
    },
  })
  const { calls } = translated(command)
  assert.throws(
    () => command.error('exact custom message', { code: 'custom', exitCode: 7 }),
    (e) => e.code === 'custom' && e.exitCode === 7 && e.message === 'exact custom message'
  )
  assert.equal(routed.length, 1)
  assert(output.err.includes('ROUTED:exact custom message'))
  assert.equal(calls.length, 0)
})

test('built-in translated errors still pass through outputError', () => {
  const { command, output } = make()
  const routed = []
  command.configureOutput({
    outputError: (text, write) => {
      routed.push(text)
      write(`PREFIX:${text}`)
    },
  })
  translated(command)
  parseError(command, ['--unknown'], 'commander.unknownOption')
  assert.equal(routed.length, 1)
  assert(routed[0].includes(marker('error.unknownOption')))
  assert(output.err.includes(`PREFIX:${marker('error.unknownOption')}`))
})

test('parse errors preserve translation callback exceptions', () => {
  const { command } = make()
  const error = new Error('translation failed during parsing')
  configure(command, () => {
    throw error
  })
  assert.throws(
    () => command.parse(['--unknown'], { from: 'user' }),
    (e) => e === error
  )
})

test('nested diagnostics use child configuration and retain raw flag data', () => {
  const { command } = make('parent')
  const child = command.command('child').showSuggestionAfterError(false)
  translated(command, 'parent')
  const { calls } = translated(child, 'child')
  const flag = "--unknown'世界"
  const error = parseError(command, ['child', flag], 'commander.unknownOption')
  assert(error.message.includes(marker('error.unknownOption', 'child')))
  saw(calls, 'error.unknownOption', { flag })
})

test('version values are emitted verbatim with translation enabled', () => {
  const { command, output } = make()
  command.version('release-value')
  const { calls } = translated(command)
  assert.throws(
    () => command.parse(['--version'], { from: 'user' }),
    (e) => e.code === 'commander.version' && e.exitCode === 0
  )
  assert.equal(output.out, 'release-value\n')
  assert.equal(calls.length, 0)
})

test('parseAsync keeps command-local diagnostics across independent roots', async () => {
  const roots = [make('left'), make('right')]
  for (const [index, { command }] of roots.entries()) {
    command.option('--color <s>').showSuggestionAfterError(false)
    translated(command, String(index))
  }
  const outcomes = await Promise.allSettled(
    roots.map(({ command }) => command.parseAsync(['--unknown'], { from: 'user' }))
  )
  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome.status, 'rejected')
    assert.equal(outcome.reason.code, 'commander.unknownOption')
    assert(outcome.reason.message.includes(marker('error.unknownOption', String(index))))
  }
})

test('implicit help command uses target command language', () => {
  const { command, output } = make('root')
  const child = command.command('build')
  translated(command, 'root')
  translated(child, 'child')
  try {
    command.parse(['help', 'build'], { from: 'user' })
  } catch (error) {
    assert.equal(error.code, 'commander.help')
    assert.equal(error.exitCode, 0)
  }
  assert(output.out.includes(marker('help.usage', 'child')))
  assert(!output.out.includes(marker('help.usage', 'root')))
})

test('ESM entry offers the same command-local feature', async () => {
  const esm = await import(pathToFileURL(join(workspace, 'esm.mjs')))
  const command = new esm.Command('esm')
  translated(command, 'esm')
  assert(command.helpInformation().includes(marker('help.usage', 'esm')))
})

test('public TypeScript declarations accept callbacks and reject invalid return types', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-i18n-types-'))
  try {
    const path = join(dir, 'check.ts')
    await writeFile(
      path,
      `import { Command } from ${JSON.stringify(workspace)};
const command = new Command().configureI18n({ translate(key, values) { const name: string = key; return name || undefined; } }).name('translated');
const configuration = command.configureI18n();
if (configuration?.translate) { const value: string | undefined = configuration.translate('help.usage', {}); }
command.configureI18n(null).name('english');
// @ts-expect-error translation return type must be text or undefined
command.configureI18n({ translate: () => 3 });
// @ts-expect-error translation is synchronous
command.configureI18n({ translate: async () => 'text' });
`
    )
    try {
      execFileSync(
        process.execPath,
        [
          join(workspace, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          'Node16',
          '--moduleResolution',
          'Node16',
          '--types',
          'node',
          '--typeRoots',
          join(workspace, 'node_modules/@types'),
          path,
        ],
        { cwd: workspace, timeout: 30000, stdio: 'pipe' }
      )
    } catch (error) {
      assert.fail(String(error.stdout ?? '') + String(error.stderr ?? ''))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
