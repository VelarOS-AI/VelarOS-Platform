import { describe, expect, test } from 'bun:test'

import type {
  ComputerClickOptions,
  ComputerHelperRequest,
  ComputerHelperResponse,
  ComputerSidecarProcess,
} from '../../index'
import { createComputerRuntime } from '../../index'

class FakeOutput {
  private readonly listeners: Array<(chunk: Buffer | string) => void> = []

  public on(_event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.listeners.push(listener)
  }

  public emit(value: Buffer | string): void {
    for (const listener of this.listeners) listener(value)
  }
}

class FakeProcess implements ComputerSidecarProcess {
  private readonly exits: Array<(code: Nullable<number>) => void> = []
  public readonly stdout = new FakeOutput()
  public readonly stderr = new FakeOutput()
  public readonly requests: ComputerHelperRequest[] = []
  public readonly stdin = {
    write: (chunk: string) => {
      const request = JSON.parse(chunk) as ComputerHelperRequest
      this.requests.push(request)
      const response = this.respond(request)
      queueMicrotask(() => {
        const line = `${JSON.stringify(response)}\n`
        if (this.fragmented)
          for (const byte of Buffer.from(line)) this.stdout.emit(Buffer.from([byte]))
        else this.stdout.emit(line)
      })
    },
    end: () => undefined,
  }

  public constructor(
    private readonly respond: (request: ComputerHelperRequest) => ComputerHelperResponse,
    private readonly fragmented = false
  ) {}

  public on(
    event: 'error' | 'exit',
    listener: ((error: Error) => void) | ((code: Nullable<number>) => void)
  ): void {
    if (event === 'exit') this.exits.push(listener as (code: Nullable<number>) => void)
  }

  public exit(code: number): void {
    for (const listener of this.exits) listener(code)
  }

  public kill(_signal?: NodeJS.Signals): void {}
}

function createManager(
  respond: (request: ComputerHelperRequest) => ComputerHelperResponse,
  fragmented = false
) {
  let process: FakeProcess | undefined
  const manager = createComputerRuntime({
    resolveHelper: () => ({
      pythonCommand: 'python',
      helperScript: '/computer/helper.py',
      runtimeDir: '/computer',
      packageRoot: '/computer',
      version: 'test',
    }),
    spawnProcess: () => {
      process = new FakeProcess(respond, fragmented)
      queueMicrotask(() => process?.stdout.emit('{"id":0,"ok":true,"result":{"ready":true}}\n'))
      return process
    },
  })
  return { manager, readProcess: () => process }
}

describe('computer sidecar screenshot binding', () => {
  test('key requests use the current keys field without a legacy alias', async () => {
    const harness = createManager((request) => ({
      id: request.id,
      ok: true,
      result: { pressed: ['ctrl', 'enter'] },
    }))
    try {
      expect(await harness.manager.key('ctrl+enter')).toEqual({ pressed: ['ctrl', 'enter'] })
      expect(harness.readProcess()?.requests).toEqual([
        { id: 1, command: 'key', payload: { keys: 'ctrl+enter' } },
      ])
    } finally {
      harness.manager.dispose()
    }
  })

  test('EOF rejects an incomplete UTF-8 character instead of replacing it', async () => {
    const harness = createManager((request) => {
      const process = harness.readProcess()!
      process.stdout.emit(Buffer.from([0xe4]))
      process.exit(0)
      return { id: request.id, ok: true, result: [] }
    })
    try {
      await expect(harness.manager.windows()).rejects.toMatchObject({ code: 'PROTOCOL' })
    } finally {
      harness.manager.dispose()
    }
  })

  test.each(['stdout', 'stderr'] as const)(
    'invalid UTF-8 on %s rejects this generation and permits a fresh start',
    async (stream) => {
      let corrupt = true
      const harness = createManager((request) => {
        if (corrupt) {
          corrupt = false
          harness.readProcess()![stream].emit(Buffer.from([0xff]))
        }
        return { id: request.id, ok: true, result: [] }
      })
      try {
        await expect(harness.manager.windows()).rejects.toMatchObject({ code: 'PROTOCOL' })
        expect(await harness.manager.windows()).toEqual([])
      } finally {
        harness.manager.dispose()
      }
    }
  )

  test('UTF-8 response fragments preserve Unicode window and control text', async () => {
    const result = [{ id: 'window_test', title: '中文窗口😀', processId: 1 }]
    const harness = createManager((request) => ({ id: request.id, ok: true, result }), true)
    try {
      expect(await harness.manager.windows()).toEqual(result)
    } finally {
      harness.manager.dispose()
    }
  })

  test('forwards primary-display snapshot binding in the click wire payload', async () => {
    const harness = createManager((request) => ({
      id: request.id,
      ok: true,
      result: {
        x: -1_800,
        y: 160,
        button: 'left',
        count: 1,
        coordinateSpace: 'primary-display',
        displayId: 7,
        snapshotId: 'screen_test_snapshot_01',
      },
    }))

    try {
      await harness.manager.click(120, 40, {
        coordinateSpace: 'primary-display',
        snapshotId: 'screen_test_snapshot_01',
      })

      expect(harness.readProcess()?.requests).toEqual([
        {
          id: 1,
          command: 'left_click',
          payload: {
            x: 120,
            y: 40,
            coordinateSpace: 'primary-display',
            snapshotId: 'screen_test_snapshot_01',
          },
        },
      ])
    } finally {
      harness.manager.dispose()
    }
  })

  test('maps helper stale-snapshot failures to non-retryable validation errors', async () => {
    const harness = createManager((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: 'screen_snapshot_stale',
        message: 'The primary display changed; take a new screenshot',
      },
    }))

    try {
      await expect(
        harness.manager.click(120, 40, {
          coordinateSpace: 'primary-display',
          snapshotId: 'screen_test_snapshot_01',
        })
      ).rejects.toMatchObject({
        code: 'VALIDATION',
        context: { helperErrorCode: 'screen_snapshot_stale' },
        // helper 的英文原文按码翻成中文：模型要照着这句决定「重新截图」。
        message: expect.stringContaining('重新 screenshot'),
      })
    } finally {
      harness.manager.dispose()
    }
  })

  test('maps a global snapshotId protocol violation to validation', async () => {
    const harness = createManager((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: 'screen_snapshot_unexpected',
        message: 'global coordinates must not carry snapshotId',
      },
    }))

    try {
      await expect(
        // 协议违规是调用方造出来的：全局坐标不许带 snapshotId，类型层面就拦着，这里故意绕过去看 helper 的裁决。
        harness.manager.click(120, 40, {
          coordinateSpace: 'global',
          snapshotId: 'screen_test_snapshot_01',
        } as unknown as ComputerClickOptions)
      ).rejects.toMatchObject({
        code: 'VALIDATION',
        context: { helperErrorCode: 'screen_snapshot_unexpected' },
      })
    } finally {
      harness.manager.dispose()
    }
  })
})
