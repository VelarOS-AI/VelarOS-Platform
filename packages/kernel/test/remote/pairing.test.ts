import { afterEach, describe, expect, test } from 'bun:test'

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { KernelVersionAxes } from '../../src/contract/constants'
import type { RemoteNodeClientCredentialStore as RemoteNodeCredentialStore } from '../../src/contract/requires'
import type { RemoteNodeServerCredentialStore as NodeCredentialStore } from '../../src/contract/requires'
import { RemoteNodeClient } from '../../src/impl/remote-client/RemoteNodeClient'
import { RemoteNodeModuleApiVersion } from '../../src/impl/remote-client/RemoteNodeProjection'
import { RemoteNodeCallRunner } from '../../src/impl/remote-node/RemoteNodeCallRunner'
import { RemoteNodeServer } from '../../src/impl/remote-node/RemoteNodeServer'
import type { RemoteNodeCredentials } from '../../src/types/remote-client'
import type { RemoteNodeAuditEntry, RemoteNodePairedCredential } from '../../src/types/remote-node'
import type { RemoteNodeInvoke, RemoteNodeResult } from '../../src/types/wire'
import { computeManifestRevision, createManifest } from '../../src/utils/remote/manifest'

const PairingCode = '123456'

for (const nextClientId of ['client-b', 'client-a']) {
  test(`remote trust retirement isolates late calls for ${nextClientId}`, async () => {
    const timers = new TimerScope({ name: 'remote-trust-test' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const nextDone = Promise.withResolvers<void>()
    const oldIdDone = Promise.withResolvers<void>()
    const deliveries: Array<{ clientId: string; result: RemoteNodeResult }> = []
    const audit: RemoteNodeAuditEntry[] = []
    const executed: unknown[] = []
    let oldSignal: AbortSignal | undefined
    const runner = new RemoteNodeCallRunner({
      timers,
      now: Date.now,
      maxConcurrent: 1,
      invoker: {
        invoke: async (request, signal) => {
          executed.push(request.input)
          if (request.input === 'old-private-output') {
            oldSignal = signal
            entered.resolve()
            await release.promise
          }
          return { status: 'success', output: request.input }
        },
      },
      audit: {
        record: (entry) => {
          audit.push(entry)
        },
      },
      deliver: (clientId, result) => {
        deliveries.push({ clientId, result })
        if (result.callId === 'next') nextDone.resolve()
        if (result.callId === 'old' && result.output === 'new-public-output') oldIdDone.resolve()
      },
    })
    const frame = (callId: string, input: string): RemoteNodeInvoke => ({
      type: 'invoke',
      callId,
      input,
      manifestRevision: 'current',
      capabilityId: 'test.remote',
      operation: 'read',
      scope: null,
      deadlineMs: 60_000,
    })
    runner.submit(frame('old', 'old-private-output'), 'client-a', 'A', 'current')
    await entered.promise
    try {
      runner.forgetCompleted()
      runner.submit(frame('next', 'next-public-output'), nextClientId, 'Next', 'current')
      runner.cancel({ type: 'cancel', callId: 'old', reason: 'not my old call' }, nextClientId)
      expect(oldSignal?.aborted).toBe(false)
      expect(executed).toEqual(['old-private-output'])
      release.resolve()
      await nextDone.promise
      expect(audit.some((entry) => entry.callId === 'old' && entry.status === 'success')).toBe(true)
      expect(deliveries).toEqual([
        {
          clientId: nextClientId,
          result: expect.objectContaining({ callId: 'next', output: 'next-public-output' }),
        },
      ])
      // 旧信任的晚到结果没有重新进入回放；同一 id 在新信任下是独立真实调用。
      runner.submit(frame('old', 'new-public-output'), nextClientId, 'Next', 'current')
      await oldIdDone.promise
      expect(executed).toEqual(['old-private-output', 'next-public-output', 'new-public-output'])
      const executionCount = executed.length
      const auditCount = audit.length
      runner.submit(frame('old', 'new-public-output'), nextClientId, 'Next', 'current')
      expect(executed.length).toBe(executionCount)
      expect(audit.length).toBe(auditCount)
      expect(deliveries.at(-1)).toMatchObject({
        clientId: nextClientId,
        result: { callId: 'old', output: 'new-public-output' },
      })
    } finally {
      release.resolve()
      await nextDone.promise
      runner.abortAll('test cleanup')
      timers.dispose()
    }
  })
}

test('remote trust retirement keys replay and cancellation by authenticated client', async () => {
  const timers = new TimerScope({ name: 'remote-client-owner-test' })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const otherFinished = Promise.withResolvers<void>()
  const deliveries: Array<{ clientId: string; result: RemoteNodeResult }> = []
  let signal: AbortSignal | undefined
  let executions = 0
  const runner = new RemoteNodeCallRunner({
    timers,
    now: Date.now,
    maxConcurrent: 1,
    invoker: {
      invoke: async (request, callSignal) => {
        executions++
        signal = callSignal
        entered.resolve()
        await release.promise
        return { status: 'success', output: request.input }
      },
    },
    audit: { record: () => undefined },
    deliver: (clientId, result) => {
      deliveries.push({ clientId, result })
      finished.resolve()
      if (clientId === 'client-b') otherFinished.resolve()
    },
  })
  const frame: RemoteNodeInvoke = {
    type: 'invoke',
    callId: 'shared',
    manifestRevision: 'current',
    capabilityId: 'test.remote',
    operation: 'read',
    scope: null,
    input: 'private-a',
    deadlineMs: 60_000,
  }
  runner.submit(frame, 'client-a', 'A', 'current')
  await entered.promise
  try {
    runner.cancel({ type: 'cancel', callId: 'shared', reason: 'foreign' }, 'client-b')
    expect(signal?.aborted).toBe(false)
    release.resolve()
    await finished.promise
    runner.submit(frame, 'client-a', 'A reconnected', 'current')
    expect(executions).toBe(1)
    expect(deliveries).toHaveLength(2)
    expect(deliveries.every((item) => item.clientId === 'client-a')).toBe(true)
    runner.submit({ ...frame, input: 'public-b' }, 'client-b', 'B', 'current')
    expect(deliveries).toHaveLength(2)
    // pool名额只在物理完成时归还；让同一个真实执行队尾继续处理B。
    await otherFinished.promise
    expect(executions).toBe(2)
    expect(deliveries.at(-1)).toMatchObject({
      clientId: 'client-b',
      result: { output: 'public-b' },
    })
  } finally {
    release.resolve()
    runner.abortAll('test cleanup')
    timers.dispose()
  }
})

class MemoryClientCredentialStore implements RemoteNodeCredentialStore {
  private stored: Nullable<RemoteNodeCredentials> = null

  public async load(): Promise<Nullable<RemoteNodeCredentials>> {
    return this.stored
  }

  public async save(credentials: RemoteNodeCredentials): Promise<void> {
    this.stored = credentials
  }

  public async clear(): Promise<void> {
    this.stored = null
  }
}

class MemoryNodeCredentialStore implements NodeCredentialStore {
  public stored: Nullable<RemoteNodePairedCredential> = null
  /** 挂住 save()，用来站在「码已接受、凭据还没落盘」的那一小段窗口里观察。 */
  public hold = false
  private release: Nullable<() => void> = null
  private entered: Nullable<() => void> = null
  public readonly saveEntered = new Promise<void>((resolve) => {
    this.entered = resolve
  })

  public async load(): Promise<Nullable<RemoteNodePairedCredential>> {
    return this.stored
  }

  public async save(credential: RemoteNodePairedCredential): Promise<void> {
    this.stored = credential
    this.entered?.()
    if (!this.hold) return
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
  }

  public releaseSave(): void {
    this.hold = false
    this.release?.()
  }

  public async clear(): Promise<void> {
    this.stored = null
  }
}

const servers: RemoteNodeServer[] = []
const clients: RemoteNodeClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  for (const server of servers.splice(0)) await server.stop()
})

