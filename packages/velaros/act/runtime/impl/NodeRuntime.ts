import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { localContextStorage } from '@velaros-ai/context/node'
import { isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { createAiSdkModelDriver, createModelRuntimeComposition } from '@velaros-ai/model'
import { nodeExecutable } from '@velaros-ai/script'

import { createLocalShellHost } from '../../../execution/local.js'
import { RuntimeModelLimits, VelarosRunLimits } from '../contract/constants.js'
import type { NodeRuntimeOptions } from '../contract/requires.js'

import type { VelarosRuntime } from './ComposedRuntime.js'
import { createRuntime } from './ComposedRuntime.js'
import { createNodeExecutionEnvironment } from './NodeExecutionEnvironment.js'
import { resolveNodeRuntimeBinding } from './NodeRuntimeBinding.js'

/** 普通 Node 环境的单一资源装配器。 */
export interface NodeRuntimeApi {
  /** 解析环境资源后复用基础 Runtime，不建立另一条 Agent 链。 */
  create(options: NodeRuntimeOptions): Promise<VelarosRuntime>
}

class NodeRuntime implements NodeRuntimeApi {
  public async create(options: NodeRuntimeOptions): Promise<VelarosRuntime> {
    const {
      cwd: requestedCwd,
      stateDirectory,
      host,
      localHost,
      storage: injectedStorage,
      execution,
      model: inputModel,
      ...runtimeOptions
    } = options
    if (
      !isNonBlankString(requestedCwd) ||
      !isNonBlankString(stateDirectory) ||
      !isAbsolute(requestedCwd) ||
      !isAbsolute(stateDirectory)
    )
      throw new AppError('VALIDATION', 'cwd 和 stateDirectory 需要绝对路径')
    if (
      !isNonBlankString(options.binding?.executionIdentity) ||
      !isNonBlankString(options.binding?.authorizationScope)
    )
      throw new AppError('VALIDATION', '需要已核验的 executionIdentity 和 authorizationScope')
    if ((host && localHost) || (!host && !localHost?.processConfinement))
      throw new AppError('VALIDATION', '需要单一 host，或明确带 processConfinement 的 localHost')
    const cwd = await realpath(requestedCwd)
    if (!(await stat(cwd)).isDirectory()) throw new AppError('VALIDATION', 'cwd 必须是已有目录')
    const lexical = relative(cwd, stateDirectory)
    if (lexical !== '..' && !lexical.startsWith(`..${sep}`) && !isAbsolute(lexical))
      throw new AppError('VALIDATION', '运行状态目录必须位于执行目录之外')
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const directory = await realpath(stateDirectory)
    const contained = relative(cwd, directory)
    if (contained !== '..' && !contained.startsWith(`..${sep}`) && !isAbsolute(contained))
      throw new AppError('VALIDATION', '运行状态目录必须位于执行目录之外')
    const executable = execution?.executable ?? nodeExecutable.resolve()
    if (!executable) throw new AppError('UNAVAILABLE', '需要真实 Node.js 可执行文件')
    let model = inputModel && 'stream' in inputModel ? inputModel : undefined
    if (inputModel && !('stream' in inputModel)) {
      const config = inputModel
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
    const binding = await resolveNodeRuntimeBinding({
      cwd,
      binding: options.binding,
      executable,
      processConfinement: localHost?.processConfinement,
    })
    const ownedHost = host ? undefined : createLocalShellHost({ ...localHost, cwd })
    let storage = injectedStorage
    try {
      const node = createNodeExecutionEnvironment({
        ...execution,
        executable,
        cwd,
        directory: join(directory, 'node'),
        host: host ?? ownedHost!,
      })
      storage ??= localContextStorage({ path: join(directory, 'context.sqlite') })
      return await createRuntime({
        ...runtimeOptions,
        binding,
        model,
        node,
        storage,
        resources: [
          ...(runtimeOptions.resources ?? []),
          ...(ownedHost ? [{ close: () => ownedHost.dispose() }] : []),
        ],
      })
    } catch (error) {
      const cleanup = await Promise.allSettled([
        !injectedStorage ? storage?.close() : undefined,
        ownedHost?.dispose(),
      ])
      const failures = cleanup
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (failures.length)
        throw AppError.withFields('UNAVAILABLE', 'Node Runtime 初始化及资源清理失败', {
          errors: [error, ...failures],
        })
      throw error
    }
  }
}

/** 建立普通 Node 环境；能力与产品身份始终由宿主显式提供。 */
export async function createNodeRuntime(options: NodeRuntimeOptions): Promise<VelarosRuntime> {
  return new NodeRuntime().create(options)
}
