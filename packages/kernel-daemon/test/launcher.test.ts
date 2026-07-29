import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { KernelModuleHost } from '@velaros-ai/core/kernel/host'
import { KernelService } from '@velaros-ai/core/kernel/runtime'
import {
  createDefaultKernelDaemonPaths,
  type KernelDaemonPaths,
  KernelLauncher,
  KernelLauncherError,
  type KernelVersionTarget,
} from '@velaros-ai/kernel-client'

import { KernelLocalDaemon } from '../src/daemon'

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

  public kill(signal: NodeJS.Signals): boolean {
    this.killed = true
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
