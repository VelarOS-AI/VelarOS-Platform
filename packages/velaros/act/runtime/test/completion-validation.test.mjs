import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { AppError } from '@velaros-ai/core/error'

import { VelarCompletionValidationModule } from '../../../dist/act/runtime/contract/surface.js'
import { CompletionValidation } from '../../../dist/act/runtime/impl/CompletionValidation.js'
import { completionValidationInput } from '../../../dist/act/runtime/utils/completion-validation.js'
import { createLocalNodeValidationHost } from '../../../dist/execution/local.js'

const hash = (text) => createHash('sha256').update(text).digest('hex')
const text = 'export const value = 42;\n'
const input = {
  requirementIds: ['R1'],
  artifacts: [{ identity: 'file:module.mjs', sha256: hash(text) }],
  code: 'console.log(42)',
}
const signal = new AbortController().signal
const successful = {
  status: 'passed',
  exitCode: 0,
  stdout: '42\n',
  stderr: '',
  timedOut: false,
  cancelled: false,
  outputTruncated: false,
  cleanupComplete: true,
  durationMs: 10,
}
function fixture(overrides = {}) {
  let calls = 0
  let checked = 0
  const dependencies = {
    host: {
      execute: async () => {
        calls++
        return successful
      },
    },
    snapshot: {
      fingerprint: {
        status: 'versioned',
        providerId: 'fixture',
        token: 'v1',
        authorization: 'allowed',
        artifacts: [],
      },
      materials: [{ identity: 'file:module.mjs', text }],
      issues: [],
    },
    requirementIds: ['R1'],
    requirementsSha256: hash('fixed requirements'),
    assertCurrent: async () => {
      checked++
    },
    ...overrides,
  }
  return {
    validation: new CompletionValidation(dependencies),
    calls: () => calls,
    checked: () => checked,
    dependencies,
  }
}

test('validation operation declares execution separately from read-only evidence', () => {
  assert.equal(VelarCompletionValidationModule.operations.execute.effects, 'write')
  for (const invalid of [
    { ...input, command: 'anything' },
    { ...input, environment: {} },
    { ...input, requirementIds: [] },
    { ...input, artifacts: [] },
    { ...input, artifacts: [{ ...input.artifacts[0], path: '/tmp/extra' }] },
    { ...input, artifacts: [{ identity: 'execution:recent', sha256: hash(text) }] },
    { ...input, code: 'x'.repeat(32769) },
  ])
    assert.throws(() => completionValidationInput(invalid))
})

test('unlisted requirements, files and hashes never reach the host', async () => {
  for (const value of [
    { ...input, requirementIds: ['foreign'] },
    { ...input, artifacts: [{ identity: 'file:../secret', sha256: hash(text) }] },
    { ...input, artifacts: [{ identity: 'file:module.mjs', sha256: hash('different') }] },
  ]) {
    const f = fixture()
    await assert.rejects(f.validation.execute(value, signal), /需求|身份|哈希/u)
    assert.equal(f.calls(), 0)
  }
})

test('receipts bind full source, code and requirement hashes and consume a shared two-attempt budget', async () => {
  const f = fixture()
  const receipt = await f.validation.execute(input, signal)
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.codeSha256, hash(input.code))
  assert.equal(receipt.requirementsSha256, hash('fixed requirements'))
  assert.deepEqual(receipt.artifacts, input.artifacts)
  assert.equal(receipt.versionCurrent, true)
  assert.equal(f.checked(), 2)
  await assert.rejects(f.validation.execute({ ...input, code: '' }, signal))
  await assert.rejects(f.validation.execute(input, signal), /耗尽/u)
  assert.equal(f.calls(), 1)
})

test('version changes invalidate an actual execution receipt without inventing a new version', async () => {
  let checks = 0
  const f = fixture({
    assertCurrent: async () => {
      if (++checks === 2) throw new AppError('STALE', 'changed')
    },
  })
  const result = await f.validation.execute(input, signal)
  assert.equal(result.versionCurrent, false)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.stdout, '42\n')
})

test('timeout, cancellation, truncated output and incomplete cleanup cannot be successful receipts', async () => {
  for (const partial of [
    { timedOut: true },
    { cancelled: true },
    { outputTruncated: true },
    { cleanupComplete: false },
    { signal: 'SIGTERM' },
    { exitCode: 1 },
  ]) {
    const f = fixture({ host: { execute: async () => ({ ...successful, ...partial }) } })
    assert.equal((await f.validation.execute(input, signal)).status, 'failed')
  }
})

