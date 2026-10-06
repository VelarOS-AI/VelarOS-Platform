import type { AgentSupervisorApi } from '@velaros-ai/agent'
import type { ContextViewApi } from '@velaros-ai/context'
import { isPlainObject } from '@velaros-ai/core'
import { isArray, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  InvocationJournal,
  OperationDefinition,
  OperationModuleDefinition,
  OperationRuntimeApi,
  OperationSchema,
} from '@velaros-ai/kernel'

import { VelarImagesModule } from '../../../images/contract/surface.js'
import { imageOperations } from '../../../images/impl/ImageOperations.js'
import { VelarCodeModule, VelarProjectModule } from '../../../project/contract/surface.js'
import { projectCapabilityPorts } from '../../../project/impl/operations/ProjectCapabilityPorts.js'
import { projectCodeOperations } from '../../../project/impl/operations/ProjectCodeOperations.js'
import { projectFileOperations } from '../../../project/impl/operations/ProjectFileOperations.js'
import type { AgentsHost, WidgetHost } from '../../agents/contract/requires.js'
import { agentsModule, interactionModule, widgetModule } from '../../agents/index.js'
import type { AdvancedSearchApi } from '../../search/impl/AdvancedSearch.js'
import { evidenceModule, searchModule } from '../../search/index.js'
import type {
  ContextMaintenanceHost,
  LongTermMemoryHost,
  ProgramsHost,
  StoreHost,
} from '../../system/contract/requires.js'
import { systemModules } from '../../system/index.js'
import type {
  McpModuleOptions,
  ProjectCapabilityModuleOptions,
  ProjectImagesModuleOptions,
} from '../contract/requires.js'
import type { ScriptSubmission } from '../types/session.js'
import { scriptInputCopy } from '../utils/program-context.js'
import { normalizeCapabilityValue } from '../utils/results.js'
import { checkScriptSubmission } from '../utils/script-submission.js'

import { capabilityModules } from './CapabilityModules.js'
import type { RuntimeSessionAccess } from './RuntimeSession.js'

/** 标准模块的受控依赖。 */
export interface StandardModulesHost extends ProgramsHost {
  /** 实际子任务配置目录。 */
  readonly agentProfiles: AgentsHost['agentProfiles']
  /** 共享结构化状态端口，复用唯一持久存储。 */
  readonly stores?: StoreHost
  /** 主线长期记忆的已固定作用域。 */
  readonly longTermMemory?: LongTermMemoryHost
  /** 独立上下文整理的可选能力。 */
  readonly maintenance?: ContextMaintenanceHost
  /** 子任务统一调度器。 */
  readonly agents?: AgentSupervisorApi
  /** 宿主的小部件显示端口；给了才挂 velaros:widget。 */
  readonly widgets?: WidgetHost
  /** 发现和执行使用相同能力范围。 */
  allows(sessionId: string, moduleId: string): boolean
  /** 配置存在时装配高级搜索。 */
  readonly search?: AdvancedSearchApi

  /** 解析当前任务的观察与材料控制面。 */
  view(sessionId: string): ContextViewApi
  /** 统一模块运行时，构建阶段通过此方法延迟取用。 */
  kernel(): OperationRuntimeApi
  /** 与上下文共用对象存储的持久日志。 */
  readonly journal: InvocationJournal
  /** 读取当前会话的源码与结果访问端口。 */
  programs(sessionId: string): RuntimeSessionAccess
}

/** 标准操作定义的唯一装配器。 */
export interface StandardModuleFactory {
  /** 按脚本提交的类型逐项核对，并固定一份不可变参数。 */
  parseScript(input: unknown): ScriptSubmission
  /** 生成标准模块定义；处理器只转发到主干机制。 */
  create(host: StandardModulesHost): readonly OperationModuleDefinition[]
}

class StandardModules implements StandardModuleFactory {
  public parseScript(input: unknown): ScriptSubmission {
    const copy = scriptInputCopy(input)
    checkScriptSubmission(copy)
    return copy
  }

  public create(host: StandardModulesHost): readonly OperationModuleDefinition[] {
    return [
      ...systemModules.create(host),
      interactionModule.create(host),
      ...(host.widgets ? [widgetModule.create(host.widgets)] : []),
      ...(host.agents ? [agentsModule.create({ ...host, agents: host.agents })] : []),
      ...(host.search
        ? [
            searchModule.create({ ...host, search: host.search }),
            evidenceModule.create({ ...host, search: host.search }),
          ]
        : []),
    ]
  }
}

