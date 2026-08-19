import { createHash, randomUUID } from 'node:crypto'

import {
  ToolCatalogDiscoveryToolName,
  ToolSchemaDiscoveryToolName,
} from '@velaros-ai/agent/protocol'
import { schemaToInputSchema } from '@velaros-ai/agent/tool-contract'
import { ComputerCapability } from '@velaros-ai/computer/runtime'
import { computerTools } from '@velaros-ai/computer/tools'
import {
  isBlank,
  isEmpty,
  isNull,
  isPresent,
  isString,
  toOptional,
} from '@velaros-ai/core'
import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'
import {
  type CapabilitySession,
  type KernelClient,
  KernelProtocolVersion,
} from '@velaros-ai/kernel/client'
import type {
  CapabilityCallResponse,
  ScopeRef,
} from '@velaros-ai/kernel/contracts/protocol'
import { OfficeCapability } from '@velaros-ai/office/composition'
import type { OfficeToolContext } from '@velaros-ai/office/contracts'
import { officeTools } from '@velaros-ai/office/tools'
import { projectTools } from '@velaros-ai/project/agent'
import {
  ProjectToolNames,
} from '@velaros-ai/project/contracts'
import {
  ProjectCapability,
} from '@velaros-ai/project/kernel'
import {
  type ProviderSurfaceArtifact,
  ProviderSurfaceProtocolVersion,
  type ProviderSurfaceToolCall,
  ProviderSurfaceToolCallSchema,
  type ProviderSurfaceToolCatalog,
  type ProviderSurfaceToolDescriptor,
  type ProviderSurfaceToolResult,
  type ProviderSurfaceWorkspaceSpace,
} from '@velaros-ai/surface-protocol'
import {
  SystemCapability,
  SystemToolCategoryByName,
  SystemToolNames,
  systemTools,
} from '@velaros-ai/system'

import type { VelarHostConfigStore } from './config'

const ProjectReadOperations = Object.freeze([
  ProjectToolNames.read,
  ProjectToolNames.list,
  ProjectToolNames.search,
])

const ProjectWriteOperations = Object.freeze([
  ProjectToolNames.write,
  ProjectToolNames.edit,
  ProjectToolNames.rollback,
])
const ProjectExecuteOperations = Object.freeze([ProjectToolNames.run])

const SystemObserveOperations = new Set<string>([
  SystemToolNames.processes,
  SystemToolNames.listTasks,
])
const SystemReadOperations = new Set<string>([
  SystemToolNames.read,
  SystemToolNames.list,
  SystemToolNames.search,
])
const SystemWriteOperations = new Set<string>([SystemToolNames.write, SystemToolNames.edit])
const SystemExecuteOperations = new Set<string>([
  SystemToolNames.run,
  SystemToolNames.open,
  SystemToolNames.refreshEnvironment,
  SystemToolNames.terminateTask,
])

const ComputerOperationByToolName = Object.freeze({
  'computer:screenshot': 'screenshot',
  'computer:screen_size': 'screen_size',
  'computer:move': 'mouse_move',
  'computer:click': 'left_click',
  'computer:type': 'type_text',
  'computer:key': 'key',
})

const ComputerObserveToolNames = new Set([
  'computer:screenshot',
  'computer:screen_size',
])
const ComputerControlToolNames = new Set([
  'computer:move',
  'computer:click',
  'computer:type',
  'computer:key',
])

/**
 * Computer 各能力操作声明的权限位。
 *
 * 这是 `velaros.computer.sidecar` 模块内联声明的镜像——那张表没有导出口，而工具自带的权限
 * 只有屏幕与输入两位，漏掉了辅助进程必需的 `process:exec`。远端调用方是逐权限判定的，
 * 少报一位就会按不足的权限面放行。其余三个能力包的操作权限就是工具自带的那份，无需镜像。
 */
const ComputerOperationPermissions: ReadonlyMap<string, readonly string[]> = new Map([
  ['screen_size', ['process:exec', 'screen:capture']],
  ['screenshot', ['process:exec', 'screen:capture']],
  ['mouse_move', ['process:exec', 'input:control']],
  ['left_click', ['process:exec', 'input:control']],
  ['type_text', ['process:exec', 'input:control']],
  ['key', ['process:exec', 'input:control']],
])

/** 一条工具路由的对外投影；`permissions` 是该操作在 Kernel 侧声明的权限位。 */
export interface VelarHostToolRoute {
  readonly descriptor: ProviderSurfaceToolDescriptor
  readonly capabilityId: string
  readonly operation: string
  readonly permissions: readonly string[]
}

