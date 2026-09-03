import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  InMemoryKernelBackgroundJobOutputStore,
  KernelBackgroundJobManager,
  type KernelBackgroundJobOutputStore,
  type KernelBackgroundJobStoredOutput,
} from '../src/kernel/background-jobs'
import { formatSubAgentBackgroundArtifact } from '../src/kernel/dispatch/result-format'

class ReadFailingOutputStore implements KernelBackgroundJobOutputStore {
  private readonly delegate = new InMemoryKernelBackgroundJobOutputStore()
  public readCalls = 0

  public append(input: {
    jobId: string
    sessionId: string
    parentSessionId?: string
    chunk: string
  }): void {
    this.delegate.append(input)
  }

  public read(_input: { jobId: string; offset: number }): Nullable<KernelBackgroundJobStoredOutput> {
    this.readCalls += 1
    throw new Error('artifact read unavailable')
  }

  public readAll(_input: { jobId: string }): Nullable<KernelBackgroundJobStoredOutput> {
    this.readCalls += 1
    throw new Error('artifact read unavailable')
  }

  public dropJob(_jobId: string): void {
    throw new Error('artifact cleanup unavailable')
  }

  public dropSession(_sessionId: string): void {
    throw new Error('artifact session cleanup unavailable')
  }
}

function startJob(manager: KernelBackgroundJobManager, id: string) {
  return manager.start({
    id,
    sessionId: 'session-1',
    kind: 'sub-agent',
    label: id,
  })
}

