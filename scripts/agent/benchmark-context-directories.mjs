import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContextRuntime, createContextView } from '../../packages/context/dist/index.js'
import { localContextStorage } from '../../packages/context/dist/node.js'
import { ContextMemory } from '../../packages/velaros/dist/act/runtime/impl/ContextMemory.js'
import { RecentContext } from '../../packages/velaros/dist/act/runtime/impl/RecentContext.js'
import { ProgramContext } from '../../packages/velaros/dist/act/runtime/impl/ProgramContext.js'

// 旧选择字段/完整检查点 CAS 与新选择字段/增量检查点 CAS 使用相同数据、持久性和业务验收。
const root = await mkdtemp(join(tmpdir(), 'velaros-directory-benchmark-')),
  samples = 20,
  results = []
try {
  for (const mode of ['legacy', 'filtered']) {
    const storage = localContextStorage({ path: join(root, `${mode}.sqlite`) })
    try {
      const records = [],
        objectId = await storage.put('s', '{}')
      const add = (title, kind, id, chars = 2) =>
        records.push({
          ref: { sessionId: 's', id: crypto.randomUUID() },
          sequence: records.length + 1,
          title,
          kind,
          objectId: id,
          chars,
          sources: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        })
      for (let i = 0; i < 10000; i++) add(`script:control:${i}`, 'audit', objectId)
      for (let i = 0; i < 1000; i++) {
        const body = JSON.stringify({
          key: 'plan',
          revision: i + 1,
          title: 'plan',
          body: `version${i}`,
          sources: [],
          resident: true,
          stamps: [],
          origin: 'model-note',
        })
        add('workspace:note:plan', 'note', await storage.put('s', body), body.length)
      }
      const pairs = []
      for (let i = 0; i < samples + 4; i++) {
        add('', 'assistant', objectId)
        add(`script:${crypto.randomUUID()}:result`, 'audit', objectId)
        pairs.push(records.at(-1))
      }
      assert(
        await storage.compareAndSwap('s', 0, {
          version: 1,
          records,
          workingSet: { revision: 0, cursor: 0, items: [] },
        })
      )
      let rows = 0
      const port = {
        load: async (...args) => {
          const state = await storage.load(...args)
          rows += state?.records.length ?? 0
          return state
        },
        compareAndSwap: (...args) => storage.compareAndSwap(...args),
        loadMetadata: (...args) => storage.loadMetadata(...args),
        appendRecord: (...args) => storage.appendRecord(...args),
        records: (...args) => storage.records(...args),
        put: (...args) => storage.put(...args),
        get: (...args) => storage.get(...args),
        close: () => storage.close(),
        selectSnapshot: async (id, queries) => {
          const actual =
            mode === 'filtered'
              ? queries
              : queries.map(
                  ({
                    titleSuffix: _suffix,
                    sequence: _sequence,
                    last: _last,
                    latestPerTitle: _heads,
                    ...query
                  }) => query
                )
          const state = await storage.selectSnapshot(id, actual)
          rows += state?.records.length ?? 0
          return state
        },
        ...(mode === 'filtered'
          ? { compareAndSwapMetadata: (...args) => storage.compareAndSwapMetadata(...args) }
          : {}),
      }
      const context = createContextRuntime({ sessionId: 's', storage: port }),
        view = createContextView({ sessionId: 's', storage: port, context, sources: [] })
      const recent = new RecentContext('s', context, port),
        programs = new ProgramContext('s', context, port),
        memory = new ContextMemory('s', context, port, view, programs, recent),
        signal = new AbortController().signal
      const operations = {
        noteList: () => memory.list({}, signal),
        historyList: () => recent.list({}, signal),
        checkpoint: (i) =>
          recent.checkpoint(
            {
              baseThrough: i ? pairs[i - 1].sequence : 0,
              through: pairs[i].sequence,
              summary: `completed ${i}`,
              evidence: [pairs[i].ref],
              unresolved: [],
              negativeAttempts: [],
            },
            signal
          ),
      }
      for (const [operation, run] of Object.entries(operations)) {
        const durations = [],
          counts = []
        for (let i = 0; i < samples; i++) {
          rows = 0
          const started = performance.now()
          const value = await run(i)
          durations.push(performance.now() - started)
          counts.push(rows)
          if (operation === 'noteList') assert.equal(value.items[0].revision, 1000)
          if (operation === 'historyList') assert.equal(value.items.length, 32)
        }
        durations.sort((a, b) => a - b)
        results.push({
          mode,
          operation,
          samples,
          p50Ms: durations[10],
          p95Ms: durations[18],
          snapshotRecordsFirst: counts[0],
          snapshotRecordsLast: counts.at(-1),
        })
      }
      const checkpoints = (await storage.records('s', { title: 'search:history-checkpoint' })).items
      assert.equal(checkpoints.length, samples)
      assert.equal(
        JSON.parse(await storage.get('s', checkpoints.at(-1).objectId)).through,
        pairs[samples - 1].sequence
      )
      assert.equal((await storage.load('s')).records.length, records.length + samples)
    } finally {
      await storage.close()
    }
  }
  process.stdout.write(
    `${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, scriptMetadata: 10000, noteVersions: 1000, results }, null, 2)}\n`
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
