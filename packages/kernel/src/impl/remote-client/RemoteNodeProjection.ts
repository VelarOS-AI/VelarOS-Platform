// Platform Kernel 统一持有与宿主无关的远程节点实现。
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

import { KernelModuleApiVersion } from '../../contract/constants'
import type { KernelModuleDefinition } from '../../contract/requires'
import type {
  RemoteNodeCapabilityBinding,
  RemoteNodeProjectionInput,
  RemoteNodeToolProjection,
} from '../../types/remote'
import type { RemoteNodeManifest } from '../../utils/wire/remote-node'
import { createCapabilityToken } from '../runtime/KernelModuleKit'

/**
 * 本机 Kernel 的 API 轴;远端代理模块与宿主同轴,不另立版本。
 *
 * 必须**引用**宿主那份常量而不是另抄一个字面量：抄一份的后果是模块 API 版本升到 2 时,
 * 所有远端代理模块注册即报 `API_VERSION_MISMATCH`,而两处写的都是「同轴」。
 */
export const RemoteNodeModuleApiVersion: typeof KernelModuleApiVersion = KernelModuleApiVersion

/**
 * 代理模块自身的版本。
 *
 * 固定值:代理模块是**客户端产物**,它的版本轴属于本包而不是 Node。Node 的真实版本骑在
 * capability token 的 version 上,清单一变就整体重投影。
 */
export const RemoteNodeModuleVersion: string = '1.0.0'

/**
 * 一次清单投影的完整产物。
 *
 * 一份清单一个实例:清单每次变更都整份重投影再重注册,实例本身是只读快照,不就地改。
 * `resolveBinding` / `resolveTool` 是**字段而非方法**:装配方会把它们摘下来单独传给
 * isolation adapter,带 `this` 的方法在那里会当场失灵。
 */
export interface RemoteNodeProjectionApi {
  /** 用户给这台机器起的名字,原样保留,只用于展示。 */
  readonly hostName: string
  /** 由主机名收敛出的 `[a-z0-9-]+` 标识;本机 id 与工具名的前缀都用它。 */
  readonly hostSlug: string
  /** 被投影那份清单的修订号;调用帧带着它做新鲜度判定。 */
  readonly revision: string
  /** 可直接注册进 Kernel 的代理模块定义,按远端 moduleId 聚簇。 */
  readonly modules: readonly KernelModuleDefinition[]
  /** 本地名 ↔ 远端原名的能力映射表。 */
  readonly capabilities: readonly RemoteNodeCapabilityBinding[]
  /** 交给 Agent 主干注册的工具面,名字已带主机前缀。 */
  readonly tools: readonly RemoteNodeToolProjection[]
  /** 按本机能力 id 找绑定;清单里没有这条能力时返回 undefined。 */
  readonly resolveBinding: (
    localCapabilityId: string,
  ) => LooseOptional<RemoteNodeCapabilityBinding>
  /** 按工具名找投影;不在本次清单里时返回 undefined。 */
  readonly resolveTool: (
    toolName: string,
  ) => LooseOptional<RemoteNodeToolProjection>
}

/**
 * 一份远端清单在本机的投影。
 *
 * 构造即定型:能力绑定、代理模块与工具面在构造函数里一次算完,之后只读。清单变更时整份重建,
 * 不提供任何就地修改的口子——`createKernelCallableCapability` 建的是**闭合**操作表,改不了,
 * 这也是我们要的:能力面变化必须走一次显式的注册周期。
 */
export class RemoteNodeProjection implements RemoteNodeProjectionApi {
  public readonly hostName: string
  public readonly hostSlug: string
  public readonly revision: string
  public readonly capabilities: readonly RemoteNodeCapabilityBinding[]
  public readonly tools: readonly RemoteNodeToolProjection[]
  public readonly modules: readonly KernelModuleDefinition[]

  private readonly byLocalCapability: ReadonlyMap<string, RemoteNodeCapabilityBinding>
  private readonly byToolName: ReadonlyMap<string, RemoteNodeToolProjection>