void describe('KernelBackgroundJobManager wait-any completion boundary', () => {
  void test('wakes after the first terminal job while explicit waitForSession remains wait-all', async () => {
    const manager = new KernelBackgroundJobManager()
    startJob(manager, 'job-a')
    startJob(manager, 'job-b')

    const nextTerminal = manager.waitForNextTerminalForSession('session-1')
    manager.complete('job-a', { result: 'a done' })

    const first = await nextTerminal
    assert.equal(first?.id, 'job-a')
    assert.equal(first?.status, 'completed')
    assert.deepEqual(manager.runningForSession('session-1').map((job) => job.id), ['job-b'])

    let waitAllSettled = false
    const waitAll = manager
      .waitForSession('session-1', { jobIds: ['job-a', 'job-b'] })
      .then((snapshots) => {
        waitAllSettled = true
        return snapshots
      })
    await Promise.resolve()
    assert.equal(waitAllSettled, false)

    manager.complete('job-b', { result: 'b done' })
    const all = await waitAll
    assert.deepEqual(all.map((snapshot) => snapshot.id), ['job-a', 'job-b'])
  })

  void test('registers before onWaiting and cannot lose a terminal transition in that window', async () => {
    const manager = new KernelBackgroundJobManager()
    startJob(manager, 'job-race')

    const terminal = await manager.waitForNextTerminalForSession('session-1', {
      onWaiting: () => {
        manager.complete('job-race', { result: 'finished during wait registration' })
      },
    })

    assert.equal(terminal?.id, 'job-race')
    assert.equal(terminal?.status, 'completed')
  })

  void test('execution abort releases the waiter immediately without waiting for the job', async () => {
    const manager = new KernelBackgroundJobManager()
    const controller = new AbortController()
    startJob(manager, 'job-long')

    const terminal = await manager.waitForNextTerminalForSession('session-1', {
      signal: controller.signal,
      onWaiting: () => controller.abort('stop execution'),
    })

    assert.equal(terminal, null)
    assert.deepEqual(manager.runningForSession('session-1').map((job) => job.id), ['job-long'])
  })

  void test('cancelForSession is a terminal transition that wakes wait-any', async () => {
    const manager = new KernelBackgroundJobManager()
    const artifact = formatSubAgentBackgroundArtifact({
      thread_id: 'thread-cancelled',
      status: 'aborted',
      summary: 'cancel acknowledged by worker',
    })
    manager.start({
      id: 'job-cancel',
      sessionId: 'session-1',
      kind: 'sub-agent',
      label: 'cancelled child',
      // Dispatcher 也利用这个同步顺序：Manager 先置 cancelled，然后 onCancel 写制品，
      // 最后才发 lifecycle delta/notify waiter。
      onCancel: () => manager.appendTerminalArtifact('job-cancel', artifact.artifact),
    })
    const waiting = manager.waitForNextTerminalForSession('session-1')

    manager.cancelForSession('session-1', 'job-cancel')
    const terminal = await waiting

    assert.equal(terminal?.id, 'job-cancel')
    assert.equal(terminal?.status, 'cancelled')
    assert.ok(
      manager
        .snapshotOutputForSession('session-1', 'job-cancel')
        ?.output.includes('"status":"aborted"')
    )
  })

  void test('stores the full terminal artifact while keeping the job record preview bounded', () => {
    const manager = new KernelBackgroundJobManager({
      outputStore: new InMemoryKernelBackgroundJobOutputStore(),
    })
    startJob(manager, 'job-artifact')
    const preview = `preview:${'p'.repeat(3_000)}`
    const artifact = JSON.stringify({
      thread_id: 'thread-full',
      status: 'completed',
      summary: `full:${'f'.repeat(5_000)}:artifact-tail`,
    })

    const finished = manager.complete('job-artifact', { result: preview, artifact })
    const snapshot = manager.snapshotOutputForSession('session-1', 'job-artifact')

    assert.equal(finished.result?.length, 2_000)
    assert.ok(finished.result?.endsWith('…'))
    assert.equal(snapshot?.output, artifact)
    assert.ok(snapshot?.output.includes('artifact-tail'))
  })

  void test('serializes completed, failed, and aborted SubAgentTaskResult envelopes for artifacts', () => {
    for (const status of ['completed', 'failed', 'aborted'] as const) {
      const formatted = formatSubAgentBackgroundArtifact({
        thread_id: `thread-${status}`,
        status,
        summary: `${status} full summary`,
        structured_output: { status, retained: true },
      })

      assert.equal(formatted.degraded, false)
      assert.ok(formatted.artifact.includes(`"thread_id":"thread-${status}"`))
      assert.ok(formatted.artifact.includes(`"status":"${status}"`))
      assert.ok(formatted.artifact.includes('"retained":true'))
    }
  })

  void test('non-serializable structured output degrades to summary instead of throwing', () => {
    const formatted = formatSubAgentBackgroundArtifact({
      thread_id: 'thread-bigint',
      status: 'completed',
      summary: 'safe fallback summary',
      structured_output: { unsupported: 1n },
    })

    assert.equal(formatted.degraded, true)
    assert.equal(formatted.artifact, 'safe fallback summary')
  })

  void test('terminal lifecycle notification contains status and read hint, not child output', () => {
    const manager = new KernelBackgroundJobManager()
    const source = manager.createTurnContextSource(['default'])
    startJob(manager, 'job-notice')
    manager.complete('job-notice', {
      result: 'SECRET_CHILD_RESULT_MUST_NOT_BE_IN_CONTEXT',
    })

    const snapshot = source.peekCached({
      sessionId: 'session-1',
      afterSeq: 0,
      generation: null,
    })
    const terminal = snapshot.deltas.at(-1)
    assert.ok(terminal?.summaryText.includes('已完成'))
    assert.ok(!terminal?.summaryText.includes('SECRET_CHILD_RESULT_MUST_NOT_BE_IN_CONTEXT'))
    assert.deepEqual(terminal?.inspect, {
      tool: 'job:read_output',
      argsHint: { job_id: 'job-notice' },
    })
  })

  void test('publishes one output-free lifecycle delta per terminal job', () => {
    const manager = new KernelBackgroundJobManager()
    const source = manager.createTurnContextSource(['default'])
    startJob(manager, 'job-a-event')
    startJob(manager, 'job-b-event')

    manager.complete('job-a-event', { result: 'SECRET_RESULT_A' })
    manager.fail('job-b-event', { error: 'SECRET_ERROR_B' })

    const snapshot = source.peekCached({
      sessionId: 'session-1',
      afterSeq: 0,
      generation: null,
    })
    assert.equal(snapshot.deltas.length, 2)
    assert.deepEqual(
      snapshot.deltas.map((delta) => delta.inspect?.argsHint?.job_id),
      ['job-a-event', 'job-b-event']
    )
    assert.deepEqual(
      snapshot.deltas.map((delta) => delta.label),
      ['job-a-event 完成', 'job-b-event 失败']
    )
    const notificationText = snapshot.deltas.map((delta) => delta.summaryText).join('\n')
    assert.ok(!notificationText.includes('SECRET_RESULT_A'))
    assert.ok(!notificationText.includes('SECRET_ERROR_B'))
  })

  void test('artifact read and cleanup failures fall back without suppressing terminal delivery', async () => {
    let terminalEvents = 0
    const outputStore = new ReadFailingOutputStore()
    const manager = new KernelBackgroundJobManager({
      outputStore,
      onTerminal: () => {
        terminalEvents += 1
      },
    })
    startJob(manager, 'job-io-failure')
    // 这条断言也防 appendOutput 回归为每个 chunk 双写。
    manager.appendOutput('job-io-failure', 'progress-once')
    const waiting = manager.waitForNextTerminalForSession('session-1')

    assert.doesNotThrow(() => {
      manager.complete('job-io-failure', { result: 'done', artifact: 'full-result-artifact' })
    })
    const terminal = await waiting
    // wait-any 是薄控制面唤醒，不得偷读全量 artifact。
    assert.equal(outputStore.readCalls, 0)
    const output = manager.snapshotOutputForSession('session-1', 'job-io-failure')

    assert.equal(terminalEvents, 1)
    assert.equal(terminal?.status, 'completed')
    assert.ok(output?.output.includes('progress-once\nfull-result-artifact'))
    assert.equal(output?.output.match(/progress-once/g)?.length, 1)
    assert.ok(output?.artifactError?.includes('artifact read unavailable'))
    assert.equal(outputStore.readCalls, 1)
    assert.doesNotThrow(() => manager.dropSession('session-1'))
  })
})
