import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import type { ActRunLimits } from '@velaros-ai/agent'
import type { ContextStorage } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import {
  isArray,
  isBoolean,
  isFalse,
  isFunction,
  isPlainObject,
  isString,
  isTrue,
  isUndefined,
} from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'
import { createAiSdkModelDriver, createModelRuntimeComposition } from '@velaros-ai/model'
import type { CodeRunnerApi } from '@velaros-ai/script'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createLocalImagePort } from '../../../images/local.js'
import type { MemoryScopePort } from '../../../memory/index.js'
import { createMemoryStore } from '../../../memory/index.js'
import type { ProjectCodeIndexApi, ProjectSpacePort } from '../../../project/index.js'
import {
  createProjectCodeQuery,
  createProjectContextSource,
  createProjectKernel,
} from '../../../project/index.js'
import type { VelarosSearchOptions } from '../../search/index.js'
import {
  ModelToolLimits,
  RuntimeModelLimits,
  RuntimeSearchProfile,
  VelarosRunLimits,
} from '../contract/constants.js'
import type {
  VelarosAgentsOptions,
  VelarosProjectOptions,
  VelarosRuntimeOptions,
} from '../contract/requires.js'

import {
  createProjectCapabilityModule,
  createProjectCodeModule,
  createProjectImagesModule,
} from './StandardModules.js'

/** 在同一正式入口内建立缺省依赖，具体机制仍归原能力单元。 */
export interface RuntimeBootstrapApi {
  /** 核验配置并解析为现有运行时的具体依赖。 */
  prepare(options: VelarosRuntimeOptions): Promise<RuntimeBootstrapOptions>
}
/** 完成默认装配之后注入唯一运行时的具体依赖。 */
export interface RuntimeBootstrapOptions extends Omit<
  VelarosRuntimeOptions,
  'storage' | 'runner' | 'modules' | 'model' | 'memory' | 'search' | 'agents' | 'limits'
> {
  /** 已建立的唯一持久存储。 */
  readonly storage: ContextStorage
  /** 已选定的隔离执行器。 */
  readonly runner: CodeRunnerApi
  /** 实际挂载的业务模块。 */
  readonly modules: readonly OperationModuleDefinition[]
  /** 已解析的模型驱动。 */
  readonly model?: ModelDriver
  /** 长期记忆作用域工厂。 */
  readonly memory?: (sessionId: string) => MemoryScopePort
  /** 已解析的高级搜索配置。 */
  readonly search?: VelarosSearchOptions
  /** 已解析的业务子任务配置。 */
  readonly agents?: VelarosAgentsOptions
  /** 完整主运行预算。 */
  readonly limits: ActRunLimits
}

class RuntimeBootstrap implements RuntimeBootstrapApi {
  /** 没有代码图谱后端：语言服务照常答，图谱类查询报 UNAVAILABLE（不可用时不会调 query）。 */
  private static readonly NoCodeGraph: ProjectCodeIndexApi = {
    isAvailable: () => false,
    query: async () => ({}),
  }