  public constructor(input: RemoteNodeProjectionInput) {
    this.hostName = input.hostName
    this.hostSlug = slugifyRemoteHostName(input.hostName)
    this.revision = input.manifest.revision
    this.capabilities = this.buildBindings(input.manifest)
    this.byLocalCapability = new Map(
      this.capabilities.map((binding) => [binding.localCapabilityId, binding]),
    )
    this.tools = this.buildTools(input.manifest)
    this.byToolName = new Map(this.tools.map((tool) => [tool.name, tool]))
    this.modules = this.buildModules()
  }

  public readonly resolveBinding = (
    localCapabilityId: string,
  ): LooseOptional<RemoteNodeCapabilityBinding> =>
    this.byLocalCapability.get(localCapabilityId)

  public readonly resolveTool = (
    toolName: string,
  ): LooseOptional<RemoteNodeToolProjection> => this.byToolName.get(toolName)

  /** 清单里的每条能力换成一条本地 ↔ 远端绑定;操作表原样带过来,权限位由它承载。 */
  private buildBindings(
    manifest: RemoteNodeManifest,
  ): readonly RemoteNodeCapabilityBinding[] {
    return manifest.capabilities.map((capability) => ({
      localCapabilityId: namespaceRemoteId(this.hostSlug, capability.capabilityId),
      localModuleId: namespaceRemoteId(this.hostSlug, capability.moduleId),
      operations: capability.operations,
      remoteCapabilityId: capability.capabilityId,
      remoteModuleId: capability.moduleId,
      version: capability.version,
    } satisfies RemoteNodeCapabilityBinding))
  }

  /** 工具面按能力绑定过滤:清单里挂在未知能力上的工具直接丢掉,不做一张调不通的目录。 */
  private buildTools(
    manifest: RemoteNodeManifest,
  ): readonly RemoteNodeToolProjection[] {
    const byRemoteCapability = new Map(
      this.capabilities.map((binding) => [binding.remoteCapabilityId, binding]),
    )
    return manifest.tools.flatMap((tool) => {
      const binding = byRemoteCapability.get(tool.capabilityId)
      if (isUndefined(binding)) return []
      return [{
        capabilityId: binding.localCapabilityId,
        category: tool.category,
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: namespaceRemoteToolName(this.hostSlug, tool.name),
        operation: tool.operation,
        readOnly: tool.readOnly,
        remoteCapabilityId: binding.remoteCapabilityId,
        remoteName: tool.name,
      } satisfies RemoteNodeToolProjection]
    })
  }

  /**
   * 按远端 moduleId 聚簇建代理模块。
   *
   * Node 侧一个模块可以提供多个能力,聚簇保住这层归属:本机看到的模块拓扑与远端一致,
   * 停掉一个远端模块时本机也是整块下线,不会留下半张能力面。
   */
  private buildModules(): readonly KernelModuleDefinition[] {
    const grouped = new Map<string, RemoteNodeCapabilityBinding[]>()
    for (const binding of this.capabilities) {
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
          `远程模块 "${localModuleId}" 必须由远程隔离适配器来激活`,
        )
      },
    } satisfies KernelModuleDefinition))
  }
}

/**
 * 把人给的主机名收敛成 `[a-z0-9-]+`。
 *
 * 全非 ASCII 的名字(中文主机名很常见)归一化后会空掉,这时用名字摘要兜底而不是报错:
 * id 需要的是唯一与稳定,不是可读——可读性由 `hostName` 自己承担。
 */
export function slugifyRemoteHostName(hostName: string): string {
  const replaced = hostName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
  let start = 0
  let end = replaced.length
  while (replaced[start] === '-') start += 1
  while (end > start && replaced[end - 1] === '-') end -= 1
  const slug = replaced.slice(start, end)
  if (isNonBlankString(slug)) return slug
  return `host-${createHash('sha256').update(hostName).digest('hex').slice(0, 8)}`
}

/** 远端 id 的本地化:`velaros.system` → `velaros.remote.<slug>.system`。 */
export function namespaceRemoteId(hostSlug: string, remoteId: string): string {
  const tail = remoteId.startsWith('velaros.')
    ? remoteId.slice('velaros.'.length)
    : remoteId
  return `velaros.remote.${hostSlug}.${tail}`
}

/** 工具名的本地化:`<hostSlug>:<toolName>`,模型看得见是哪台机器在干活。 */
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
): RemoteNodeProjectionApi {
  return new RemoteNodeProjection(input)
}
