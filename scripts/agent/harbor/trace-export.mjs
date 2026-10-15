import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'

import { toTrajectory } from './atif.mjs'
import {
  createTraceArtifactWriter,
  decodeTraceArtifact,
  readInvocationBlobs,
} from './trace-artifact.mjs'

export async function snapshot(path, value) {
  const temporary = `${path}.writing`
  const file = await open(temporary, 'w')
  let bytes = 0
  let parts = []
  let length = 0
  const flush = async () => {
    const text = parts.join('')
    await file.writeFile(text)
    bytes += Buffer.byteLength(text)
    parts = []
    length = 0
  }
  try {
    // 长任务的完整轨迹可超过单字符串上限；按有界片段写入，成功后原子替换。
    for (const text of jsonFragments(value)) {
      parts.push(text)
      length += text.length
      if (length >= 65536) await flush()
    }
    if (parts.length) await flush()
    await file.close()
    await rename(temporary, path)
    return bytes
  } catch (error) {
    await file.close()
    await rm(temporary, { force: true })
    throw error
  }
}

// 输入是 JSON 数据；toJSON、缺席对象字段、稀疏数组和循环检查遵循 JSON.stringify。
function* jsonFragments(
  value,
  ancestors = new Set(),
  property = '',
  arrayItem = false,
  normalized = false
) {
  if (!normalized && value && typeof value.toJSON === 'function') value = value.toJSON(property)
  if (value instanceof Number || value instanceof String || value instanceof Boolean)
    value = value.valueOf()
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    if (text === undefined && !arrayItem) throw new TypeError('Snapshot must contain JSON data')
    yield text ?? 'null'
    return
  }
  if (ancestors.has(value)) throw new TypeError('Circular snapshot value')
  ancestors.add(value)
  if (Array.isArray(value)) {
    yield '['
    for (let index = 0; index < value.length; index++) {
      if (index) yield ','
      yield* jsonFragments(value[index], ancestors, String(index), true)
    }
    yield ']'
  } else {
    yield '{'
    let first = true
    for (const name of Object.keys(value)) {
      let item = value[name]
      if (item && typeof item.toJSON === 'function') item = item.toJSON(name)
      if (['undefined', 'function', 'symbol'].includes(typeof item)) continue
      if (!first) yield ','
      first = false
      yield JSON.stringify(name) + ':'
      yield* jsonFragments(item, ancestors, name, false, true)
    }
    yield '}'
  }
  ancestors.delete(value)
}

// 一个检查点对应一个 gzip member；有界写入允许读取器恢复被中断的最后一个 member。
async function appendCompressedProgress(path, value) {
  const gzip = createGzip({ level: 3 })
  let bytes = 0
  gzip.on('data', (chunk) => {
    bytes += chunk.length
  })
  function* chunks() {
    let parts = [],
      length = 0
    for (const fragment of jsonFragments(value)) {
      parts.push(fragment)
      length += fragment.length
      if (length >= 65536) {
        yield parts.join('')
        parts = []
        length = 0
      }
    }
    yield parts.join('') + '\n'
  }
  await pipeline(Readable.from(chunks()), gzip, createWriteStream(path, { flags: 'a' }))
  return bytes
}

