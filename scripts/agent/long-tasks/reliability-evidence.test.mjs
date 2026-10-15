// 合成夹具只校准证据解析器，不构成真实持续运行或产品正确性的证明。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertReliabilityAppend,
  faultKinds,
  readReliabilityEvidence,
} from './reliability-evidence.mjs'

const limits = { productiveMs: 4000, transactions: 12, faults: 2 }

function appendEvidence(productiveMs, transactions, faults, count) {
  return {
    productiveMs,
    transactions,
    faults: Object.fromEntries(faultKinds.map((kind) => [kind, faults])),
    report: {
      segments: Array.from({ length: count }, (_, index) => ({
        id: String(index),
        log: `${index}.ndjson`,
        sha256: String(index).repeat(64),
      })),
    },
  }
}

test('resume validates the added invocation across multiple new segments', () => {
  const before = appendEvidence(10000, 100, 8, 2)
  const after = appendEvidence(12000, 110, 9, 4)
  assert.deepEqual(
    assertReliabilityAppend(before, after, { productiveMs: 2000, transactions: 10, faults: 1 }),
    {
      productiveMs: 2000,
      transactions: 10,
      faults: Object.fromEntries(faultKinds.map((kind) => [kind, 1])),
    }
  )
})

test('large prior fault totals cannot hide a missing category in the resumed invocation', () => {
  const before = appendEvidence(10000, 100, 8, 2)
  const after = appendEvidence(12000, 110, 9, 3)
  after.faults['lost-ack'] = 8
  assert.throws(
    () =>
      assertReliabilityAppend(before, after, { productiveMs: 2000, transactions: 10, faults: 1 }),
    /Resumed invocation has insufficient lost-ack coverage/u
  )
})

test('old productive work and receipts cannot satisfy a resumed invocation', () => {
  const before = appendEvidence(10000, 100, 8, 2)
  for (const [after, message] of [
    [appendEvidence(11000, 110, 9, 3), /requested productive duration/u],
    [appendEvidence(12000, 105, 9, 3), /required acknowledged workload/u],
  ])
    assert.throws(
      () =>
        assertReliabilityAppend(before, after, { productiveMs: 2000, transactions: 10, faults: 1 }),
      message
    )
})

test('new totals cannot authorize rewriting the previous evidence prefix', () => {
  const before = appendEvidence(10000, 100, 8, 2)
  const after = appendEvidence(12000, 110, 9, 3)
  after.report.segments[0].sha256 = 'a'.repeat(64)
  assert.throws(
    () =>
      assertReliabilityAppend(before, after, { productiveMs: 2000, transactions: 10, faults: 1 }),
    /Resume must preserve prior evidence/u
  )
})

async function fixture(t, changeEvents = () => {}, changeReport = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'reliability-evidence-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'evidence'))
  const report = {
    schema: 1,
    status: 'passed',
    productiveMs: 4000,
    transactions: 12,
    faults: Object.fromEntries(faultKinds.map((kind) => [kind, 2])),
    segments: [],
  }
  for (let index = 0; index < 2; index++) {
    const id = `segment-${index}`
    const start = Date.UTC(2020, 0, 1) + index * 3000
    const events = [{ type: 'start', segmentId: id, at: new Date(start).toISOString(), pid: 42 }]
    for (let n = 0; n < 6; n++)
      events.push({
        type: 'ack',
        elapsedMs: n * 200 + 10,
        room: `room-${n % 3}`,
        revision: n + 1,
        clientId: `client-${n % 2}`,
        requestId: `${id}-${n}`,
      })
    for (let n = 0; n < 4; n++) {
      events.push({
        type: 'fault',
        elapsedMs: n * 200 + 50,
        kind: faultKinds[n],
        pid: 42,
        detail: 'synthetic parser-control barrier',
      })
      events.push({ type: 'verified', elapsedMs: n * 200 + 80 })
    }
    events.push({
      type: 'end',
      elapsedMs: 2000,
      at: new Date(start + 2000).toISOString(),
      success: true,
    })
    events.sort((a, b) => (a.elapsedMs ?? 0) - (b.elapsedMs ?? 0))
    changeEvents(events, index)
    const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    const log = `${id}.ndjson`
    await writeFile(join(root, 'evidence', log), body)
    report.segments.push({ id, log, sha256: createHash('sha256').update(body).digest('hex') })
  }
  changeReport(report)
  await writeFile(join(root, 'report.json'), JSON.stringify(report))
  return root
}

test('complete non-overlapping log segments support counts without claiming real elapsed work', async (t) => {
  const root = await fixture(t)
  const value = await readReliabilityEvidence(root, limits)
  assert.equal(value.productiveMs, 4000)
  assert.equal(value.transactions, 12)
  assert.equal(value.rooms, 3)
  assert.equal(value.clients, 2)
  await assert.rejects(readReliabilityEvidence(root), /duration/u)
})

