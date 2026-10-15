import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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
    const { value, invocation } = parseInvocationBlob(line)
    values.set(key(value), invocation)
  }
  return values
}

function parseInvocationBlob(line) {
  const value = JSON.parse(line)
  identity(value)
  if (value.schema !== 1 || typeof value.json !== 'string')
    throw new Error('Unknown trace invocation blob schema')
  if (digest(value.json) !== value.sha256) throw new Error('Trace invocation blob hash mismatch')
  const invocation = JSON.parse(value.json)
  if (invocation.id !== value.id) throw new Error('Trace invocation blob identity mismatch')
  return { value, invocation }
}

function projectInvocationIdentity(invocation, project) {
  const projected = project(invocation)
  if (projected?.id !== invocation.id)
    throw new Error('Trace projection changed invocation identity')
  return projected
}

// 一次只拼接一个实体；UTF-8 流解码保留跨块字符，不把全部历史 JSONL 放进内存。
async function* invocationLines(path, allowIncompleteTail) {
  let fragments = []
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    let start = 0
    for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
      const line = fragments.join('') + chunk.slice(start, end)
      fragments = []
      yield line
      start = end + 1
    }
    if (start < chunk.length) fragments.push(chunk.slice(start))
  }
  if (fragments.length && !allowIncompleteTail)
    throw new Error('Incomplete trace invocation blob record')
}

export async function readInvocationBlobs(
  directory,
  { allowIncompleteTail = false, project = (invocation) => invocation } = {}
) {
  try {
    const values = new Map()
    for await (const line of invocationLines(join(directory, blobName), allowIncompleteTail)) {
      const { value, invocation } = parseInvocationBlob(line)
      values.set(key(value), projectInvocationIdentity(invocation, project))
    }
    return values
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
}

export function decodeTraceArtifact(value, blobs = new Map()) {
  if (!Object.hasOwn(value, 'artifactSchema')) return value
  if (value.artifactSchema !== 2) throw new Error('Unknown trace artifact schema')
  return mapTurns(value.data, (turn) => decodeTurnInvocations(turn, blobs))
}

function decodeTurnInvocations(turn, blobs) {
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
}

async function readExternalTurn(directory, reference) {
  identity(reference)
  if (Object.keys(reference).length !== 3) throw new Error('Invalid trace turn reference fields')
  const json = await readFile(join(directory, 'trace-turns', reference.sha256 + '.json'), 'utf8')
  if (digest(json) !== reference.sha256) throw new Error('Trace turn hash mismatch')
  const turn = JSON.parse(json)
  if (turn.turnId !== reference.id || turn.sessionId !== reference.sessionId)
    throw new Error('Trace turn identity mismatch')
  return turn
}

// v3 每次只保留一个完整 turn；投影前仍验证全部调用实体与引用的哈希及会话身份。
export async function visitTraceArtifact(path, visit, { projectInvocation } = {}) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  const modern = Object.hasOwn(value, 'artifactSchema')
  if (modern && ![2, 3].includes(value.artifactSchema))
    throw new Error('Unknown trace artifact schema')
  const data = modern ? value.data : value
  const blobs = modern
    ? await readInvocationBlobs(dirname(path), { project: projectInvocation })
    : null
  const groups = [data.traces, ...(data.branches ?? []).map((branch) => branch.turns)]
  for (const [group, turns] of groups.entries()) {
    for (const item of turns) {
      let turn = value.artifactSchema === 3 ? await readExternalTurn(dirname(path), item) : item
      if (modern) turn = decodeTurnInvocations(turn, blobs)
      else if (projectInvocation && Array.isArray(turn.invocations))
        turn = {
          ...turn,
          invocations: turn.invocations.map((invocation) =>
            projectInvocationIdentity(invocation, projectInvocation)
          ),
        }
      await visit(turn, { branchIndex: group === 0 ? null : group - 1 })
    }
  }
}

export async function readTraceArtifact(path) {
  let value = JSON.parse(await readFile(path, 'utf8'))
  if (!Object.hasOwn(value, 'artifactSchema')) return value
  if (value.artifactSchema === 3) {
    const turns = new Map()
    for (const reference of [
      ...value.data.traces,
      ...(value.data.branches ?? []).flatMap((branch) => branch.turns),
    ]) {
      const turn = await readExternalTurn(dirname(path), reference)
      turns.set(key(reference), turn)
    }
    value = {
      artifactSchema: 2,
      data: mapTurns(value.data, (reference) => turns.get(key(reference))),
    }
  }
  return decodeTraceArtifact(value, await readInvocationBlobs(dirname(path)))
}

export function createTraceArtifactWriter(directory) {
  let known
  const versions = new Map()
  return {
    async encode(data, { externalTurns = false } = {}) {
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
      if (externalTurns) {
        await mkdir(join(directory, 'trace-turns'), { recursive: true })
        const references = new Map()
        for (const turn of [
          ...encoded.traces,
          ...(encoded.branches ?? []).flatMap((branch) => branch.turns),
        ]) {
          const json = JSON.stringify(turn)
          const reference = { sessionId: turn.sessionId, id: turn.turnId, sha256: digest(json) }
          identity(reference)
          const path = join(directory, 'trace-turns', reference.sha256 + '.json')
          try {
            await writeFile(path, json, { flag: 'wx' })
            bytesWritten += Buffer.byteLength(json)
          } catch (error) {
            if (error.code !== 'EEXIST') throw error
            if ((await readFile(path, 'utf8')) !== json) throw new Error('Trace turn hash mismatch')
          }
          references.set(turn, reference)
        }
        return {
          value: { artifactSchema: 3, data: mapTurns(encoded, (turn) => references.get(turn)) },
          bytesWritten,
        }
      }
      return { value: { artifactSchema: 2, data: encoded }, bytesWritten }
    },
  }
}
