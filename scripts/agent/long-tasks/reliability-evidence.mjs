// 校验持久故障压测的日志完整性与统计；真实运行时间另由宿主执行回执审计，文件不能自行证明。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { ProductivityLedger } from './reliability-productivity.mjs'

export const faultKinds = ['write-kill', 'compact-kill', 'lost-ack', 'offline-reconnect']

// 两份输入须先完整校验日志；累计通过不能代替本次恢复调用新增的工作和故障覆盖。
export function assertReliabilityAppend(previous, current, limits) {
  const before = previous.report.segments
  const after = current.report.segments
  assert(after.length > before.length, 'Resume must append complete evidence segments')
  assert.deepEqual(after.slice(0, before.length), before, 'Resume must preserve prior evidence')
  const delta = {
    productiveMs: current.productiveMs - previous.productiveMs,
    transactions: current.transactions - previous.transactions,
    faults: Object.fromEntries(
      faultKinds.map((kind) => [kind, current.faults[kind] - previous.faults[kind]])
    ),
  }
  assert(
    delta.productiveMs >= limits.productiveMs,
    'Resumed invocation did not add its requested productive duration'
  )
  assert(
    delta.transactions >= limits.transactions,
    'Resumed invocation did not add its required acknowledged workload'
  )
  for (const kind of faultKinds)
    assert(
      delta.faults[kind] >= limits.faults,
      `Resumed invocation has insufficient ${kind} coverage`
    )
  return delta
}

// 长日志按块校验原始字节哈希，逐条解析；单条记录沿用原读取额度，不把总日志载入内存。
async function* readLogEvents(path, hash) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let hasEvents = false
  let trailingBlank = false
  const parse = (line) => {
    if (!line.trim()) {
      if (hasEvents) trailingBlank = true
      return { present: false }
    }
    assert(!trailingBlank, 'Empty interior evidence records are invalid')
    assert(Buffer.byteLength(line) <= 32_000_000, 'Evidence record exceeds its bounded read size')
    hasEvents = true
    return { present: true, value: JSON.parse(line) }
  }
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk)
    pending += decoder.decode(chunk, { stream: true })
    let offset = 0
    let end
    while ((end = pending.indexOf('\n', offset)) !== -1) {
      const record = parse(pending.slice(offset, end))
      if (record.present) yield record.value
      offset = end + 1
    }
    pending = pending.slice(offset)
    assert(
      Buffer.byteLength(pending) <= 32_000_000,
      'Evidence record exceeds its bounded read size'
    )
  }
  pending += decoder.decode()
  const record = parse(pending)
  if (record.present) yield record.value
}

