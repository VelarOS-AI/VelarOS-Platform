import { expect, test } from 'bun:test'

import type { ComputerOperationContext } from '../contract/requires'
import type { ComputerSidecarProcess } from '../contract/requires'
import { computerOperations } from '../impl/ComputerOperations'
import { createComputerRuntime } from '../impl/ComputerSidecarManager'

const StartupSpec = {
  pythonCommand: 'python',
  helperScript: '/fake/helper.py',
  runtimeDir: '/fake',
  packageRoot: '/fake',
  version: 'test',
}

test('sidecar startup ownership rejects a helper resolved after disposal without spawning', async () => {
  let spawns = 0
  const manager = createComputerRuntime({
    resolveHelper: () => {
      manager.dispose()
      return StartupSpec
    },
    spawnProcess: () => {
      spawns++
      throw new Error('disposed startup must not spawn')
    },
  })
  try {
    await expect(manager.screenSize()).rejects.toMatchObject({ code: 'COMPUTER_SIDECAR_DISPOSED' })
    expect(spawns).toBe(0)
    expect(manager.isReady()).toBe(false)
    await expect(manager.screenSize()).rejects.toMatchObject({ code: 'COMPUTER_SIDECAR_DISPOSED' })
  } finally {
    manager.dispose()
  }
})

for (const exitOnEof of [false, true]) {
  test(`sidecar startup ownership releases a late child with ${exitOnEof ? 'synchronous EOF exit' : 'EOF grace then kill'}`, async () => {
    const exits: Array<(code: Nullable<number>) => void> = []
    const stdout: Array<(chunk: Buffer | string) => void> = []
    const signals: NodeJS.Signals[] = []
    const killed = Promise.withResolvers<void>()
    let ends = 0
    let spawns = 0
    let reentrantAvailability:
      ReturnType<ReturnType<typeof createComputerRuntime>['ensureAvailable']> | undefined
    const child: ComputerSidecarProcess = {
      stdin: {
        write: () => {
          throw new Error('late child must not receive actions')
        },
        end: () => {
          ends++
          if (exitOnEof) for (const listener of exits) listener(0)
        },
        on: () => undefined,
      },
      stdout: {
        on: (_event, listener) => {
          stdout.push(listener)
        },
      },
      stderr: { on: () => undefined },
      on: ((
        event: 'error' | 'exit',
        listener: ((error: Error) => void) | ((code: Nullable<number>) => void)
      ) => {
        if (event === 'exit') exits.push(listener as (code: Nullable<number>) => void)
      }) as ComputerSidecarProcess['on'],
      kill: (signal) => {
        signals.push(signal ?? 'SIGTERM')
        for (const listener of exits) listener(0)
        killed.resolve()
      },
    }
    const manager = createComputerRuntime({
      resolveHelper: () => StartupSpec,
      spawnProcess: () => {
        spawns++
        // 此入口不经动作串行队列；必须复用已登记的同一次启动，不能再 spawn。
        if (spawns === 1) reentrantAvailability = manager.ensureAvailable()
        manager.dispose()
        return child
      },
    })
    try {
      await expect(manager.screenSize()).rejects.toMatchObject({
        code: 'COMPUTER_SIDECAR_DISPOSED',
      })
      expect(spawns).toBe(1)
      expect(ends).toBe(1)
      expect(signals).toEqual([])
      for (const listener of stdout) listener('{"id":0,"ok":true,"result":{"ready":true}}\n')
      expect(manager.isReady()).toBe(false)
      expect((await reentrantAvailability)?.available).toBe(false)
      if (!exitOnEof) {
        await killed.promise
        expect(signals).toEqual(['SIGTERM'])
      }
      expect(manager.isReady()).toBe(false)
      await expect(manager.windows()).rejects.toMatchObject({ code: 'COMPUTER_SIDECAR_DISPOSED' })
      expect(spawns).toBe(1)
    } finally {
      for (const listener of exits) listener(0)
      manager.dispose()
    }
  })
}

test('cancelled screenshot response cannot deliver a late attachment', async () => {
  const abort = new AbortController()
  const attached: unknown[] = []
  const ctx = {
    abortSignal: abort.signal,
    attachImage: (image: unknown) => attached.push(image),
    computer: {
      ensureAvailable: async () => ({ available: true }),
      screenshot: async () => {
        abort.abort()
        return { base64: 'late-pixels', format: 'jpeg' }
      },
    },
  } as unknown as ComputerOperationContext
  await expect(computerOperations.screenshot(ctx)).rejects.toBeDefined()
  expect(attached).toEqual([])
})

test.each(['typeText', 'key'])(
  'cancelled availability check prevents %s dispatch',
  async (operation) => {
    const abort = new AbortController()
    let dispatched = false
    const ctx = {
      abortSignal: abort.signal,
      computer: {
        ensureAvailable: async () => {
          abort.abort()
          return { available: true }
        },
        typeText: async () => {
          dispatched = true
          return {}
        },
        key: async () => {
          dispatched = true
          return {}
        },
      },
    } as unknown as ComputerOperationContext
    await expect(
      operation === 'typeText'
        ? computerOperations.typeText({ text: 'example' }, ctx)
        : computerOperations.key({ keys: 'enter' }, ctx)
    ).rejects.toBeDefined()
    expect(dispatched).toBe(false)
  }
)
