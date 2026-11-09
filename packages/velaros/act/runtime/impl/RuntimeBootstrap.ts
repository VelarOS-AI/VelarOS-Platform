import type { ActRunLimits } from '@velaros-ai/agent'
import {
  isArray,
  isBoolean,
  isEmpty,
  isFunction,
  isNonBlankString,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'
import type { CodeRunnerApi } from '@velaros-ai/script'
import { createNodeCodeRunner } from '@velaros-ai/script'

import { SystemCatalogLimits } from '../../system/contract/constants.js'
import { VelarosRunLimits } from '../contract/constants.js'
import type { VelarosRuntimeOptions } from '../contract/requires.js'
import { withPackageEnvironment } from '../utils/package-environment.js'

/** 核验已解析的执行与能力端口，不建立产品或环境资源。 */
export interface RuntimeBootstrapApi {
  /** 固定本次装配的真实模块与执行口。 */
  prepare(options: VelarosRuntimeOptions): Promise<RuntimeBootstrapOptions>
}
/** 注入唯一运行时的具体执行依赖。 */
export interface RuntimeBootstrapOptions extends Omit<
  VelarosRuntimeOptions,
  'runner' | 'modules' | 'limits'
> {
  /** 已选定的隔离执行器。 */
  readonly runner: CodeRunnerApi
  /** 实际挂载的业务模块。 */
  readonly modules: readonly OperationModuleDefinition[]
  /** 完整主运行预算。 */
  readonly limits: ActRunLimits
}

class RuntimeBootstrap implements RuntimeBootstrapApi {
  public async prepare(options: VelarosRuntimeOptions): Promise<RuntimeBootstrapOptions> {
    for (const retired of ['workspace', 'project', 'skills', 'dataDir'])
      if (Object.hasOwn(options, retired))
        throw new AppError('VALIDATION', `已删除隐式装配配置 ${retired}，请显式注入能力与环境`)
    if (options.model && !isFunction(options.model.stream))
      throw new AppError('VALIDATION', '基础 Runtime 只接收已解析 ModelDriver')
    for (const configuration of [
      options.agents,
      options.search,
      options.memory,
      options.packageEnvironment,
    ])
      if (isBoolean(configuration))
        throw new AppError('VALIDATION', '能力配置必须显式提供端口，省略即不装配')
    if (
      options.resources &&
      (new Set(options.resources).size !== options.resources.length ||
        options.resources.some((resource) => !resource || !isFunction(resource.close)))
    )
      throw new AppError('VALIDATION', 'resources 必须是互不重复且提供 close 的资源')
    const modules = [...(options.modules ?? [])]
    const sources = [...(options.context?.sources ?? [])]
    const snapshots = [...(options.context?.snapshots ?? [])]
    if (
      snapshots.some(
        (provider) =>
          !provider ||
          !isNonBlankString(provider.id) ||
          !isNonBlankString(provider.moduleId) ||
          !isNonBlankString(provider.operation) ||
          !isNonBlankString(provider.revision) ||
          !isNonBlankString(provider.source) ||
          !isFunction(provider.prepare) ||
          !isArray(provider.plans) ||
          isEmpty(provider.plans) ||
          provider.plans.some((plan) => !isNonBlankString(plan))
      )
    )
      throw new AppError('VALIDATION', '纯快照提供者需要固定目录、派生源码和领域输入检查口')
    if (
      !isUndefined(options.executionDepth) &&
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.executionDepth)
    )
      throw new AppError('VALIDATION', 'executionDepth 必须为 low、medium、high、xhigh 或 max')
    if (!isUndefined(options.instructions) && !isString(options.instructions))
      throw new AppError('VALIDATION', 'instructions 必须是宿主提供的文本')
    if (
      !isUndefined(options.residentModules) &&
      !(
        isArray(options.residentModules) &&
        options.residentModules.every(
          (entry) =>
            isPlainObject(entry) &&
            isNonBlankString(entry.module) &&
            (isUndefined(entry.template) || isBoolean(entry.template)) &&
            (isUndefined(entry.exports) ||
              (isArray(entry.exports) &&
                !isEmpty(entry.exports) &&
                entry.exports.length <= SystemCatalogLimits.maxExports &&
                entry.exports.every(isNonBlankString)))
        )
      )
    )
      throw new AppError(
        'VALIDATION',
        'residentModules 必须是 {module, exports?, template?} 列表，exports 为非空导出名数组，template 为布尔值'
      )
    if (!isUndefined(options.environment) && !isFunction(options.environment))
      throw new AppError('VALIDATION', 'environment 必须是返回宿主环境条目的函数')
    if (!options.storage) throw new AppError('VALIDATION', '需要显式 ContextStorage')
    if (
      !isNonBlankString(options.binding?.executionIdentity) ||
      !isNonBlankString(options.binding?.authorizationScope)
    )
      throw new AppError('VALIDATION', '需要已核验的 executionIdentity 和 authorizationScope')
    if (!options.node && !options.runner)
      throw new AppError('VALIDATION', '需要显式 Node 环境或隔离执行器')
    if (options.node && options.runner)
      throw new AppError('VALIDATION', 'Node 环境与独立执行器不能重复装配')
    if (new Set(snapshots.map((provider) => provider.id)).size !== snapshots.length)
      throw new AppError('VALIDATION', '纯快照提供者身份不能重复')
    if (options.packageEnvironment && !options.node)
      throw new AppError('VALIDATION', '持久 npm 环境需要标准 Node 执行口')
    const node =
      options.node && options.packageEnvironment
        ? withPackageEnvironment(options.node, options.packageEnvironment)
        : options.node
    if (!node && Object.values(options.agents?.profiles ?? {}).some((profile) => profile.node))
      throw new AppError('VALIDATION', '子任务的标准 Node 范围需要宿主先给父任务提供 Node 环境')
    return {
      ...options,
      binding: Object.freeze({ ...options.binding }),
      resources: options.resources ? [...options.resources] : undefined,
      modules,
      node,
      runner: node
        ? createNodeCodeRunner({
            cwd: node.cwd,
            directory: node.directory,
            packageDirectory: node.packageDirectory,
            runtime: node.runtime,
            get observationSupport() {
              return node.observationSupport?.bind(node)
            },
            acquireRuntime: 'acquireRuntime' in node ? node.acquireRuntime : undefined,
            execute: (request, output, signal) =>
              node.execute({ ...request, mode: 'observe' }, output, signal),
          })
        : options.runner!,
      context: { ...options.context, sources, snapshots },
      limits: {
        ...VelarosRunLimits,
        outputTokens: options.model
          ? options.model.limits.outputTokens
          : VelarosRunLimits.outputTokens,
        ...options.limits,
      },
    }
  }
}
/** 正式 Runtime 的单一端口核验器。 */
export const runtimeBootstrap: RuntimeBootstrapApi = new RuntimeBootstrap()
