import { createHash, randomUUID } from 'node:crypto'

import {
  ToolCatalogDiscoveryToolName,
  ToolSchemaDiscoveryToolName,
} from '@velaros-ai/agent/protocol'
import { ComputerCapability } from '@velaros-ai/computer/runtime'
import { computerTools } from '@velaros-ai/computer/tools'
import {
  isBlank,
  isEmpty,
  isNull,
  isPlainObject,
  isPresent,
  isString,
  toOptional,
} from '@velaros-ai/core'
import {
  type CapabilitySession,
  type KernelClient,
  KernelProtocolVersion,
} from '@velaros-ai/kernel-client'
import {
  type OfficeToolContext,
  officeTools,
  OfficeToolsCapability,
} from '@velaros-ai/office-tools'
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
  systemTools,
  SystemToolsCapability,
} from '@velaros-ai/system-tools'
import {
  schemaToInputSchema,
  type VelarosWorkspaceBridge,
  WorkspaceCapability,
  WorkspaceKernelToolNames,
} from '@velaros-ai/workspace'

import type { VelarHostConfigStore } from './config'

const WorkspaceReadOperations = Object.freeze([
  WorkspaceKernelToolNames.status,
  WorkspaceKernelToolNames.read,
  WorkspaceKernelToolNames.stat,
  WorkspaceKernelToolNames.listFiles,
  WorkspaceKernelToolNames.search,
  WorkspaceKernelToolNames.symbols,
  WorkspaceKernelToolNames.resolveTarget,
  WorkspaceKernelToolNames.buildEvidence,
  WorkspaceKernelToolNames.diff,
])

const WorkspaceWriteOperations = Object.freeze([
  WorkspaceKernelToolNames.prepareEdit,
  WorkspaceKernelToolNames.amendEdit,
  WorkspaceKernelToolNames.commitEdit,
  WorkspaceKernelToolNames.applyEdit,
  WorkspaceKernelToolNames.validate,
  WorkspaceKernelToolNames.rollback,
  WorkspaceKernelToolNames.runBatch,
])

const SystemObserveOperations = new Set([
  'get_system_overview',
  'ps',
  'refresh_shell_environment',
  'list_background_tasks',
])
const SystemReadOperations = new Set(['read', 'list', 'grep'])
const SystemWriteOperations = new Set(['write', 'edit'])
const SystemExecuteOperations = new Set(['bash', 'open', 'terminate_background_task'])

const ComputerOperationByToolName = Object.freeze({
  computer_screenshot: 'screenshot',
  computer_screen_size: 'screen_size',
  computer_move: 'mouse_move',
  computer_click: 'left_click',
  computer_type: 'type_text',
  computer_key: 'key',
})

const ComputerObserveToolNames = new Set([
  'computer_screenshot',
  'computer_screen_size',
])
const ComputerControlToolNames = new Set([
  'computer_move',
  'computer_click',
  'computer_type',
  'computer_key',
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

function asRecord(value: unknown): Nullable<Record<string, unknown>> {
  return isPlainObject(value) ? value : null
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
    workspace: VelarosWorkspaceBridge,
    private readonly config: VelarHostConfigStore,
    officeToolContextFactory?: VelarHostOfficeToolContextFactory,
  ) {
    const supportedWorkspaceOperations = new Set<string>([
      ...WorkspaceReadOperations,
      ...WorkspaceWriteOperations,
    ])
    const workspaceRoutes: ToolRoute[] = workspace.tools
      .filter((tool) => supportedWorkspaceOperations.has(tool.name))
      .map((tool) => ({
        descriptor: {
          name: tool.name,
          description: compactDescription(tool.description),
          inputSchema: schemaToInputSchema(tool.schema),
          category: 'workspace',
          readOnly: WorkspaceReadOperations.includes(
            tool.name as (typeof WorkspaceReadOperations)[number],
          ),
        },
        capabilityId: WorkspaceCapability.id,
        operation: tool.name,
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
            category: 'system-control',
            readOnly: SystemObserveOperations.has(name) || SystemReadOperations.has(name),
          },
          capabilityId: SystemToolsCapability.id,
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
          capabilityId: OfficeToolsCapability.id,
          operation: name,
          isAvailable: !isAvailable || !officeToolContextFactory
            ? undefined
            : () => isAvailable(officeToolContextFactory()),
        }
      })
    this.routesByName = new Map(
      [...workspaceRoutes, ...systemRoutes, ...officeRoutes, ...computerRoutes]
        .map((route) => [route.descriptor.name, route]),
    )
  }

  public async start(): Promise<void> {
    if (isPresent(this.session)) return
    this.session = await this.kernel.openCapabilitySession({
      requires: [
        {
          capabilityId: WorkspaceCapability.id,
          operations: [...WorkspaceReadOperations, ...WorkspaceWriteOperations],
          scope: null,
        },
        {
          capabilityId: ComputerCapability.id,
          operations: [...new Set(Object.values(ComputerOperationByToolName))],
          scope: null,
        },
        {
          capabilityId: SystemToolsCapability.id,
          operations: Object.values(systemTools).map((tool) => tool.name).filter(isString),
          scope: null,
        },
        {
          capabilityId: OfficeToolsCapability.id,
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
          && route.capabilityId !== WorkspaceCapability.id
          && route.capabilityId !== OfficeToolsCapability.id
        ) return false
        if (
          workspaceSpace === 'system'
          && route.capabilityId !== ComputerCapability.id
          && route.capabilityId !== SystemToolsCapability.id
        ) return false
        if (workspaceSpace === 'browser') return false
        if (WorkspaceReadOperations.includes(
          route.operation as (typeof WorkspaceReadOperations)[number],
        )) return capabilities.workspace.read
        if (WorkspaceWriteOperations.includes(
          route.operation as (typeof WorkspaceWriteOperations)[number],
        )) return capabilities.workspace.write
        if (route.capabilityId === OfficeToolsCapability.id) return capabilities.workspace.write
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
    if (toolName !== 'computer_screenshot') return { output: value }
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
