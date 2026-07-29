import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel-sdk'

import {
  ComputerSidecarManager,
  type ComputerSidecarManagerOptions,
} from './ComputerSidecarManager'
import type {
  ComputerAvailability,
  ComputerClickResult,
  ComputerKeyResult,
  ComputerMoveResult,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerTypeResult,
} from './types'

export interface ComputerRuntimePort {
  isReady(): boolean
  ensureAvailable(): Promise<ComputerAvailability>
  screenSize(): Promise<ComputerScreenSize>
  screenshot(): Promise<ComputerScreenshot>
  mouseMove(x: number, y: number): Promise<ComputerMoveResult>
  leftClick(
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; count?: number },
  ): Promise<ComputerClickResult>
  typeText(text: string): Promise<ComputerTypeResult>
  key(keys: string): Promise<ComputerKeyResult>
  dispose(): void
}

/** Public desktop-control surface exposed through the Kernel service registry. */
export interface ComputerRuntimeCapabilityService
  extends ComputerRuntimePort, KernelCallableCapabilityService {}

export interface CreateComputerKernelModuleOptions {
  /** Inject the product-owned singleton runtime when one already exists. */
  runtime?: ComputerRuntimePort
  /** Used only when the module owns the default sidecar manager. */
  sidecar?: ComputerSidecarManagerOptions
  /** Injected runtimes remain caller-owned unless explicitly opted in. */
  disposeInjectedRuntime?: boolean
}

/** Typed service identity for the optional OS-level Computer capability. */
export const ComputerCapability =
  createCapabilityToken<ComputerRuntimeCapabilityService>('velaros.computer')

function parseStrictObject(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Computer capability input is invalid')
  }
  const record = input as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Computer capability input is invalid')
  }
  return record
}

function parseEmptyInput(input: unknown): void {
  if (Object.keys(parseStrictObject(input, [])).length !== 0) {
    throw new Error('Computer capability input is invalid')
  }
}

function parseCoordinateInput(input: unknown): { x: number; y: number } {
  const record = parseStrictObject(input, ['x', 'y'])
  return readCoordinates(record)
}

function readCoordinates(record: Readonly<Record<string, unknown>>): {
  x: number
  y: number
} {
  const { x, y } = record
  if (
    typeof x !== 'number'
    || !Number.isFinite(x)
    || x < 0
    || typeof y !== 'number'
    || !Number.isFinite(y)
    || y < 0
  ) {
    throw new Error('Computer capability input is invalid')
  }
  return { x, y }
}

function parseClickInput(input: unknown): {
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  count?: number
} {
  const record = parseStrictObject(input, ['x', 'y', 'button', 'count'])
  const { x, y } = readCoordinates(record)
  const button = record.button
  const count = record.count
  if (
    button !== undefined
    && button !== 'left'
    && button !== 'right'
    && button !== 'middle'
  ) {
    throw new Error('Computer capability input is invalid')
  }
  if (
    count !== undefined
    && (
      typeof count !== 'number'
      || !Number.isInteger(count)
      || count < 1
      || count > 3
    )
  ) {
    throw new Error('Computer capability input is invalid')
  }
  return {
    x,
    y,
    ...(button === undefined ? {} : { button }),
    ...(count === undefined ? {} : { count }),
  }
}

function parseBoundedString(
  input: unknown,
  key: string,
  maxLength: number,
): string {
  const record = parseStrictObject(input, [key])
  const value = record[key]
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
  ) {
    throw new Error('Computer capability input is invalid')
  }
  return value
}

function createComputerCapabilityService(
  runtime: ComputerRuntimePort,
): ComputerRuntimeCapabilityService {
  const callable = createKernelCallableCapability({
    ensure_available: {
      metadata: {
        permissions: ['process:exec'],
        reason: 'Check whether the desktop-control sidecar is available.',
      },
      invoke: (_scope, input) => {
        parseEmptyInput(input)
        return runtime.ensureAvailable()
      },
    },
    screen_size: {
      metadata: {
        permissions: ['process:exec', 'screen:capture'],
        reason: 'Read the active display dimensions.',
      },
      invoke: (_scope, input) => {
        parseEmptyInput(input)
        return runtime.screenSize()
      },
    },
    screenshot: {
      metadata: {
        permissions: ['process:exec', 'screen:capture'],
        reason: 'Capture the active display.',
      },
      invoke: (_scope, input) => {
        parseEmptyInput(input)
        return runtime.screenshot()
      },
    },
    mouse_move: {
      metadata: {
        permissions: ['process:exec', 'input:control'],
        reason: 'Move the system pointer.',
      },
      invoke: (_scope, input) => {
        const { x, y } = parseCoordinateInput(input)
        return runtime.mouseMove(x, y)
      },
    },
    left_click: {
      metadata: {
        permissions: ['process:exec', 'input:control'],
        reason: 'Click at a display coordinate.',
      },
      invoke: (_scope, input) => {
        const { x, y, ...options } = parseClickInput(input)
        return runtime.leftClick(x, y, options)
      },
    },
    type_text: {
      metadata: {
        permissions: ['process:exec', 'input:control'],
        reason: 'Type text into the active application.',
      },
      invoke: (_scope, input) =>
        runtime.typeText(parseBoundedString(input, 'text', 100_000)),
    },
    key: {
      metadata: {
        permissions: ['process:exec', 'input:control'],
        reason: 'Send a bounded keyboard chord.',
      },
      invoke: (_scope, input) =>
        runtime.key(parseBoundedString(input, 'keys', 256)),
    },
  })

  return Object.freeze({
    ...callable,
    isReady: () => runtime.isReady(),
    ensureAvailable: () => runtime.ensureAvailable(),
    screenSize: () => runtime.screenSize(),
    screenshot: () => runtime.screenshot(),
    mouseMove: (x: number, y: number) => runtime.mouseMove(x, y),
    leftClick: (
      x: number,
      y: number,
      options?: {
        button?: 'left' | 'right' | 'middle'
        count?: number
      },
    ) => runtime.leftClick(x, y, options),
    typeText: (text: string) => runtime.typeText(text),
    key: (keys: string) => runtime.key(keys),
    dispose: () => runtime.dispose(),
  })
}

/**
 * Wraps the existing sidecar manager as an injectable capability. The module
 * adapter itself runs in-process while the manager owns the helper sidecar.
 */
export function createComputerKernelModule(
  options: CreateComputerKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.computer.sidecar',
      version: '0.2.6',
      apiVersion: 1,
      provides: [ComputerCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['process:exec', 'screen:capture', 'input:control'],
      isolation: 'in-process',
    },
    activate(context) {
      const ownsRuntime = options.runtime === undefined
        || options.disposeInjectedRuntime === true
      const runtime =
        options.runtime ?? new ComputerSidecarManager(options.sidecar)
      const service = createComputerCapabilityService(runtime)
      context.registerService(ComputerCapability, service)

      return {
        dispose() {
          if (ownsRuntime) runtime.dispose()
        },
      }
    },
  })
}
