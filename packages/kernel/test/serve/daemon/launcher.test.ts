import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { kernelDaemons } from '../../../src/impl/client/KernelDaemonDirectory'
import { KernelModuleHost } from '../../../src/impl/runtime/KernelModuleHost'
import { KernelLauncher } from '../../../src/impl/serve/KernelLauncher'
import { KernelLocalDaemon } from '../../../src/impl/serve/KernelLocalDaemon'
import { KernelService } from '../../../src/impl/serve/KernelService'
import type { KernelDaemonPaths } from '../../../src/types/kernel'
import type { KernelVersionTarget } from '../../../src/types/serve'
import { KernelClientError } from '../../../src/utils/errors'
import { createDefaultKernelDaemonPaths } from '../../../src/utils/rpc/descriptor'
import { KernelProtocolVersion } from '../../../src/utils/wire/version'

const temporaryDirectories: string[] = []
const runningDaemons: KernelLocalDaemon[] = []

afterEach(async () => {
  for (const daemon of runningDaemons.splice(0)) await daemon.dispose()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-launcher-'))
  temporaryDirectories.push(directory)
  return directory
}

function createService(): KernelService {
  return new KernelService({
    host: new KernelModuleHost({ apiVersion: 1 }),
    kernelVersion: '0.3.0',
  })
}

function resolverFor(target: Partial<KernelVersionTarget> = {}) {
  return {
    resolveActiveVersion: () =>
      Promise.resolve({
        version: '0.3.0',
        entryPoint: '/nonexistent/kernel/main.js',
        ...target,
      }),
  }
}

/** Stands in for a spawned Kernel that never publishes an endpoint. */
class FakeChildProcess extends EventEmitter {
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  public killed = false
  public unrefCalls = 0
  /** 收到的信号序列（SIGTERM 之后有没有补 SIGKILL 的证据）。 */
  public readonly signals: NodeJS.Signals[] = []
  /** true 时装成「收到信号也不退」的卡死进程。 */
  public ignoreSignals = false

  public unref(): this {
    this.unrefCalls += 1
    return this
  }

  public kill(signal: NodeJS.Signals): boolean {
    this.killed = true
    this.signals.push(signal)
    if (this.ignoreSignals) return true
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

function fakeSpawn(child: FakeChildProcess) {
  return (() => child) as unknown as typeof import('node:child_process').spawn
}

describe('KernelLauncher', () => {
  test('launcher startup ownership serializes ignition and gives each caller an independent client', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-owned', directory)
    const daemon = new KernelLocalDaemon({ paths, service: createService() })
    runningDaemons.push(daemon)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const child = new FakeChildProcess()
    let resolutions = 0
    let spawns = 0
    const launcher = new KernelLauncher({
      paths,
      resolver: {
        resolveActiveVersion: async () => {
          resolutions++
          entered.resolve()
          await release.promise
          await daemon.start()
          return resolverFor().resolveActiveVersion()
        },
      },
      spawnProcess: (() => {
        spawns++
        return child
      }) as unknown as typeof import('node:child_process').spawn,
    })
    const first = launcher.ensureRunning()
    await entered.promise
    const second = launcher.ensureRunning()
    try {
      expect(resolutions).toBe(1)
      release.resolve()
      const [a, b] = await Promise.all([first, second])
      try {
        expect(spawns).toBe(1)
        expect(resolutions).toBe(1)
        expect(a.started).toBe(true)
        expect(b.started).toBe(false)
        expect(a.client).not.toBe(b.client)
        await a.client.dispose()
        expect((await b.client.handshake()).kernelVersion).toBe('0.3.0')
      } finally {
        await a.client.dispose()
        await b.client.dispose()
      }
    } finally {
      release.resolve()
      await Promise.allSettled([first, second])
      await launcher.dispose()
    }
    expect(child.signals).toEqual(['SIGTERM'])
  })

  test('launcher startup ownership drains spawn and kill callbacks that reenter disposal', async () => {
    const directory = await temporaryDirectory()
    const child = new FakeChildProcess()
    let closing: Promise<void> | undefined
    let reentered: Promise<void> | undefined
    const kill = child.kill.bind(child)
    child.kill = (signal) => {
      reentered = launcher.dispose()
      return kill(signal)
    }
    const launcher = new KernelLauncher({
      paths: createDefaultKernelDaemonPaths('launcher-reentrant', directory),
      resolver: resolverFor(),
      spawnProcess: (() => {
        closing = launcher.dispose()
        return child
      }) as unknown as typeof import('node:child_process').spawn,
    })
    const starting = launcher.ensureRunning().catch((error: unknown) => error)
    try {
      expect(await starting).toMatchObject({ code: 'LAUNCHER_DISPOSED' })
      await closing
      expect(reentered).toBe(closing)
      expect(closing).toBe(launcher.dispose())
      expect(child.signals).toEqual(['SIGTERM'])
    } finally {
      await launcher.dispose()
    }
  })

  test('launcher startup ownership retains a child after stop deadlines until it really exits', async () => {
    const directory = await temporaryDirectory()
    const child = new FakeChildProcess()
    child.ignoreSignals = true
    let now = 0
    let spawns = 0
    const launcher = new KernelLauncher({
      paths: createDefaultKernelDaemonPaths('launcher-still-alive', directory),
      resolver: resolverFor(),
      spawnProcess: (() => {
        spawns++
        return child
      }) as unknown as typeof import('node:child_process').spawn,
      startTimeoutMs: 0,
      stopGraceMs: 1,
      stopKillGraceMs: 1,
      pollIntervalMs: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    try {
      await expect(launcher.ensureRunning()).rejects.toMatchObject({ code: 'KERNEL_START_TIMEOUT' })
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      await expect(launcher.ensureRunning()).rejects.toMatchObject({ code: 'KERNEL_START_FAILED' })
      expect(spawns).toBe(1)
      child.ignoreSignals = false
      const stopping = launcher.stop()
      expect(launcher.stop()).toBe(stopping)
      await stopping
      expect(child.signalCode).toBe('SIGTERM')
    } finally {
      child.ignoreSignals = false
      await launcher.dispose()
    }
  })

  test('attaches to an already running Kernel instead of starting a second one', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    const daemon = new KernelLocalDaemon({ paths, service: createService() })
    runningDaemons.push(daemon)
    await daemon.start()

    const child = new FakeChildProcess()
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(child),
    })

    expect(await launcher.isRunning()).toBe(true)
    const result = await launcher.ensureRunning()
    try {
      expect(result.started).toBe(false)
      expect(result.process).toBeUndefined()
      expect(child.killed).toBe(false)
      expect(result.handshake.kernelVersion).toBe('0.3.0')
      await launcher.verifyHealthy(result)
    } finally {
      await result.client.dispose()
      await launcher.dispose()
    }
  })

  test('reports no running Kernel when no descriptor has been published', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(new FakeChildProcess()),
    })
    expect(await launcher.isRunning()).toBe(false)
  })

  test('times out when the spawned Kernel never publishes an endpoint', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    const child = new FakeChildProcess()
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(child),
      startTimeoutMs: 30,
      pollIntervalMs: 5,
    })

    const failure = await launcher.ensureRunning().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KernelClientError)
    expect(failure).toMatchObject({ code: 'KERNEL_START_TIMEOUT' })
    expect(child.killed).toBe(true)
    await launcher.dispose()
  })

  test('fails fast when the Kernel process exits during startup', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    const child = new FakeChildProcess()
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(child),
      startTimeoutMs: 2000,
      pollIntervalMs: 5,
    })

    setTimeout(() => {
      child.exitCode = 1
      child.emit('exit', 1, null)
    }, 10)
    const failure = await launcher.ensureRunning().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'KERNEL_START_FAILED' })
    await launcher.dispose()
  })

  test('ignores an unreadable descriptor and treats the Kernel as stopped', async () => {
    const directory = await temporaryDirectory()
    const paths: KernelDaemonPaths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    await writeFile(paths.descriptorPath, 'not json\n', 'utf8')

    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(new FakeChildProcess()),
    })
    expect(await launcher.isRunning()).toBe(false)
    await launcher.dispose()
  })

  test('treats a descriptor left by a crashed Kernel as "not running"', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    // 崩溃后残留的 descriptor：pid 早没了，端点也没人听。
    await writeFile(
      paths.descriptorPath,
      `${JSON.stringify({
        authToken: 'x'.repeat(43),
        instanceId: 'dead',
        protocolVersion: KernelProtocolVersion,
        kernelVersion: '0.3.0',
        pid: 0x7fff_fffe,
        startedAt: 1,
        endpoint: { kind: 'tcp', host: '127.0.0.1', port: 1 },
      })}\n`,
      'utf8'
    )

    const child = new FakeChildProcess()
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(child),
      startTimeoutMs: 30,
      pollIntervalMs: 5,
    })

    // isRunning() 不再只看文件在不在，还要核 pid 是否真的活着。
    expect(await launcher.isRunning()).toBe(false)

    // 连不上不再直接抛出去，而是照常去启动。
    const failure = await launcher.ensureRunning().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'KERNEL_START_TIMEOUT' })
    expect(child.unrefCalls).toBe(1)
    await launcher.dispose()
  })

  test('refuses to connect to a descriptor from another protocol version before sending the token', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    await writeFile(
      paths.descriptorPath,
      `${JSON.stringify({
        authToken: 'x'.repeat(43),
        instanceId: 'other-protocol',
        protocolVersion: KernelProtocolVersion + 1,
        kernelVersion: '9.9.9',
        pid: process.pid,
        startedAt: 1,
        endpoint: { kind: 'tcp', host: '127.0.0.1', port: 1 },
      })}\n`,
      'utf8'
    )

    // 版本不合在拨号之前就判定：端点根本没人听，若先 handshake 只会拿到连接错误。
    await expect(kernelDaemons.connect(paths)).rejects.toMatchObject({
      name: 'KernelClientError',
      code: 'PROTOCOL_VERSION_MISMATCH',
    })
  })

  test('stops a stuck Kernel with SIGKILL instead of waiting forever', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    const child = new FakeChildProcess()
    child.ignoreSignals = true
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(child),
      startTimeoutMs: 20,
      pollIntervalMs: 2,
      stopGraceMs: 10,
      stopKillGraceMs: 10,
    })

    // 启动超时后会调 stop()：卡死的进程收 SIGTERM 不退，必须补一发 SIGKILL 并结束等待。
    await expect(launcher.ensureRunning()).rejects.toMatchObject({
      code: 'KERNEL_START_TIMEOUT',
    })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await launcher.dispose()
  })

  test('refuses to start once disposed', async () => {
    const directory = await temporaryDirectory()
    const paths = createDefaultKernelDaemonPaths('launcher-kernel', directory)
    const launcher = new KernelLauncher({
      paths,
      resolver: resolverFor(),
      spawnProcess: fakeSpawn(new FakeChildProcess()),
    })
    await launcher.dispose()
    await expect(launcher.ensureRunning()).rejects.toMatchObject({
      code: 'LAUNCHER_DISPOSED',
    })
  })

  test('launcher startup ownership drains a late version resolution without spawning', async () => {
    const directory = await temporaryDirectory()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const child = new FakeChildProcess()
    const launcher = new KernelLauncher({
      paths: createDefaultKernelDaemonPaths('launcher-kernel', directory),
      resolver: {
        async resolveActiveVersion() {
          enter()
          await gate
          return resolverFor().resolveActiveVersion()
        },
      },
      spawnProcess: fakeSpawn(child),
      startTimeoutMs: 0,
    })
    const starting = launcher.ensureRunning().catch((error: unknown) => error)
    try {
      await entered
      let closed = false
      const closing = launcher.dispose().then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      release()
      expect(await starting).toMatchObject({ code: 'LAUNCHER_DISPOSED' })
      await closing
      expect(child.unrefCalls).toBe(0)
      expect(child.signals).toEqual([])
    } finally {
      release()
      await starting
      await launcher.dispose()
    }
  })
})
