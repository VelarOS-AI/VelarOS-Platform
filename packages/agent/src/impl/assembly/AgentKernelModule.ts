import type { KernelModuleActivateContext, KernelModuleDefinition, KernelModuleLifecycle } from '@velaros-ai/kernel'
import { kernelModules } from '@velaros-ai/kernel'
import type { CapabilityToken, KernelModuleHealth, KernelModuleManifest, ScopeRef } from '@velaros-ai/kernel/contracts'
import { KernelVersionAxes } from '@velaros-ai/kernel/contracts'

import { AgentIdentity } from '../../contract/constants.js'
import type { CreateAgentKernelModuleOptions } from '../../contract/requires.js'
import type { AgentCapabilityExecutionContext, AgentCapabilityService } from '../../types/execution.js'
import { parseEmptyInput } from '../../utils/execution/kernel-capability'

/** Stable identity for an independently injected Agent execution capability. */
export const AgentCapability: CapabilityToken<AgentCapabilityService> =
  kernelModules.token<AgentCapabilityService>(AgentIdentity.capabilityId)

/** Stable module identity used by host permission policies；等价于 `AgentIdentity.kernelModuleId`。 */
export const AgentKernelModuleId: string = AgentIdentity.kernelModuleId

/** Permission required to execute an Agent through the Kernel capability；等价于 `AgentIdentity.executionPermission`。 */
export const AgentExecutionPermission: string = AgentIdentity.executionPermission

/**
 * 把宿主注入的 Agent 运行时包成一个内核模块：清单声明身份、能力与权限，`activate` 登记能力服务并接上生命周期。
 *
 * `ready` 归启动，health / suspend / dispose 归生命周期；对外可调用面刻意只有不透明的执行与不敏感的健康查询。
 * 就绪状态存在实例上：`ready()` 之前任何执行与健康查询都按「没准备好」处理，`suspend` / `dispose` 会把它打回去。
 * 一个宿主建一个实例，建完把它本身当模块定义交给内核。
 */
export interface AgentKernelModuleApi extends KernelModuleDefinition {
  /** 模块清单：身份 `velaros.agent.runtime`、提供的能力令牌与要求的权限。内核按它做注册与权限投影，宿主不要改字段。 */
  readonly manifest: KernelModuleManifest
  /**
   * 内核激活本模块时调用一次：向 `context` 登记 Agent 能力服务，返回 ready / health / suspend / dispose 四个生命周期钩子。
   * 登记完成即返回，真正的运行时启动在 `ready()` 里发生。
   */
  activate(context: KernelModuleActivateContext): KernelModuleLifecycle
}

class AgentKernelModule implements AgentKernelModuleApi {
  public readonly manifest: KernelModuleManifest = {
    id: AgentKernelModuleId,
    version: '0.3.2',
    apiVersion: KernelVersionAxes.moduleApi,
    provides: [AgentCapability],
    requires: [],
    optionalRequires: [],
    permissions: [AgentExecutionPermission],
    isolation: 'in-process',
  }

  private ready = false

  public constructor(private readonly options: CreateAgentKernelModuleOptions) {}

  public activate(context: KernelModuleActivateContext): KernelModuleLifecycle {
    const callable = kernelModules.callable({
      health: {
        metadata: {
          permissions: [],
          reason: '查看注入进来的 Agent 运行时是否健康。',
        },
        invoke: async (_scope, input) => {
          parseEmptyInput(input)
          return this.health()
        },
      },
      execute: {
        metadata: {
          permissions: [AgentExecutionPermission],
          reason: '经注入进来的运行时执行一次 Agent 请求。',
        },
        invoke: async (scope, input, signal) => this.execute(context, scope, input, signal),
      },
    })
    const service: AgentCapabilityService = Object.freeze({
      ...callable,
      isReady: () => this.ready,
      execute: async (scope: LooseOptional<ScopeRef>, input: unknown, signal: AbortSignal) =>
        this.execute(context, scope, input, signal),
      health: async () => this.health(),
    })
    context.registerService(AgentCapability, service)

    return {
      ready: async () => {
        await this.options.runtime.start?.(context.signal)
        context.signal.throwIfAborted()
        this.ready = true
      },
      health: async () => this.health(),
      suspend: async () => {
        this.ready = false
        await this.options.runtime.suspend?.()
      },
      dispose: async () => {
        this.ready = false
        await this.options.runtime.dispose?.()
      },
    }
  }

  /** 健康查询：没 ready 之前一律 unknown，ready 之后转问注入的运行时；运行时不实现 health 就按 healthy 处理。 */
  private async health(): Promise<KernelModuleHealth> {
    if (!this.ready) return { status: 'unknown', message: 'Agent 运行时尚未就绪，健康状态还问不出来：模块要等生命周期走到 ready 之后才会转问注入的运行时。' }
    return this.options.runtime.health?.() ?? { status: 'healthy' }
  }

  /**
   * 执行面：先确认已就绪、再看中止信号，然后把请求原样交给注入的运行时。
   * 给运行时的执行上下文是冻结的，publish 每次发事件前都重新检查中止，避免中止后还往外发。
   */
  private async execute(
    context: KernelModuleActivateContext,
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.ready) throw new Error('Agent 能力尚未就绪，拒绝执行本次请求：请等模块生命周期走到 ready 之后再调用。')
    signal.throwIfAborted()
    const executionContext: AgentCapabilityExecutionContext = Object.freeze({
      signal,
      async publish<TPayload>(type: string, payload: TPayload) {
        signal.throwIfAborted()
        await context.events.publish(type, payload)
      },
    })
    return this.options.runtime.execute(scope, input, executionContext)
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
  return kernelModules.define(new AgentKernelModule(options))
}