/** 标准工具装配保持单一入口，模型看见的说明和执行使用同一份定义。 */
export const standardModules: StandardModuleFactory = new StandardModules()

/** 项目上的 velaros:project：读、列、搜与按路径改，都经同一个项目内核。 */
export function createProjectCapabilityModule(
  options: ProjectCapabilityModuleOptions
): OperationModuleDefinition {
  return capabilityModules.create({
    surface: VelarProjectModule,
    implementation: projectFileOperations,
    instanceId: options.instanceId,
    generation: options.generation,
    context: (call) => ({
      project: options.project,
      sessionId: call.invocation.sessionId,
      abortSignal: call.signal,
      recordWriteOutcome: (outcome) =>
        call.recordEffect(outcome === 'applied' ? 'committed' : 'none'),
      recordSnapshotCompletion: () =>
        call.recordObservation?.({ completed: true, protection: 'full' }),
      recordSnapshotMetrics: (metrics) =>
        call.recordDiagnostic?.({
          code: 'PROJECT_SNAPSHOT_COST',
          message: JSON.stringify(metrics),
        }),
    }),
  })
}

/** 项目上的 velaros:code：语言查询只借项目内核的只读端口；图谱类查询经项目端口的 queryCode。 */
export function createProjectCodeModule(
  options: ProjectCapabilityModuleOptions
): OperationModuleDefinition {
  return capabilityModules.create({
    surface: VelarCodeModule,
    implementation: projectCodeOperations,
    instanceId: options.instanceId,
    generation: options.generation,
    context: (call) => ({
      project: options.project,
      sessionId: call.invocation.sessionId,
      abortSignal: call.signal,
    }),
  })
}

/** 项目上的 velaros:images：只看项目里的图，图经代码面的图片通道跟在结果后面交给模型。 */
export function createProjectImagesModule(
  options: ProjectImagesModuleOptions
): OperationModuleDefinition {
  const project = { ...options.project, resizeImage: options.resizeImage }
  const images = projectCapabilityPorts.images(project)
  return capabilityModules.create({
    surface: VelarImagesModule,
    implementation: imageOperations,
    instanceId: options.instanceId,
    generation: options.generation,
    context: (call) => ({
      abortSignal: call.signal,
      images,
      attachImage: (image) => call.attach({ type: 'image-data', ...image }),
    }),
  })
}

/** 将 MCP 固定目录装配到唯一 Kernel，远端提示不自动获得观察权限。 */
export function createMcpModule(options: McpModuleOptions): OperationModuleDefinition {
  const readOnly = new Set(options.readOnly ?? [])
  const operations: Record<string, OperationDefinition> = Object.create(null)
  for (const tool of options.tools) {
    if (Object.hasOwn(operations, tool.name)) throw new AppError('CONFLICT', 'MCP 工具名重复')
    const trusted = readOnly.has(tool.name)
    operations[tool.name] = {
      summary: tool.description ?? tool.name,
      input: tool.inputSchema as OperationSchema,
      output: { type: 'object' },
      effects: trusted ? 'none' : 'write',
      allowedModes: trusted ? undefined : (['execute'] as const),
      run: async (input, call) => {
        if (!trusted) {
          try {
            if (!options.authorize) throw new AppError('PERMISSION', 'MCP 写操作需要宿主授权')
            await options.authorize(call, tool)
            call.signal.throwIfAborted()
          } catch (error) {
            call.recordEffect('none')
            throw error
          }
        }
        const raw = await options.connection.callTool(
          tool.name,
          input as Record<string, unknown>,
          call.signal
        )
        // 写操作即使远端返回成功也只表示协议成功，需领域核对才宣称世界效果。
        call.recordEffect(trusted ? 'none' : 'unknown')
        if (isArray(raw.content))
          for (const block of raw.content)
            if (
              block &&
              isPlainObject(block) &&
              block.type === 'image' &&
              isString(block.data) &&
              isString(block.mimeType)
            )
              call.attach({
                type: 'image-data',
                origin: 'capability',
                label: tool.name,
                mediaType: block.mimeType,
                data: block.data,
              })
        if (raw.isError) throw new AppError('MCP_RESULT_ERROR', JSON.stringify(raw))
        return normalizeCapabilityValue(raw)
      },
    }
  }
  return {
    binding: options.binding,
    summary: `MCP ${options.binding.moduleId}`,
    operations,
    activate: () => options.connection.connect(),
    dispose: () => options.connection.close(),
  }
}
