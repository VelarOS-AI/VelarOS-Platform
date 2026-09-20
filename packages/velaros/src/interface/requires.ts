import type { ShellSpacePort, ShellOperationContext } from '../../shell/contract/requires.js'
import type { FoundationRunLimits } from '@velaros-ai/agent'
import type { ContextCompletionPort,ContextSourcePort, ContextStorage, ContextViewLimits } from '@velaros-ai/context'
import type { OperationContext, OperationDefinition, OperationModuleDefinition, OperationSurface } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'
import type { CodeRunnerApi } from '@velaros-ai/script'

/** 从领域方法的最后一个参数推导宿主上下文，使装配参数在编译期受原接口约束。 */
export type CapabilityContext<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer P) => unknown ? P extends [...infer _Args, infer C] ? C : never : never
}[keyof T]

/** 将已有领域操作接到统一 Kernel；模型合同由同一份领域接口生成。 */
export interface CapabilityModuleOptions<T extends object> {
  /** 领域随包发布的声明、schema、效果及示例。 */
  readonly surface: OperationSurface
  /** 已有领域操作实例，方法不重新实现。 */
  readonly implementation: T
  /** 宿主选择的稳定资源身份。 */
  readonly instanceId: string
  /** 资源重新绑定后的代际，默认 1。 */
  readonly generation?: number
  /** 发现卡片摘要，默认模块身份。 */
  readonly summary?: string
  /** 给每次真实调用注入领域上下文，可使用回执记录口。 */
  context(operation: OperationContext): CapabilityContext<T> | Promise<CapabilityContext<T>>
  /** 领域提供可验证的只读核对能力；省略时未知效果保持未决。 */
  readonly reconcile?: Readonly<Partial<Record<keyof T, OperationDefinition['reconcile']>>>
  /** 某些能力在观察模式下的受限实现，例如使用受限进程的命令执行。 */
  readonly observation?: Readonly<Partial<Record<keyof T, OperationDefinition['run']>>>
  /** 挂载资源的激活。 */
  activate?(): void | Promise<void>
  /** 挂载资源的释放。 */
  dispose?(): void | Promise<void>
}

/** 宿主只选择实例资源，公共机制由 Velaros 统一装配。 */
/** 任务事实与只读证据源的配置，宿主装配领域只读源。 */
export interface VelarosContextOptions {
  /** 各领域负责实际读取与空间边界。 */
  readonly sources: readonly ContextSourcePort[]
  /** 共享任务预算与证据上限。 */
  readonly limits?: Partial<ContextViewLimits>
  /** 领域完成验证；省略时明确标为未验证。 */
  readonly completion?: ContextCompletionPort
}

/** 正式 Runtime 的单一装配入口。 */
export interface VelarosRuntimeOptions {
  /** 任务事实与领域适配器；省略时使用用户目标、脚本观察和执行材料。 */
  readonly context?: VelarosContextOptions
  /** 可靠存储；运行时关闭时释放，多个运行时使用独立连接。 */
  readonly storage: ContextStorage
  /** 显式注入隔离执行器。 */
  readonly runner: CodeRunnerApi
  /** 宿主挂载的领域模块；标准模块由运行时提供。 */
  readonly modules: readonly OperationModuleDefinition[]
  /** 使用共享驱动接入模型；纯脚本宿主可以不给。 */
  readonly model?: ModelDriver
  /** 覆盖明确的回合和上下文预算。 */
  readonly limits?: FoundationRunLimits
}

/** 在同一 Kernel 注册 Shell 的正常执行及受限观察实现。 */
export interface ShellCapabilityModuleOptions {
  /** 宿主资源身份。 */
  readonly instanceId:string
  /** 同一空间的命令能力，观察时必须实现 runObservationCommand。 */
  readonly shell:ShellSpacePort
  /** 一次性危险操作仍使用现有审批端口。 */
  readonly approval:ShellOperationContext['approval']
}
