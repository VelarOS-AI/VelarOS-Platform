import { describe, expect, test } from 'bun:test'

import type { ComputerToolContext, ToolComputerApi } from '../../src/tools'
import { computerTools } from '../../src/tools'

function createContext() {
  const moves: Array<[number, number]> = []
  const clicks: Array<[number, number]> = []
  let screenSizeReads = 0
  const computer: ToolComputerApi = {
    ensureAvailable: async () => ({ available: true, reason: 'available', detail: null }),
    screenSize: async () => {
      screenSizeReads += 1
      return {
        displayId: 7,
        width: 1_920,
        height: 1_080,
        scaleFactor: 1,
        originX: -1_920,
        originY: 120,
      }
    },
    screenshot: async () => { throw new Error('not used') },
    mouseMove: async (x, y) => {
      moves.push([x, y])
      return { x, y }
    },
    click: async (x, y, options) => {
      clicks.push([x, y])
      return { x, y, button: options?.button ?? 'left', count: options?.count ?? 1 }
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
  test('maps screenshot-local coordinates through the primary display origin', async () => {
    const harness = createContext()
    const input = computerTools['computer:click'].schema.parse({ x: 100, y: 50 })

    const result = await computerTools['computer:click'].execute(input, harness.context)

    expect(harness.clicks).toEqual([[-1_820, 170]])
    expect(result).toMatchObject({
      x: 100,
      y: 50,
      coordinateSpace: 'primary-display',
      displayId: 7,
      globalX: -1_820,
      globalY: 170,
    })
  })

  test('passes explicit global coordinates through without applying the display origin', async () => {
    const harness = createContext()
    const input = computerTools['computer:move'].schema.parse({
      x: -100,
      y: 40,
      coordinateSpace: 'global',
    })

    const result = await computerTools['computer:move'].execute(input, harness.context)

    expect(harness.moves).toEqual([[-100, 40]])
    expect(harness.readScreenSizeReads()).toBe(0)
    expect(result).toMatchObject({
      x: -100,
      y: 40,
      coordinateSpace: 'global',
      globalX: -100,
      globalY: 40,
    })
  })

  test('rejects a screenshot-local point outside the captured display', async () => {
    const harness = createContext()
    const input = computerTools['computer:click'].schema.parse({ x: 1_920, y: 10 })

    await expect(
      computerTools['computer:click'].execute(input, harness.context)
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(harness.clicks).toEqual([])
  })
})