test('cancellation waits for host cleanup and preserves the actual cancelled receipt', async () => {
  const controller = new AbortController()
  let released = false
  let completed = false
  const f = fixture({
    host: {
      execute: async (_request, current) => {
        await new Promise((resolve) => current.addEventListener('abort', resolve, { once: true }))
        await delay(30)
        released = true
        return { ...successful, status: 'failed', cancelled: true, signal: 'SIGTERM' }
      },
    },
  })
  const pending = f.validation.execute(input, controller.signal).then((value) => {
    completed = true
    return value
  })
  await delay(5)
  controller.abort()
  await delay(5)
  assert.equal(completed, false)
  const receipt = await pending
  assert.equal(released, true)
  assert.equal(receipt.cancelled, true)
  assert.equal(receipt.versionCurrent, false)
})

const native = { skip: process.platform !== 'darwin', timeout: 20000 }
const host = createLocalNodeValidationHost({ executable: process.execPath })
const request = (code) => ({
  files: [{ identity: 'file:module.mjs', path: 'src/module.mjs', text, sha256: hash(text) }],
  code,
  timeoutMs: 10000,
  maxOutputBytes: 4096,
})

test(
  'real isolated Node validation imports immutable inputs and distinguishes a failed assertion',
  native,
  async () => {
    const code = `import assert from 'node:assert/strict'; const files=JSON.parse(process.env.VELAR_REVIEW_INPUTS); const {value}=await import(files['file:module.mjs']); assert.equal(value,42); console.log('verified');`
    const pass = await host.execute(request(code), signal)
    assert.equal(pass.status, 'passed', JSON.stringify(pass))
    assert.equal(pass.stdout.trim(), 'verified')
    assert.equal(pass.cleanupComplete, true)
    assert.match(pass.environmentSha256, /^[a-f0-9]{64}$/u)
    const fail = await host.execute(request(code.replace('value,42', 'value,43')), signal)
    assert.equal(fail.status, 'failed')
    assert.equal(fail.exitCode, 1)
    assert.match(fail.stderr, /AssertionError/u)
    assert.equal(fail.cleanupComplete, true)
  }
)

test(
  'real validation cannot alter its input, read outside or spawn processes',
  native,
  async () => {
    const result = await host.execute(
      request(
        `import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process'; const files=JSON.parse(process.env.VELAR_REVIEW_INPUTS);for(const action of [()=>fs.writeFileSync(new URL(files['file:module.mjs']),'changed'),()=>fs.readFileSync('/etc/hosts')]){assert.throws(action,error=>['EPERM','EACCES'].includes(error.code))} const child=cp.spawnSync(process.execPath,['-e','process.exit(0)']);assert(['EPERM','EACCES'].includes(child.error?.code));fs.writeFileSync('scratch','allowed');console.log(fs.readFileSync('scratch','utf8'));`
      ),
      signal
    )
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.stdout.trim(), 'allowed')
  }
)

test(
  'real timeout and cancellation stop the owned Node process before returning',
  native,
  async () => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController()
      const pending = host.execute(
        {
          ...request('console.log(process.pid);setInterval(()=>{},100);'),
          timeoutMs: cancelled ? 10000 : 900,
        },
        controller.signal
      )
      const timer = cancelled ? setTimeout(() => controller.abort(), 1200) : undefined
      const result = await pending
      clearTimeout(timer)
      assert.equal(cancelled ? result.cancelled : result.timedOut, true, JSON.stringify(result))
      assert.equal(result.cleanupComplete, true)
      const pid = Number(result.stdout.trim())
      assert(Number.isSafeInteger(pid) && pid > 1, JSON.stringify(result))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    }
  }
)

test('real output truncation stays bounded and prevents a passing receipt', native, async () => {
  const result = await host.execute(
    { ...request("console.log('🙂'.repeat(10000))"), maxOutputBytes: 512 },
    signal
  )
  assert.equal(result.status, 'failed', JSON.stringify(result))
  assert.equal(result.outputTruncated, true)
  assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 512)
  assert(!result.stdout.includes('\ufffd'))
  assert.equal(result.cleanupComplete, true)
})