export async function readReliabilityEvidence(directory, limits = {}) {
  const root = await realpath(directory)
  const locate = async (relative) => {
    const path = await realpath(join(root, relative))
    assert(path.startsWith(root + sep), 'Evidence must stay inside its campaign directory')
    const info = await stat(path)
    assert(info.isFile(), 'Evidence must be a regular file')
    return { path, size: info.size }
  }
  const read = async (relative, maxBytes) => {
    const { path, size } = await locate(relative)
    assert(size <= maxBytes, 'Evidence file exceeds its bounded read size')
    return readFile(path, 'utf8')
  }
  const report = JSON.parse(await read('report.json', 2_000_000))
  assert.equal(report.schema, 1)
  assert.equal(report.status, 'passed')
  assert(
    Array.isArray(report.segments) && report.segments.length > 0 && report.segments.length <= 10000
  )
  const ids = new Set()
  const paths = new Set()
  const requests = new Set()
  const rooms = new Set()
  const clients = new Set()
  const faults = Object.fromEntries(faultKinds.map((kind) => [kind, 0]))
  let segmentElapsedMs = 0
  let workProductiveMs = 0
  let workIntervals = 0
  let explicitIdleMs = 0
  let previousEnd = 0
  for (const segment of report.segments) {
    assert(
      typeof segment.id === 'string' && segment.id && !ids.has(segment.id),
      'Unique segment ID required'
    )
    ids.add(segment.id)
    // 合同要求普通文件名，不限制时间戳、空格或 Unicode；两种路径分隔符都不能越界。
    assert.match(segment.log, /^[^/\\\0]+\.ndjson$/u)
    assert(!paths.has(segment.log), 'A log cannot be counted twice')
    paths.add(segment.log)
    const { path } = await locate(join('evidence', segment.log))
    const hash = createHash('sha256')
    let first
    let last
    let events = 0
    let elapsed = 0
    let progress
    let acknowledged = 0
    let verified = 0
    let pendingFault = false
    const productivity = limits.workIntervals ? new ProductivityLedger() : null
    for await (const event of readLogEvents(path, hash)) {
      events++
      productivity?.add(event)
      if (events === 1) {
        first = event
        assert.equal(first.type, 'start')
        assert.equal(first.segmentId, segment.id)
        assert(Number.isSafeInteger(first.pid) && first.pid > 0)
        continue
      }
      last = event
      assert(
        Number.isFinite(event.elapsedMs) && event.elapsedMs >= elapsed,
        'Monotonic progress required'
      )
      elapsed = event.elapsedMs
      // 进度间隔只比较两个真实进度事件；启动/收尾是否计入工作由区间账本单独校验。
      if (
        progress !== undefined &&
        (event.type === 'ack' || event.type === 'fault' || event.type === 'verified')
      )
        assert(elapsed - progress <= 10000, 'Unproductive gaps cannot count as soak work')
      if (event.type === 'ack') {
        for (const name of ['room', 'clientId', 'requestId'])
          assert(typeof event[name] === 'string' && event[name])
        assert(Number.isSafeInteger(event.revision) && event.revision > 0)
        const identity = JSON.stringify([event.room, event.clientId, event.requestId])
        assert(
          !requests.has(identity),
          'Retried acknowledgements cannot inflate unique transactions'
        )
        requests.add(identity)
        rooms.add(event.room)
        clients.add(event.clientId)
        acknowledged++
        progress = elapsed
      } else if (event.type === 'fault') {
        assert(faultKinds.includes(event.kind))
        assert(Number.isSafeInteger(event.pid) && event.pid > 0)
        assert(typeof event.detail === 'string' && event.detail.length > 0)
        assert(!pendingFault, 'Verify recovery before injecting the next fault')
        pendingFault = true
        faults[event.kind]++
        progress = elapsed
      } else if (event.type === 'verified') {
        verified++
        pendingFault = false
        progress = elapsed
      }
    }
    assert.equal(hash.digest('hex'), segment.sha256, 'Segment hash mismatch')
    assert(events >= 4, 'A segment must contain actual acknowledged work and verification')
    assert.equal(last.type, 'end')
    assert.equal(last.success, true)
    const started = Date.parse(first.at)
    const ended = Date.parse(last.at)
    assert(Number.isFinite(started) && Number.isFinite(ended) && ended > started)
    assert(started >= previousEnd, 'Concurrent segments cannot be added to elapsed work')
    assert(Number.isFinite(last.elapsedMs) && last.elapsedMs > 0)
    assert(
      Math.abs(ended - started - last.elapsedMs) <= 2000,
      'Wall and monotonic segment durations disagree'
    )
    previousEnd = ended
    assert(
      acknowledged > 0 && verified > 0 && !pendingFault,
      'Every segment must acknowledge work and verify recovery'
    )
    segmentElapsedMs += last.elapsedMs
    if (productivity) {
      const measured = productivity.finish()
      workProductiveMs += measured.productiveMs
      workIntervals += measured.workIntervals
      explicitIdleMs += measured.excludedExplicitIdleMs
    }
  }
  assert(
    Number.isFinite(report.productiveMs) &&
      report.productiveMs > 0 &&
      report.productiveMs <= segmentElapsedMs,
    'Cumulative productive time must be positive and cannot exceed complete segment duration'
  )
  assert.equal(report.transactions, requests.size, 'Transaction total must match unique receipts')
  assert.deepEqual(report.faults, faults)
  if (limits.workIntervals)
    assert.equal(
      report.productiveMs,
      workProductiveMs,
      'Productive time must equal complete non-overlapping work intervals'
    )
  assert(
    report.productiveMs >= (limits.productiveMs ?? 4_500_000),
    'Required productive soak duration was not reached'
  )
  assert(
    requests.size >= (limits.transactions ?? 15000),
    'Required transaction workload was not reached'
  )
  assert(rooms.size >= 3 && clients.size >= 2, 'Exercise multiple rooms and clients')
  for (const kind of faultKinds)
    assert(faults[kind] >= (limits.faults ?? 10), `Insufficient ${kind} coverage`)
  return {
    report,
    productiveMs: report.productiveMs,
    segmentElapsedMs,
    productiveTimeVerified: false,
    productiveTimeBasis:
      'Structural bounds only; derive actual productive intervals from retained source and hash-bound logs, then verify against host execution before awarding long-task completion',
    ...(limits.workIntervals
      ? {
          intervalAccounting: {
            productiveMs: workProductiveMs,
            workIntervals,
            excludedExplicitIdleMs: explicitIdleMs,
            structuralTimeVerified: true,
            actualWorkVerified: false,
          },
        }
      : {}),
    transactions: requests.size,
    faults,
    rooms: rooms.size,
    clients: clients.size,
  }
}
