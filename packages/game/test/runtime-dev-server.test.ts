import { describe, expect, test } from 'bun:test'

import { parseGameProjectManifest } from '../dist/core/index.js'
import {
  DenyAllGameProcessHost,
  describeUnreadableColor,
  describeUnrealizedVisual,
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
  isGamePageHostTimeout,
  parseVisualColor,
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

/**
 * AGENT-12：**一个工具不许无声吊死整条会话**。
 *
 * 现场是宿主的会话串行队列被一条永不 settle 的页面求值占死，于是 `pageHost.open()` 里的
 * 每一步都永远等下去——`game:run` 14 分钟没有回执、舞台停在「正在接管」、abort 也解不开，
 * 只能重启应用。下面三条把两层修法钉死：**等承载的 await 必须有上限**，
 * 且**失败之后运行态必须回滚到干净**，下一次 game:run 不许受影响。
 */
describe('game runtime deadlines', () => {
  const fastTimeouts = { pageOpenMs: 40, firstFrameMs: 30, pageOperationMs: 40 }
  const never = () => new Promise<never>(() => {})

  const workingPageHost = (open: () => Promise<void>): GameRuntimePageHost => ({
    open,
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
      entityCount: 1,
      renderedEntities: 1,
      invisibleEntities: 0,
      fps: 60,
      elapsedMs: 3,
    }),
    input: async () => ({ appliedSteps: 0, droppedSteps: [] }),
  })

  test('承载永不就绪时 game:run 有限时间内返回终态失败，并回滚到未启动', async () => {
    let closeCalls = 0
    const processHost = new ProbeProcessHost()
    const pageHost: GameRuntimePageHost = {
      ...workingPageHost(never),
      close: async () => {
        closeCalls += 1
      },
    }
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      processHost,
      pageHost,
      undefined,
      undefined,
      fastTimeouts,
    )

    const error = await runtime.run({}).catch((thrown: unknown) => thrown)

    // 终态、可执行、带得出「可以再发一次」这句结论。
    expect(isGamePageHostTimeout(error)).toBeTrue()
    expect((error as Error).message).toContain('可以安全地再发一次 game:run')
    // 回滚：页面关了、dev server 停了、运行态是「未启动」。
    expect(runtime.isRunning()).toBeFalse()
    expect(closeCalls).toBe(1)
    expect(processHost.processes[0]?.stopCalls).toEqual([false])
  })

  test('上一次挂死不许污染下一次：紧接着的 game:run 照常跑起来', async () => {
    let openCalls = 0
    const processHost = new ProbeProcessHost()
    const pageHost = workingPageHost(async () => {
      openCalls += 1
      if (openCalls === 1) await never()
    })
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      processHost,
      pageHost,
      undefined,
      undefined,
      fastTimeouts,
    )

    await runtime.run({}).catch(() => undefined)
    const result = await runtime.run({})

    expect(result.status).toBe('running')
    expect(runtime.isRunning()).toBeTrue()
    expect(openCalls).toBe(2)
  })

  test('首帧观测卡住只丢观测，绝不把「其实跑起来了」翻成失败', async () => {
    const pageHost: GameRuntimePageHost = {
      ...workingPageHost(async () => undefined),
      query: never,
    }
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      new ProbeProcessHost(),
      pageHost,
      undefined,
      undefined,
      fastTimeouts,
    )

    const result = await runtime.run({})

    expect(result.status).toBe('running')
    expect(result.firstFrame).toBeUndefined()
    expect(runtime.isRunning()).toBeTrue()
  })
})

/**
 * 第十二轮：「跑起来了但什么都看不见」的信号必须在**跑**结束那一刻就到手。
 *
 * 真机第一手：模型 `game:run` 成功后直接截图、报告三个物体都在，全程没调过 `game:query_state`。
 * 可见性只挂在查询工具上等于给了一条它不会走的路。
 */
describe('game:run first frame visibility', () => {
  const scenePayload = (renderedEntities: number) => ({
    select: 'scene' as const,
    scene: 'main',
    running: true,
    url: 'http://127.0.0.1:4173',
    entityCount: 3,
    renderedEntities,
    invisibleEntities: 3 - renderedEntities,
    fps: 97,
    elapsedMs: 12,
  })

  const errorRecord = {
    signature: 'runtime|blind|',
    message: '场景 scene:main 的 3 个实体没有一个产生可见画面：这一帧上只有调试叠加层。',
    source: 'runtime' as const,
    count: 1,
    firstAt: 1,
    lastAt: 1,
  }

  test('把首帧可见性与页面诊断拼进 game:run 结果', async () => {
    const pageHost: GameRuntimePageHost = {
      open: async () => undefined,
      close: async () => undefined,
      screenshot: async () => ({
        path: 'game.png',
        width: 960,
        height: 540,
        capturedAt: 1,
        overlay: true,
      }),
      query: async (request) =>
        request.select === 'errors'
          ? { select: 'errors', errors: [errorRecord], total: 1 }
          : scenePayload(0),
      input: async () => ({ appliedSteps: 0, droppedSteps: [] }),
    }
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      new ProbeProcessHost(),
      pageHost,
    )

    const result = await runtime.run({})

    expect(result.firstFrame).toEqual({
      entityCount: 3,
      renderedEntities: 0,
      invisibleEntities: 3,
    })
    // 内置服务那条路上 `waitUntilReady` 看不到页面诊断；这里把两半接上。
    expect(result.runtimeErrors).toHaveLength(1)
    expect(result.runtimeErrors[0]?.message).toContain('没有一个产生可见画面')
  })

  test('观测失败绝不把「其实跑起来了」翻成失败', async () => {
    const pageHost: GameRuntimePageHost = {
      open: async () => undefined,
      close: async () => undefined,
      screenshot: async () => ({
        path: 'game.png',
        width: 960,
        height: 540,
        capturedAt: 1,
        overlay: true,
      }),
      query: async () => {
        throw new Error('window.__velarosGame 还没挂上')
      },
      input: async () => ({ appliedSteps: 0, droppedSteps: [] }),
    }
    const runtime = new GameProjectRuntime(
      '/tmp/runtime-probe',
      project,
      new ProbeProcessHost(),
      pageHost,
    )

    const result = await runtime.run({})

    expect(result.status).toBe('running')
    expect(result.firstFrame).toBeUndefined()
    expect(runtime.isRunning()).toBeTrue()
  })
})

