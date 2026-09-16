import {
  type CapabilityToken,
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type ScopeRef,
} from '@velaros-ai/kernel/contracts/abi'

import type { BrowserRuntimeCapabilityService, CreateBrowserKernelModuleOptions } from '../../types/electron.js'
import { parseEmptyInput, parseSessionInput } from '../../utils/electron/kernel-input'

/** 浏览器运行时在内核里的能力令牌：宿主经它拿到本进程唯一的那份运行时。 */
export const BrowserRuntimeCapability: CapabilityToken<BrowserRuntimeCapabilityService> =
  createCapabilityToken<BrowserRuntimeCapabilityService>('velaros.browser')

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
      apiVersion: KernelModuleApiVersion,
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
            reason: '关掉一个由产品持有的浏览器会话。',
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
            reason: '关掉全部由产品持有的浏览器会话。',
          },
          invoke: (_scope, input) => {
            parseEmptyInput(input)
            options.runtime.closeAllSessions()
            return { closed: true }
          },
        },
      })
      // 逐个转发而不是 `...callable` 展开：可调用能力是内核给的**实例**，方法挂在原型上，
      // 展开只会拿到自有属性，`getOperationMetadata` 等会静默丢成 undefined。
      const service: BrowserRuntimeCapabilityService = Object.freeze({
        getOperationMetadata: (operation: string) => callable.getOperationMetadata(operation),
        invoke: (
          operation: string,
          scope: LooseOptional<ScopeRef>,
          input: unknown,
          signal: AbortSignal
        ) => callable.invoke(operation, scope, input, signal),
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