/** 绕过工具目录、直接落到 Kernel 能力面的一次调用。 */
export interface VelarHostCapabilityCall {
  readonly capabilityId: string
  readonly operation: string
  readonly scope: Nullable<ScopeRef>
  readonly input: unknown
}

interface ToolRoute extends VelarHostToolRoute {
  readonly isAvailable?: () => boolean
}

export type VelarHostOfficeToolContextFactory = () => OfficeToolContext

function compactDescription(description: string): string {
  const compact = description.replace(/\s+/gu, ' ').trim()
  return compact.length <= 320 ? compact : `${compact.slice(0, 317)}...`
}

function discoveryTools(): readonly ProviderSurfaceToolDescriptor[] {
  return [
    {
      name: ToolCatalogDiscoveryToolName,
      description: 'Return the current complete Velar Host tool catalog.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      category: 'discovery',
      readOnly: true,
    },
    {
      name: ToolSchemaDiscoveryToolName,
      description: 'Return the exact input schema for one Velar Host tool.',
      inputSchema: {
        type: 'object',
        properties: { toolName: { type: 'string', minLength: 1 } },
        required: ['toolName'],
        additionalProperties: false,
      },
      category: 'discovery',
      readOnly: true,
    },
  ]
}

/**
 * Provider Surface projection over real Kernel capability sessions.
 *
 * Catalog visibility follows the live Host configuration, while every call
 * still crosses KernelService and the host-owned permission broker. Changing a
 * toggle therefore both rotates the catalog lease and changes execution
 * authority; neither layer can silently broaden the other.
 */
export class VelarHostToolGateway {
  private readonly routesByName: ReadonlyMap<string, ToolRoute>
  private session?: CapabilitySession

  public constructor(
    private readonly kernel: KernelClient,
    private readonly config: VelarHostConfigStore,
    officeToolContextFactory?: VelarHostOfficeToolContextFactory,
  ) {
    const projectRoutes: ToolRoute[] = Object.entries(projectTools)
      .map(([name, tool]) => ({
        descriptor: {
          name,
          description: compactDescription(tool.description),
          inputSchema: schemaToInputSchema(tool.schema),
          category: 'project',
          readOnly: ProjectReadOperations.includes(
            name as (typeof ProjectReadOperations)[number],
          ),
        },
        capabilityId: ProjectCapability.id,
        operation: name,
        permissions: [...new Set(tool.permissions)],
      }))
    const computerRoutes: ToolRoute[] = Object.entries(computerTools)
      .flatMap(([fallbackName, tool]) => {
        const name = tool.name ?? fallbackName
        const operation = Reflect.get(ComputerOperationByToolName, name)
        if (!isString(operation)) return []
        return [{
          descriptor: {
            name,
            description: compactDescription(tool.description),
            inputSchema: schemaToInputSchema(tool.schema),
            category: 'computer-control',
            readOnly: ComputerObserveToolNames.has(name),
          },
          capabilityId: ComputerCapability.id,
          operation,
          permissions: ComputerOperationPermissions.get(operation) ?? [],
        }]
      })
    const systemRoutes: ToolRoute[] = Object.entries(systemTools)
      .map(([fallbackName, tool]) => {
        const name = tool.name ?? fallbackName
        return {
          descriptor: {
            name,
            description: compactDescription(tool.description),
            inputSchema: schemaToInputSchema(tool.schema),
            category: SystemToolCategoryByName[
              name as keyof typeof SystemToolCategoryByName
            ],
            readOnly: SystemObserveOperations.has(name) || SystemReadOperations.has(name),
          },
          capabilityId: SystemCapability.id,
          operation: name,
          permissions: [...new Set(tool.permissions)],
        }
      })
    const officeRoutes: ToolRoute[] = Object.entries(officeTools)
      .map(([fallbackName, tool]) => {
        const name = tool.name ?? fallbackName
        const isAvailable = tool.isAvailable
        return {
          descriptor: {
            name,
            description: compactDescription(tool.description),
            inputSchema: schemaToInputSchema(tool.schema),
            category: 'office',
            readOnly: !tool.permissions.includes('fs:write'),
          },
          capabilityId: OfficeCapability.id,
          operation: name,
          permissions: [...new Set(tool.permissions)],
          isAvailable: !isAvailable || !officeToolContextFactory
            ? undefined
            : () => isAvailable(officeToolContextFactory()),
        }
      })
    this.routesByName = new Map(
      [...projectRoutes, ...systemRoutes, ...officeRoutes, ...computerRoutes]
        .map((route) => [route.descriptor.name, route]),
    )
  }

