/**
 * @test-meta
 * title: 工作区命令行调度
 * summary: 发布契约：验证子命令调度与运行器集成路径。
 * area: packages
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { test } from 'bun:test'

import { parseWorkspaceCliArgs } from '../dist/cli/args.js'
import { formatWorkspaceCliError, formatWorkspaceCliSuccess } from '../dist/cli/output.js'
import { runWorkspaceCli } from '../dist/cli/runner.js'
import { WorkspaceCliError } from '../dist/cli/types.js'
import { WorkspaceError } from '../dist/errors.js'

test('parse human read command', () => {
  assert.deepEqual(
    parseWorkspaceCliArgs(['read', 'src/index.ts', '--start', '2', '--end', '9', '--max-bytes', '1200', '--json']),
    {
      command: 'read',
      json: true,
      cwd: null,
      args: {
        path: 'src/index.ts',
        startLine: 2,
        endLine: 9,
        maxBytes: 1200,
      },
    }
  )
})

test('parse machine tool call command', () => {
  assert.deepEqual(
    parseWorkspaceCliArgs([
      'tools',
      'call',
      'ws_read',
      '--args-json',
      '{"path":"src/index.ts","maxBytes":4000}',
      '--json',
    ]),
    {
      command: 'tools.call',
      json: true,
      cwd: null,
      args: {
        toolName: 'ws_read',
        argsJson: '{"path":"src/index.ts","maxBytes":4000}',
        argsFile: null,
      },
    }
  )
})

test('parse global flags before command', () => {
  assert.deepEqual(parseWorkspaceCliArgs(['--json', 'read', 'src/index.ts']), {
    command: 'read',
    json: true,
    cwd: null,
    args: {
      path: 'src/index.ts',
      startLine: undefined,
      endLine: undefined,
      maxBytes: undefined,
    },
  })

  assert.deepEqual(parseWorkspaceCliArgs(['--cwd', '/tmp/project', 'read', 'src/index.ts']), {
    command: 'read',
    json: false,
    cwd: '/tmp/project',
    args: {
      path: 'src/index.ts',
      startLine: undefined,
      endLine: undefined,
      maxBytes: undefined,
    },
  })
})

test('tools commands default to json output', () => {
  assert.deepEqual(parseWorkspaceCliArgs(['tools', 'list']), {
    command: 'tools.list',
    json: true,
    cwd: null,
    args: {},
  })

  assert.deepEqual(parseWorkspaceCliArgs(['tools', 'workflow']), {
    command: 'tools.workflow',
    json: true,
    cwd: null,
    args: {
      stepsJson: null,
      stepsFile: null,
    },
  })
})

test('parse validates missing command arguments', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['tools', 'call']),
    'ARGUMENT_ERROR',
    /tools call requires <toolName>/,
    {}
  )
})

test('parse validates missing positional arguments after leading global flags', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['--cwd', '/tmp/project', 'tools', 'call']),
    'ARGUMENT_ERROR',
    /tools call requires <toolName>/,
    {}
  )
})

test('parse reports unknown command details', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['bogus']),
    'UNKNOWN_COMMAND',
    /Unknown command: bogus/,
    { command: 'bogus' }
  )
})

test('parse reports unknown tools action details', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['tools', 'bogus']),
    'UNKNOWN_COMMAND',
    /Unknown command: tools\.bogus/,
    { command: 'tools.bogus' }
  )
})

test('parse validates missing flag values', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'src/index.ts', '--max-bytes']),
    'ARGUMENT_ERROR',
    /--max-bytes requires a value/,
    { flag: '--max-bytes' }
  )
})

test('parse rejects empty numeric flag values', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'src/index.ts', '--max-bytes', '']),
    'ARGUMENT_ERROR',
    /--max-bytes requires a value/,
    { flag: '--max-bytes' }
  )
})

test('parse rejects empty cwd flag values', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['--cwd', '', 'status']),
    'ARGUMENT_ERROR',
    /--cwd requires a value/,
    { flag: '--cwd' }
  )
})

test('parse validates numeric flags', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'src/index.ts', '--start', 'NaN']),
    'ARGUMENT_ERROR',
    /--start must be a number/,
    { flag: '--start', value: 'NaN' }
  )
})

test('parse rejects extra status positional arguments', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['status', 'extra']),
    'ARGUMENT_ERROR',
    /status received unexpected argument/,
    { command: 'status', argument: 'extra' }
  )
})

test('parse rejects extra read positional arguments', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'src/index.ts', 'extra']),
    'ARGUMENT_ERROR',
    /read received unexpected argument/,
    { command: 'read', argument: 'extra' }
  )
})

test('parse rejects unknown read flags', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'src/index.ts', '--bogus']),
    'ARGUMENT_ERROR',
    /read received unknown flag/,
    { command: 'read', flag: '--bogus' }
  )
})

test('parse rejects extra tools list positional arguments', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['tools', 'list', 'extra']),
    'ARGUMENT_ERROR',
    /tools list received unexpected argument/,
    { command: 'tools.list', argument: 'extra' }
  )
})

test('parse rejects unknown tools call flags', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['tools', 'call', 'ws_read', '--bad']),
    'ARGUMENT_ERROR',
    /tools call received unknown flag/,
    { command: 'tools.call', flag: '--bad' }
  )
})

test('parse rejects arguments after status json flag', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['status', '--json', 'extra']),
    'ARGUMENT_ERROR',
    /status received unexpected argument/,
    { command: 'status', argument: 'extra' }
  )
})

test('parse rejects flags after status json flag', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['status', '--json', '--bad']),
    'ARGUMENT_ERROR',
    /status received unknown flag/,
    { command: 'status', flag: '--bad' }
  )
})

test('parse rejects arguments after search regex flag', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['search', 'foo', '--regex', 'extra']),
    'ARGUMENT_ERROR',
    /search received unexpected argument/,
    { command: 'search', argument: 'extra' }
  )
})

test('parse rejects arguments after tools list json flag', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['tools', 'list', '--json', 'extra']),
    'ARGUMENT_ERROR',
    /tools list received unexpected argument/,
    { command: 'tools.list', argument: 'extra' }
  )
})

test('parse rejects arguments after read json flag', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'src/index.ts', '--json', 'extra']),
    'ARGUMENT_ERROR',
    /read received unexpected argument/,
    { command: 'read', argument: 'extra' }
  )
})

test('parse validates repeated cwd flag values', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['status', '--cwd', '/tmp', '--cwd']),
    'ARGUMENT_ERROR',
    /--cwd requires a value/,
    { flag: '--cwd' }
  )
})

test('parse validates repeated numeric flag values', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['read', 'p', '--start', '1', '--start']),
    'ARGUMENT_ERROR',
    /--start requires a value/,
    { flag: '--start' }
  )
})

test('parse validates repeated tools args flag values', () => {
  assertWorkspaceCliError(
    () => parseWorkspaceCliArgs(['tools', 'call', 'x', '--args-json', '{}', '--args-json']),
    'ARGUMENT_ERROR',
    /--args-json requires a value/,
    { flag: '--args-json' }
  )
})

test('format success as JSON envelope', () => {
  const formatted = formatWorkspaceCliSuccess({
    kind: 'velaros.workspaceCli.status',
    workspaceRoot: '/tmp/project',
    durationMs: 7,
    result: { ok: true },
    json: true,
    text: 'status: ok',
  })
  assert.equal(formatted.exitCode, 0)
  assert.deepEqual(JSON.parse(formatted.text), {
    schemaVersion: 1,
    kind: 'velaros.workspaceCli.status',
    status: 'ok',
    workspaceRoot: '/tmp/project',
    durationMs: 7,
    result: { ok: true },
  })
})

test('format errors as stable JSON envelopes', () => {
  const formatted = formatWorkspaceCliError(
    new WorkspaceCliError('UNKNOWN_TOOL', 'Unknown workspace tool: x', 2, { toolName: 'x' }),
    true
  )
  assert.equal(formatted.exitCode, 2)
  assert.deepEqual(JSON.parse(formatted.text), {
    schemaVersion: 1,
    kind: 'velaros.workspaceCli.error',
    status: 'error',
    error: {
      code: 'UNKNOWN_TOOL',
      message: 'Unknown workspace tool: x',
      details: { toolName: 'x' },
    },
  })
})

test('format workspace domain errors as stable JSON envelopes', () => {
  const formatted = formatWorkspaceCliError(
    new WorkspaceError(
      'TARGET_NOT_FOUND',
      'Could not find requested target',
      { path: 'src/index.ts', matches: 0 },
      'Refresh symbols and try again.'
    ),
    true
  )
  assert.equal(formatted.exitCode, 1)
  assert.deepEqual(JSON.parse(formatted.text), {
    schemaVersion: 1,
    kind: 'velaros.workspaceCli.error',
    status: 'error',
    error: {
      code: 'TARGET_NOT_FOUND',
      message: 'Could not find requested target',
      details: {
        path: 'src/index.ts',
        matches: 0,
        suggestedNextAction: 'Refresh symbols and try again.',
      },
    },
  })
})

test('runner reads a file with JSON envelope', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(
    ['read', 'src/index.ts', '--max-bytes', '2000', '--json'],
    { cwd: root }
  )
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.read')
  assert.equal(parsed.status, 'ok')
  assert.equal(parsed.workspaceRoot, root)
  assert.match(parsed.result.content, /export const value/)
})

test('runner reads a file without range flags', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(['read', 'src/index.ts', '--json'], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.read')
  assert.equal(parsed.status, 'ok')
  assert.match(parsed.result.content, /export function hello/)
})

test('runner commit-edit applies an input file transaction', async () => {
  const root = await makeCliFixture()
  const inputPath = path.join(root, 'edit.json')
  await fs.writeFile(
    inputPath,
    JSON.stringify({
      operations: [{
        operation: {
          type: 'replace_text',
          path: 'src/index.ts',
          oldText: 'value = 1',
          newText: 'value = 2',
        },
      }],
    })
  )

  const result = await runWorkspaceCli(['commit-edit', '--input', inputPath, '--json'], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.commit-edit')
  assert.equal(parsed.result.status, 'applied')
  assert.match(await fs.readFile(path.join(root, 'src/index.ts'), 'utf8'), /value = 2/)
})

test('runner commit-edit reports missing input files with stable error code', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(['commit-edit', '--input', 'missing.json', '--json'], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.status, 'error')
  assert.equal(parsed.error.code, 'INPUT_FILE_ERROR')
  assert.equal(parsed.error.details.path, 'missing.json')
  assert.match(parsed.error.details.message, /missing\.json/)
})

test('runner emits JSON parse errors for tools commands after leading global flags', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(['--cwd', root, 'tools', 'bogus'])
  assert.equal(result.exitCode, 2)
  assert.doesNotThrow(() => JSON.parse(result.text))
  assert.equal(JSON.parse(result.text).error.code, 'UNKNOWN_COMMAND')
})

test('runner lists workspace agent tools', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(['tools', 'list'], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.tools.list')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'ws_read'))
  assert.ok(Object.keys(parsed.result.$defs).length > 0)
  assert.ok(JSON.stringify(parsed.result.tools).includes('#/$defs/'))
  assert.ok(JSON.stringify(parsed.result).length <= 40_000)
})

test('runner lists ws_file_stat agent tool', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(['tools', 'list'], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.tools.list')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'ws_file_stat'))
})

test('runner calls a workspace agent tool', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    '{"path":"src/index.ts","maxBytes":2000}',
  ], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.tools.call')
  assert.match(parsed.result.files[0].content, /hello/)
})

test('runner persists target ids across machine tool CLI invocations', async () => {
  const root = await makeCliFixture()
  const resolved = await runWorkspaceCli([
    'tools',
    'call',
    'ws_resolve_target',
    '--args-json',
    '{"path":"src/index.ts","target":{"exactSnippet":"return value"},"expectedMatches":1}',
  ], { cwd: root })
  assert.equal(resolved.exitCode, 0)
  const targetId = JSON.parse(resolved.text).result.target.targetId

  const evidence = await runWorkspaceCli([
    'tools',
    'call',
    'ws_build_evidence',
    '--args-json',
    JSON.stringify({ target: { targetId }, include: { currentWindow: true } }),
  ], { cwd: root })
  assert.equal(evidence.exitCode, 0)
  const parsed = JSON.parse(evidence.text)
  assert.equal(parsed.result.freshContext.path, 'src/index.ts')
  assert.match(parsed.result.freshContext.currentWindow, /return value/)
})

test('runner exercises inspect, evidence, workflow, and batch chains through CLI on large inputs', async () => {
  const root = await makeOperationCoverageFixture()

  const humanStatus = await runWorkspaceCli(['status', '--json'], { cwd: root })
  assert.equal(humanStatus.exitCode, 0)
  const statusEnvelope = parseCliJson(humanStatus)
  assert.equal(statusEnvelope.kind, 'velaros.workspaceCli.status')
  assert.equal(statusEnvelope.result.root, root)

  const humanRead = await runWorkspaceCli([
    'read',
    'src/large.txt',
    '--start',
    '8099',
    '--end',
    '8102',
    '--max-bytes',
    '5000',
    '--json',
  ], { cwd: root })
  assert.equal(humanRead.exitCode, 0)
  const readEnvelope = parseCliJson(humanRead)
  assert.equal(readEnvelope.kind, 'velaros.workspaceCli.read')
  assert.match(readEnvelope.result.content, /LARGE_REPLACE_TARGET=before/)
  assert.equal(readEnvelope.result.range.startLine, 8099)

  const humanSearch = await runWorkspaceCli([
    'search',
    'replaceBody',
    '--json',
  ], { cwd: root })
  assert.equal(humanSearch.exitCode, 0)
  const searchEnvelope = parseCliJson(humanSearch)
  assert.ok(searchEnvelope.result.hits.some((hit) => normalizeWorkspacePath(hit.path) === 'src/symbols.ts'))

  const humanSymbols = await runWorkspaceCli([
    'symbols',
    'src/symbols.ts',
    '--json',
  ], { cwd: root })
  assert.equal(humanSymbols.exitCode, 0)
  const symbolsEnvelope = parseCliJson(humanSymbols)
  assert.ok(symbolsEnvelope.result.some((symbol) => symbol.name === 'replaceBody'))

  const humanResolve = await runWorkspaceCli([
    'resolve',
    'src/symbols.ts',
    '--symbol',
    'replaceBody',
    '--kind',
    'function',
    '--json',
  ], { cwd: root })
  assert.equal(humanResolve.exitCode, 0)
  const resolveEnvelope = parseCliJson(humanResolve)
  assert.equal(resolveEnvelope.result.status, 'resolved')
  assert.equal(resolveEnvelope.result.target.path, 'src/symbols.ts')

  const fileList = await callWorkspaceTool(root, 'ws_list_files', {
    path: 'src',
    include: ['**/*.ts'],
    exclude: ['**/imports.ts'],
    recursive: true,
    maxDepth: 3,
    maxFiles: 20,
  })
  assert.ok(fileList.some((entry) => entry.path === 'src/symbols.ts'))
  assert.equal(fileList.some((entry) => entry.path === 'src/imports.ts'), false)

  const fileStat = await callWorkspaceTool(root, 'ws_file_stat', {
    path: 'src/large.txt',
  })
  assert.equal(fileStat.kind, 'file')
  assert.equal(fileStat.readableText, true)
  assert.ok(fileStat.sizeBytes > 100_000)

  const evidence = await callWorkspaceTool(root, 'ws_build_evidence', {
    target: {
      path: 'src/large.txt',
      range: { startLine: 8101, endLine: 8101 },
    },
    include: {
      currentWindow: true,
      windowLinesBefore: 2,
      windowLinesAfter: 2,
    },
    task: {
      goal: 'verify large file evidence chain',
      userConstraints: ['bounded read only'],
      successCriteria: ['target window contains marker'],
      riskLevel: 'low',
    },
    editScope: {
      allowedFiles: ['src/large.txt'],
      maxChangedFiles: 1,
      maxChangedLines: 0,
    },
  })
  assert.equal(evidence.freshContext.path, 'src/large.txt')
  assert.match(evidence.freshContext.currentWindow, /LARGE_REPLACE_TARGET=before/)
  assert.equal(evidence.task.goal, 'verify large file evidence chain')
  assert.deepEqual(evidence.editScope.allowedFiles, ['src/large.txt'])

  const workflowSteps = [
    {
      id: 'status',
      tool: 'ws_status',
      args: {},
    },
    {
      id: 'stat-large',
      tool: 'ws_file_stat',
      args: { path: 'src/large.txt' },
    },
    {
      id: 'read-window',
      tool: 'ws_read',
      args: {
        path: 'src/large.txt',
        range: { startLine: 8101, endLine: 8101 },
        maxBytes: 2000,
      },
    },
    {
      id: 'search-marker',
      tool: 'ws_search',
      args: {
        query: 'LARGE_REPLACE_TARGET=before',
        root: 'src',
        maxResults: 5,
      },
    },
    {
      id: 'symbols',
      tool: 'ws_symbols',
      args: { path: 'src/symbols.ts' },
    },
    {
      id: 'evidence-direct',
      tool: 'ws_build_evidence',
      args: {
        target: {
          path: 'src/large.txt',
          range: { startLine: 8101, endLine: 8101 },
        },
        include: { currentWindow: true },
      },
    },
  ]
  const workflow = await runWorkspaceCli([
    'tools',
    'workflow',
    '--steps-json',
    JSON.stringify(workflowSteps),
  ], { cwd: root })
  assert.equal(workflow.exitCode, 0)
  const workflowEnvelope = parseCliJson(workflow)
  assert.deepEqual(workflowEnvelope.result.results.map((step) => step.id), workflowSteps.map((step) => step.id))
  assert.equal(workflowEnvelope.result.results.every((step) => step.status === 'ok'), true)
  assert.match(
    workflowEnvelope.result.results.find((step) => step.id === 'read-window').result.files[0].content,
    /LARGE_REPLACE_TARGET=before/
  )
  assert.match(
    workflowEnvelope.result.results.find((step) => step.id === 'evidence-direct').result.freshContext.currentWindow,
    /LARGE_REPLACE_TARGET=before/
  )

  const batch = await callWorkspaceTool(root, 'ws_run_batch', {
    tasks: [
      {
        id: 'read-large-window',
        op: {
          kind: 'read',
          input: {
            path: 'src/large.txt',
            range: { startLine: 8101, endLine: 8101 },
            maxBytes: 2000,
          },
        },
      },
      {
        id: 'search-large-marker',
        op: {
          kind: 'search',
          input: {
            query: 'LARGE_REPLACE_TARGET=before',
            root: 'src',
            maxResults: 5,
          },
        },
      },
      {
        id: 'resolve-doc-target',
        op: {
          kind: 'resolve',
          input: {
            path: 'docs/insert-target.txt',
            target: { exactSnippet: 'INSERT_TARGET' },
            expectedMatches: 1,
          },
        },
      },
      {
        id: 'validate-json-file',
        op: {
          kind: 'validate',
          input: {
            paths: ['config/settings.json'],
          },
        },
      },
    ],
    concurrency: 4,
  })
  assert.equal(batch.ok, true)
  assert.equal(batch.results.length, 4)
  const batchById = new Map(batch.results.map((result) => [result.id, result]))
  assert.match(batchById.get('read-large-window').result.files[0].content, /LARGE_REPLACE_TARGET=before/)
  assert.ok(batchById.get('search-large-marker').result.hits.some((hit) => hit.path === 'src/large.txt'))
  assert.equal(batchById.get('resolve-doc-target').result.status, 'resolved')
  assert.equal(batchById.get('validate-json-file').result.ok, true)
})

