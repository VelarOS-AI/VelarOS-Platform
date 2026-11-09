// 用途：验证原生评测的身份、未结算状态、分层去重、冻结产物与真实进程收尾。
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assessLedger,
  acquireControllerLeases,
  comparisonEligible,
  codexMetrics,
  generationPolicyWitness,
  scriptMetrics,
  snapshotFiles,
  verifyFrozen,
} from './controller.mjs'
import {
  configureModel,
  prepareUnattendedPermissions,
  privateJson,
  restoreModel,
  waitForSettlement,
} from './client.mjs'
import { runCodex } from './codex.mjs'

const identity = {
  campaignId: 'campaign',
  candidateId: 'candidate',
  participantId: 'scriptact',
  taskId: 'task',
  attemptId: 'attempt',
  jobId: 'job',
  phase: 'source',
}
const row = {
  id: 'request',
  identity,
  status: 'http-200',
  finishedAt: '2026-10-03T00:00:00Z',
  estimatedUsd: null,
  usage: null,
}

async function settingsFixture(t, permissionConfirmationMode = 'standard-open') {
  const directory = await mkdtemp(join(tmpdir(), 'native-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsFile = join(directory, 'settings.json')
  const system = {
    providerRuntimeConfigs: [
      { provider: 'openai', apiKey: 'original-key', baseURL: 'https://original.invalid' },
      { provider: 'other', enabled: false },
    ],
    advancedRuntime: { permissionConfirmationMode, toolProtocol: 'text' },
  }
  const commands = []
  const save = () => writeFile(settingsFile, JSON.stringify({ system }))
  await save()
  const hook = async (command) => {
    commands.push(structuredClone(command))
    assert.equal(command.kind, 'config_op')
    assert.equal(command.key, 'system')
    if (command.op === 'patch') {
      if (command.patch.providerRuntimeConfigs)
        system.providerRuntimeConfigs = command.patch.providerRuntimeConfigs
      if (command.patch.advancedRuntime)
        Object.assign(system.advancedRuntime, command.patch.advancedRuntime)
      await save()
    }
    return { config: structuredClone(system) }
  }
  return { commands, hook, save, settingsFile, system }
}

test('model configuration changes only the provider settings it owns', async (t) => {
  const fixture = await settingsFixture(t)
  const advanced = structuredClone(fixture.system.advancedRuntime)
  await configureModel(fixture.hook, fixture.settingsFile, {
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'attempt-key',
    model: 'fixture-model',
  })
  assert.deepEqual(fixture.system.advancedRuntime, advanced)
  assert.deepEqual(Object.keys(fixture.commands[0].patch), ['providerRuntimeConfigs'])
  assert.equal(fixture.system.providerRuntimeConfigs[1].apiKey, 'attempt-key')
  assert.equal(fixture.system.providerRuntimeConfigs[0].provider, 'other')
})

test('temporary permissions restore only their field and preserve concurrent user settings', async (t) => {
  const fixture = await settingsFixture(t)
  const permissions = await prepareUnattendedPermissions(fixture.hook)
  await permissions.enable()
  assert.equal(fixture.system.advancedRuntime.permissionConfirmationMode, 'never-ask')
  fixture.system.advancedRuntime.toolProtocol = 'tools'
  fixture.system.advancedRuntime.systemNotificationsEnabled = true
  assert.equal(await permissions.restore(), 'restored')
  assert.deepEqual(fixture.system.advancedRuntime, {
    permissionConfirmationMode: 'standard-open',
    toolProtocol: 'tools',
    systemNotificationsEnabled: true,
  })
  assert(
    fixture.commands
      .filter((command) => command.op === 'patch')
      .every(
        (command) =>
          Object.keys(command.patch).length === 1 &&
          Object.keys(command.patch.advancedRuntime).join() === 'permissionConfirmationMode'
      )
  )
  assert.equal(await permissions.restore(), 'unchanged')

  const changed = await prepareUnattendedPermissions(fixture.hook)
  await changed.enable()
  fixture.system.advancedRuntime.permissionConfirmationMode = 'standard-open'
  const patches = fixture.commands.filter((command) => command.op === 'patch').length
  assert.equal(await changed.restore(), 'user_configuration_preserved')
  assert.equal(fixture.commands.filter((command) => command.op === 'patch').length, patches)
})

test('an existing unattended mode or an unused permission scope is left untouched', async (t) => {
  for (const mode of ['never-ask', 'standard-open']) {
    const fixture = await settingsFixture(t, mode)
    const permissions = await prepareUnattendedPermissions(fixture.hook)
    if (mode === 'never-ask') await permissions.enable()
    assert.equal(await permissions.restore(), 'unchanged')
    assert.equal(fixture.commands.filter((command) => command.op === 'patch').length, 0)
  }
})

test('permission ownership survives a lost write receipt and a failed restore can retry', async (t) => {
  const fixture = await settingsFixture(t)
  const failure = new Error('write receipt lost')
  let rejectWrite = true
  let rejectRestore = false
  const hook = async (command) => {
    if (command.op === 'patch' && rejectRestore) {
      rejectRestore = false
      throw failure
    }
    const result = await fixture.hook(command)
    if (command.op === 'patch' && rejectWrite) {
      rejectWrite = false
      throw failure
    }
    return result
  }
  const permissions = await prepareUnattendedPermissions(hook)
  await assert.rejects(permissions.enable(), (error) => error === failure)
  assert.equal(fixture.system.advancedRuntime.permissionConfirmationMode, 'never-ask')
  assert.equal(await permissions.restore(), 'restored')

  const next = await prepareUnattendedPermissions(hook)
  await next.enable()
  rejectRestore = true
  await assert.rejects(next.restore(), (error) => error === failure)
  assert.equal(fixture.system.advancedRuntime.permissionConfirmationMode, 'never-ask')
  assert.equal(await next.restore(), 'restored')
})

test('provider restoration preserves user changes and newly added providers', async (t) => {
  const fixture = await settingsFixture(t)
  const original = structuredClone(fixture.system.providerRuntimeConfigs)
  await configureModel(fixture.hook, fixture.settingsFile, {
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'attempt-key',
    model: 'fixture-model',
  })
  fixture.system.providerRuntimeConfigs[0].enabled = true
  fixture.system.providerRuntimeConfigs.push({ provider: 'added-by-user' })
  await fixture.save()
  assert.equal(
    await restoreModel(fixture.hook, fixture.settingsFile, original, 'attempt-key'),
    'restored'
  )
  assert.deepEqual(fixture.system.providerRuntimeConfigs, [
    { provider: 'other', enabled: true },
    { provider: 'added-by-user' },
    original[0],
  ])
  fixture.system.providerRuntimeConfigs.at(-1).apiKey = 'user-key'
  await fixture.save()
  const patches = fixture.commands.length
  assert.equal(
    await restoreModel(fixture.hook, fixture.settingsFile, original, 'attempt-key'),
    'user_configuration_preserved'
  )
  assert.equal(fixture.commands.length, patches)
})

test('generation comparison requires both participants and every actual outbound request to match', () => {
  const policy = {
    maxOutputTokens: 12000,
    reasoningContext: 'all_turns',
    reasoningSummary: 'auto',
    textVerbosity: 'medium',
  }
  const rows = ['scriptact', 'codex'].map((participantId) => ({
    id: participantId,
    identity: { ...identity, participantId },
    metadata: {
      endpoint: '/v1/responses',
      outputLimit: 12000,
      wireOptions: {
        reasoningContext: { state: 'value', value: 'all_turns' },
        reasoningSummary: { state: 'value', value: 'auto' },
        textVerbosity: { state: 'value', value: 'medium' },
      },
    },
  }))
  const witness = generationPolicyWitness(rows, policy)
  assert.equal(witness.status, 'verified')
  assert.equal(generationPolicyWitness([], policy).status, 'mismatch')
  assert.equal(generationPolicyWitness(rows.slice(0, 1), policy).status, 'mismatch')
  for (const key of ['reasoningContext', 'reasoningSummary', 'textVerbosity']) {
    const changed = structuredClone(rows)
    changed[1].metadata.wireOptions[key] = { state: 'absent' }
    assert.equal(generationPolicyWitness(changed, policy).status, 'mismatch')
  }
  const changed = structuredClone(rows)
  changed[1].metadata.outputLimit = 32768
  assert.equal(generationPolicyWitness(changed, policy).status, 'mismatch')
  assert.equal(generationPolicyWitness(rows, undefined), null)
  const state = {
    status: 'completed',
    generationPolicy: policy,
    participants: Object.fromEntries(
      ['scriptact', 'codex'].map((who) => [who, { grade: { status: 'graded' }, policyAudit: {} }])
    ),
  }
  assert.equal(comparisonEligible(state), false)
  state.generationWitness = witness
  assert.equal(comparisonEligible(state), true)
})

test('valid graded failures remain comparable; policy and infrastructure faults are kept separate', () => {
  const participant = {
    terminalComplete: true,
    grade: { status: 'graded', resolved: true },
    policyAudit: { confirmedSolutionPatchAccess: false, requiresReview: false },
  }
  const state = {
    status: 'completed',
    participants: {
      scriptact: {
        ...participant,
        terminalComplete: false,
        grade: { status: 'graded', resolved: false },
      },
      codex: structuredClone(participant),
    },
  }
  assert.equal(comparisonEligible(state), true)
  state.participants.scriptact.policyAudit = {
    confirmedSolutionPatchAccess: true,
    requiresReview: false,
  }
  assert.equal(comparisonEligible(state), false)
  state.participants.scriptact.policyAudit = {
    confirmedSolutionPatchAccess: false,
    requiresReview: true,
  }
  assert.equal(comparisonEligible(state), false)
  state.participants.scriptact.policyAudit = participant.policyAudit
  state.status = 'grading_infrastructure_failure'
  assert.equal(comparisonEligible(state), false)
})

test('new pairs require observed ScriptAct capacity and the actual Codex launch threshold', () => {
  const participant = {
    grade: { status: 'graded', resolved: true },
    policyAudit: { confirmedSolutionPatchAccess: false, requiresReview: false },
  }
  const state = {
    status: 'completed',
    contextPolicy: { inputWindowTokens: 200000 },
    participants: {
      scriptact: { ...structuredClone(participant), inputWindowVerified: true },
      codex: { ...structuredClone(participant), inputWindowTokens: 200000 },
    },
  }
  assert.equal(comparisonEligible(state), true)
  state.participants.codex.inputWindowTokens = 1033904
  assert.equal(comparisonEligible(state), false)
  state.participants.codex.inputWindowTokens = 200000
  delete state.participants.scriptact.inputWindowVerified
  assert.equal(comparisonEligible(state), false)
  state.participants.scriptact.inputWindowVerified = true
  state.status = 'context_policy_infrastructure_failure'
  assert.equal(comparisonEligible(state), false)
})

test('a prior attempt lock cannot strand a new campaign lock or be overwritten', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-leases-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const globalPath = join(root, 'campaign.lock'),
    localPath = join(root, 'attempt.lock')
  await writeFile(localPath, 'unsettled prior attempt')
  await assert.rejects(acquireControllerLeases(globalPath, localPath, { pid: process.pid }), {
    code: 'EEXIST',
  })
  assert.equal(await readFile(localPath, 'utf8'), 'unsettled prior attempt')
  await assert.rejects(readFile(globalPath), { code: 'ENOENT' })
  await writeFile(globalPath, 'another live controller')
  await assert.rejects(acquireControllerLeases(globalPath, localPath, { pid: process.pid }), {
    code: 'EEXIST',
  })
  assert.equal(await readFile(globalPath, 'utf8'), 'another live controller')
  assert.equal(await readFile(localPath, 'utf8'), 'unsettled prior attempt')
})

test('unsettled and conflicting paid records cannot produce a comparison; unknown fees remain unknown', () => {
  assert.throws(() => assessLedger([{ ...row, finishedAt: undefined }], [identity]), /unsettled/)
  assert.throws(() => assessLedger([row, row], [identity]), /Duplicate/)
  assert.throws(
    () => assessLedger([{ ...row, identity: { ...identity, taskId: 'foreign' } }], [identity]),
    /owner/
  )
  const result = assessLedger([row], [identity]).scriptact
  assert.equal(result.unknownUsage, 1)
  assert.equal(result.referenceCostComplete, false)
})

test('idle with no execution proof cannot be accepted as task completion', async () => {
  await assert.rejects(
    waitForSettlement(
      async () => ({ found: true, settleReason: 'never-ran', running: false }),
      'task',
      1000
    ),
    /no execution evidence/
  )
  await assert.rejects(
    waitForSettlement(
      async () => ({ found: true, settleReason: 'pending-user', hasPendingConfirmation: true }),
      'task',
      1000
    ),
    /human answer/
  )
  const complete = {
    found: true,
    settleReason: 'already-idle',
    running: false,
    pendingPrompt: false,
    queuedInputs: 0,
    backgroundJobs: 0,
    timedOut: false,
  }
  assert.deepEqual(await waitForSettlement(async () => complete, 'task', 1000), complete)
})

test('layered measurements retain operation failures, command nonzero exits and truncated evidence', () => {
  const call = {
    module: 'velaros:shell',
    operation: 'run',
    status: 'succeeded',
    output: JSON.stringify({ exitCode: 2 }),
    truncated: false,
  }
  const page = {
    turns: [
      {
        turnId: 'turn',
        timing: { modelMs: 10 },
        executions: [{ executionId: 'script', status: 'completed', durationMs: 20, calls: [call] }],
        detail: {},
        gaps: [],
      },
    ],
    omitted: 0,
  }
  const result = scriptMetrics([page])
  assert.equal(result.kernelOperations['velaros:shell.run'].failures, 0)
  assert.equal(result.nonzeroCommands, 1)
  assert.equal(result.scriptMs, 20)
  assert.equal(scriptMetrics([page, page]).nativeCommands, 1)
  assert.equal(
    scriptMetrics([page, { ...page, turns: [{ ...page.turns[0], turnId: 'later-turn' }] }])
      .nativeCommands,
    1
  )
  call.truncated = true
  assert.equal(scriptMetrics([page]).fullTrace, false)
  const cli = [
    { type: 'thread.started', thread_id: 'thread' },
    {
      type: 'item.completed',
      item: { id: 'command', type: 'command_execution', status: 'completed', exit_code: 1 },
    },
    { type: 'turn.failed' },
  ]
    .map((item) => JSON.stringify(item))
    .join('\n')
  const codex = codexMetrics(cli)
  assert.equal(codex.nativeCommands, 1)
  assert.equal(codex.nonzeroCommands, 1)
  assert.equal(codex.terminalComplete, false)
})

test('bound patch refusals are counted separately from transport success and applied patches', () => {
  const page = {
    turns: [
      {
        turnId: 'bound-edit',
        executions: [
          {
            executionId: 'editing-script',
            status: 'completed',
            calls: [
              {
                module: 'velaros:project',
                operation: 'patch',
                status: 'succeeded',
                output: JSON.stringify({ status: 'blocked', executionOutcome: 'not-applied' }),
              },
              {
                module: 'velaros:project',
                operation: 'patch',
                status: 'succeeded',
                output: JSON.stringify({ status: 'applied', changed: true }),
              },
              { module: 'velaros:project', operation: 'patch', status: 'failed', output: '' },
            ],
          },
        ],
      },
    ],
  }
  const result = scriptMetrics([page])
  assert.deepEqual(result.kernelOperations['velaros:project.patch'], {
    calls: 3,
    failures: 2,
    unknown: 0,
    blocked: 1,
  })
  assert.equal(result.failedScripts, 0)
  assert.equal(result.fullTrace, true)
  page.turns[0].executions[0].calls[0].output = '{truncated'
  assert.equal(scriptMetrics([page]).fullTrace, false)
})

test('atomic evidence writes cannot expose a partial JSON and frozen changes fail verification', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      privateJson(path, { revision: n, body: 'x'.repeat(10000) })
    )
  )
  assert.equal(JSON.parse(await readFile(path, 'utf8')).body.length, 10000)
  assert.deepEqual(await readdir(directory), ['state.json'])
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  const frozen = await snapshotFiles([path])
  await verifyFrozen(frozen)
  await privateJson(path, { changed: true })
  await assert.rejects(verifyFrozen(frozen), /Frozen artifact changed/)
})

