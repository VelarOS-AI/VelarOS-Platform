import { isFiniteNumber, isPlainObject, isString, isUndefined, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'

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
 * - **挡什么**：这一族 `parse*` 是 Kernel 能力面（`invoke(scope, input)`）与 OS 级鼠标/键盘之间
 *   的唯一屏障。调用方是任意 mod / 远端 caller，`input` 是 `unknown`，越过这里就直达
 *   `input:control` 权限下的真实点击与按键。
 * - **门为什么在这一层**：sidecar 之后是 Python helper 与操作系统 API，那里既没有类型也没有
 *   VelarOS 的错误语义；把校验放在 helper 里等于把安全水位交给一门没有编译期的语言。
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
  return readCoordinates(parseStrictObject(input, ['x', 'y']))
}

function readCoordinates(record: Readonly<Record<string, unknown>>): {
  x: number
  y: number
} {
  return { x: readCoordinate(record.x, 'x'), y: readCoordinate(record.y, 'y') }
}

function readCoordinate(value: unknown, field: string): number {
  // 只设下界不设上界：屏幕分辨率是运行期事实，上界归 sidecar 与工具 schema，这里越权钉死会在
  // 高分屏/多显示器上误拒合法坐标。
  if (!isFiniteNumber(value) || value < 0)
    throw invalidCapabilityInput(field, 'expected a finite number >= 0')
  return value
}

function parseClickInput(input: unknown): {
  x: number
  y: number
  button?: ClickButton
  count?: number
} {
  const record = parseStrictObject(input, ['x', 'y', 'button', 'count'])
  const { x, y } = readCoordinates(record)
  // 省略（`undefined`）是合法的「不指定」；`null` 或任何别的值都是错误输入。缺席用 null 在包内传递，
  // 到出口处一次 toOptional 归一（§1.5：null↔undefined 只在边界转一次）。
  return {
    x,
    y,
    button: toOptional(readClickButton(record.button)),
    count: toOptional(readClickCount(record.count)),
  }
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
        runtime.typeText(parseBoundedString(input, 'text', MaxTypeTextLength)),
    },
    key: {
      metadata: {
        permissions: ['process:exec', 'input:control'],
        reason: 'Send a bounded keyboard chord.',
      },
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