test('evidence accepts ordinary NDJSON basenames including timestamps and Unicode', async (t) => {
  for (const name of ['2026-10-13T09-56-57.556Z', 'work log.2', '恢复记录']) {
    const root = await fixture(t)
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
    for (const [index, segment] of report.segments.entries()) {
      const log = `${name}-${index}.ndjson`
      await rename(join(root, 'evidence', segment.log), join(root, 'evidence', log))
      segment.log = log
    }
    await writeFile(join(root, 'report.json'), JSON.stringify(report))
    assert.equal((await readReliabilityEvidence(root, limits)).transactions, 12)
  }
})

test('evidence log references must remain basenames on either path convention', async (t) => {
  for (const log of [
    '../segment-0.ndjson',
    '/segment-0.ndjson',
    'dir\\segment-0.ndjson',
    'bad\0.ndjson',
  ]) {
    const root = await fixture(t, undefined, (report) => (report.segments[0].log = log))
    await assert.rejects(readReliabilityEvidence(root, limits))
  }
})

test('productive time can exclude setup and teardown from hash-bound segment time', async (t) => {
  const root = await fixture(
    t,
    (events) => {
      events.splice(1, 0, { type: 'workload-start', elapsedMs: 5 })
      events.splice(-1, 0, { type: 'workload-end', elapsedMs: 1755 })
    },
    (report) => {
      report.productiveMs = 3500
    }
  )
  const value = await readReliabilityEvidence(root, { ...limits, productiveMs: 3500 })
  assert.equal(value.productiveMs, 3500)
  assert.equal(value.segmentElapsedMs, 4000)
  assert.equal(value.productiveTimeVerified, false)
  await assert.rejects(readReliabilityEvidence(root, limits), /duration/u)
})

test('prospective interval accounting rejects legacy elapsed-only evidence', async (t) => {
  const root = await fixture(t)
  await readReliabilityEvidence(root, limits)
  await assert.rejects(
    readReliabilityEvidence(root, { ...limits, workIntervals: true }),
    /productive intervals/u
  )
})

const addIntervals = (events) => {
  const work = events
    .filter((event) => event.type === 'ack')
    .map((event) => ({
      type: 'work',
      kind: 'transaction',
      startMs: event.elapsedMs - 5,
      endMs: event.elapsedMs,
      elapsedMs: event.elapsedMs,
    }))
  events.push(...work, { type: 'idle', startMs: 1100, endMs: 1500, elapsedMs: 1500 })
  events.sort((a, b) => (a.elapsedMs ?? 0) - (b.elapsedMs ?? 0))
}

for (const [setupMs, cleanupMs] of [
  [20000, 0],
  [0, 20000],
  [20000, 20000],
])
  test(`setup and cleanup gaps outside work are excluded (${setupMs}, ${cleanupMs})`, async (t) => {
    const root = await fixture(
      t,
      (events, index) => {
        addIntervals(events)
        const start = Date.UTC(2020, 0, 1) + index * 60000
        events[0].at = new Date(start).toISOString()
        for (const event of events)
          for (const key of ['elapsedMs', 'startMs', 'endMs'])
            if (typeof event[key] === 'number') event[key] += setupMs
        events.at(-1).elapsedMs += cleanupMs
        events.at(-1).at = new Date(start + events.at(-1).elapsedMs).toISOString()
      },
      (report) => {
        report.productiveMs = 60
      }
    )
    const result = await readReliabilityEvidence(root, {
      ...limits,
      productiveMs: 60,
      workIntervals: true,
    })
    assert.equal(result.productiveMs, 60)
    assert.equal(result.intervalAccounting.productiveMs, 60)
    assert.equal(result.productiveTimeVerified, false)
  })

test('complete streamed intervals reconcile across segments without claiming actual work', async (t) => {
  const root = await fixture(t, addIntervals, (report) => {
    report.productiveMs = 60
  })
  const result = await readReliabilityEvidence(root, {
    ...limits,
    productiveMs: 60,
    workIntervals: true,
  })
  assert.equal(result.productiveTimeVerified, false)
  assert.deepEqual(result.intervalAccounting, {
    productiveMs: 60,
    workIntervals: 12,
    excludedExplicitIdleMs: 800,
    structuralTimeVerified: true,
    actualWorkVerified: false,
  })
})

test('idle and setup time cannot inflate the prospective productive total', async (t) => {
  const root = await fixture(t, addIntervals)
  await readReliabilityEvidence(root, limits)
  await assert.rejects(
    readReliabilityEvidence(root, { ...limits, workIntervals: true }),
    /complete non-overlapping work intervals/u
  )
})

for (const productiveMs of [null, '4000', -1, 0])
  test(`rejects invalid reported productive duration ${JSON.stringify(productiveMs)}`, async (t) => {
    const root = await fixture(t, undefined, (report) => {
      report.productiveMs = productiveMs
    })
    await assert.rejects(readReliabilityEvidence(root, limits), /productive time/u)
  })