  public async start(): Promise<void> {
    if (isPresent(this.session)) return
    this.session = await this.kernel.openCapabilitySession({
      requires: [
        {
          capabilityId: ProjectCapability.id,
          operations: [
            ...ProjectReadOperations,
            ...ProjectWriteOperations,
            ...ProjectExecuteOperations,
          ],
          scope: null,
        },
        {
          capabilityId: ComputerCapability.id,
          operations: [...new Set(Object.values(ComputerOperationByToolName))],
          scope: null,
        },
        {
          capabilityId: SystemCapability.id,
          operations: Object.values(systemTools).map((tool) => tool.name).filter(isString),
          scope: null,
        },
        {
          capabilityId: OfficeCapability.id,
          operations: Object.values(officeTools).map((tool) => tool.name).filter(isString),
          scope: null,
        },
      ],
    })
  }

  public snapshot(workspaceSpace: ProviderSurfaceWorkspaceSpace): ProviderSurfaceToolCatalog {
    const tools = [
      ...discoveryTools(),
      ...this.visibleRoutes(workspaceSpace).map((route) => route.descriptor),
    ]
    const revision = createHash('sha256')
      .update(JSON.stringify(tools))
      .digest('base64url')
      .slice(0, 32)
    return Object.freeze({
      protocolVersion: ProviderSurfaceProtocolVersion,
      revision,
      tools,
    })
  }

  /**
   * 远程节点面：当前可见的全部路由，不按工作区空间收窄。
   *
   * 空间轴是网页会话的概念（一个 surface 绑一个工作区）；远端 Client 拿到的是整台机器的能力面，
   * 唯一的收窄仍然是 Host 开关本身——两条面共用 `visibleRoutes`，开关翻转必须同时改变两者。
   */
  public remoteRoutes(): readonly VelarHostToolRoute[] {
    return this.visibleRoutes(null)
  }

  /**
   * 远程节点派发口：与工具面同一条 Kernel 会话、同一套权限 broker。
   *
   * `signal` 是必填而非可选——跨机调用的取消与超时全靠它，缺了就只能等对端 socket 断开，
   * 在途的长任务会继续在本机跑完。
   */
  public callCapability(
    call: VelarHostCapabilityCall,
    signal: AbortSignal,
  ): Promise<CapabilityCallResponse> {
    const session = this.session
    if (!isPresent(session)) throw new Error('Kernel 工具会话尚未启动。')
    return session.call({
      protocolVersion: KernelProtocolVersion,
      callId: randomUUID(),
      capabilityId: call.capabilityId,
      operation: call.operation,
      scope: call.scope,
      input: call.input,
    }, signal)
  }

  public async execute(
    input: ProviderSurfaceToolCall,
    workspaceSpace: ProviderSurfaceWorkspaceSpace,
    signal?: AbortSignal,
  ): Promise<ProviderSurfaceToolResult> {
    const call = ProviderSurfaceToolCallSchema.parse(input)
    const catalog = this.snapshot(workspaceSpace)
    if (call.catalogRevision !== catalog.revision) return this.denied(call, catalog.revision, '工具目录已经变化，本次调用未执行。')
    const visibleTools = new Map(catalog.tools.map((tool) => [tool.name, tool]))
    if (call.toolName === ToolCatalogDiscoveryToolName) return this.success(call, catalog.revision, catalog)
    if (call.toolName === ToolSchemaDiscoveryToolName) {
      const toolName = call.input.toolName
      if (!isString(toolName) || isBlank(toolName)) return this.error(call, catalog.revision, 'toolName 必须是非空字符串。')
      const tool = visibleTools.get(toolName.trim())
      return !isPresent(tool)
        ? this.denied(call, catalog.revision, `未知工具：${toolName.trim()}`)
        : this.success(call, catalog.revision, { tool })
    }
    const route = this.routesByName.get(call.toolName)
    if (!isPresent(route) || !visibleTools.has(call.toolName)) return this.denied(call, catalog.revision, `工具 ${call.toolName} 未被当前 Host 配置授权。`)
    const session = this.session
    if (!isPresent(session)) return this.error(call, catalog.revision, 'Kernel 工具会话尚未启动。')
    // signal 一路带到 Kernel RPC：调用方（插件桥 / 远程节点）撤掉页面或断链时，本机的长任务
    // 才会真的停下，而不是等它自己跑完再把结果丢给一个已经不存在的会话。
    const response = await session.call({
      protocolVersion: KernelProtocolVersion,
      callId: randomUUID(),
      capabilityId: route.capabilityId,
      operation: route.operation,
      scope: null,
      input: call.input,
    }, signal)
    if (response.status !== 'ok') return response.error.code === 'PERMISSION_DENIED'
        ? this.denied(call, catalog.revision, response.error.message)
        : this.error(call, catalog.revision, response.error.message)
    const lifted = this.liftArtifacts(call.toolName, response.output)
    return this.success(
      call,
      catalog.revision,
      lifted.output,
      lifted.artifacts,
    )
  }

