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

interface ToolRoute {
  readonly descriptor: ProviderSurfaceToolDescriptor
  readonly capabilityId: string
  readonly operation: string
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

  public async execute(
    input: ProviderSurfaceToolCall,
    workspaceSpace: ProviderSurfaceWorkspaceSpace,
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
    const response = await session.call({
      protocolVersion: KernelProtocolVersion,
      callId: randomUUID(),
      capabilityId: route.capabilityId,
      operation: route.operation,
      scope: null,
      input: call.input,
    })
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

  private visibleRoutes(workspaceSpace: ProviderSurfaceWorkspaceSpace): ToolRoute[] {
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