async function startNode(): Promise<{
  readonly server: RemoteNodeServer
  readonly url: string
  readonly credentials: MemoryNodeCredentialStore
  readonly activeSubscriptions: () => number
}> {
  const credentials = new MemoryNodeCredentialStore()
  let subscriptions = 0
  const server = new RemoteNodeServer({
    nodeName: 'test-node',
    nodeVersion: '0.3.0',
    manifestSource: {
      current: () => createManifest([], []),
      onChange: () => {
        subscriptions++
        return () => {
          subscriptions--
        }
      },
    },
    invoker: {
      invoke: async () => ({ status: 'success' as const, output: null }),
    },
    credentialStore: credentials,
    audit: { record: () => undefined },
    pairingCode: PairingCode,
  })
  servers.push(server)
  const status = await server.start()
  return { server, url: status.endpoint, credentials, activeSubscriptions: () => subscriptions }
}

function createClient(url: string, clientName: string): RemoteNodeClient {
  const client = new RemoteNodeClient({
    url,
    clientName,
    credentials: new MemoryClientCredentialStore(),
    pairingCode: PairingCode,
  })
  clients.push(client)
  return client
}

describe('远程节点配对窗口', () => {
  test('迟到凭据读取不能恢复已解除信任，停机排空同代启动并允许显式重启', async () => {
    for (const phase of ['unpair', 'stop'] as const) {
      const { server, credentials, activeSubscriptions } = await startNode()
      await server.stop()
      credentials.stored = {
        clientId: 'old-client',
        publicKey: 'old-public-key',
        clientName: 'Old client',
        pairedAt: 0,
      }
      const load = credentials.load.bind(credentials)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let loads = 0
      credentials.load = async () => {
        loads++
        const snapshot = await load()
        entered.resolve()
        await release.promise
        return snapshot
      }
      const starting = server.start()
      const result = starting.catch((error: unknown) => error)
      let closing: Promise<void> | undefined
      try {
        expect(server.start()).toBe(starting)
        await entered.promise
        expect(loads).toBe(1)
        if (phase === 'unpair') {
          await server.unpair()
          release.resolve()
          expect((await starting).pairedClientId).toBeNull()
          expect(credentials.stored).toBeNull()
          expect(activeSubscriptions()).toBe(1)
        } else {
          let stopped = false
          closing = server.stop().then(() => {
            stopped = true
          })
          await expect(server.start()).rejects.toMatchObject({ code: 'CLOSED' })
          expect(stopped).toBe(false)
          expect(activeSubscriptions()).toBe(0)
          release.resolve()
          expect(await result).toMatchObject({ name: 'AbortError' })
          await closing
          expect(activeSubscriptions()).toBe(0)
          expect(() => server.getStatus()).toThrow('远程节点服务端还没启动')
          credentials.load = load
          expect((await server.start()).pairedClientId).toBe('old-client')
          expect(activeSubscriptions()).toBe(1)
        }
      } finally {
        release.resolve()
        await result
        await closing
        credentials.load = load
        await server.stop()
      }
    }
  })

  test('配对码一经接受立刻作废，落盘途中同一个码不能被第二条连接复用', async () => {
    const { server, url, credentials } = await startNode()
    credentials.hold = true
    server.startPairing()

    const first = createClient(url, 'client-a')
    const firstConnect = first.connect()
    // 站在「码已接受、凭据还在落盘」的窗口里：关窗原来在 `await save()` 之后，这一段时间
    // 同一个码还能再被用一次。
    await credentials.saveEntered
    expect(server.getStatus().pairingCode).toBeNull()

    const second = createClient(url, 'client-b')
    const secondConnect = second.connect()
    await expect(secondConnect).rejects.toMatchObject({
      name: 'RemoteNodeClientError',
      code: 'REMOTE_NODE_UNAUTHORIZED',
    })

    credentials.releaseSave()
    await firstConnect
    const pairedClientId = server.getStatus().pairedClientId
    expect(pairedClientId).not.toBeNull()
    expect(credentials.stored?.clientId).toBe(pairedClientId!)

    // 窗口关上之后再来一个 clientId，照样顶不掉已有凭据。
    const third = createClient(url, 'client-c')
    await expect(third.connect()).rejects.toMatchObject({
      name: 'RemoteNodeClientError',
    })
    expect(server.getStatus().pairedClientId).toBe(pairedClientId!)
    expect(credentials.stored?.clientId).toBe(pairedClientId!)
  })

  test('解除配对排空已接受的凭据写入，迟到配对不能恢复连接或落盘凭据', async () => {
    const { server, url, credentials } = await startNode()
    const completed: string[] = []
    const save = credentials.save.bind(credentials)
    credentials.save = async (credential) => {
      await save(credential)
      // 模拟真正落盘在 gate 之后结束，不能仅靠清掉内存就通过。
      credentials.stored = credential
      completed.push('save')
    }
    credentials.hold = true
    server.startPairing()
    const client = createClient(url, 'cancelled-pairing')
    const connecting = client.connect().catch((error: unknown) => error)
    await credentials.saveEntered
    let cleared = false
    const clear = credentials.clear.bind(credentials)
    credentials.clear = async () => {
      cleared = true
      await clear()
      completed.push('clear')
    }
    let unpaired = false
    let stopped = false
    const unpairing = server.unpair().then(() => {
      unpaired = true
    })
    let stopping: Promise<void> | undefined
    try {
      await Promise.resolve()
      expect(cleared).toBe(false)
      expect(server.getStatus().pairingCode).toBeNull()
      expect(server.getStatus().pairedClientId).toBeNull()
      expect(server.getStatus().connectedClientId).toBeNull()
      expect(await connecting).toMatchObject({ code: 'REMOTE_NODE_UNAUTHORIZED' })
      stopping = server.stop().then(() => {
        stopped = true
        completed.push('stop')
      })
      // 让已关闭连接的本地 close 回调跑完；凭据 save 仍由 gate 持有。
      await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
      expect(unpaired).toBe(false)
      expect(stopped).toBe(false)
      credentials.releaseSave()
      await Promise.all([unpairing, stopping])
      expect(cleared).toBe(true)
      expect(await credentials.load()).toBeNull()
      expect(completed).toEqual(['save', 'clear', 'stop'])
      expect(() => server.getStatus()).toThrow('远程节点服务端还没启动')
    } finally {
      credentials.releaseSave()
      await unpairing
      await stopping
      await connecting
    }
  })
})

