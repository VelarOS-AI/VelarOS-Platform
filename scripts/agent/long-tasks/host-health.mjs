// 宿主异步文件操作失效时先记录基础设施故障并取消任务，宽限期后有界退出。
import assert from 'node:assert/strict'
import { readFile, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function monitorHostIo({
  directory,
  probePath = import.meta.filename,
  intervalMs = 5000,
  timeoutMs = 15000,
  shutdownGraceMs = 10000,
  onFailure = () => {},
}) {
  for (const value of [intervalMs, timeoutMs, shutdownGraceMs])
    assert(Number.isSafeInteger(value) && value > 0, 'Host health intervals must be positive')
  const startedAt = new Date().toISOString()
  let stopped = false
  let pending = false
  let deadline
  let interval
  let phase = 'initializing'
  let completedProbes = 0
  let lastCompletedAt = null
  let failure = null
  const path = join(directory, 'evaluator-host-failure.json')
  const persist = (record) => {
    writeFileSync(path + '.writing', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    renameSync(path + '.writing', path)
  }
  const fail = (kind, probeStartedAt, error) => {
    if (stopped || failure) return
    clearTimeout(deadline)
    clearInterval(interval)
    failure = new Error('Evaluator asynchronous filesystem health check failed')
    const record = {
      schema: 1,
      classification: 'evaluation-infrastructure-failure',
      kind,
      controllerPid: process.pid,
      startedAt,
      detectedAt: new Date().toISOString(),
      phase,
      probePath,
      probeStartedAt,
      completedProbes,
      lastCompletedAt,
      timeoutMs,
      shutdownGraceMs,
      ...(error ? { errorCode: error.code ?? 'PROBE_ERROR' } : {}),
      action: 'cancel-participant-and-preserve-resources',
      participantOutcome: null,
      processCleanupVerified: false,
    }
    // 不能再依赖失效的异步 snapshot，也不能让失效的 finally 撤销退出期限。
    process.exitCode = 70
    setTimeout(() => {
      try {
        persist({
          ...record,
          action: 'force-controller-sigkill',
          terminationRequestedAt: new Date().toISOString(),
        })
      } finally {
        // process.exit 仍会等待 libuv 原生线程池清理；该故障下只能由系统终止当前拥有的进程。
        process.kill(process.pid, 'SIGKILL')
      }
    }, shutdownGraceMs)
    try {
      persist(record)
    } catch (error) {
      record.evidenceErrorCode = error.code ?? 'HOST_EVIDENCE_ERROR'
    }
    try {
      onFailure(failure)
    } catch (error) {
      record.cancellationErrorCode = error.code ?? 'CANCELLATION_ERROR'
    }
  }
  const probe = () => {
    if (stopped || failure || pending) return
    pending = true
    const probeStartedAt = new Date().toISOString()
    deadline = setTimeout(() => fail('async-io-timeout', probeStartedAt), timeoutMs)
    deadline.unref()
    readFile(probePath, (error) => {
      if (stopped || failure) return
      clearTimeout(deadline)
      pending = false
      if (error) fail('async-io-error', probeStartedAt, error)
      else {
        completedProbes++
        lastCompletedAt = new Date().toISOString()
      }
    })
  }
  interval = setInterval(probe, intervalMs)
  interval.unref()
  probe()
  return {
    setPhase(value) {
      phase = value
    },
    assertHealthy() {
      if (failure) throw failure
    },
    stop() {
      stopped = true
      clearInterval(interval)
      clearTimeout(deadline)
      return { completedProbes, lastCompletedAt, failed: failure !== null }
    },
  }
}
