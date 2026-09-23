import { createServer } from 'node:http'

import { expect, test } from 'bun:test'

import { fetchWithTimeout } from '../src/utils/fetchWithTimeout'

for (const status of [200, 503]) {
  test(`deadline includes a stalled ${status} response body and closes the request`, async () => {
    let closed!: () => void
    const responseClosed = new Promise<void>((resolve) => { closed = resolve })
    const server = createServer((request, response) => {
      request.on('close', closed)
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.write('{"waiting":')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    let headersReceived = false
    try {
      await expect(fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, (response) => {
        headersReceived = true
        return response.json()
      }, { timeoutMs: 150 })).rejects.toHaveProperty('name', 'TimeoutError')
      expect(headersReceived).toBe(true)
      await responseClosed
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    }
  }, 3000)
}

test('caller abort also covers consumption and a pre-aborted call never sends', async () => {
  const controller = new AbortController()
  let calls = 0
  let requestSignal: AbortSignal | null | undefined
  const fetcher = async (_url: string | URL, init?: RequestInit) => {
    calls += 1
    requestSignal = init?.signal
    return new Response('{}')
  }
  await expect(fetchWithTimeout('https://example.invalid', { signal: controller.signal }, () => {
    controller.abort()
    return new Promise<never>(() => {})
  }, { timeoutMs: 1000, fetch: fetcher })).rejects.toHaveProperty('name', 'AbortError')
  expect(requestSignal?.aborted).toBe(true)
  await expect(fetchWithTimeout('https://example.invalid', { signal: controller.signal }, (r) => r.json(), {
    timeoutMs: 1000, fetch: fetcher,
  })).rejects.toHaveProperty('name', 'AbortError')
  expect(calls).toBe(1)
})

test('success and parsing failures are preserved; invalid deadlines do not send', async () => {
  expect(await fetchWithTimeout('https://example.invalid', {}, (r) => r.json(), {
    timeoutMs: 1000, fetch: async () => new Response('{"value":42}'),
  })).toEqual({ value: 42 })
  await expect(fetchWithTimeout('https://example.invalid', {}, (r) => r.json(), {
    timeoutMs: 1000, fetch: async () => new Response('invalid'),
  })).rejects.toBeInstanceOf(SyntaxError)
  for (const timeoutMs of [-1, NaN, Infinity])
    await expect(fetchWithTimeout('https://example.invalid', {}, (r) => r.json(), {
      timeoutMs, fetch: async () => { throw new Error('must not send') },
    })).rejects.toBeInstanceOf(RangeError)
})
