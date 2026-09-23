import { createHash } from 'node:crypto'

import type { AgentSupervisorApi } from '@velaros-ai/agent'
import type { ContextViewApi } from '@velaros-ai/context'
import { isPlainObject } from '@velaros-ai/core'
import { isNull } from '@velaros-ai/core'
import { isArray, isString } from '@velaros-ai/core'
import type {
  InvocationJournal,
  OperationDefinition,
  OperationModuleDefinition,
  OperationRuntimeApi,
  OperationSchema,
} from '@velaros-ai/kernel'

import { VelarProjectModule } from '../../../project/contract/surface.js'
import { projectFileOperations } from '../../../project/impl/operations/ProjectFileOperations.js'
import type {
  ProjectEditResult,
  ProjectListInput,
  ProjectReadResult,
  ProjectSearchInput,
} from '../../../project/types/files.js'
import { VelarShellModule } from '../../../shell/contract/surface.js'
import { shellOperations } from '../../../shell/impl/ShellOperations.js'
import type { ShellRunInput } from '../../../shell/types/shell-command.js'
import type { AgentsHost } from '../../agents/contract/requires.js'
import { agentsModule, interactionModule } from '../../agents/index.js'
import type { AdvancedSearchApi } from '../../search/impl/AdvancedSearch.js'
import { evidenceModule, searchModule } from '../../search/index.js'
import type {
  ContextMaintenanceHost,
  LongTermMemoryHost,
  StoreHost,
} from '../../system/contract/requires.js'
import { systemModules } from '../../system/index.js'
import type {
  McpModuleOptions,
  ProjectCapabilityModuleOptions,
  ShellCapabilityModuleOptions,
} from '../contract/requires.js'
import type { ScriptSubmission } from '../types/session.js'
import { scriptInputCopy } from '../utils/program-context.js'
import { normalizeCapabilityValue } from '../utils/results.js'
import { checkScriptSubmission } from '../utils/script-submission.js'

import { capabilityModules } from './CapabilityModules.js'
import type { RuntimeSessionAccess } from './RuntimeSession.js'

/** 标准模块的受控依赖。 */
export interface StandardModulesHost {
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

/** 用既有项目内核装配真实版本读取；不从模型输出推断文件版本。 */
export function createProjectCapabilityModule(
  options: ProjectCapabilityModuleOptions
): OperationModuleDefinition {
  const hash = (value: unknown) =>
    createHash('sha256')
      .update(
        JSON.stringify(value, (key, item) =>
          ['fileRef', 'changeRef'].includes(key) ? undefined : item
        )
      )
      .digest('hex')
  const files: NonNullable<OperationDefinition['reads']> = {
    capture: (_input, value) => {
      const result = value as Partial<ProjectReadResult & ProjectEditResult>
      const versions = new Map(
        (result.files ?? [])
          .filter((file) => file.revision)
          .map((file) => [`file:${file.path}`, file.revision!] as const)
      )
      for (const [path, version] of Object.entries(result.newRevisions ?? {}))
        versions.set(`file:${path}`, version)
      for (const issue of result.issues ?? [])
        if (issue.code === 'TARGET_NOT_FOUND') versions.set(`file:${issue.path}`, 'missing')
      return [...versions].map(([resourceId, version]) => ({ resourceId, version }))
    },
    validate: async (stamp, call) => {
      call.signal.throwIfAborted()
      if (!stamp.resourceId.startsWith('file:')) return null
      const stat = await (await options.project.kernel()).stat({ path: stamp.resourceId.slice(5) })
      call.signal.throwIfAborted()
      return !stat.exists
        ? ['deleted', 'missing'].includes(stamp.version)
        : stat.revision === stamp.version
    },
  }
  const query = (name: 'list' | 'search'): NonNullable<OperationDefinition['reads']> => ({
    capture: (input, value) => [{ resourceId: `${name}:${hash(input)}`, version: hash(value) }],
    validate: async (stamp, call) => {
      if (stamp.resourceId.startsWith('file:')) return files.validate(stamp, call)
      if (stamp.resourceId !== `${name}:${hash(call.invocation.input)}`) return false
      const context = {
        project: options.project,
        sessionId: call.invocation.sessionId,
        abortSignal: call.signal,
      }
      const value =
        name === 'list'
          ? await projectFileOperations.list(call.invocation.input as ProjectListInput, context)
          : await projectFileOperations.search(call.invocation.input as ProjectSearchInput, context)
      call.signal.throwIfAborted()
      return hash(value) === stamp.version
    },
  })
  return capabilityModules.create({
    surface: VelarProjectModule,
    implementation: projectFileOperations,
    instanceId: options.instanceId,
    generation: options.generation,
    context: (call) => ({
      project: options.project,
      sessionId: call.invocation.sessionId,
      abortSignal: call.signal,
    }),
    reads: { read: files, list: query('list'), search: query('search'), edit: files, undo: files },
  })
}

/** Shell 观察保留任意命令表达力，调用同一领域实现的宿主受限执行口。 */
export function createShellCapabilityModule(
  options: ShellCapabilityModuleOptions
): OperationModuleDefinition {
  return capabilityModules.create({
    surface: VelarShellModule,
    implementation: shellOperations,
    instanceId: options.instanceId,
    context: (call) => ({
      shell: options.shell,
      approval: options.approval,
      abortSignal: call.signal,
      sessionId: call.invocation.sessionId,
    }),
    observation: {
      run: async (input, call) => {
        let result
        try {
          result = await shellOperations.run(input as ShellRunInput, {
            shell: options.shell,
            approval: options.approval,
            abortSignal: call.signal,
            sessionId: call.invocation.sessionId,
            observation: true,
          })
        } catch (error) {
          if (
            ['OBSERVATION_EFFECT_DENIED', 'OBSERVATION_SHELL_UNAVAILABLE'].includes(
              (error as { code?: string }).code ?? ''
            )
          )
            call.recordEffect('none')
          throw error
        }
        call.recordEffect('unknown')
        if (!result.timedOut && !result.aborted && !isNull(result.exitCode))
          call.recordObservation?.({
            completed: true,
            protection: result.confinement?.enforcement ?? 'none',
          })
        return normalizeCapabilityValue(result)
      },
    },
  })
}

/** 将 MCP 固定目录装配到唯一 Kernel，远端提示不自动获得观察权限。 */
export function createMcpModule(options: McpModuleOptions): OperationModuleDefinition {
  const readOnly = new Set(options.readOnly ?? [])
  const operations: Record<string, OperationDefinition> = Object.create(null)
  for (const tool of options.tools) {
    if (Object.hasOwn(operations, tool.name)) throw new Error('MCP 工具名重复')
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
            if (!options.authorize) throw new Error('MCP 写操作需要宿主授权')
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
        if (raw.isError)
          throw Object.assign(new Error(JSON.stringify(raw)), { code: 'MCP_RESULT_ERROR' })
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
