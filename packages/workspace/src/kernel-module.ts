import { z } from 'zod'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
  type ScopeRef,
} from '@velaros-ai/core/kernel/abi'

import { WORKSPACE_PACKAGE_VERSION } from './core/defaults.js'
import {
  createVelarosWorkspaceBridge,
  type CreateVelarosWorkspaceOptions,
  type VelarosWorkspaceBridge,
} from './velaros/index.js'
import type { AgentToolDefinition } from './agent-tools.js'
import { WorkspaceKernelToolNames as wsTool } from './workspace-tool-names.js'

export interface WorkspaceBridgeResolver {
  resolveBridge(
    scope: ScopeRef | undefined,
    signal: AbortSignal,
  ): VelarosWorkspaceBridge | Promise<VelarosWorkspaceBridge>
}

export interface WorkspaceCapabilityService
  extends KernelCallableCapabilityService {
  resolveBridge(
    scope: ScopeRef | undefined,
    signal: AbortSignal,
  ): Promise<VelarosWorkspaceBridge>
}

export interface CreateWorkspaceKernelModuleOptions {
  /** Existing product registry adapter. Resolved bridges remain host-owned. */
  resolver?: WorkspaceBridgeResolver
  /** Existing single bridge convenience; remains caller-owned by default. */
  bridge?: VelarosWorkspaceBridge
  /** Creates one module-owned bridge during activation. */
  workspace?: CreateVelarosWorkspaceOptions
  /** Opt in only when the module should dispose injected/resolved bridges. */
  disposeResolvedBridges?: boolean
}

/** Typed service identity for the independently injected workspace capability. */
export const WorkspaceCapability =
  createCapabilityToken<WorkspaceCapabilityService>('velaros.workspace')

const workspaceOperationPermissions: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  [wsTool.status]: ['fs:read'],
  [wsTool.read]: ['fs:read'],
  [wsTool.stat]: ['fs:read'],
  [wsTool.listFiles]: ['fs:read'],
  [wsTool.search]: ['fs:read'],
  [wsTool.symbols]: ['fs:read'],
  [wsTool.resolveTarget]: ['fs:read'],
  [wsTool.buildEvidence]: ['fs:read'],
  [wsTool.diff]: ['fs:read'],
  [wsTool.prepareEdit]: ['fs:read', 'fs:write'],
  [wsTool.amendEdit]: ['fs:read', 'fs:write'],
  [wsTool.commitEdit]: ['fs:read', 'fs:write', 'process:exec'],
  [wsTool.applyEdit]: ['fs:write'],
  [wsTool.validate]: ['fs:read', 'process:exec'],
  [wsTool.rollback]: ['fs:write'],
  [wsTool.runBatch]: ['fs:read', 'fs:write', 'process:exec'],
})

function isLegacyWorkspaceOptions(
  options:
    | CreateVelarosWorkspaceOptions
    | CreateWorkspaceKernelModuleOptions,
): options is CreateVelarosWorkspaceOptions {
  return 'root' in options
}

function parseWorkspaceToolInput(
  tool: AgentToolDefinition,
  input: unknown,
): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Workspace capability input is invalid')
  }
  const schema = tool.schema instanceof z.ZodObject
    ? tool.schema.strict()
    : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Workspace capability input is invalid')
  }
  return parsed.data
}

function findWorkspaceTool(
  bridge: VelarosWorkspaceBridge,
  operation: string,
): AgentToolDefinition {
  const tool = bridge.tools.find((candidate) => candidate.name === operation)
  if (tool === undefined) {
    throw new Error('Workspace capability operation is unavailable')
  }
  return tool
}

function normalizeWorkspaceModuleOptions(
  options:
    | CreateVelarosWorkspaceOptions
    | CreateWorkspaceKernelModuleOptions,
): CreateWorkspaceKernelModuleOptions {
  return isLegacyWorkspaceOptions(options)
    ? { workspace: options }
    : options
}

function assertSingleWorkspaceSource(
  options: CreateWorkspaceKernelModuleOptions,
): void {
  const sourceCount = [
    options.resolver,
    options.bridge,
    options.workspace,
  ].filter((source) => source !== undefined).length
  if (sourceCount !== 1) {
    throw new Error(
      'Workspace kernel module requires exactly one resolver, bridge, or workspace option',
    )
  }
}

/**
 * Adapts either a product-owned workspace registry or a convenient single
 * bridge to the microkernel boundary. Workspace state never moves into Kernel.
 */
export function createWorkspaceKernelModule(
  input:
    | CreateVelarosWorkspaceOptions
    | CreateWorkspaceKernelModuleOptions,
): KernelModuleDefinition {
  const options = normalizeWorkspaceModuleOptions(input)
  assertSingleWorkspaceSource(options)

  return defineKernelModule({
    manifest: {
      id: 'velaros.workspace.default',
      version: WORKSPACE_PACKAGE_VERSION,
      apiVersion: 1,
      provides: [WorkspaceCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    async activate(context) {
      const createdBridge = options.workspace === undefined
        ? undefined
        : await createVelarosWorkspaceBridge(options.workspace)
      const injectedBridge = options.bridge
      const trackedBridges = new Set<VelarosWorkspaceBridge>()
      if (createdBridge !== undefined) trackedBridges.add(createdBridge)

      const resolveBridge = async (
        scope: ScopeRef | undefined,
        signal: AbortSignal,
      ): Promise<VelarosWorkspaceBridge> => {
        signal.throwIfAborted()
        const bridge = createdBridge
          ?? injectedBridge
          ?? await options.resolver!.resolveBridge(scope, signal)
        if (options.disposeResolvedBridges) trackedBridges.add(bridge)
        return bridge
      }

      const callable = createKernelCallableCapability(
        Object.fromEntries(
          Object.entries(workspaceOperationPermissions).map(
            ([operation, permissions]) => [
              operation,
              {
                metadata: {
                  permissions,
                  reason: `Invoke workspace operation "${operation}".`,
                },
                async invoke(
                  scope: ScopeRef | undefined,
                  operationInput: unknown,
                  signal: AbortSignal,
                ) {
                  const bridge = await resolveBridge(scope, signal)
                  const tool = findWorkspaceTool(bridge, operation)
                  const parsed = parseWorkspaceToolInput(tool, operationInput)
                  signal.throwIfAborted()
                  return tool.execute(parsed)
                },
              },
            ],
          ),
        ),
      )
      const service: WorkspaceCapabilityService = Object.freeze({
        ...callable,
        resolveBridge,
      })
      context.registerService(WorkspaceCapability, service)

      return {
        async dispose() {
          for (const bridge of trackedBridges) {
            await bridge.asModule().dispose?.()
          }
        },
      }
    },
  })
}
