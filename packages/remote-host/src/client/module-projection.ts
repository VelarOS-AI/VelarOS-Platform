// 域:把 Node 清单投影成本机 Kernel 认得的模块面与 Agent 主干认得的工具面。
//
// ## 命名空间是硬性要求,不是审美
// Mac 本机已经有 `velaros.system` 这样的模块与能力;一个 Kernel 里 module id 与 capability id
// 都必须唯一。远端来的同名 provider 直接注册会与本地实现撞车,而 Kernel 只会报「重复能力」,
// 不会告诉你撞的是哪台机器。所以本文件把远端 id 一律改写成 `velaros.remote.<hostSlug>.<尾段>`。
//
// ## 改写只在本机发生
// wire 上永远走 Node 侧原名(remote-node 契约已判决)。因此每条投影都带着 remote 原名,
// `invoke` 时按 binding 换回去。丢掉这层映射就等于把调用发到一个 Node 不认识的能力上。
import { createHash } from 'node:crypto'

import { isNonBlankString, isPresent, isUndefined } from '@velaros-ai/core'
import {
  createCapabilityToken,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel'
import type {
  RemoteNodeManifest,
  RemoteNodeOperationDescriptor,
} from '@velaros-ai/kernel/contracts/protocol'

/** 本机 Kernel 的 API 轴;远端代理模块与宿主同轴,不另立版本。 */
export const RemoteNodeModuleApiVersion = 1

/**
 * 代理模块自身的版本。
 *
 * 固定值:代理模块是**客户端产物**,它的版本轴属于本包而不是 Node。Node 的真实版本骑在
 * capability token 的 version 上,清单一变就整体重投影。
 */
export const RemoteNodeModuleVersion = '1.0.0'

const RemoteIdPrefix = 'velaros.remote'
const LocalIdPrefix = 'velaros.'

/** 一条能力的本地名 ↔ 远端原名映射,外加该能力的操作与权限声明。 */
export interface RemoteNodeCapabilityBinding {
  readonly localModuleId: string
  readonly localCapabilityId: string
  readonly remoteModuleId: string
  readonly remoteCapabilityId: string
  readonly version: string
  readonly operations: readonly RemoteNodeOperationDescriptor[]
}

/**
 * 命名空间化后的工具描述符。
 *
 * `name` 形如 `<hostSlug>:<toolName>`:模型看得见是哪台机器在干活,同名工具也不会在目录里打架。
 * `capabilityId` 是**本地**能力 id——工具调用要经本机 Kernel 的权限闸,不能拿原名直连 socket。
 */
export interface RemoteNodeToolProjection {
  readonly name: string
  readonly remoteName: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly category: Nullable<string>
  readonly readOnly: boolean
  readonly capabilityId: string
  readonly remoteCapabilityId: string
  readonly operation: string
}

/**
 * 一次清单投影的完整产物。
 *
 * `resolveBinding` / `resolveTool` 都是闭包而非方法:装配方会把它们摘下来单独传给
 * isolation adapter,带 `this` 的方法在那里会当场失灵。
 */
export interface RemoteNodeProjection {
  readonly hostName: string
  readonly hostSlug: string
  readonly revision: string
  readonly modules: readonly KernelModuleDefinition[]
  readonly capabilities: readonly RemoteNodeCapabilityBinding[]
  readonly tools: readonly RemoteNodeToolProjection[]
  readonly resolveBinding: (
    localCapabilityId: string,
  ) => LooseOptional<RemoteNodeCapabilityBinding>
  readonly resolveTool: (
    toolName: string,
  ) => LooseOptional<RemoteNodeToolProjection>
}

export interface RemoteNodeProjectionInput {
  /** 用户给这台机器起的名字;只用来生成 slug 与展示,不参与鉴权。 */
  readonly hostName: string
  readonly manifest: RemoteNodeManifest
}

/**
 * 把人给的主机名收敛成 `[a-z0-9-]+`。
 *
 * 全非 ASCII 的名字(中文主机名很常见)归一化后会空掉,这时用名字摘要兜底而不是报错:
 * id 需要的是唯一与稳定,不是可读——可读性由 `hostName` 自己承担。
 */
export function slugifyRemoteHostName(hostName: string): string {
  const slug = hostName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  if (isNonBlankString(slug)) return slug
  return `host-${createHash('sha256').update(hostName).digest('hex').slice(0, 8)}`
}

/** 远端 id 的本地化:`velaros.system` → `velaros.remote.<slug>.system`。 */
export function namespaceRemoteId(hostSlug: string, remoteId: string): string {
  const tail = remoteId.startsWith(LocalIdPrefix)
    ? remoteId.slice(LocalIdPrefix.length)
    : remoteId
  return `${RemoteIdPrefix}.${hostSlug}.${tail}`
}

export function namespaceRemoteToolName(
  hostSlug: string,
  toolName: string,
): string {
  return `${hostSlug}:${toolName}`
}

/**
 * 投影一份清单。
 *
 * 清单每次变更都应整份重投影再重注册:`createKernelCallableCapability` 建的是**闭合**操作表,
 * 就地改不了——这也是我们要的,能力面变化必须走一次显式的注册周期。
 */
export function createRemoteNodeProjection(
  input: RemoteNodeProjectionInput,
): RemoteNodeProjection {
  const hostSlug = slugifyRemoteHostName(input.hostName)
  const bindings = input.manifest.capabilities.map((capability) => ({
    localCapabilityId: namespaceRemoteId(hostSlug, capability.capabilityId),
    localModuleId: namespaceRemoteId(hostSlug, capability.moduleId),
    operations: capability.operations,
    remoteCapabilityId: capability.capabilityId,
    remoteModuleId: capability.moduleId,
    version: capability.version,
  } satisfies RemoteNodeCapabilityBinding))

  const byLocalCapability = new Map(
    bindings.map((binding) => [binding.localCapabilityId, binding]),
  )
  const byRemoteCapability = new Map(
    bindings.map((binding) => [binding.remoteCapabilityId, binding]),
  )

  const tools = input.manifest.tools.flatMap((tool) => {
    const binding = byRemoteCapability.get(tool.capabilityId)
    if (isUndefined(binding)) return []
    return [{
      capabilityId: binding.localCapabilityId,
      category: tool.category,
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: namespaceRemoteToolName(hostSlug, tool.name),
      operation: tool.operation,
      readOnly: tool.readOnly,
      remoteCapabilityId: binding.remoteCapabilityId,
      remoteName: tool.name,
    } satisfies RemoteNodeToolProjection]
  })
  const byToolName = new Map(tools.map((tool) => [tool.name, tool]))

  return {
    capabilities: bindings,
    hostName: input.hostName,
    hostSlug,
    modules: buildModules(bindings),
    resolveBinding: (localCapabilityId) =>
      byLocalCapability.get(localCapabilityId),
    resolveTool: (toolName) => byToolName.get(toolName),
    revision: input.manifest.revision,
    tools,
  }
}

/**
 * 按远端 moduleId 聚簇建代理模块。
 *
 * Node 侧一个模块可以提供多个能力,聚簇保住这层归属:本机看到的模块拓扑与远端一致,
 * 停掉一个远端模块时本机也是整块下线,不会留下半张能力面。
 */
function buildModules(
  bindings: readonly RemoteNodeCapabilityBinding[],
): readonly KernelModuleDefinition[] {
  const grouped = new Map<string, RemoteNodeCapabilityBinding[]>()
  for (const binding of bindings) {
    const bucket = grouped.get(binding.localModuleId)
    if (isPresent(bucket)) {
      bucket.push(binding)
      continue
    }
    grouped.set(binding.localModuleId, [binding])
  }

  return [...grouped].map(([localModuleId, members]) => ({
    manifest: {
      apiVersion: RemoteNodeModuleApiVersion,
      id: localModuleId,
      isolation: 'remote' as const,
      optionalRequires: [],
      // 模块级权限 = 其全部操作声明的并集,供 Kernel 做静态审计;逐次调用的判定仍走操作元数据。
      permissions: [...new Set(
        members.flatMap((binding) =>
          binding.operations.flatMap((operation) => operation.permissions)),
      )],
      provides: members.map((binding) =>
        createCapabilityToken(binding.localCapabilityId, binding.version)),
      requires: [],
      version: RemoteNodeModuleVersion,
    },
    // `isolation: 'remote'` 的模块由宿主注入的 adapter 激活,本函数永远不会被 Kernel 调到;
    // 真被调到说明装配漏了 adapter,此时炸掉比静默注册一张空能力面安全。
    activate: () => {
      throw new Error(
        `Remote module "${localModuleId}" must be activated by a remote isolation adapter`,
      )
    },
  } satisfies KernelModuleDefinition))
}
