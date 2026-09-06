import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { ComputerClickOptions } from '../../src/runtime'
import type { ComputerToolContext, ToolComputerApi } from '../../src/tools'
import { computerTools } from '../../src/tools'

const SnapshotId = 'screen_test_snapshot_01'

interface HarnessOptions {
  acceptedSnapshotId?: string
}

function createContext(options: HarnessOptions = {}) {
  const moves: Array<[number, number]> = []
  const clicks: Array<{ x: number; y: number; options?: ComputerClickOptions }> = []
  let screenSizeReads = 0
  const acceptedSnapshotId = options.acceptedSnapshotId ?? SnapshotId
  const display = {
    displayId: 7,
    width: 1_920,
    height: 1_080,
    scaleFactor: 1,
    originX: -1_920,
    originY: 120,
  }
  const computer: ToolComputerApi = {
    ensureAvailable: async () => ({ available: true, reason: 'available', detail: null }),
    screenSize: async () => {
      screenSizeReads += 1
      return display
    },
    screenshot: async () => ({
      base64: 'image-bytes',
      format: 'jpeg',
      snapshotId: SnapshotId,
      width: display.width,
      height: display.height,
      displayWidth: display.width,
      displayHeight: display.height,
      ...display,
    }),
    mouseMove: async (x, y) => {
      moves.push([x, y])
      return { x, y }
    },
    click: async (x, y, clickOptions) => {
      if (clickOptions?.coordinateSpace === 'primary-display') {
        if (clickOptions.snapshotId !== acceptedSnapshotId)
          throw new AppError(
            'VALIDATION',
            'screen_snapshot_stale: take a new computer:screenshot before clicking',
          )
        clicks.push({ x, y, options: clickOptions })
        return {
          x: display.originX + x,
          y: display.originY + y,
          button: clickOptions.button ?? 'left',
          count: clickOptions.count ?? 1,
          coordinateSpace: 'primary-display',
          displayId: display.displayId,
          snapshotId: clickOptions.snapshotId,
        }
      }
      clicks.push({ x, y, options: clickOptions })
      return {
        x,
        y,
        button: clickOptions?.button ?? 'left',
        count: clickOptions?.count ?? 1,
        coordinateSpace: 'global',
      }
    },
    typeText: async () => { throw new Error('not used') },
    key: async () => { throw new Error('not used') },
  }
  const context: ComputerToolContext = {
    abortSignal: new AbortController().signal,
    computer,
    execution: null,
  }
  return { clicks, context, moves, readScreenSizeReads: () => screenSizeReads }
}

describe('computer input coordinate contract', () => {
  test('returns an opaque binding alongside each model-visible screenshot', async () => {
    const harness = createContext()

    const result = await computerTools['computer:screenshot'].execute({}, harness.context)

    expect(result).toMatchObject({
      snapshotId: SnapshotId,
      width: 1_920,
      height: 1_080,
      modelImage: { data: 'image-bytes', mediaType: 'image/jpeg' },
    })
  })

  test('requires a screenshot binding for primary-display clicks', () => {
    expect(() =>
      computerTools['computer:click'].schema.parse({ x: 100, y: 50 })
    ).toThrow()
  })

  test('rejects a screenshot binding on explicit global coordinates instead of stripping it', () => {
    expect(() =>
      computerTools['computer:click'].schema.parse({
        x: 100,
        y: 50,
        coordinateSpace: 'global',
        snapshotId: SnapshotId,
      })
    ).toThrow()
  })

  test('passes screenshot-local coordinates and binding to the runtime for atomic validation', async () => {
    const harness = createContext()
    const input = computerTools['computer:click'].schema.parse({
      x: 100,
      y: 50,
      snapshotId: SnapshotId,
    })

    const result = await computerTools['computer:click'].execute(input, harness.context)

    expect(harness.clicks).toEqual([{
      x: 100,
      y: 50,
      options: {
        button: undefined,
        count: undefined,
        coordinateSpace: 'primary-display',
        snapshotId: SnapshotId,
      },
    }])
    expect(harness.readScreenSizeReads()).toBe(0)
    expect(result).toMatchObject({
      x: 100,
      y: 50,
      coordinateSpace: 'primary-display',
      snapshotId: SnapshotId,
      displayId: 7,
      globalX: -1_820,
      globalY: 170,
    })
  })

  test('fails closed when the runtime rejects a stale screenshot binding', async () => {
    const harness = createContext({ acceptedSnapshotId: 'screen_new_snapshot_02' })
    const input = computerTools['computer:click'].schema.parse({
      x: 100,
      y: 50,
      snapshotId: SnapshotId,
    })

    await expect(
      computerTools['computer:click'].execute(input, harness.context)
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(harness.clicks).toEqual([])
  })

  test('passes explicit global coordinates through without a screenshot binding', async () => {
    const harness = createContext()
    const input = computerTools['computer:click'].schema.parse({
      x: -100,
      y: 40,
      coordinateSpace: 'global',
    })

    const result = await computerTools['computer:click'].execute(input, harness.context)

    expect(harness.clicks).toEqual([{
      x: -100,
      y: 40,
      options: {
        button: undefined,
        count: undefined,
        coordinateSpace: 'global',
      },
    }])
    expect(harness.readScreenSizeReads()).toBe(0)
    expect(result).toMatchObject({
      x: -100,
      y: 40,
      coordinateSpace: 'global',
      globalX: -100,
      globalY: 40,
    })
  })

  test('keeps screenshot-local movement compatible with the current display geometry', async () => {
    const harness = createContext()
    const input = computerTools['computer:move'].schema.parse({ x: 100, y: 50 })

    const result = await computerTools['computer:move'].execute(input, harness.context)

    expect(harness.moves).toEqual([[-1_820, 170]])
    expect(result).toMatchObject({
      x: 100,
      y: 50,
      coordinateSpace: 'primary-display',
      displayId: 7,
      globalX: -1_820,
      globalY: 170,
    })
  })

  test('rejects a screenshot-local move outside the current display', async () => {
    const harness = createContext()
    const input = computerTools['computer:move'].schema.parse({ x: 1_920, y: 10 })

    await expect(
      computerTools['computer:move'].execute(input, harness.context)
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(harness.moves).toEqual([])
  })
})
