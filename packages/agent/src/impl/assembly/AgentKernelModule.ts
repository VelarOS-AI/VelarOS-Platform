import { isEmpty, isPlainObject } from '@velaros-ai/core'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type KernelModuleHealth,
  type ScopeRef,
} from '@velaros-ai/kernel/contracts/abi'

/**
 * Product-owned Agent runtime injected at composition time.
 *
 * The Kernel adapter deliberately treats execution input and output as opaque.
 * Agent session, prompt, tool, and capability semantics remain owned by
 * Agent 运行时及其宿主装配，而不是 Kernel 契约。
 *
 * Two-tier registration boundary: this adapter is tier one and never parses a
 * domain manifest. Hosts pass the Kernel pack listing to the tier-two Agent
 * loader through `assembleAgentMods` (see `mods/AgentModHostAssembly.ts`) and
 * inject the assembled runtime here, so the Kernel keeps seeing only the narrow
 * module descriptor.
 */
export interface AgentCapabilityRuntime {
  start?(signal: AbortSignal): void | Promise<void>
  execute(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    context: AgentCapabilityExecutionContext,
  ): unknown | Promise<unknown>
  health?(): KernelModuleHealth | Promise<KernelModuleHealth>
  suspend?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

/**
 * Narrow execution context exposed to the injected Agent runtime.
 *
 * Products publish execution progress through this module-attributed event
 * bridge and never receive the Kernel host or its registries.
 */
export interface AgentCapabilityExecutionContext {
  readonly signal: AbortSignal
  publish<TPayload>(type: string, payload: TPayload): Promise<void>
}

export interface AgentCapabilityService
  extends KernelCallableCapabilityService {
  isReady(): boolean
  execute(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown>
  health(): Promise<KernelModuleHealth>
}

export interface CreateAgentKernelModuleOptions {
  /** Agent implementation assembled by a product host. */
  readonly runtime: AgentCapabilityRuntime
}

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
