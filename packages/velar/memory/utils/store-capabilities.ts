/**
 * 记忆后端能力令牌族的纯逻辑：拼能力 id、铸令牌、包内核模块、按优先序解析权威层与派生索引、
 * 枚举在册后端。这些都用不到实例状态，按标准放在 utils，由 `impl/host/MemoryStoreCapabilities.ts`
 * 的实例收口出去。
 */

import { isEmpty } from '@velaros-ai/core'
import type { KernelModuleDefinition } from '@velaros-ai/kernel'
import { kernelModules } from '@velaros-ai/kernel'
import type { CapabilityToken } from '@velaros-ai/kernel/contracts'
import { KernelVersionAxes } from '@velaros-ai/kernel/contracts'

import { MemoryStoreCapabilityIdentity } from '../contract/constants.js'
import type {
  CreateMemoryStoreKernelModuleOptions,
  MemoryStoreBackend,
  MemoryStoreCapabilityRegistry,
  MemoryStoreCapabilityService,
  ResolveMemoryStoreBackendInput,
} from '../contract/requires.js'
import type { MemoryBackendDescriptor } from '../types/memory.js'

import { listMissingAuthorityMemoryVerbs } from './backends.js'

/** 一个后端的能力 id：`velaros.memory.store.<后端 id>`；后端 id 为空时当场判错。 */
export function memoryStoreCapabilityId(backendId: string): string {
  const normalized = backendId.trim()
  if (isEmpty(normalized)) {
    throw new Error('记忆后端 id 不能为空：能力令牌要用它拼 id。')
  }
  return `${MemoryStoreCapabilityIdentity.namespace}.${normalized}`
}

/** 为一个后端档铸 token。同 id 同 version 铸出的 token 可互换解析。 */
export function createMemoryStoreCapabilityToken(
  backendId: string,
  version: string = MemoryStoreCapabilityIdentity.defaultVersion,
): CapabilityToken<MemoryStoreCapabilityService> {
  return kernelModules.token<MemoryStoreCapabilityService>(
    memoryStoreCapabilityId(backendId),
    version,
  )
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

  return kernelModules.define({
    manifest: {
      id: options.moduleId ?? token.id,
      version: options.moduleVersion ?? MemoryStoreCapabilityIdentity.defaultVersion,
      apiVersion: options.apiVersion ?? KernelVersionAxes.moduleApi,
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