test('frozen directory inventories detect added runtime files and are independent of root order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-inventory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const one = join(directory, 'one'),
    two = join(directory, 'two')
  await mkdir(one)
  await mkdir(two)
  await writeFile(join(one, 'index.js'), 'old runtime')
  await writeFile(join(two, 'index.js'), 'other runtime')
  const frozen = await snapshotFiles([two, one, one])
  assert.deepEqual(frozen, await snapshotFiles([one, two]))
  await verifyFrozen(frozen)
  await writeFile(join(one, 'new-tool.js'), 'new capability')
  await assert.rejects(verifyFrozen(frozen), /Frozen artifact inventory changed/)
  await rm(join(one, 'new-tool.js'))
  await verifyFrozen(frozen)
  await rm(join(one, 'index.js'))
  await assert.rejects(verifyFrozen(frozen), { code: 'ENOENT' })
})

async function nativeCodexFixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'native-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // Node consumes the real runner's first argv (exec) as this script; no shell or runner seam.
  await writeFile(join(directory, 'exec'), source)
  return {
    executable: process.execPath,
    workspace: directory,
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'private-fixture',
    model: 'gpt-5.6-sol',
    prompt: 'input',
    timeoutMs: 3000,
  }
}

test('native Codex runner preserves actual CLI input, failed turns and exit code', async (t) => {
  const common = await nativeCodexFixture(
    t,
    `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), input, apiKey: process.env.CODEX_API_KEY }));
  fs.writeFileSync(1, '{"type":"thread.started","thread_id":"native-fixture"}\\n{"type":"turn.started"}\\n{"type":"turn.failed"}\\n');
  process.exitCode = 1;
});
`
  )
  const directory = common.workspace
  const failed = join(directory, 'failed')
  await mkdir(failed)
  let invokedArgs
  const result = await runCodex({
    ...common,
    directory: failed,
    contextTokens: 1050000,
    inputWindowTokens: 200000,
    onSpawn: ({ args }) => {
      invokedArgs = args
    },
  })
  const invocation = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'))
  assert.deepEqual(invocation.args, invokedArgs.slice(1))
  assert.equal(invocation.input, common.prompt)
  assert.equal(invocation.apiKey, common.apiKey)
  assert(invokedArgs.includes('model_context_window=1050000'))
  assert(invokedArgs.includes('model_auto_compact_token_limit=200000'))
  await assert.rejects(
    runCodex({ ...common, directory: join(directory, 'not-created'), inputWindowTokens: 1050000 }),
    /Invalid native Codex input window/
  )
  assert.equal(result.code, 1)
  assert.equal(result.terminalComplete, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.cancelled, false)
  assert.equal(result.threadId, 'native-fixture')
  assert.equal((await readFile(join(failed, 'codex.jsonl'), 'utf8')).includes('turn.failed'), true)
})

for (const mode of ['deadline', 'cancellation'])
  test(
    `native Codex ${mode} reaps its POSIX process group`,
    { skip: process.platform === 'win32' ? 'Mac evaluation uses POSIX process groups' : false },
    async (t) => {
      const common = await nativeCodexFixture(
        t,
        'process.stdin.resume(); setInterval(() => {}, 1000);'
      )
      const directory = join(common.workspace, mode)
      await mkdir(directory)
      const signal = new AbortController()
      let pid
      const result = await runCodex({
        ...common,
        directory,
        timeoutMs: mode === 'deadline' ? 50 : 3000,
        signal: signal.signal,
        onSpawn: (value) => {
          pid = value.pid
          if (mode === 'cancellation') signal.abort()
        },
      })
      assert.equal(result.timedOut, mode === 'deadline')
      assert.equal(result.cancelled, mode === 'cancellation')
      assert.equal(result.terminalComplete, false)
      assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' })
    }
  )