  public async prepare(options: VelarosRuntimeOptions): Promise<RuntimeBootstrapOptions> {
    const modules = [...(options.modules ?? [])]
    const sources = [...(options.context?.sources ?? [])]
    if (!isUndefined(options.instructions) && !isString(options.instructions))
      throw new AppError('VALIDATION', 'instructions 必须是宿主提供的文本')
    if (
      !isUndefined(options.residentModules) &&
      !(
        isArray(options.residentModules) &&
        options.residentModules.every(
          (entry) =>
            isString(entry) ||
            (isPlainObject(entry) &&
              isString(entry.module) &&
              Boolean(entry.module.trim()) &&
              isString(entry.export) &&
              Boolean(entry.export.trim()))
        )
      )
    )
      throw new AppError('VALIDATION', 'residentModules 必须是模块名或 {module, export} 列表')
    if (!isUndefined(options.environment) && !isFunction(options.environment))
      throw new AppError('VALIDATION', 'environment 必须是返回宿主环境条目的函数')
    let workspace: Optional<string>
    if (options.workspace) {
      if (!isAbsolute(options.workspace)) throw new AppError('VALIDATION', 'workspace 需要绝对路径')
      workspace = await realpath(options.workspace)
      if (!(await stat(workspace)).isDirectory())
        throw new AppError('VALIDATION', 'workspace 必须是已有目录')
      if (
        !isFalse(options.project) &&
        (modules.some((module) => module.binding.moduleId === 'velaros:project') ||
          sources.some((source) => source.id === 'project'))
      )
        throw new AppError('VALIDATION', 'workspace 已装配 project，不能重复挂载同一能力或来源')
    }
    const dataDir = options.dataDir
    if (dataDir) {
      if (!isAbsolute(dataDir)) throw new AppError('VALIDATION', 'dataDir 需要绝对路径')
      if (workspace) {
        const path = relative(workspace, dataDir)
        if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
          throw new AppError(
            'VALIDATION',
            'dataDir 应位于业务工作区之外，避免被项目能力当作任务文件处理'
          )
      }
      await mkdir(dataDir, { recursive: true })
      if (workspace) {
        const path = relative(workspace, await realpath(dataDir))
        if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
          throw new AppError('VALIDATION', 'dataDir 的真实位置不能在业务工作区内')
      }
    }
    if (!options.storage && !dataDir)
      throw new AppError('VALIDATION', '需要 dataDir 保存运行状态，或注入 ContextStorage')
    if (workspace && !isFalse(options.project)) {
      const root = workspace
      const transactionStatePath = dataDir
        ? join(
            dataDir,
            'projects',
            createHash('sha256').update(root).digest('hex'),
            'transactions.json'
          )
        : undefined
      const kernel = await createProjectKernel({ root, transactionStatePath })
      const extras: VelarosProjectOptions = isPlainObject(options.project) ? options.project : {}
      const code = extras.code
      const codeIndex =
        isUndefined(code) || isBoolean(code)
          ? isTrue(code)
            ? RuntimeBootstrap.NoCodeGraph
            : undefined
          : code
      const project: ProjectSpacePort = {
        getRootPath: () => root,
        kernel: async () => kernel,
        queryCode: codeIndex
          ? createProjectCodeQuery(codeIndex)
          : async () => {
              throw new AppError('UNAVAILABLE', '此项目没有装配代码智能端口')
            },
      }
      modules.push(createProjectCapabilityModule({ instanceId: root, project }))
      if (codeIndex) modules.push(createProjectCodeModule({ instanceId: root, project }))
      if (isTrue(extras.images))
        modules.push(
          createProjectImagesModule({
            instanceId: root,
            project,
            // 本机看图端口只借它的缩图（macOS 的 sips）；看哪张图仍由项目端口钳在项目里。
            resizeImage: createLocalImagePort({ resolvePath: (path) => path }).resizeImage,
          })
        )
      sources.push(createProjectContextSource({ id: 'project', kernel }))
    }
    let model: RuntimeBootstrapOptions['model']
    if (options.model && 'stream' in options.model) model = options.model
    else if (options.model) {
      const config = options.model
      const limits = { ...RuntimeModelLimits, ...config.limits }
      if (!config.model?.trim() || !config.apiKey?.trim())
        throw new AppError('VALIDATION', '模型配置需要 model 和 apiKey')
      const url = new URL(config.baseURL)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new AppError('VALIDATION', '模型 baseURL 需要不含凭据或查询参数的 HTTP(S) 地址')
      if (
        Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
        limits.inputTokens + limits.outputTokens + VelarosRunLimits.safetyTokens >
          limits.contextTokens
      )
        throw new AppError('VALIDATION', '模型窗口预算需要覆盖输入、输出和安全余量')
      const providers = createModelRuntimeComposition({
        environment: {},
        providerScripts: { configPaths: [] },
      })
      const factory = providers.modelAdapterRegistry.createLanguageModelFactory(config)
      model = createAiSdkModelDriver({
        id: `${config.provider}/${config.model}`,
        model: factory(config.model),
        limits,
      })
    }
    const defaults = Boolean(options.workspace || (options.model && !('stream' in options.model)))
    const search = isFalse(options.search)
      ? undefined
      : options.search && !isTrue(options.search)
        ? options.search
        : (defaults || isTrue(options.search)) && model && !isEmpty(sources)
          ? {
              model,
              profiles: {
                standard: {
                  ...RuntimeSearchProfile,
                  outputTokens: Math.min(
                    RuntimeSearchProfile.outputTokens,
                    model.limits.outputTokens
                  ),
                },
              },
              defaultProfile: 'standard',
            }
          : undefined
    if (isTrue(options.search) && !search)
      throw new AppError('VALIDATION', '启用搜索需要模型和真实证据来源')
    const agents = isFalse(options.agents)
      ? undefined
      : options.agents && !isTrue(options.agents)
        ? options.agents
        : (defaults || isTrue(options.agents)) && model
          ? {
              profiles: {
                worker: {
                  model,
                  modules: [
                    ...modules.map((module) => module.binding.moduleId),
                    ...(search ? ['velaros:search'] : []),
                  ],
                },
              },
              concurrency: ModelToolLimits.concurrency,
              maxChildren: ModelToolLimits.maxChildren,
            }
          : undefined
    if (isTrue(options.agents) && !agents) throw new AppError('VALIDATION', '启用子任务需要模型')
    const scope = createHash('sha256')
      .update(workspace ?? dataDir ?? 'injected')
      .digest('hex')
    const memoryStore =
      dataDir && isUndefined(options.memory)
        ? createMemoryStore({ root: join(dataDir, 'memory') })
        : undefined
    const memory = isFalse(options.memory)
      ? undefined
      : (options.memory ?? (memoryStore ? () => memoryStore.scope(scope) : undefined))
    // 存储最后建立；此前的配置失败不会遗留数据库句柄。
    const storage =
      options.storage ?? localContextStorage({ path: join(dataDir!, 'context.sqlite') })
    return {
      ...options,
      workspace,
      dataDir,
      storage,
      model,
      modules,
      runner: options.runner ?? nodeSubprocessCodeRunner,
      memory,
      search,
      agents,
      context: { ...options.context, sources },
      limits: {
        ...VelarosRunLimits,
        outputTokens: model ? model.limits.outputTokens : VelarosRunLimits.outputTokens,
        ...options.limits,
      },
    }
  }
}
/** 普通配置与底层端口共享的默认装配器。 */
export const runtimeBootstrap: RuntimeBootstrapApi = new RuntimeBootstrap()
