import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { monitorHostIo } from './host-health.mjs'

const execute = promisify(execFile)

test(
  'fatal host guard terminates while a real native filesystem worker cannot finish',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'host-native-failure-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const fifo = join(directory, 'blocked-open')
    await execute('/usr/bin/mkfifo', [fifo])
    const worker = join(directory, 'worker.mjs')
    await writeFile(
      worker,
      `import fs from 'node:fs';
import { monitorHostIo } from ${JSON.stringify(new URL('./host-health.mjs', import.meta.url).href)};
// A genuine libuv worker blocks opening a pipe with no writer. The health probe queues behind it.
fs.open(${JSON.stringify(fifo)}, 'r', () => {});
const monitor = monitorHostIo({ directory: ${JSON.stringify(directory)}, intervalMs: 10, timeoutMs: 50, shutdownGraceMs: 50 });
monitor.setPhase('fixture:native-worker-blocked');
await new Promise(() => {});
`
    )
    const result = await execute(process.execPath, [worker], {
      env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
      timeout: 5000,
      killSignal: 'SIGKILL',
    }).catch((error) => error)
    assert.equal(result.killed, false, 'Host guard must terminate before the test watchdog')
    assert.equal(result.signal, 'SIGKILL')
    const record = JSON.parse(
      await readFile(join(directory, 'evaluator-host-failure.json'), 'utf8')
    )
    assert.equal(record.kind, 'async-io-timeout')
    assert.equal(record.action, 'force-controller-sigkill')
    assert.equal(record.phase, 'fixture:native-worker-blocked')
    assert.equal(record.processCleanupVerified, false)
    assert.equal(
      record.exitedAt,
      undefined,
      'The controller can only record its termination request'
    )
    assert.equal(typeof record.terminationRequestedAt, 'string')
  }
)

test('healthy filesystem probes continue through phases and stop without failure evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'host-health-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const monitor = monitorHostIo({ directory, intervalMs: 10, timeoutMs: 1000 })
  t.after(() => monitor.stop())
  monitor.setPhase('fixture:grading')
  await delay(60)
  monitor.assertHealthy()
  const state = monitor.stop()
  assert(state.completedProbes >= 2)
  assert.equal(state.failed, false)
  await delay(30)
  assert.deepEqual(monitor.stop(), state)
  assert.equal(existsSync(join(directory, 'evaluator-host-failure.json')), false)
})

for (const mode of ['pending-read', 'read-error', 'cancellation-throws']) {
  test(`host guard exits with infrastructure evidence after ${mode}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'host-failure-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const worker = join(directory, 'worker.mjs')
    await writeFile(
      worker,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.readFile = ${mode === 'read-error' ? "(_path, callback) => setTimeout(() => callback(Object.assign(new Error('fixture'), { code: 'EIO' })), 5)" : '() => {}'};
syncBuiltinESMExports();
const { monitorHostIo } = await import(${JSON.stringify(new URL('./host-health.mjs', import.meta.url).href)});
let cancellations = 0;
const monitor = monitorHostIo({ directory: ${JSON.stringify(directory)}, intervalMs: 10, timeoutMs: 40, shutdownGraceMs: 40, onFailure() {
  cancellations++;
  fs.writeFileSync(${JSON.stringify(join(directory, 'cancelled.json'))}, JSON.stringify({ cancellations }));
  // Even cleanup that calls stop or throws cannot cancel the fatal deadline.
  monitor.stop();
  ${mode === 'cancellation-throws' ? "throw new Error('cleanup also failed');" : ''}
} });
monitor.setPhase('fixture:finalizing');
setTimeout(() => process.exit(91), 2000);
await new Promise(() => {});
`
    )
    const result = await execute(process.execPath, [worker], { timeout: 3000 }).catch((e) => e)
    assert.equal(result.signal, 'SIGKILL', result.stderr)
    assert.equal(result.killed, false, 'Host guard must terminate before the test watchdog')
    const record = JSON.parse(
      await readFile(join(directory, 'evaluator-host-failure.json'), 'utf8')
    )
    assert.equal(record.classification, 'evaluation-infrastructure-failure')
    assert.equal(record.kind, mode === 'read-error' ? 'async-io-error' : 'async-io-timeout')
    assert.equal(record.action, 'force-controller-sigkill')
    assert.equal(record.phase, 'fixture:finalizing')
    assert.equal(record.participantOutcome, null)
    assert.equal(record.processCleanupVerified, false)
    assert.equal(record.completedProbes, 0)
    if (mode === 'cancellation-throws')
      assert.equal(record.cancellationErrorCode, 'CANCELLATION_ERROR')
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'cancelled.json'), 'utf8')), {
      cancellations: 1,
    })
  })
}

test('host failure cancels an actual CLI and preserves its exit before stuck finalization', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'host-cli-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'fake-codex')
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { require('node:fs').writeFileSync(1, '{"type":"thread.started","thread_id":"host-failure"}\\n'); setInterval(() => {}, 1000) });\n`,
    { mode: 0o700 }
  )
  const worker = join(directory, 'worker.mjs')
  await writeFile(
    worker,
    `import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
fs.readFile = () => {};
promises.readFile = () => new Promise(() => {});
syncBuiltinESMExports();
const { monitorHostIo } = await import(${JSON.stringify(new URL('./host-health.mjs', import.meta.url).href)});
const { runCodex } = await import(${JSON.stringify(new URL('../native-desktop/codex.mjs', import.meta.url).href)});
const cancellation = new AbortController();
let monitor;
const result = await runCodex({ executable: ${JSON.stringify(executable)}, workspace: ${JSON.stringify(directory)}, directory: ${JSON.stringify(directory)}, baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture', model: 'fixture', prompt: 'input', timeoutMs: 2000, signal: cancellation.signal, onSpawn() {
  monitor = monitorHostIo({ directory: ${JSON.stringify(directory)}, intervalMs: 10, timeoutMs: 150, shutdownGraceMs: 200, onFailure(error) { cancellation.abort(error) } });
  monitor.setPhase('fixture:executing');
} });
fs.writeFileSync(${JSON.stringify(join(directory, 'native-result.json'))}, JSON.stringify(result));
monitor.setPhase('fixture:finalizing');
// The same host cannot proceed through an asynchronous snapshot or grading read.
await promises.readFile(${JSON.stringify(worker)});
`
  )
  const result = await execute(process.execPath, [worker], { timeout: 4000 }).catch((e) => e)
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.equal(result.killed, false, 'Host guard must terminate before the test watchdog')
  const native = JSON.parse(await readFile(join(directory, 'native-result.json'), 'utf8'))
  assert.equal(native.cancelled, true)
  assert.equal(native.timedOut, false)
  assert.equal(native.terminalComplete, false)
  const checkpoint = JSON.parse(await readFile(join(directory, 'codex-exit.json'), 'utf8'))
  assert.equal(checkpoint.signal, 'SIGTERM')
  assert.throws(() => process.kill(-checkpoint.pid, 0), { code: 'ESRCH' })
  const record = JSON.parse(await readFile(join(directory, 'evaluator-host-failure.json'), 'utf8'))
  assert.equal(record.action, 'force-controller-sigkill')
  assert.equal(record.participantOutcome, null)
  assert.equal(checkpoint.exitedAt <= Date.parse(record.terminationRequestedAt), true)
})