test('a long valid log can exceed 32 MB without changing its event accounting', async (t) => {
  const root = await fixture(t)
  const reportPath = join(root, 'report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const logPath = join(root, 'evidence', report.segments[0].log)
  const original = await readFile(logPath, 'utf8')
  const firstEnd = original.indexOf('\n') + 1
  const file = await open(logPath, 'w')
  const hash = createHash('sha256')
  const write = async (text) => {
    await file.writeFile(text)
    hash.update(text)
  }
  try {
    await write(original.slice(0, firstEnd))
    const batch = (
      JSON.stringify({ type: 'diagnostic', elapsedMs: 0, detail: 'x'.repeat(1024) }) + '\n'
    ).repeat(128)
    for (let index = 0; index < 256; index++) await write(batch)
    await write(original.slice(firstEnd))
  } finally {
    await file.close()
  }
  assert((await stat(logPath)).size > 32_000_000)
  report.segments[0].sha256 = hash.digest('hex')
  await writeFile(reportPath, JSON.stringify(report))
  const value = await readReliabilityEvidence(root, limits)
  assert.equal(value.transactions, 12)
  assert.equal(value.segmentElapsedMs, 4000)
  assert.equal(value.productiveTimeVerified, false)
  await appendFile(logPath, ' ')
  await assert.rejects(readReliabilityEvidence(root, limits), /hash/u)
})

test('UTF-8 event strings survive multiple input chunks', async (t) => {
  const root = await fixture(t, (events) => {
    events.splice(1, 0, { type: 'diagnostic', elapsedMs: 0, detail: 'A🧪'.repeat(40000) })
  })
  const value = await readReliabilityEvidence(root, limits)
  assert.equal(value.transactions, 12)
  assert.equal(value.segmentElapsedMs, 4000)
})

for (const [name, events, report, expected] of [
  [
    'bad hash',
    undefined,
    (report) => {
      report.segments[0].sha256 = '0'.repeat(64)
    },
    /hash/u,
  ],
  [
    'duplicate segment',
    undefined,
    (report) => {
      report.segments.push(report.segments[0])
    },
    /Unique segment/u,
  ],
  [
    'path escape',
    undefined,
    (report) => {
      report.segments[0].log = '../elsewhere.ndjson'
    },
    /match/u,
  ],
  [
    'inflated transactions',
    undefined,
    (report) => {
      report.transactions++
    },
    /Transaction total/u,
  ],
  [
    'inflated productive time',
    undefined,
    (report) => {
      report.productiveMs++
    },
    /Cumulative/u,
  ],
  [
    'inflated fault count',
    undefined,
    (report) => {
      report.faults['write-kill']++
    },
    /deep-equal/u,
  ],
  [
    'overlapping segments',
    (events, index) => {
      if (index) {
        events[0].at = '2020-01-01T00:00:01.000Z'
        events.at(-1).at = '2020-01-01T00:00:03.000Z'
      }
    },
    undefined,
    /Concurrent segments/u,
  ],
  [
    'duplicate acknowledgement',
    (events, index) => {
      if (index) events.find((event) => event.type === 'ack').requestId = 'segment-0-0'
    },
    undefined,
    /inflate unique/u,
  ],
  [
    'duplicate acknowledgement after multiple UTF-8 input chunks',
    (events, index) => {
      events.splice(1, 0, { type: 'diagnostic', elapsedMs: 0, detail: '中文🧪'.repeat(20000) })
      if (index) events.find((event) => event.type === 'ack').requestId = 'segment-0-0'
    },
    undefined,
    /inflate unique/u,
  ],
  [
    'clock mismatch',
    (events) => {
      events.at(-1).at = '2020-01-02T00:00:00.000Z'
    },
    undefined,
    /durations disagree/u,
  ],
  [
    'gap between actual progress events',
    (events, index) => {
      const start = Date.UTC(2020, 0, 1) + index * 60000
      events[0].at = new Date(start).toISOString()
      for (const event of events) if (event.elapsedMs >= 250) event.elapsedMs += 20000
      events.at(-1).at = new Date(start + events.at(-1).elapsedMs).toISOString()
    },
    undefined,
    /Unproductive gaps/u,
  ],
  [
    'unverified fault',
    (events) => {
      for (const event of events) if (event.type === 'verified') event.type = 'diagnostic'
    },
    undefined,
    /Verify recovery/u,
  ],
  [
    'unsuccessful segment',
    (events) => {
      events.at(-1).success = false
    },
    undefined,
    /equal/u,
  ],
])
  test(`rejects ${name} in hash-consistent evidence`, async (t) => {
    const root = await fixture(t, events, report)
    await assert.rejects(readReliabilityEvidence(root, limits), expected)
  })