test('runner persists transactions across machine tool CLI invocations', async () => {
  const root = await makeCliFixture()
  const prepared = await runWorkspaceCli([
    'tools',
    'call',
    'ws_prepare_edit',
    '--args-json',
    JSON.stringify({
      operations: [{
        operation: {
          type: 'replace_text',
          path: 'src/index.ts',
          oldText: 'value = 1',
          newText: 'value = 2',
        },
      }],
    }),
  ], { cwd: root })
  assert.equal(prepared.exitCode, 0)
  const transactionId = JSON.parse(prepared.text).result.transactionId

  const diff = await runWorkspaceCli([
    'tools',
    'call',
    'ws_diff',
    '--args-json',
    JSON.stringify({ transactionId }),
  ], { cwd: root })
  assert.equal(diff.exitCode, 0)
  assert.match(JSON.parse(diff.text).result.diff, /value = 2/)

  const apply = await runWorkspaceCli([
    'tools',
    'call',
    'ws_apply_edit',
    '--args-json',
    JSON.stringify({ transactionId }),
  ], { cwd: root })
  assert.equal(apply.exitCode, 0)
  assert.match(await fs.readFile(path.join(root, 'src/index.ts'), 'utf8'), /value = 2/)

  const rollback = await runWorkspaceCli([
    'tools',
    'call',
    'ws_rollback',
    '--args-json',
    JSON.stringify({ transactionId }),
  ], { cwd: root })
  assert.equal(rollback.exitCode, 0)
  assert.match(await fs.readFile(path.join(root, 'src/index.ts'), 'utf8'), /value = 1/)

  const listed = await runWorkspaceCli([
    'tools',
    'call',
    'ws_list_files',
    '--args-json',
    '{"recursive":true,"maxFiles":100}',
  ], { cwd: root })
  assert.equal(listed.exitCode, 0)
  assert.equal(JSON.parse(listed.text).result.some((entry) => entry.path.startsWith('.velaros-workspace')), false)

  const stateRead = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    '{"path":".velaros-workspace/state.json","maxBytes":1000}',
  ], { cwd: root })
  assert.equal(stateRead.exitCode, 1)
  assert.equal(JSON.parse(stateRead.text).error.code, 'PERMISSION_DENIED')
})

