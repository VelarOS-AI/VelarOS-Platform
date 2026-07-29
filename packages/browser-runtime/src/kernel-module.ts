import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel-sdk'

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

function parseSessionInput(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Browser capability input is invalid')
  }
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).length !== 1
    || typeof record.sessionId !== 'string'
    || record.sessionId.trim().length === 0
    || record.sessionId !== record.sessionId.trim()
    || record.sessionId.length > 512
  ) {
    throw new Error('Browser capability input is invalid')
  }
  return record.sessionId
}

function parseEmptyInput(input: unknown): void {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 0
  ) {
    throw new Error('Browser capability input is invalid')
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
