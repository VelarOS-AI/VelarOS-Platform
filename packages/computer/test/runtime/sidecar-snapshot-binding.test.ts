import { describe, expect, test } from 'bun:test'

import type {
  ComputerHelperRequest,
  ComputerHelperResponse,
  ComputerSidecarProcess,
} from '../../src/runtime'
import { ComputerSidecarManager } from '../../src/runtime'

class FakeOutput {
  private readonly listeners: Array<(chunk: Buffer | string) => void> = []

  public on(_event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.listeners.push(listener)
  }

  public emit(value: string): void {
    for (const listener of this.listeners) listener(value)
  }
}

class FakeProcess implements ComputerSidecarProcess {
  public readonly stdout = new FakeOutput()
  public readonly stderr = new FakeOutput()
  public readonly requests: ComputerHelperRequest[] = []
  public readonly stdin = {
    write: (chunk: string) => {
      const request = JSON.parse(chunk) as ComputerHelperRequest
      this.requests.push(request)
      const response = this.respond(request)
      queueMicrotask(() => this.stdout.emit(`${JSON.stringify(response)}\n`))
    },
    end: () => undefined,
  }

  public constructor(
    private readonly respond: (
      request: ComputerHelperRequest,
    ) => ComputerHelperResponse,
  ) {}

  public on(
    _event: 'error' | 'exit',
    _listener: ((error: Error) => void) | ((code: Nullable<number>) => void),
  ): void {}

  public kill(_signal?: NodeJS.Signals): void {}
}

function createManager(
  respond: (request: ComputerHelperRequest) => ComputerHelperResponse,
) {
  let process: FakeProcess | undefined
  const manager = new ComputerSidecarManager({
    resolveHelper: () => ({
      pythonCommand: 'python',
      helperScript: '/computer/helper.py',
      runtimeDir: '/computer',
      packageRoot: '/computer',
      version: 'test',
      bundledVenv: true,
    }),
    spawnProcess: () => {
      process = new FakeProcess(respond)
      queueMicrotask(() =>
        process?.stdout.emit('{"id":0,"ok":true,"result":{"ready":true}}\n')
      )
      return process
    },
  })
  return { manager, readProcess: () => process }
}

describe('computer sidecar screenshot binding', () => {
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
      await harness.manager.leftClick(120, 40, {
        coordinateSpace: 'primary-display',
        snapshotId: 'screen_test_snapshot_01',
      })

      expect(harness.readProcess()?.requests).toEqual([{
        id: 1,
        command: 'left_click',
        payload: {
          x: 120,
          y: 40,
          coordinateSpace: 'primary-display',
          snapshotId: 'screen_test_snapshot_01',
        },
      }])
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
        harness.manager.leftClick(120, 40, {
          coordinateSpace: 'primary-display',
          snapshotId: 'screen_test_snapshot_01',
        })
      ).rejects.toMatchObject({
        code: 'VALIDATION',
        context: { helperErrorCode: 'screen_snapshot_stale' },
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
        harness.manager.request('left_click', {
          x: 120,
          y: 40,
          coordinateSpace: 'global',
          snapshotId: 'screen_test_snapshot_01',
        })
      ).rejects.toMatchObject({
        code: 'VALIDATION',
        context: { helperErrorCode: 'screen_snapshot_unexpected' },
      })
    } finally {
      harness.manager.dispose()
    }
  })
})