describe('describeUnrealizedVisual', () => {
  const entity = (id, components, envelope = {}) => ({ id, components, ...envelope })

  test('真机那一档：组件写成 sprite / collider，实体什么都没画 → 点名并给出路', () => {
    const message = describeUnrealizedVisual(
      entity('ground', {
        sprite: { width: 800, height: 40, color: '#6b8e23' },
        collider: { width: 800 },
      }),
      false,
    )
    expect(message).toContain('实体 ground 没有产生任何画面')
    expect(message).toContain('sprite / collider')
    expect(message).toContain('components.visual')
  })

  /**
   * 第十三轮 P1-2：证据面必须覆盖实体**信封**。
   *
   * 清单解析器只把名字在组件闭集或别名表里的键搬进 `components`，闭集外的（`renderer` /
   * 直接写在实体上的 `color`）原地留在信封上。上一版只扫组件表，于是这一档在运行期
   * 一条诊断都没有——而回合上下文恰恰叫模型去 `select:'errors'` 看原因。
   */
  test('闭集外的键留在实体信封上时同样算证据（P1-2）', () => {
    const message = describeUnrealizedVisual(
      entity('coin', {}, { renderer: 'circle', color: '#ffd700' }),
      false,
    )
    expect(message).toContain('实体 coin 没有产生任何画面')
    expect(message).toContain('实体块上的 renderer / color')
    expect(message).toContain('components.visual')
  })

  test('故意不画的实体（触发器 / 出生点 / 纯逻辑）不报——清单干净就是没有未兑现的意图', () => {
    expect(describeUnrealizedVisual(
      entity('spawn-point', {
        transform: { position: { x: 10, y: 20 } },
        tags: ['spawn'],
        layer: 'actors',
        order: 0,
      }),
      false,
    )).toBeNull()
    expect(describeUnrealizedVisual(
      entity(
        'trigger',
        { body: { kind: 'static', layer: 'ground' }, script: { module: 'src/systems/trigger.js' } },
        // 信封上的已知键（from / parent / notes）不是证据：它们是被支持的写法。
        { from: 'prefab:trigger', notes: '出生区域，故意不画' },
      ),
      false,
    )).toBeNull()
  })

  test('声明了 visual 却没投影出来一定报；画出来了一定不报', () => {
    expect(describeUnrealizedVisual(entity('ghost', { visual: { color: '#fff' } }), false))
      .toContain('声明了 visual 却没有产生任何画面')
    expect(describeUnrealizedVisual(entity('hero', { sprite: { color: '#fff' } }), true)).toBeNull()
  })
})

/**
 * 第十三轮 P1-1：颜色不许静默变紫。
 *
 * 只有 hex / `0x` / `rgb()` / `rgba()` 这几档是本包自己解析的，所以能在 Node 里钉住；
 * 具名色与 `hsl()` 走页面自己的 CSS 解析器（没有 DOM 时回 null，由调用点出诊断）。
 */
describe('parseVisualColor', () => {
  test('收下 3/4/6/8 位十六进制、0x 前缀与 rgb()/rgba()，alpha 不再被丢掉', () => {
    expect(parseVisualColor('#f00')).toEqual({ color: 0xff0000, alpha: 1 })
    expect(parseVisualColor('6b8e23')).toEqual({ color: 0x6b8e23, alpha: 1 })
    expect(parseVisualColor('0x6b8e23')).toEqual({ color: 0x6b8e23, alpha: 1 })
    expect(parseVisualColor('#ffd700')).toEqual({ color: 0xffd700, alpha: 1 })
    expect(parseVisualColor('#ff000080')?.color).toBe(0xff0000)
    expect(parseVisualColor('#ff000080')?.alpha).toBeCloseTo(128 / 255, 5)
    expect(parseVisualColor('rgb(255, 215, 0)')).toEqual({ color: 0xffd700, alpha: 1 })
    expect(parseVisualColor('rgba(255 0 0 / 50%)')).toEqual({ color: 0xff0000, alpha: 0.5 })
    expect(parseVisualColor('rgb(100%, 0%, 0%)')).toEqual({ color: 0xff0000, alpha: 1 })
  })

  test('认不出来回 null（调用点据此出诊断），绝不回一个别的颜色', () => {
    for (const value of ['reed', '#12345', 'rgb(1,2)', '', '   ', 42, null, undefined]) {
      expect(parseVisualColor(value)).toBeNull()
    }
  })

  test('诊断正文点名「你写的是什么 / 画面上会是什么 / 可以怎么写」', () => {
    const message = describeUnreadableColor('实体 coin 的 visual.color', 'gooold', '#8b5cf6')
    expect(message).toContain('"gooold"')
    expect(message).toContain('#8b5cf6')
    expect(message).toContain('rgba(…)')
  })
})