  public async dispose(): Promise<void> {
    const session = this.session
    this.session = undefined
    await session?.dispose()
  }

  /** `workspaceSpace` 为 `null` 表示不做空间收窄，只跟随 Host 开关（远程节点面）。 */
  private visibleRoutes(
    workspaceSpace: Nullable<ProviderSurfaceWorkspaceSpace>,
  ): ToolRoute[] {
    const capabilities = this.config.snapshot().value.capabilities
    return [...this.routesByName.values()]
      .filter((route) => {
        if (route.isAvailable && !route.isAvailable()) return false
        if (
          workspaceSpace === 'project'
          && route.capabilityId !== ProjectCapability.id
          && route.capabilityId !== OfficeCapability.id
        ) return false
        if (
          workspaceSpace === 'system'
          && route.capabilityId !== ComputerCapability.id
          && route.capabilityId !== SystemCapability.id
        ) return false
        if (workspaceSpace === 'browser') return false
        if (ProjectReadOperations.includes(
          route.operation as (typeof ProjectReadOperations)[number],
        )) return capabilities.project.read
        if (ProjectWriteOperations.includes(
          route.operation as (typeof ProjectWriteOperations)[number],
        )) return capabilities.project.write
        if (ProjectExecuteOperations.includes(
          route.operation as (typeof ProjectExecuteOperations)[number],
        )) return capabilities.project.execute
        if (route.capabilityId === OfficeCapability.id) return capabilities.project.write
        if (SystemObserveOperations.has(route.operation)) return capabilities.system.observe
        if (SystemReadOperations.has(route.operation)) return capabilities.system.read
        if (SystemWriteOperations.has(route.operation)) return capabilities.system.write
        if (SystemExecuteOperations.has(route.operation)) return capabilities.system.execute
        if (ComputerObserveToolNames.has(route.descriptor.name)) return capabilities.computer.observe
        if (ComputerControlToolNames.has(route.descriptor.name)) return capabilities.computer.control
        return false
      })
      .sort((left, right) => left.descriptor.name.localeCompare(right.descriptor.name))
  }

  private liftArtifacts(
    toolName: string,
    value: unknown,
  ): { output: unknown; artifacts?: ProviderSurfaceArtifact[] } {
    if (toolName !== 'computer:screenshot') return { output: value }
    const output = asRecord(value)
    if (isNull(output) || !isString(output.base64) || isEmpty(output.base64)) return { output: value }
    const { base64, ...metadata } = output
    const mediaType = output.format === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const
    return {
      output: metadata,
      artifacts: [{
        kind: 'image',
        mediaType,
        data: base64,
        name: `desktop-screenshot.${mediaType === 'image/jpeg' ? 'jpg' : 'png'}`,
      }],
    }
  }

  private success(
    call: ProviderSurfaceToolCall,
    catalogRevision: string,
    output: unknown,
    artifacts?: ProviderSurfaceArtifact[],
  ): ProviderSurfaceToolResult {
    return {
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: call.contractId,
      catalogRevision,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      status: 'success',
      output,
      artifacts: toOptional(artifacts),
    }
  }

  private denied(
    call: ProviderSurfaceToolCall,
    catalogRevision: string,
    error: string,
  ): ProviderSurfaceToolResult {
    return {
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: call.contractId,
      catalogRevision,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      status: 'denied',
      error,
    }
  }

  private error(
    call: ProviderSurfaceToolCall,
    catalogRevision: string,
    error: string,
  ): ProviderSurfaceToolResult {
    return {
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: call.contractId,
      catalogRevision,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      status: 'error',
      error,
    }
  }
}