describe('远程节点清单修订号', () => {
  test('工具 inputSchema 的键序不影响修订号', () => {
    const tools = (schema: Record<string, unknown>) => [
      {
        name: 'search',
        description: '搜索',
        capabilityId: 'velaros.search',
        operation: 'run',
        category: null,
        readOnly: true,
        inputSchema: schema,
      },
    ]
    // 同一份 schema 换个键序：内容没变，修订号就不该变，否则在途调用被当过期拒绝。
    const first = computeManifestRevision(
      [],
      tools({
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
      })
    )
    const second = computeManifestRevision(
      [],
      tools({
        properties: { limit: { type: 'number' }, query: { type: 'string' } },
        type: 'object',
      })
    )
    expect(second).toBe(first)

    // 内容真的变了仍然换修订号。
    const changed = computeManifestRevision(
      [],
      tools({
        type: 'object',
        properties: { query: { type: 'number' } },
      })
    )
    expect(changed).not.toBe(first)
  })
})

describe('远程代理模块 API 轴', () => {
  test('引用宿主的常量，不另抄一个字面量', () => {
    // 抄一份的后果：模块 API 版本升到 2 时，所有远端代理模块注册即报 API_VERSION_MISMATCH。
    expect(RemoteNodeModuleApiVersion).toBe(KernelVersionAxes.moduleApi)
  })
})

describe('远程节点客户端凭据读取', () => {
  test('第一次 load 失败后 connect() 仍会拒绝，而不是永远挂着', async () => {
    let loads = 0
    const client = new RemoteNodeClient({
      url: 'ws://127.0.0.1:1/v1/remote-node/ws',
      clientName: 'probe',
      credentials: {
        load: async () => {
          loads += 1
          throw new Error('keychain locked')
        },
        save: async () => undefined,
        clear: async () => undefined,
      },
      socketFactory: () => {
        throw new Error('凭据都没读出来，不该拨号')
      },
    })
    clients.push(client)

    // `started = true` 原来写在 `await load()` 之前：load 抛错后没人开 socket，也没人再走
    // 这一段，之后每次 connect() 都永远挂着。
    await expect(client.connect()).rejects.toMatchObject({
      code: 'REMOTE_NODE_CREDENTIALS_UNAVAILABLE',
    })
    await expect(client.connect()).rejects.toMatchObject({
      code: 'REMOTE_NODE_CREDENTIALS_UNAVAILABLE',
    })
    expect(loads).toBe(2)
  })
})
