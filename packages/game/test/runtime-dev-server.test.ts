import { describe, expect, test } from 'bun:test'

import { parseGameProjectManifest } from '../dist/core/index.js'
import {
  DenyAllGameProcessHost,
  type GameApprovedProcessHost,
  GameDevServerController,
  GameDevServerPortMismatchError,
  type GameDevServerStartRequest,
  GameDevServerStartupError,
  type GameDevServerStartupOutcome,
  type GameManagedDevProcess,
  GameProjectRuntime,
  type GameRuntimePageHost,
  GameRuntimePermissionDeniedError,
} from '../dist/runtime/index.js'

const project = parseGameProjectManifest({
  name: 'runtime-probe',
  entryScene: 'scene:main',
  scenes: ['scenes/main.scene.json'],
  layers: ['actors'],
  collisionLayers: [],
  input: { actions: {} },
  dev: {
    server: {
      command: 'bun run dev',
      port: 4173,
    },
  },
}).value

class ProbeProcess implements GameManagedDevProcess {
  public stopCalls: boolean[] = []

  public constructor(private readonly readyPort = 4173) {}

  public async waitUntilReady() {
    return {
      url: `http://127.0.0.1:${this.readyPort}`,
      port: this.readyPort,
      readyMs: 25,
      outcome: { kind: 'ready' } as const,
      compileErrors: [],
      runtimeErrors: [],
      startupLogTail: 'ready',
    }
  }

  public async stop(force: boolean) {
    this.stopCalls.push(force)
    return { exitCode: 0 }
  }
}

/** 起不来的 dev server：终态由宿主如实上报，不再伪装成一条编译错误。 */
class FailingProbeProcess implements GameManagedDevProcess {
  public stopCalls: boolean[] = []

  public constructor(
    private readonly outcome: GameDevServerStartupOutcome,
    private readonly startupLogTail: string,
  ) {}

  public async waitUntilReady() {
    return {
      url: 'http://127.0.0.1:4173',
      port: 4173,
      readyMs: 40,
      outcome: this.outcome,
      compileErrors: [],
      runtimeErrors: [],
      startupLogTail: this.startupLogTail,
    }
  }

  public async stop(force: boolean) {
    this.stopCalls.push(force)
    return { exitCode: 0 }
  }
}

class FailingProbeProcessHost implements GameApprovedProcessHost {
  public constructor(
    private readonly outcome: GameDevServerStartupOutcome,
    private readonly startupLogTail: string,
  ) {}

  public async startApproved(): Promise<GameManagedDevProcess> {
    return new FailingProbeProcess(this.outcome, this.startupLogTail)
  }
}

class ProbeProcessHost implements GameApprovedProcessHost {
  public readonly requests: GameDevServerStartRequest[] = []
  public readonly processes: ProbeProcess[] = []

  public constructor(private readonly readyPorts: readonly number[] = []) {}

  public async startApproved(request: GameDevServerStartRequest): Promise<GameManagedDevProcess> {
    this.requests.push(request)
    const process = new ProbeProcess(
      this.readyPorts[this.processes.length] ?? 4173,
    )
    this.processes.push(process)
    return process
  }
}

