// 用途：限定调试传输的单帧大小，逐字恢复同一快照；连接故障立即报告而不重发模型任务。
import { createHash } from 'node:crypto'

const chunkChars = 256 * 1024
const maxSnapshotChars = 128 * 1024 * 1024

export async function connectDebugger(
  origin,
  { fetchFn = fetch, WebSocketClass = WebSocket, openTimeoutMs = 10000 } = {}
) {
  const targets = await fetchFn(new URL('/json/list', origin), {
    signal: AbortSignal.timeout(openTimeoutMs),
  }).then((response) => response.json())
  const pages = targets.filter((target) => {
    if (target.type !== 'page') return false
    let url
    try {
      url = new URL(target.url)
    } catch {
      return false
    }
    if (url.protocol === 'file:') return url.pathname.endsWith('/renderer/index.html')
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.hash.startsWith('#/')
    )
  })
  if (pages.length > 1) throw new Error('Desktop renderer is ambiguous')
  const [page] = pages
  if (!page?.webSocketDebuggerUrl) throw new Error('Desktop renderer is unavailable')
  const socket = new WebSocketClass(page.webSocketDebuggerUrl)
  let sequence = 0
  let connectionError
  const pending = new Map()
  const fail = (error) => {
    connectionError ??= error
    for (const job of pending.values()) {
      clearTimeout(job.timer)
      job.reject(connectionError)
    }
    pending.clear()
  }
  socket.addEventListener('close', (event) =>
    fail(
      new Error(
        'Desktop debugger connection closed: ' +
          event.code +
          (event.reason ? ' ' + event.reason : '')
      )
    )
  )
  socket.addEventListener('error', () => fail(new Error('Desktop debugger connection failed')))
  socket.addEventListener('message', (message) => {
    let value
    try {
      value = JSON.parse(message.data)
    } catch {
      fail(new Error('Malformed Desktop debugger response'))
      socket.close()
      return
    }
    if (value.method === 'Inspector.detached') {
      fail(new Error('Desktop debugger detached: ' + value.params?.reason))
      return
    }
    const job = pending.get(value.id)
    if (!job) return
    pending.delete(value.id)
    clearTimeout(job.timer)
    if (value.error) job.reject(new Error(JSON.stringify(value.error)))
    else job.resolve(value.result)
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Desktop debugger connection timed out')),
        openTimeoutMs
      )
      const onOpen = () => finish()
      const onError = () =>
        finish(connectionError ?? new Error('Desktop debugger connection failed'))
      const finish = (error) => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onError)
        if (error) reject(error)
        else resolve()
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      socket.addEventListener('close', onError, { once: true })
    })
  } catch (error) {
    socket.close()
    throw error
  }
  const call = (method, params = {}, timeoutMs = 45000) =>
    new Promise((resolve, reject) => {
      if (connectionError || socket.readyState !== 1) {
        reject(connectionError ?? new Error('Desktop debugger connection is not open'))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Desktop debugger command timed out: ' + method))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  return {
    close: () => socket.close(),
    call,
    async evaluate(expression, timeoutMs) {
      const result = await call(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        timeoutMs
      )
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    },
  }
}

/** 快照只生成一次；按 UTF-16 切块，长度和完整 UTF-8 SHA256 都必须吻合。 */
export async function readDebuggerSnapshot(wire, bootstrap, key) {
  let failure
  try {
    const metadata = await wire.evaluate(bootstrap)
    if (
      !Number.isSafeInteger(metadata?.chars) ||
      metadata.chars < 1 ||
      metadata.chars > maxSnapshotChars ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)
    )
      throw new Error('Invalid Desktop debug snapshot metadata')
    const chunks = []
    const handle = 'globalThis[' + JSON.stringify(key) + ']'
    for (let offset = 0; offset < metadata.chars; offset += chunkChars) {
      const end = Math.min(offset + chunkChars, metadata.chars)
      const chunk = await wire.evaluate(handle + '.slice(' + offset + ',' + end + ')')
      if (typeof chunk !== 'string' || chunk.length !== end - offset)
        throw new Error('Incomplete Desktop debug snapshot chunk')
      chunks.push(chunk)
    }
    const text = chunks.join('')
    if (createHash('sha256').update(text).digest('hex') !== metadata.sha256)
      throw new Error('Desktop debug snapshot hash mismatch')
    return JSON.parse(text)
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await wire.evaluate('delete globalThis[' + JSON.stringify(key) + ']', 5000)
    } catch (error) {
      if (failure)
        throw new AggregateError([failure, error], failure.message + '; snapshot cleanup failed')
      throw new Error('Desktop debug snapshot cleanup failed', { cause: error })
    }
  }
}
