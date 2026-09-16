import { isEmpty, isPlainObject } from '@velaros-ai/core'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type KernelModuleHealth,
  type ScopeRef,
} from '@velaros-ai/kernel/contracts/abi'

import type { CreateAgentKernelModuleOptions } from '../../contract/requires.js'
import type { AgentCapabilityExecutionContext, AgentCapabilityService } from '../../types/execution.js'

/** Stable identity for an independently injected Agent execution capability. */
export const AgentCapability =
  createCapabilityToken<AgentCapabilityService>('velaros.agent')

/** Stable module identity used by host permission policies. */
export const AgentKernelModuleId = 'velaros.agent.runtime'

/** Permission required to execute an Agent through the Kernel capability. */
export const AgentExecutionPermission = 'agent:execute'

function parseEmptyInput(input: unknown): void {
  if (!isPlainObject(input) || !isEmpty(Object.keys(input))) {
    throw new Error('Agent health input is invalid')
  }
}

/**
 * Exposes an injected Agent runtime through the Kernel module lifecycle.
 *
 * `ready` owns startup, while health, suspend, and dispose stay lifecycle
 * concerns. The callable surface is intentionally limited to opaque execution
 * plus non-sensitive health inspection.
 */
export function createAgentKernelModule(
  options: CreateAgentKernelModuleOptions,
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: AgentKernelModuleId,
      version: '0.3.2',
      apiVersion: KernelModuleApiVersion,
      provides: [AgentCapability],
      requires: [],
      optionalRequires: [],
      permissions: [AgentExecutionPermission],
      isolation: 'in-process',
    },
    activate(context) {
      let ready = false

      const health = async (): Promise<KernelModuleHealth> => {
        if (!ready) return { status: 'unknown', message: 'Agent runtime is not ready' }
        return options.runtime.health?.() ?? { status: 'healthy' }
      }

      const execute = async (
        scope: LooseOptional<ScopeRef>,
        input: unknown,
        signal: AbortSignal,
      ): Promise<unknown> => {
        if (!ready) throw new Error('Agent capability is not ready')
        signal.throwIfAborted()
        const executionContext: AgentCapabilityExecutionContext =
          Object.freeze({
            signal,
            async publish<TPayload>(type: string, payload: TPayload) {
              signal.throwIfAborted()
              await context.events.publish(type, payload)
            },
          })
        return options.runtime.execute(scope, input, executionContext)
      }

      const callable = createKernelCallableCapability({
        health: {
          metadata: {
            permissions: [],
            reason: 'Inspect the injected Agent runtime health.',
          },
          invoke: async (_scope, input) => {
            parseEmptyInput(input)
            return health()
          },
        },
        execute: {
          metadata: {
            permissions: [AgentExecutionPermission],
            reason: 'Execute an Agent request through the injected runtime.',
          },
          invoke: execute,
        },
      })
      const service: AgentCapabilityService = Object.freeze({
        ...callable,
        isReady: () => ready,
        execute,
        health,
      })
      context.registerService(AgentCapability, service)

      return {
        async ready() {
          await options.runtime.start?.(context.signal)
          context.signal.throwIfAborted()
          ready = true
        },
        async health() {
          return health()
        },
        async suspend() {
          ready = false
          await options.runtime.suspend?.()
        },
        async dispose() {
          ready = false
          await options.runtime.dispose?.()
        },
      }
    },
  })
}