describe('GameDevServerController', () => {
  test('fails closed when the host does not inject an approved process port', async () => {
    const controller = new GameDevServerController(
      '/tmp/runtime-probe',
      project,
      new DenyAllGameProcessHost(),
    )

    expect(controller.isRunning()).toBeFalse()
    expect(controller.run()).rejects.toBeInstanceOf(GameRuntimePermissionDeniedError)
  })

  test('passes the immutable permission request and keeps same-scene run idempotent', async () => {
    const host = new ProbeProcessHost()
    const controller = new GameDevServerController('/tmp/runtime-probe', project, host)

    const first = await controller.run()
    const second = await controller.run()

    expect(first).toEqual(second)
    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]).toMatchObject({
      command: 'bun run dev',
      cwd: '/tmp/runtime-probe',
      requestedPort: 4173,
      permission: 'process:exec',
    })
    expect(await controller.stop()).toEqual({
      status: 'stopped',
      wasRunning: true,
      exitCode: 0,
    })
    expect(await controller.stop()).toEqual({
      status: 'stopped',
      wasRunning: false,
    })
  })

  test('restarts for a different scene without leaving the old process alive', async () => {
    const host = new ProbeProcessHost()
    const controller = new GameDevServerController('/tmp/runtime-probe', project, host)

    await controller.run()
    const switched = await controller.run({ scene: 'bonus' })

    expect(switched.scene).toBe('bonus')
    expect(switched.restarted).toBeTrue()
    expect(host.processes[0]?.stopCalls).toEqual([false])
    expect(host.requests).toHaveLength(2)
  })

  test('restarts with a refreshed project snapshot instead of reusing stale config', async () => {
    const host = new ProbeProcessHost()
    const controller = new GameDevServerController('/tmp/runtime-probe', project, host)
    await controller.run()

    controller.updateProject(parseGameProjectManifest({
      ...project,
      name: 'runtime-probe-refreshed',
      entryScene: 'scene:bonus',
      scenes: [...project.scenes, 'scenes/bonus.scene.json'],
      dev: {
        ...project.dev,
        server: {
          ...project.dev.server,
          command: 'bun run dev:refreshed',
        },
      },
    }).value)
    const refreshed = await controller.run()

    expect(refreshed.scene).toBe('bonus')
    expect(refreshed.restarted).toBeTrue()
    expect(host.processes[0]?.stopCalls).toEqual([false])
    expect(host.requests[1]).toMatchObject({
      command: 'bun run dev:refreshed',
      approvalReason: '启动游戏工程 runtime-probe-refreshed 的本地 dev server',
    })
  })

  test('reports an immediate process exit with its own startup log instead of a fake compile error', async () => {
    const controller = new GameDevServerController(
      '/tmp/runtime-probe',
      project,
      new FailingProbeProcessHost(
        { kind: 'exited', exitCode: 1 },
        'error: Script not found "dev"\n',
      ),
    )

    await expect(controller.run()).rejects.toThrow(GameDevServerStartupError)
    await expect(controller.run()).rejects.toThrow('启动后立即退出（exit 1）')
    // 唯一能让模型下一步做对的信息在进程自己的输出里，必须进错误正文。
    await expect(controller.run()).rejects.toThrow('Script not found "dev"')
    expect(controller.isRunning()).toBeFalse()
  })

  test('does not call a readiness timeout a compile failure', async () => {
    const controller = new GameDevServerController(
      '/tmp/runtime-probe',
      project,
      new FailingProbeProcessHost({ kind: 'timeout', waitedMs: 60_000 }, 'compiling…'),
    )

    await expect(controller.run()).rejects.toThrow('就绪超时（60000ms）')
    await expect(controller.run()).rejects.not.toThrow('游戏编译失败')
  })

  test('rejects an auto-selected port and stops the mismatched process', async () => {
    const host = new ProbeProcessHost([4174])
    const controller = new GameDevServerController('/tmp/runtime-probe', project, host)

    await expect(controller.run()).rejects.toBeInstanceOf(
      GameDevServerPortMismatchError,
    )
    expect(host.processes[0]?.stopCalls).toEqual([false])
    expect(controller.isRunning()).toBeFalse()
  })
})

describe('GameProjectRuntime', () => {
  test('keeps an already-ready page intact for an idempotent same-scene run', async () => {
    const processHost = new ProbeProcessHost()
    let openCalls = 0
    const pageHost: GameRuntimePageHost = {
      open: async () => {
        openCalls += 1
      },
      close: async () => undefined,
      screenshot: async () => ({
        path: 'game.png',
        width: 960,
        height: 540,
        capturedAt: 1,
        overlay: true,
      }),
      query: async () => ({
        select: 'scene',
        scene: 'main',
        running: true,
        url: 'http://127.0.0.1:4173',
        entityCount: 0,
        fps: 60,
        elapsedMs: 1,
      }),
      input: async () => ({ appliedSteps: 0, droppedSteps: [] }),
    }
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      processHost,
      pageHost,
    )

    await runtime.run({})
    await runtime.run({})

    expect(openCalls).toBe(1)
    expect(processHost.requests).toHaveLength(1)
  })

  test('closes the page and dev server when page readiness fails', async () => {
    const processHost = new ProbeProcessHost()
    let closeCalls = 0
    const pageHost: GameRuntimePageHost = {
      open: async () => {
        throw new Error('page bridge did not become ready')
      },
      close: async () => {
        closeCalls += 1
      },
      screenshot: async () => {
        throw new Error('not running')
      },
      query: async () => {
        throw new Error('not running')
      },
      input: async () => {
        throw new Error('not running')
      },
    }
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      processHost,
      pageHost,
    )

    expect(runtime.run({})).rejects.toThrow('page bridge did not become ready')
    expect(runtime.isRunning()).toBeFalse()
    expect(closeCalls).toBe(1)
    expect(processHost.processes[0]?.stopCalls).toEqual([false])
  })
})
