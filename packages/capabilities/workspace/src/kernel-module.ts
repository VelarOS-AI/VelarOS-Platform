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
import { WorkspaceError } from './errors.js'
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

/**
 * 能力入口的**唯一**入参解析点（§1.8 边界解析一次）。
 *
 * 这里刻意用 `.strict()`：kernel 能力调用来自宿主之外，多余字段意味着调用方与本版本的
 * schema 已经不同步，静默丢弃会让「参数没生效」表现成「功能没实现」。失败信息也刻意**不带
 * zod 的字段级细节**——能力边界的错误会回流给不受信调用方，暴露内部 schema 形状没有收益。
 */
function parseWorkspaceToolInput(
  tool: AgentToolDefinition,
  input: unknown,
): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WorkspaceError('INVALID_INPUT', 'Workspace capability input is invalid')
  }
  const schema = tool.schema instanceof z.ZodObject
    ? tool.schema.strict()
    : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new WorkspaceError('INVALID_INPUT', 'Workspace capability input is invalid')
  }
  return parsed.data
}

function findWorkspaceTool(
  bridge: VelarosWorkspaceBridge,
  operation: string,
): AgentToolDefinition {
  const tool = bridge.tools.find((candidate) => candidate.name === operation)
  if (tool === undefined) {
    throw new WorkspaceError(
      'NOT_SUPPORTED',
      'Workspace capability operation is unavailable',
      { operation },
    )
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
    // 三选一而非「优先级回落」：多源同时给出时无法判断谁是权威 bridge，安静挑一个会让
    // 宿主以为自己注入的那个生效了。装配期 fail-fast 好过运行期改错了工作区。
    throw new WorkspaceError(
      'INVALID_INPUT',
      'Workspace kernel module requires exactly one resolver, bridge, or workspace option',
      { sourceCount },
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
