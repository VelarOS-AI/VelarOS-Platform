/**
 * 记忆后端的 capability token 族与 kernel 模块注册（kernel-contract §15.7 裁决二 / §九 9.3）。
 *
 * **不开第十根轴**：后端经 `velaros.memory.store.<backendId>` 这一族 capability token 注册与
 * 发现，走既有 mod 轴与 capability registry。为记忆开一根 `memoryBackends` 轴，下一个能力域
 * 就会照抄，五套并行扩展系统按域重新长回来。
 *
 * **为什么 token 住这里而不是主干**：token 是 mod 轴机制（`@velaros-ai/core/kernel/abi`），
 * 主干只该持有与实现无关的窄动词契约（`../backend/Contract`）。方向铁律 adapter-kernel → 主干
 * 单向也强制了这个落点——主干不得反向依赖适配器。同理它也不能住 core：
 * `packages/core/src/kernel/**` 有语义词汇硬墙，出现 `memory` 一词即红。
 *
 * **为什么一个后端一个 token 而不是一个共享 token**：`KernelServiceStore` 对同一 capability id
 * 只允许一个 active 服务（重复注册即 `DUPLICATE_SERVICE`）。三档要能**叠加**（§九 9.2 权威层
 * 恒在、派生层可摘），就必须各占一个 id；共享 id 会把叠加语义降级成三选一。
 *
 * **为什么是普通服务对象而不是 callable capability**：后端解析是记忆产品**进程内**的实现选择，
 * 消费者只有本适配器。对外那张需要审计与权限门的面仍然是 `velaros.memory`
 * （见 `./kernel-module`），一条没减。
 */

import {
  type CapabilityToken,
  createCapabilityToken,
  defineKernelModule,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'

import type { MemoryBackendDescriptor, MemoryStoreBackend } from '..'

/** token 族前缀。完整 id = `${MemoryStoreCapabilityNamespace}.${backendId}`。 */
export const MemoryStoreCapabilityNamespace = 'velaros.memory.store'

export const DefaultMemoryStoreCapabilityVersion = '1.0.0'

/** 注册进 kernel service registry 的服务形状：一层薄包装，便于将来加后端级元数据。 */
export interface MemoryStoreCapabilityService {
  readonly backend: MemoryStoreBackend
}

export function memoryStoreCapabilityId(backendId: string): string {
  const normalized = backendId.trim()
  if (normalized.length === 0) {
    throw new Error('Memory store backend id must not be empty')
  }
  return `${MemoryStoreCapabilityNamespace}.${normalized}`
}

/** 为一个后端档铸 token。同 id 同 version 铸出的 token 可互换解析。 */
export function createMemoryStoreCapabilityToken(
  backendId: string,
  version: string = DefaultMemoryStoreCapabilityVersion,
): CapabilityToken<MemoryStoreCapabilityService> {
  return createCapabilityToken<MemoryStoreCapabilityService>(
    memoryStoreCapabilityId(backendId),
    version,
  )
}

export interface CreateMemoryStoreKernelModuleOptions {
  readonly backend: MemoryStoreBackend
  /** 缺省 = capability id，保证同一后端档在两个注册表里同名可追。 */
  readonly moduleId?: string
  readonly moduleVersion?: string
  readonly capabilityVersion?: string
  readonly apiVersion?: number
}

/**
 * 把一个后端包成可注册进 `KernelModuleHost` 的 kernel 模块。
 *
 * bundled 默认档（`memory-files`）与当前已接线的树档都用这一个工厂——「默认已注册后端」和
 * 「市场装的后端」在注册路径上没有第二套机制，这正是 §九「零轴变更」要检验的东西。
 */
export function createMemoryStoreKernelModule(
  options: CreateMemoryStoreKernelModuleOptions,
): KernelModuleDefinition {
  const { backend } = options
  const token = createMemoryStoreCapabilityToken(
    backend.descriptor.id,
    options.capabilityVersion,
  )
  const service: MemoryStoreCapabilityService = Object.freeze({ backend })

  return defineKernelModule({
    manifest: {
      id: options.moduleId ?? token.id,
      version: options.moduleVersion ?? DefaultMemoryStoreCapabilityVersion,
      apiVersion: options.apiVersion ?? 1,
      provides: [token],
      requires: [],
      optionalRequires: [],
      permissions: ['memory:read', 'memory:write'],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(token, service)
    },
  })
}

/**
 * 解析后端所需的最窄注册表面。
 *
 * `KernelModuleHost` 结构上就满足它——适配器因此既不持有整个 host，也不需要为测试造一个假 host。
 */
export interface MemoryStoreCapabilityRegistry {
  getOptionalService<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined
}

export interface ResolveMemoryStoreBackendInput {
  readonly registry: MemoryStoreCapabilityRegistry
  /** 后端 id 优先序；首个已注册的胜出。 */
  readonly preference: readonly string[]
  readonly capabilityVersion?: string
}

/**
 * 按优先序解析后端。
 *
 * 一个都没注册时返回 `undefined`——这就是 partial activation 的「没装就没有」（§15.7 裁决二）：
 * 该轴缺席、诊断可见，不是残废降级，也不在这里编造一个空后端。
 */
export function resolveMemoryStoreBackend(
  input: ResolveMemoryStoreBackendInput,
): MemoryStoreBackend | undefined {
  for (const backendId of input.preference) {
    const token = createMemoryStoreCapabilityToken(backendId, input.capabilityVersion)
    const service = input.registry.getOptionalService(token)
    if (service?.backend) return service.backend
  }
  return undefined
}

/** 枚举已注册后端的自述，供宿主诊断面（「装了哪些记忆后端」）使用。 */
export function listRegisteredMemoryStoreBackends(
  registry: MemoryStoreCapabilityRegistry,
  backendIds: readonly string[],
  capabilityVersion?: string,
): readonly MemoryBackendDescriptor[] {
  const descriptors: MemoryBackendDescriptor[] = []
  for (const backendId of backendIds) {
    const token = createMemoryStoreCapabilityToken(backendId, capabilityVersion)
    const service = registry.getOptionalService(token)
    if (service?.backend) descriptors.push(service.backend.descriptor)
  }
  return descriptors
}
