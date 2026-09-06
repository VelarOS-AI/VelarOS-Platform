import { isFiniteNumber, isPlainObject, isPresent, isString, isUndefined, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel/contracts/abi'

import { ComputerOperationMetadata } from '../contracts'

import {
  ComputerSidecarManager,
  type ComputerSidecarManagerOptions,
} from './ComputerSidecarManager'
import type {
  ComputerAvailability,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerKeyResult,
  ComputerMoveResult,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerTypeResult,
} from './types'

export const ComputerKernelModuleVersion = '0.2.8'

export interface ComputerRuntimePort {
  isReady(): boolean
  ensureAvailable(): Promise<ComputerAvailability>
  screenSize(): Promise<ComputerScreenSize>
  screenshot(): Promise<ComputerScreenshot>
  mouseMove(x: number, y: number): Promise<ComputerMoveResult>
  leftClick(
    x: number,
    y: number,
    options?: ComputerClickOptions,
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

const ClickButtons = ['left', 'right', 'middle'] as const
type ClickButton = (typeof ClickButtons)[number]
/** 单次调用允许的最大连击数（双击=2、三击=3）；再多是误用而非需求。 */
const MaxClickCount = 3
const MaxTypeTextLength = 100_000
const MaxKeyChordLength = 256

/**
 * 能力入口的输入门。
 *
 * 导览（§5.3b ④安全门）
 * - **拦截范围**：这一族 `parse*` 是内核能力面 `invoke(scope, input)` 与操作系统鼠标键盘之间的
 *   唯一屏障。调用方可能是任意模组或远端请求，`input` 类型未知，越过这里便会执行
 *   `input:control` 权限下的真实点击与按键。
 * - **所在层级**：辅助进程之后是 Python 辅助程序与操作系统接口，那里没有类型信息，也不具备
 *   VelarOS 错误语义；输入校验必须留在此处。
 * - **形状严格而非宽容**：`parseStrictObject` 对**未知键一律拒绝**。这与工具层（模型面）刻意
 *   宽容的参数策略方向相反，是有意的——工具层的输入来自模型、要容错；能力面的输入来自代码、
 *   多出来的键只可能是版本漂移或构造攻击，静默忽略会让「调用方以为传了个选项」和「这个选项
 *   根本没生效」长得一样。
 * - **失败方向**：任何存疑一律抛 `VALIDATION`，不裁剪、不取默认值。错误统一走
 *   `invalidCapabilityInput()` 单一出口，`details` 带上是哪个字段——原先七处同文案裸
 *   `new Error('Computer capability input is invalid')` 无法定位，等于没有诊断。
 */
function invalidCapabilityInput(field: string, detail: string): AppError {
  return new AppError('VALIDATION', 'Computer capability input is invalid', undefined, {
    field,
    detail,
  })
}

function parseStrictObject(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalidCapabilityInput('input', 'expected a plain object')
  const unexpectedKey = Object.keys(input).find((key) => !allowedKeys.includes(key))
  if (isString(unexpectedKey))
    throw invalidCapabilityInput(unexpectedKey, `unexpected key; allowed: ${allowedKeys.join(', ')}`)
  return input
}

function parseEmptyInput(input: unknown): void {
  parseStrictObject(input, [])
}

function parseCoordinateInput(input: unknown): { x: number; y: number } {
  return readCoordinates(parseStrictObject(input, ['x', 'y']), true)
}

function readCoordinates(
  record: Readonly<Record<string, unknown>>,
  allowNegative: boolean,
): {
  x: number
  y: number
} {
  return {
    x: readCoordinate(record.x, 'x', allowNegative),
    y: readCoordinate(record.y, 'y', allowNegative),
  }
}

function readCoordinate(value: unknown, field: string, allowNegative: boolean): number {
  // 虚拟桌面的全局原点可落在任意显示器，负坐标合法；只有截图内的主屏局部坐标要求非负。
  // 不设固定上界：屏幕分辨率是运行期事实，上界由 snapshot helper 对实际截图校验。
  if (!isFiniteNumber(value) || (!allowNegative && value < 0))
    throw invalidCapabilityInput(
      field,
      allowNegative ? 'expected a finite number' : 'expected a finite number >= 0',
    )
  return value
}

function parseClickInput(input: unknown): { x: number; y: number } & ComputerClickOptions {
  const record = parseStrictObject(input, [
    'x',
    'y',
    'button',
    'count',
    'coordinateSpace',
    'snapshotId',
  ])
  const coordinateSpace = readCoordinateSpace(record.coordinateSpace)
  const { x, y } = readCoordinates(record, coordinateSpace === 'global')
  const snapshotId = readSnapshotId(record.snapshotId)
  const button = toOptional(readClickButton(record.button))
  const count = toOptional(readClickCount(record.count))
  if (coordinateSpace === 'primary-display') {
    if (!isPresent(snapshotId))
      throw invalidCapabilityInput(
        'snapshotId',
        'required when coordinateSpace is primary-display',
      )
    return { x, y, button, count, coordinateSpace, snapshotId }
  }
  if (isPresent(snapshotId))
    throw invalidCapabilityInput(
      'snapshotId',
      'must be omitted when coordinateSpace is global',
    )
  return { x, y, button, count, coordinateSpace }
}

function readCoordinateSpace(
  value: unknown,
): NonNullable<ComputerClickOptions['coordinateSpace']> {
  if (isUndefined(value)) return 'global'
  if (value !== 'global' && value !== 'primary-display')
    throw invalidCapabilityInput(
      'coordinateSpace',
      'expected global or primary-display',
    )
  return value
}

function readSnapshotId(value: unknown): Nullable<string> {
  if (isUndefined(value)) return null
  if (
    !isString(value)
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw invalidCapabilityInput(
      'snapshotId',
      'expected an opaque screenshot identifier of 8-128 URL-safe characters',
    )
  return value
}

function readClickButton(value: unknown): Nullable<ClickButton> {
  if (isUndefined(value)) return null
  if (!isClickButton(value))
    throw invalidCapabilityInput('button', `expected one of: ${ClickButtons.join(', ')}`)
  return value
}

function readClickCount(value: unknown): Nullable<number> {
  if (isUndefined(value)) return null
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1 || value > MaxClickCount)
    throw invalidCapabilityInput('count', `expected an integer in [1, ${MaxClickCount}]`)
  return value
}

function isClickButton(value: unknown): value is ClickButton {
  return ClickButtons.includes(value as ClickButton)
}

function parseBoundedString(
  input: unknown,
  key: string,
  maxLength: number,
): string {
  const record = parseStrictObject(input, [key])
  const value = record[key]
  if (!isString(value) || value.length === 0 || value.length > maxLength)
    throw invalidCapabilityInput(key, `expected a non-empty string of at most ${maxLength} chars`)
  return value
}

function createComputerCapabilityService(
  runtime: ComputerRuntimePort,
): ComputerRuntimeCapabilityService {
  const callable = createKernelCallableCapability({
    ensure_available: {
      metadata: ComputerOperationMetadata.ensure_available,
      invoke: (_scope, input) => {
        parseEmptyInput(input)
        return runtime.ensureAvailable()
      },
    },
    screen_size: {
      metadata: ComputerOperationMetadata.screen_size,
      invoke: (_scope, input) => {
        parseEmptyInput(input)
        return runtime.screenSize()
      },
    },
    screenshot: {
      metadata: ComputerOperationMetadata.screenshot,
      invoke: (_scope, input) => {
        parseEmptyInput(input)
        return runtime.screenshot()
      },
    },
    mouse_move: {
      metadata: ComputerOperationMetadata.mouse_move,
      invoke: (_scope, input) => {
        const { x, y } = parseCoordinateInput(input)
        return runtime.mouseMove(x, y)
      },
    },
    left_click: {
      metadata: ComputerOperationMetadata.left_click,
      invoke: (_scope, input) => {
        const { x, y, ...options } = parseClickInput(input)
        return runtime.leftClick(x, y, options)
      },
    },
    type_text: {
      metadata: ComputerOperationMetadata.type_text,
      invoke: (_scope, input) =>
        runtime.typeText(parseBoundedString(input, 'text', MaxTypeTextLength)),
    },
    key: {
      metadata: ComputerOperationMetadata.key,
      invoke: (_scope, input) =>
        runtime.key(parseBoundedString(input, 'keys', MaxKeyChordLength)),
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
      options?: ComputerClickOptions,
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
      version: ComputerKernelModuleVersion,
      apiVersion: KernelModuleApiVersion,
      provides: [ComputerCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['process:exec', 'screen:capture', 'input:control'],
      isolation: 'in-process',
    },
    activate(context) {
      const ownsRuntime = !isPresent(options.runtime)
        || !!options.disposeInjectedRuntime
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
