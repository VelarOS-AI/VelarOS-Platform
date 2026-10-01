import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const blobName = 'trace-invocations.jsonl'
const digest = (value) => createHash('sha256').update(value).digest('hex')
const key = ({ sessionId, id, sha256 }) => JSON.stringify([sessionId, id, sha256])

function identity(value) {
  if (
    !value ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.id !== 'string' ||
    !value.id ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('Invalid trace invocation reference')
}

// Only trace.invocations is encoded. User data never participates in key discovery.
function mapTurns(data, map) {
  return {
    ...data,
    traces: data.traces.map(map),
    ...(Object.hasOwn(data, 'branches')
      ? { branches: data.branches.map((branch) => ({ ...branch, turns: branch.turns.map(map) })) }
      : {}),
  }
}

export function parseInvocationBlobs(text, { allowIncompleteTail = false } = {}) {
  const lines = text.split('\n')
  const tail = lines.pop()
  if (tail && !allowIncompleteTail) throw new Error('Incomplete trace invocation blob record')
  const values = new Map()
  for (const line of lines) {
    const value = JSON.parse(line)
    identity(value)
    if (value.schema !== 1 || typeof value.json !== 'string')
      throw new Error('Unknown trace invocation blob schema')
    if (digest(value.json) !== value.sha256) throw new Error('Trace invocation blob hash mismatch')
    const invocation = JSON.parse(value.json)
    if (invocation.id !== value.id) throw new Error('Trace invocation blob identity mismatch')
    values.set(key(value), invocation)
  }
  return values
}

export async function readInvocationBlobs(directory, options) {
  try {
    return parseInvocationBlobs(await readFile(join(directory, blobName), 'utf8'), options)
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
}

export function decodeTraceArtifact(value, blobs = new Map()) {
  if (!Object.hasOwn(value, 'artifactSchema')) return value
  if (value.artifactSchema !== 2) throw new Error('Unknown trace artifact schema')
  return mapTurns(value.data, (turn) => {
    if (!Object.hasOwn(turn, 'invocations')) return turn
    return {
      ...turn,
      invocations: turn.invocations.map((reference) => {
        identity(reference)
        if (Object.keys(reference).length !== 3)
          throw new Error('Invalid trace invocation reference fields')
        if (reference.sessionId !== turn.sessionId)
          throw new Error('Trace invocation reference crosses sessions')
        const invocation = blobs.get(key(reference))
        if (!invocation) throw new Error(`Missing trace invocation blob: ${key(reference)}`)
        return invocation
      }),
    }
  })
}

export async function readTraceArtifact(path) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (!Object.hasOwn(value, 'artifactSchema')) return value
  return decodeTraceArtifact(value, await readInvocationBlobs(dirname(path)))
}

export function createTraceArtifactWriter(directory) {
  let known
  const versions = new Map()
  return {
    async encode(data) {
      known ??= new Set((await readInvocationBlobs(directory)).keys())
      const pending = new Map()
      const newVersions = new Map()
      const encoded = mapTurns(data, (turn) => {
        if (!Object.hasOwn(turn, 'invocations')) return turn
        return {
          ...turn,
          invocations: turn.invocations.map((invocation) => {
            // Hash only the three known large string fields before serializing the
            // envelope. Retain small fingerprints, never historical stdout bodies.
            const compact = { ...invocation }
            if (typeof compact.body === 'string') compact.body = digest(compact.body)
            if (
              compact.summary &&
              typeof compact.summary === 'object' &&
              !Array.isArray(compact.summary)
            ) {
              compact.summary = { ...compact.summary }
              for (const field of ['input', 'output'])
                if (typeof compact.summary[field] === 'string')
                  compact.summary[field] = digest(compact.summary[field])
            }
            const version = digest(JSON.stringify([turn.sessionId, compact]))
            if (versions.has(version)) return versions.get(version)
            if (newVersions.has(version)) return newVersions.get(version)
            const json = JSON.stringify(invocation)
            const reference = { sessionId: turn.sessionId, id: invocation.id, sha256: digest(json) }
            identity(reference)
            newVersions.set(version, reference)
            const id = key(reference)
            if (!known.has(id) && !pending.has(id))
              pending.set(id, JSON.stringify({ schema: 1, ...reference, json }) + '\n')
            return reference
          }),
        }
      })
      let bytesWritten = 0
      if (pending.size) {
        const text = [...pending.values()].join('')
        // Persist full entities before a checkpoint can refer to them.
        await appendFile(join(directory, blobName), text)
        for (const id of pending.keys()) known.add(id)
        bytesWritten = Buffer.byteLength(text)
      }
      for (const [version, reference] of newVersions) versions.set(version, reference)
      return { value: { artifactSchema: 2, data: encoded }, bytesWritten }
    },
  }
}
