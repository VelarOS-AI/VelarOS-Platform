/**
 * 记忆后端能力令牌族与内核模块注册，对应内核契约 §15.7 裁决二和第九章 9.3。
 *
 * 后端通过 `velaros.memory.store.<backendId>` 这一族能力令牌注册和发现，复用既有模组轴与能力
 * 登记处，不为记忆另建扩展轴。令牌属于内核应用二进制接口机制，因此放在适配层；主干只持有
 * 与实现无关的窄动词契约，并保持适配层到主干的单向依赖。
 *
 * 每个后端使用独立令牌，因为 `KernelServiceStore` 对同一能力标识只允许一个活动服务。独立标识
 * 使权威层与可拆卸派生层能够叠加，而不会退化为三选一。后端解析是进程内实现选择，所以注册为
 * 普通服务对象；面向外部且需要审计与权限门的能力仍由 `velaros.memory` 提供。
 */

import { isEmpty } from '@velaros-ai/core'
import {
  type CapabilityToken,
  createCapabilityToken,
  defineKernelModule,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel/contracts/abi'

// 值导入指向具体模块（见 EvidenceBridge 同款注释：`from '..'` 在 dist 里是目录 import）。
import { listMissingAuthorityMemoryVerbs } from '../backend/Contract'
import type { MemoryBackendDescriptor, MemoryStoreBackend } from '../index'

/** token 族前缀。完整 id = `${MemoryStoreCapabilityNamespace}.${backendId}`。 */
export const MemoryStoreCapabilityNamespace = 'velaros.memory.store'

export const DefaultMemoryStoreCapabilityVersion = '1.0.0'

/** 注册进 kernel service registry 的服务形状：一层薄包装，便于将来加后端级元数据。 */
export interface MemoryStoreCapabilityService {
  readonly backend: MemoryStoreBackend
}

export function memoryStoreCapabilityId(backendId: string): string {
  const normalized = backendId.trim()
  if (isEmpty(normalized)) {
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
      apiVersion: options.apiVersion ?? KernelModuleApiVersion,
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
 * 按优先序解析**权威层**后端。
 *
 * 一个都没注册时返回 `undefined`——这就是 partial activation 的「没装就没有」（§15.7 裁决二）：
 * 该轴缺席、诊断可见，不是残废降级，也不在这里编造一个空后端。
 *
 * **角色门**：`derived-index` 角色的后端一律跳过，哪怕优先序里点名了它。派生索引不持
 * 内容（§九 9.2），被当成权威层用 = 用户以为记忆写进去了、其实什么都没存。这条门让
 * 「只装了 vector 没装 files」退化成「没有权威层 → 缺席」，而不是退化成静默丢数据。
 * 派生索引的正当入口是 {@link resolveMemoryDerivedIndexBackends} + 叠加编排。
 *
 * **必备动词门**：缺 `capture / recall / inspect / archive` 任一的后端一律跳过。半个权威层的
 * 症状（写得进读不出 / 归档按钮按下去没反应）会被当成产品 bug 追很久，而根因只是这个档
 * 没实现全。跳过让它退化成「这一档没装」，与角色门同一种失败方向。
 */
export function resolveMemoryStoreBackend(
  input: ResolveMemoryStoreBackendInput,
): MemoryStoreBackend | undefined {
  for (const backendId of input.preference) {
    const token = createMemoryStoreCapabilityToken(backendId, input.capabilityVersion)
    const backend = input.registry.getOptionalService(token)?.backend
    if (!backend || backend.descriptor.role === 'derived-index') continue
    if (!isEmpty(listMissingAuthorityMemoryVerbs(backend))) continue
    return backend
  }
  return undefined
}

/**
 * 解析已注册的**派生索引**后端（叠加编排的第二层，§九 9.2）。
 *
 * 与权威解析是两个函数而不是一个带 role 参数的函数：权威层是**单选**（谁是真相），派生层是
 * **多选且可空**（装了几个加速器）。把两种基数塞进一个函数只会让调用点每次都要判断返回的是
 * 哪一种。
 */
export function resolveMemoryDerivedIndexBackends(
  registry: MemoryStoreCapabilityRegistry,
  backendIds: readonly string[],
  capabilityVersion?: string,
): readonly MemoryStoreBackend[] {
  const backends: MemoryStoreBackend[] = []
  for (const backendId of backendIds) {
    const token = createMemoryStoreCapabilityToken(backendId, capabilityVersion)
    const service = registry.getOptionalService(token)
    if (service?.backend && service.backend.descriptor.role === 'derived-index') {
      backends.push(service.backend)
    }
  }
  return backends
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