// Progress is provisional: old asynchronous receipts can still change. The final
// export reconciles every page from authoritative runtime storage exactly once.
export function createTraceExporter({ trace, output, sessionId, instruction, identity, model }) {
  const sessions = new Map()
  const artifacts = createTraceArtifactWriter(output)
  const writtenVersions = new Map()
  const stats = { count: 0, totalMs: 0, maxMs: 0, bytesWritten: 0, finalSnapshots: 0 }
  const state = (id) => {
    if (!sessions.has(id)) sessions.set(id, new Map())
    return sessions.get(id)
  }
  const read = async (id, final) => {
    const known = state(id)
    const latest = Math.max(0, ...[...known.values()].map((turn) => turn.sequence))
    let after = final ? 0 : Math.max(0, latest - 1)
    const turns = []
    let branches = []
    do {
      const page = await trace({ sessionId: id, after, limit: 8, fullContent: true })
      turns.push(...page.turns)
      branches = page.branches
      after = page.nextAfter
    } while (after !== null)
    if (!final) {
      const refreshed = new Set(turns.map((turn) => turn.turnId))
      for (const turn of known.values()) {
        if (refreshed.has(turn.turnId)) continue
        if (turn.pending) {
          const page = await trace({
            sessionId: id,
            after: turn.sequence - 1,
            limit: 1,
            fullContent: true,
          })
          turns.push(...page.turns)
        }
      }
    } else known.clear()
    // Keep only cursors and unsettled identities between checkpoints. Historical
    // prompt bodies already live in runtime storage and the progress journal.
    for (const turn of turns)
      known.set(turn.turnId, {
        turnId: turn.turnId,
        sequence: turn.request.sequence,
        pending:
          turn.executions.some((execution) => ['running', 'unknown'].includes(execution.status)) ||
          turn.invocations.some((invocation) => invocation.summary.status === 'pending') ||
          turn.agents.some((agent) => ['running', 'waiting'].includes(agent.status)),
      })
    return { turns, branches }
  }
  return {
    stats,
    async export({ final = false, status, failure }) {
      const started = performance.now()
      const root = await read(sessionId, final)
      const branches = []
      for (const binding of root.branches)
        branches.push({ ...binding, turns: (await read(binding.sessionId, final)).turns })
      const value = { traces: root.turns, branches }
      const artifact = await artifacts.encode(
        final ? value : { schema: 1, rootSessionId: sessionId, provisional: true, ...value },
        { externalTurns: final }
      )
      stats.bytesWritten += artifact.bytesWritten
      if (final) {
        stats.bytesWritten += await snapshot(join(output, 'traces.json'), artifact.value)
        stats.bytesWritten += await snapshot(
          join(output, 'trajectory.json'),
          toTrajectory({ sessionId, instruction, ...value, identity, model })
        )
        stats.finalSnapshots++
      } else {
        const pendingVersions = new Map()
        const changed = (turn) => {
          const key = JSON.stringify([turn.sessionId, turn.turnId])
          const version = createHash('sha256').update(JSON.stringify(turn)).digest('hex')
          if (writtenVersions.get(key) === version) return false
          pendingVersions.set(key, version)
          return true
        }
        // Pending work must still be fetched. Persist only changed content;
        // unchanged closed branches otherwise repeat their last large turn on
        // every checkpoint of the parent session.
        const data = artifact.value.data
        const progress = {
          ...artifact.value,
          data: {
            ...data,
            traces: data.traces.filter(changed),
            branches: data.branches.map((branch) => ({
              ...branch,
              turns: branch.turns.filter(changed),
            })),
          },
        }
        stats.bytesWritten += await appendCompressedProgress(
          join(output, 'trace-progress.jsonl.gz'),
          progress
        )
        for (const [key, version] of pendingVersions) writtenVersions.set(key, version)
      }
      const elapsed = performance.now() - started
      stats.count++
      stats.totalMs += elapsed
      stats.maxMs = Math.max(stats.maxMs, elapsed)
      await snapshot(join(output, 'status.json'), {
        status,
        failure,
        model,
        mainRequests: state(sessionId).size,
        branchRequests: root.branches.reduce(
          (sum, branch) => sum + state(branch.sessionId).size,
          0
        ),
        traceExport: stats,
        traceProgress: {
          path: 'trace-progress.jsonl.gz',
          encoding: 'gzip-members',
          provisional: !final,
        },
      })
    },
  }
}

// A killed append can leave one partial final line. Complete malformed records
// are errors, never silently discarded. This view must not supply final scores.
function progressRecovery(blobs) {
  const sessions = new Map()
  let branches = []
  let rootSessionId
  const accept = (line) => {
    const page = decodeTraceArtifact(JSON.parse(line), blobs)
    if (page.schema !== 1 || page.provisional !== true) throw new Error('Unknown progress schema')
    if (!page.rootSessionId || (rootSessionId && rootSessionId !== page.rootSessionId))
      throw new Error('Progress root session changed')
    rootSessionId = page.rootSessionId
    branches = page.branches
    for (const turn of [...page.traces, ...branches.flatMap((branch) => branch.turns)]) {
      if (!sessions.has(turn.sessionId)) sessions.set(turn.sessionId, new Map())
      sessions.get(turn.sessionId).set(turn.turnId, turn)
    }
  }
  const turns = (id) =>
    [...(sessions.get(id)?.values() ?? [])].sort((a, b) => a.request.sequence - b.request.sequence)
  return {
    accept,
    result: (incompleteTail) => ({
      provisional: true,
      incompleteTail,
      traces: turns(rootSessionId),
      branches: branches.map((branch) => ({ ...branch, turns: turns(branch.sessionId) })),
    }),
  }
}

export function recoverTraceProgress(text, blobs = new Map()) {
  const records = text.split('\n')
  const incompleteTail = records.pop().length > 0
  const recovery = progressRecovery(blobs)
  for (const line of records) recovery.accept(line)
  return recovery.result(incompleteTail)
}

export async function readTraceProgress(path) {
  const recovery = progressRecovery(
    await readInvocationBlobs(dirname(path), { allowIncompleteTail: true })
  )
  let parts = []
  let incompleteCompressedTail = false
  const input = createReadStream(path)
  const stream = path.endsWith('.gz') ? createGunzip() : input
  if (stream !== input) input.on('error', (error) => stream.destroy(error)).pipe(stream)
  stream.setEncoding('utf8')
  try {
    for await (const chunk of stream) {
      let start = 0
      let newline
      while ((newline = chunk.indexOf('\n', start)) !== -1) {
        parts.push(chunk.slice(start, newline))
        recovery.accept(parts.join(''))
        parts = []
        start = newline + 1
      }
      if (start < chunk.length) parts.push(chunk.slice(start))
    }
  } catch (error) {
    if (stream === input || error.code !== 'Z_BUF_ERROR') throw error
    incompleteCompressedTail = true
  } finally {
    input.destroy()
    if (stream !== input) stream.destroy()
  }
  return recovery.result(parts.length > 0 || incompleteCompressedTail)
}
