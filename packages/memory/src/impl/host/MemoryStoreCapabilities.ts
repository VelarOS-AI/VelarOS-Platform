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
 *
 * 逻辑本身用不到实例状态，按标准放在 `utils/store-capabilities.ts`；这里只把它收口成一个实例。
 */

import type { KernelModuleDefinition } from '@velaros-ai/kernel'
import type { CapabilityToken } from '@velaros-ai/kernel/contracts'

import type {
  CreateMemoryStoreKernelModuleOptions,
  MemoryStoreBackend,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  ResolveMemoryStoreBackendInput,
} from '../../contract/requires'
import type { MemoryBackendDescriptor } from '../../types/memory'
import {
  createMemoryStoreCapabilityToken,
  createMemoryStoreKernelModule,
  listRegisteredMemoryStoreBackends,
  memoryStoreCapabilityId,
  resolveMemoryDerivedIndexBackends,
  resolveMemoryStoreBackend,
} from '../../utils/store-capabilities'

/**
 * 记忆后端的注册与解析面：铸令牌、包内核模块、按优先序解析权威层与派生索引、枚举在册后端。
 *
 * 工具函数不出包，宿主拿到的是这一个整件能力。整个进程共用 `memoryStoreCapabilities` 这一份。
 */
export interface MemoryStoreCapabilitiesApi {
  /** 一个后端的能力 id。 */
  capabilityId(backendId: string): string
  /** 为一个后端档铸能力令牌；同 id 同 version 铸出的令牌可互换解析。 */
  token(backendId: string, version?: string): CapabilityToken<MemoryStoreCapabilityService>
  /** 把一个后端包成可注册进内核的模块。 */
  createKernelModule(options: CreateMemoryStoreKernelModuleOptions): KernelModuleDefinition
  /** 按优先序解析权威层后端；一个都没注册时返回 undefined。 */
  resolveAuthority(input: ResolveMemoryStoreBackendInput): MemoryStoreBackend | undefined
  /** 解析已注册的派生索引后端（叠加编排的第二层）。 */
  resolveDerivedIndexes(
    registry: MemoryStoreCapabilityRegistry,
    backendIds: readonly string[],
    capabilityVersion?: string,
  ): readonly MemoryStoreBackend[]
  /** 枚举在册后端的自述，供宿主诊断面使用。 */
  listRegistered(
    registry: MemoryStoreCapabilityRegistry,
    backendIds: readonly string[],
    capabilityVersion?: string,
  ): readonly MemoryBackendDescriptor[]
}

/** 记忆后端注册与解析面的对外实例实现。 */
export class MemoryStoreCapabilities implements MemoryStoreCapabilitiesApi {
  public capabilityId(backendId: string): string {
    return memoryStoreCapabilityId(backendId)
  }

  public token(backendId: string, version?: string): CapabilityToken<MemoryStoreCapabilityService> {
    return createMemoryStoreCapabilityToken(backendId, version)
  }

  public createKernelModule(options: CreateMemoryStoreKernelModuleOptions): KernelModuleDefinition {
    return createMemoryStoreKernelModule(options)
  }

  public resolveAuthority(input: ResolveMemoryStoreBackendInput): MemoryStoreBackend | undefined {
    return resolveMemoryStoreBackend(input)
  }

  public resolveDerivedIndexes(
    registry: MemoryStoreCapabilityRegistry,
    backendIds: readonly string[],
    capabilityVersion?: string,
  ): readonly MemoryStoreBackend[] {
    return resolveMemoryDerivedIndexBackends(registry, backendIds, capabilityVersion)
  }

  public listRegistered(
    registry: MemoryStoreCapabilityRegistry,
    backendIds: readonly string[],
    capabilityVersion?: string,
  ): readonly MemoryBackendDescriptor[] {
    return listRegisteredMemoryStoreBackends(registry, backendIds, capabilityVersion)
  }
}

/** 整个进程共用的后端注册与解析实例。 */
export const memoryStoreCapabilities: MemoryStoreCapabilitiesApi = new MemoryStoreCapabilities()
