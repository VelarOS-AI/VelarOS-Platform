import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'

import { type ElectronBrowserRuntime } from './ElectronBrowserRuntime'

export interface BrowserRuntimeCapabilityService
  extends KernelCallableCapabilityService {
  /**
   * Product-local runtime. Electron WebContents cannot be transferred into a
   * daemon, so in-process consumers receive the injected runtime explicitly.
   */
  readonly runtime: ElectronBrowserRuntime
}

export interface CreateBrowserKernelModuleOptions {
  /** Reuse the product composition root's only Browser runtime instance. */
  readonly runtime: ElectronBrowserRuntime
  /** Injected runtimes remain product-owned unless this is explicitly true. */
  readonly disposeInjectedRuntime?: boolean
}

export const BrowserRuntimeCapability =
  createCapabilityToken<BrowserRuntimeCapabilityService>('velaros.browser')

/** 能力边界的入参一律拒绝而非纠正：这里收到的形状不对，意味着调用方与本版本 ABI 已不同步。 */
function invalidCapabilityInput(): AppError {
  return new AppError('VALIDATION', 'Browser capability input is invalid')
}

/**
 * 会话入参解析：**只认恰好一个 `sessionId` 字段**。
 *
 * 严到这个程度是刻意的——它是 kernel 能力面（进程外调用方也能打进来）：
 *  - 多余字段 = 调用方以为自己传了参数而实际被丢弃，静默降级最难查；
 *  - 首尾空白不 trim 而是拒绝：会话 id 是索引键，静默归一会让两个「不同」的 id 落到同一会话；
 *  - 512 上限挡的是拿超长字符串当键的内存放大。
 */
function parseSessionInput(input: unknown): string {
  if (!isPlainObject(input)) throw invalidCapabilityInput()
  const sessionId = input.sessionId
  if (
    Object.keys(input).length !== 1
    || !isString(sessionId)
    || sessionId.trim().length === 0
    || sessionId !== sessionId.trim()
    || sessionId.length > 512
  ) {
    throw invalidCapabilityInput()
  }
  return sessionId
}

function parseEmptyInput(input: unknown): void {
  if (!isPlainObject(input) || Object.keys(input).length !== 0) {
    throw invalidCapabilityInput()
  }
}

/**
 * Registers the Electron browser runtime as an optional, product-local module.
 *
 * Only lifecycle-safe operations cross the generic wire today. Rich page
 * automation stays on the typed injected runtime until its serializable
 * operation schemas are frozen; Kernel never learns WebContents semantics.
 */
export function createBrowserKernelModule(
  options: CreateBrowserKernelModuleOptions,
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.browser.electron',
      version: '0.2.4',
      apiVersion: 1,
      provides: [BrowserRuntimeCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['browser:control'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability({
        close_session: {
          metadata: {
            permissions: ['browser:control'],
            reason: 'Close one product-owned browser session.',
          },
          async invoke(_scope, input) {
            const sessionId = parseSessionInput(input)
            await options.runtime.closeSession(sessionId)
            return { closed: true, sessionId }
          },
        },
        close_all_sessions: {
          metadata: {
            permissions: ['browser:control'],
            reason: 'Close every product-owned browser session.',
          },
          invoke: (_scope, input) => {
            parseEmptyInput(input)
            options.runtime.closeAllSessions()
            return { closed: true }
          },
        },
      })
      const service: BrowserRuntimeCapabilityService = Object.freeze({
        ...callable,
        runtime: options.runtime,
      })
      context.registerService(BrowserRuntimeCapability, service)

      return {
        dispose() {
          if (options.disposeInjectedRuntime) options.runtime.dispose()
        },
      }
    },
  })
}