test('runner treats CLI state cache write failures as non-fatal', async () => {
  const root = await makeCliFixture()
  await fs.writeFile(path.join(root, '.velaros-workspace'), 'not a directory\n')

  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    '{"path":"src/index.ts","maxBytes":2000}',
  ], { cwd: root })

  assert.equal(result.exitCode, 0, result.text)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.tools.call')
  assert.match(parsed.result.files[0].content, /hello/)
})

test('runner ignores malformed CLI state cache payloads', async () => {
  const root = await makeCliFixture()
  await fs.mkdir(path.join(root, '.velaros-workspace'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.velaros-workspace/state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      targets: { targetId: 'not-an-array' },
      evidence: 'not-an-array',
      transactions: [{ nope: true }],
    })}\n`
  )

  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    '{"path":"src/index.ts","maxBytes":2000}',
  ], { cwd: root })

  assert.equal(result.exitCode, 0, result.text)
  assert.match(JSON.parse(result.text).result.files[0].content, /hello/)
})

test('runner exercises every built-in edit operation through CLI on large and multi-file inputs', async () => {
  const root = await makeOperationCoverageFixture()

  const status = await callWorkspaceTool(root, 'ws_status')
  assert.equal(status.root, root)

  const listed = await callWorkspaceTool(root, 'ws_list_files', {
    recursive: true,
    maxFiles: 100,
  })
  assert.ok(listed.some((entry) => entry.path === 'src/symbols.ts'))

  const stat = await callWorkspaceTool(root, 'ws_file_stat', {
    path: 'src/large.txt',
  })
  assert.equal(stat.path, 'src/large.txt')
  assert.ok(stat.lineCount > 10_000)

  const read = await callWorkspaceTool(root, 'ws_read', {
    path: 'src/large.txt',
    range: { startLine: 8000, endLine: 8005 },
    maxBytes: 2000,
  })
  assert.match(read.files[0].content, /large-line-08000/)

  const search = await callWorkspaceTool(root, 'ws_search', {
    query: 'LARGE_REPLACE_TARGET=before',
    root: 'src',
    maxResults: 5,
  })
  assert.ok(search.hits.some((hit) => hit.path === 'src/large.txt'))

  const symbols = await callWorkspaceTool(root, 'ws_symbols', {
    path: 'src/symbols.ts',
  })
  assert.ok(symbols.some((symbol) => symbol.name === 'replaceBody'))

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'replace_text',
      path: 'src/large.txt',
      oldText: 'LARGE_REPLACE_TARGET=before',
      newText: 'LARGE_REPLACE_TARGET=after',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'src/large.txt'), /LARGE_REPLACE_TARGET=after/)

  const insertTarget = await resolveWorkspaceTarget(root, 'docs/insert-target.txt', {
    exactSnippet: 'INSERT_TARGET',
  })
  await applyWorkspaceOperation(root, [{
    targetId: insertTarget,
    operation: {
      type: 'insert_text',
      position: 'after',
      text: '\ninserted after target',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'docs/insert-target.txt'), /INSERT_TARGET\ninserted after target/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'insert_text_at_anchor',
      path: 'docs/anchor.txt',
      anchorText: 'ANCHOR',
      position: 'before',
      text: 'before-anchor ',
      expectedMatches: 1,
    },
  }])
  assert.match(await readWorkspaceFile(root, 'docs/anchor.txt'), /before-anchor ANCHOR/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'append_text',
      path: 'docs/append.txt',
      text: '\nappended text',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'docs/append.txt'), /appended text$/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'prepend_text',
      path: 'docs/prepend.txt',
      text: 'prepended text\n',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'docs/prepend.txt'), /^prepended text/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'delete_text',
      path: 'docs/delete-text.txt',
      oldText: 'DELETE_ME',
    },
  }])
  assert.doesNotMatch(await readWorkspaceFile(root, 'docs/delete-text.txt'), /DELETE_ME/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'create_file',
      path: 'docs/created.txt',
      content: 'created through CLI\n',
    },
  }])
  assert.equal(await readWorkspaceFile(root, 'docs/created.txt'), 'created through CLI\n')

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'delete_file',
      path: 'docs/delete-file.txt',
    },
  }])
  await assertWorkspacePathMissing(root, 'docs/delete-file.txt')

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'rename_file',
      from: 'docs/rename-from.txt',
      to: 'docs/renamed-to.txt',
    },
  }])
  await assertWorkspacePathMissing(root, 'docs/rename-from.txt')
  assert.equal(await readWorkspaceFile(root, 'docs/renamed-to.txt'), 'rename me\n')

  const replaceBodyTarget = await resolveWorkspaceTarget(root, 'src/symbols.ts', {
    symbol: { kind: 'function', name: 'replaceBody' },
  })
  await applyWorkspaceOperation(root, [{
    targetId: replaceBodyTarget,
    operation: {
      type: 'replace_symbol',
      mode: 'body',
      replacement: '\n  return value + 10;\n',
    },
  }])
  const afterBodyReplace = await readWorkspaceFile(root, 'src/symbols.ts')
  assert.match(afterBodyReplace, /export function replaceBody\(value: number\) \{\n {2}return value \+ 10;\n\}/)
  assert.doesNotMatch(afterBodyReplace, /return value \+ 1;/)

  const aroundTarget = await resolveWorkspaceTarget(root, 'src/symbols.ts', {
    symbol: { kind: 'function', name: 'aroundTarget' },
  })
  await applyWorkspaceOperation(root, [{
    targetId: aroundTarget,
    operation: {
      type: 'insert_around_symbol',
      position: 'before',
      text: '// inserted around symbol\n',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'src/symbols.ts'), /\/\/ inserted around symbol\nexport function aroundTarget/)

  const beforeTarget = await resolveWorkspaceTarget(root, 'src/symbols.ts', {
    symbol: { kind: 'function', name: 'beforeTarget' },
  })
  await applyWorkspaceOperation(root, [{
    targetId: beforeTarget,
    operation: {
      type: 'insert_before_symbol',
      text: '// inserted before symbol\n',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'src/symbols.ts'), /\/\/ inserted before symbol\nexport function beforeTarget/)

  const afterTarget = await resolveWorkspaceTarget(root, 'src/symbols.ts', {
    symbol: { kind: 'function', name: 'afterTarget' },
  })
  await applyWorkspaceOperation(root, [{
    targetId: afterTarget,
    operation: {
      type: 'insert_after_symbol',
      text: '\n// inserted after symbol',
    },
  }])
  assert.match(await readWorkspaceFile(root, 'src/symbols.ts'), /export function afterTarget[\s\S]*\n\/\/ inserted after symbol/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'add_import',
      path: 'src/imports.ts',
      module: 'pkg',
      named: ['added'],
    },
  }])
  assert.match(await readWorkspaceFile(root, 'src/imports.ts'), /import \{ existing, added \} from "pkg"/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'remove_import',
      path: 'src/imports.ts',
      module: 'pkg',
      name: 'existing',
    },
  }])
  const importsAfterRemove = await readWorkspaceFile(root, 'src/imports.ts')
  assert.match(importsAfterRemove, /import \{ added \} from "pkg"/)
  assert.doesNotMatch(importsAfterRemove, /\bexisting\b/)

  await applyWorkspaceOperation(root, [{
    operation: {
      type: 'json_patch',
      path: 'config/settings.json',
      patches: [
        { op: 'replace', path: '/enabled', value: true },
        { op: 'add', path: '/features/-', value: 'cli-coverage' },
      ],
    },
  }])
  assert.deepEqual(JSON.parse(await readWorkspaceFile(root, 'config/settings.json')), {
    enabled: true,
    features: ['base', 'cli-coverage'],
  })

  const amended = await callWorkspaceTool(root, 'ws_prepare_edit', {
    operations: [{
      operation: {
        type: 'append_text',
        path: 'docs/amend.txt',
        text: '\nprepared append',
      },
    }],
  })
  await callWorkspaceTool(root, 'ws_amend_edit', {
    transactionId: amended.transactionId,
    operations: [{
      operation: {
        type: 'prepend_text',
        path: 'docs/amend.txt',
        text: 'amended prepend\n',
      },
    }],
  })
  await callWorkspaceTool(root, 'ws_apply_edit', { transactionId: amended.transactionId })
  assert.match(await readWorkspaceFile(root, 'docs/amend.txt'), /^amended prepend\nbase amend\nprepared append$/)

  const committed = await callWorkspaceTool(root, 'ws_commit_edit', {
    operations: [{
      operation: {
        type: 'replace_text',
        path: 'docs/commit.txt',
        oldText: 'commit before',
        newText: 'commit after',
      },
    }],
    postconditions: [{ type: 'must_contain', value: 'commit after' }],
  })
  assert.equal(committed.status, 'applied')
  assert.match(await readWorkspaceFile(root, 'docs/commit.txt'), /commit after/)

  const multiFileTx = await callWorkspaceTool(root, 'ws_prepare_edit', {
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: 'src/large.txt',
          oldText: 'MULTI_FILE_TARGET=before',
          newText: 'MULTI_FILE_TARGET=after',
        },
      },
      {
        operation: {
          type: 'append_text',
          path: 'docs/multi-a.txt',
          text: '\nchanged in multi-file transaction',
        },
      },
      {
        operation: {
          type: 'json_patch',
          path: 'config/multi.json',
          patches: [{ op: 'replace', path: '/count', value: 2 }],
        },
      },
    ],
  })
  assert.deepEqual(
    multiFileTx.changedFiles.sort(),
    ['config/multi.json', 'docs/multi-a.txt', 'src/large.txt']
  )
  assert.ok(multiFileTx.changedLines > 0)
  const multiValidation = await callWorkspaceTool(root, 'ws_validate', {
    transactionId: multiFileTx.transactionId,
    postconditions: [{ type: 'changed_files_allowlist', value: multiFileTx.changedFiles }],
  })
  assert.equal(multiValidation.ok, true)
  const multiDiff = await callWorkspaceTool(root, 'ws_diff', {
    transactionId: multiFileTx.transactionId,
  })
  assert.match(multiDiff.diff, /MULTI_FILE_TARGET=after/)
  await callWorkspaceTool(root, 'ws_apply_edit', {
    transactionId: multiFileTx.transactionId,
  })
  assert.match(await readWorkspaceFile(root, 'src/large.txt'), /MULTI_FILE_TARGET=after/)
  assert.match(await readWorkspaceFile(root, 'docs/multi-a.txt'), /changed in multi-file transaction/)
  assert.equal(JSON.parse(await readWorkspaceFile(root, 'config/multi.json')).count, 2)

  const rollbackTx = await callWorkspaceTool(root, 'ws_prepare_edit', {
    operations: [{
      operation: {
        type: 'replace_text',
        path: 'docs/rollback.txt',
        oldText: 'rollback before',
        newText: 'rollback after',
      },
    }],
  })
  await callWorkspaceTool(root, 'ws_apply_edit', {
    transactionId: rollbackTx.transactionId,
  })
  await callWorkspaceTool(root, 'ws_rollback', {
    transactionId: rollbackTx.transactionId,
  })
  assert.match(await readWorkspaceFile(root, 'docs/rollback.txt'), /rollback before/)

  const batch = await callWorkspaceTool(root, 'ws_run_batch', {
    tasks: Array.from({ length: 60 }, (_, index) => ({
      id: `read-large-${index}`,
      op: {
        kind: 'read',
        input: {
          path: 'src/large.txt',
          range: { startLine: 7000 + index, endLine: 7000 + index },
          maxBytes: 2000,
        },
      },
    })),
    concurrency: 16,
  })
  assert.equal(batch.ok, true)
  assert.equal(batch.results.length, 60)
})

test('runner calls ws_file_stat without returning content', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_file_stat',
    '--args-json',
    '{"path":"src/index.ts"}',
  ], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.tools.call')
  assert.equal(parsed.result.path, 'src/index.ts')
  assert.equal(parsed.result.exists, true)
  assert.ok(parsed.result.lineCount >= 1)
  assert.equal(Object.hasOwn(parsed.result, 'content'), false)
})

test('runner rejects empty inline tool call JSON payloads', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    '',
  ], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'INVALID_JSON')
  assert.match(parsed.error.details.message, /JSON/)
})

test('runner rejects non-object tool call JSON payloads', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    'null',
  ], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'ARGUMENT_ERROR')
})

test('runner rejects inline and file tool call JSON payloads together', async () => {
  const root = await makeCliFixture()
  const argsPath = path.join(root, 'args.json')
  await fs.writeFile(argsPath, '{"path":"src/index.ts","maxBytes":2000}')

  const result = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-json',
    '',
    '--args-file',
    argsPath,
  ], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'ARGUMENT_ERROR')
})

test('runner executes a sequential tools workflow', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'workflow',
    '--steps-json',
    '[{"id":"read","tool":"ws_read","args":{"path":"src/index.ts","maxBytes":2000}}]',
  ], { cwd: root })
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.tools.workflow')
  assert.equal(parsed.result.results[0].id, 'read')
  assert.equal(parsed.result.results[0].status, 'ok')
})

test('runner executes machine tool calls and workflows from JSON files', async () => {
  const root = await makeCliFixture()
  const argsPath = path.join(root, 'read-args.json')
  await fs.writeFile(argsPath, JSON.stringify({
    path: 'src/index.ts',
    maxBytes: 2000,
  }))

  const callResult = await runWorkspaceCli([
    'tools',
    'call',
    'ws_read',
    '--args-file',
    argsPath,
  ], { cwd: root })
  assert.equal(callResult.exitCode, 0)
  const callEnvelope = parseCliJson(callResult)
  assert.equal(callEnvelope.kind, 'velaros.workspaceCli.tools.call')
  assert.match(callEnvelope.result.files[0].content, /export const value/)

  const stepsPath = path.join(root, 'workflow-steps.json')
  await fs.writeFile(stepsPath, JSON.stringify([
    {
      id: 'read-index',
      tool: 'ws_read',
      args: { path: 'src/index.ts', maxBytes: 2000 },
    },
    {
      id: 'resolve-return',
      tool: 'ws_resolve_target',
      args: {
        path: 'src/index.ts',
        target: { exactSnippet: 'return value' },
        expectedMatches: 1,
      },
    },
  ]))

  const workflowResult = await runWorkspaceCli([
    'tools',
    'workflow',
    '--steps-file',
    stepsPath,
  ], { cwd: root })
  assert.equal(workflowResult.exitCode, 0)
  const workflowEnvelope = parseCliJson(workflowResult)
  assert.deepEqual(workflowEnvelope.result.results.map((step) => step.id), ['read-index', 'resolve-return'])
  assert.equal(workflowEnvelope.result.results.every((step) => step.status === 'ok'), true)
  assert.equal(workflowEnvelope.result.results[1].result.status, 'resolved')
})

test('runner rejects empty inline tools workflow JSON payloads', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'workflow',
    '--steps-json',
    '',
  ], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'INVALID_JSON')
  assert.match(parsed.error.details.message, /JSON/)
})

test('runner rejects malformed tools workflow steps', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'workflow',
    '--steps-json',
    '[null]',
  ], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'ARGUMENT_ERROR')
  assert.deepEqual(parsed.error.details, { stepIndex: 0 })
})

test('runner rejects non-object tools workflow step args', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli([
    'tools',
    'workflow',
    '--steps-json',
    '[{"tool":"ws_read","args":null}]',
  ], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'ARGUMENT_ERROR')
  assert.deepEqual(parsed.error.details, { stepIndex: 0, field: 'args' })
})

test('runner returns normalized unknown tool errors', async () => {
  const root = await makeCliFixture()
  const result = await runWorkspaceCli(['tools', 'call', 'missing_tool'], { cwd: root })
  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.workspaceCli.error')
  assert.equal(parsed.error.code, 'UNKNOWN_TOOL')
})

async function makeCliFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velaros-workspace-cli-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src/index.ts'),
    'export const value = 1\nexport function hello() { return value }\n'
  )
  return root
}

async function makeOperationCoverageFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velaros-workspace-ops-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  await fs.mkdir(path.join(root, 'config'), { recursive: true })

  const largeLines = Array.from(
    { length: 12_500 },
    (_, index) => `large-line-${String(index + 1).padStart(5, '0')}`
  )
  largeLines.splice(8100, 0, 'LARGE_REPLACE_TARGET=before')
  largeLines.splice(10_200, 0, 'MULTI_FILE_TARGET=before')
  await fs.writeFile(path.join(root, 'src/large.txt'), `${largeLines.join('\n')}\n`)

  await fs.writeFile(
    path.join(root, 'src/symbols.ts'),
    [
      'export function replaceBody(value: number) {',
      '  return value + 1;',
      '}',
      '',
      'export function aroundTarget() {',
      '  return "around";',
      '}',
      '',
      'export function beforeTarget() {',
      '  return "before";',
      '}',
      '',
      'export function afterTarget() {',
      '  return "after";',
      '}',
      '',
    ].join('\n')
  )
  await fs.writeFile(path.join(root, 'src/imports.ts'), 'import { existing } from "pkg";\nexport const value = 1;\n')

  await fs.writeFile(path.join(root, 'docs/insert-target.txt'), 'alpha\nINSERT_TARGET\nomega\n')
  await fs.writeFile(path.join(root, 'docs/anchor.txt'), 'alpha ANCHOR omega\n')
  await fs.writeFile(path.join(root, 'docs/append.txt'), 'append base')
  await fs.writeFile(path.join(root, 'docs/prepend.txt'), 'prepend base\n')
  await fs.writeFile(path.join(root, 'docs/delete-text.txt'), 'keep DELETE_ME keep\n')
  await fs.writeFile(path.join(root, 'docs/delete-file.txt'), 'delete me\n')
  await fs.writeFile(path.join(root, 'docs/rename-from.txt'), 'rename me\n')
  await fs.writeFile(path.join(root, 'docs/amend.txt'), 'base amend')
  await fs.writeFile(path.join(root, 'docs/commit.txt'), 'commit before\n')
  await fs.writeFile(path.join(root, 'docs/multi-a.txt'), 'multi file base')
  await fs.writeFile(path.join(root, 'docs/rollback.txt'), 'rollback before\n')
  await fs.writeFile(path.join(root, 'config/settings.json'), '{"enabled":false,"features":["base"]}\n')
  await fs.writeFile(path.join(root, 'config/multi.json'), '{"count":1}\n')
  return root
}

async function callWorkspaceTool(root, toolName, args = {}) {
  const result = await runWorkspaceCli([
    'tools',
    'call',
    toolName,
    '--args-json',
    JSON.stringify(args),
  ], { cwd: root })
  assert.equal(result.exitCode, 0, result.text)
  return JSON.parse(result.text).result
}

function parseCliJson(result) {
  return JSON.parse(result.text)
}

async function applyWorkspaceOperation(root, operations) {
  const tx = await callWorkspaceTool(root, 'ws_prepare_edit', { operations })
  assert.equal(tx.status, 'prepared')
  assert.ok(tx.changedFiles.length > 0)

  const diff = await callWorkspaceTool(root, 'ws_diff', {
    transactionId: tx.transactionId,
  })
  assert.ok(diff.diff.length > 0)

  const apply = await callWorkspaceTool(root, 'ws_apply_edit', {
    transactionId: tx.transactionId,
  })
  assert.equal(apply.status, 'applied')
  return { tx, apply }
}

async function resolveWorkspaceTarget(root, pathValue, target) {
  const resolved = await callWorkspaceTool(root, 'ws_resolve_target', {
    path: pathValue,
    target,
    expectedMatches: 1,
  })
  assert.equal(resolved.status, 'resolved')
  const evidence = await callWorkspaceTool(root, 'ws_build_evidence', {
    target: { targetId: resolved.target.targetId },
    include: { currentWindow: true },
  })
  assert.equal(evidence.freshContext.path, pathValue)
  return resolved.target.targetId
}

async function readWorkspaceFile(root, relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8')
}

function normalizeWorkspacePath(pathValue) {
  return String(pathValue).replace(/^\.\//, '')
}

async function assertWorkspacePathMissing(root, relativePath) {
  await assert.rejects(
    fs.stat(path.join(root, relativePath)),
    (error) => error?.code === 'ENOENT'
  )
}

function assertWorkspaceCliError(fn, code, message, details) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof WorkspaceCliError)
      assert.equal(error.code, code)
      assert.equal(error.exitCode, 2)
      assert.match(error.message, message)
      assert.deepEqual(error.details, details)
      return true
    }
  )
}
