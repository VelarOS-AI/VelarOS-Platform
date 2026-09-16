import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  createDefaultKernelDaemonPaths,
  type KernelDaemonPaths,
} from '../../../src/client/contracts/descriptor'
import { connectToKernelDaemon } from '../../../src/client/discovery'
import {
  KernelLauncher,
  KernelLauncherError,
  type KernelVersionTarget,
} from '../../../src/client/KernelLauncher'
import { KernelProtocolVersion } from '../../../src/contracts/protocol/version'
import { KernelModuleHost } from '../../../src/runtime/host/KernelModuleHost'
import { KernelService } from '../../../src/runtime/service/KernelService'
import { KernelLocalDaemon } from '../../../src/serve/daemon/daemon'

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
    expect(failure).toBeInstanceOf(KernelLauncherError)
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
    const failure = await launcher.ensureRunning().catch(
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'KERNEL_START_FAILED' })
    await launcher.dispose()
  })

  test('ignores an unreadable descriptor and treats the Kernel as stopped', async () => {
    const directory = await temporaryDirectory()
    const paths: KernelDaemonPaths = createDefaultKernelDaemonPaths(
      'launcher-kernel',
      directory,
    )
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
      'utf8',
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
      'utf8',
    )

    // 版本不合在拨号之前就判定：端点根本没人听，若先 handshake 只会拿到连接错误。
    await expect(connectToKernelDaemon(paths)).rejects.toMatchObject({
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
})
