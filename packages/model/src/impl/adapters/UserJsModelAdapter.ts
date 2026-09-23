import { Script } from 'node:vm'

import { isBlank, isFunction, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { EvaluatedUserAdapter, UserAdapterFactoryInput } from '../../types/user-adapter'
import {
  buildUserAdapterCacheKey,
  callUserAdapterFunction,
  cloneValueForVm,
  cloneValueFromVm,
  createLanguageModelFromDescriptor,
  createUserAdapterFactoryInput,
  createUserAdapterVmContext,
  normalizeLanguageModelDescriptor,
  normalizeUserAdapterEmbeddingRequest,
  runUserAdapterScript,
  UserAdapterCallSources,
  UserAdapterContextSetupSource,
  UserAdapterFilename,
  UserAdapterJsonCloneSource,
  UserAdapterJsonStringifySource,
} from '../../utils/scripts/user-adapter'
import { ModelTuning } from '../../utils/tuning'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

/**
 * 用户上传 JS adapter，用于接入未内置的模型供应商。
 *
 * 导览（§5.3b ④安全门 / ⑥非显然妥协）——**这里跑的是用户随手贴进设置页的代码，一律当敌意输入**。
 *
 * 隔离由四层叠成，缺一层都能被逃逸，改动前先看这四条各挡什么：
 * 1. **空原型 context**（`createContext(Object.create(null))`）——脚本拿不到宿主 realm 的
 *    `globalThis`，也就拿不到 `process` / `require` / `Buffer`。
 * 2. **函数硬化**——把暴露进去的每个函数的 `constructor` 置空并断原型链。不做这步，脚本可以走
 *    `helpers.createOpenAI.constructor('return process')()` 拿回宿主 realm，隔离等于没有。
 * 3. **JSON 单向搬运**——跨边界只传 JSON 可序列化的值，且**在对侧 realm 内**做 parse/stringify。
 *    直接传对象引用会把宿主原型链一起递过去。
 * 4. **执行墙**——`Script.runInContext` 的 timeout 只能打断同步死循环；事后还有一道时长复核，
 *    兜住"timeout 没能生效"的情形（§0.1 条三）。
 *
 * **与 `ProviderScriptRegistry` 的对照（别把两者混为一谈）**：那边是开发者显式登记的脚本，
 * 用 `runInThisContext` 以**宿主全权**执行；这边是普通用户上传的，所以必须沙箱。
 * 两者都叫"provider script"，信任级完全相反。
 *
 * **产物只认描述符**：VM 里返回的不是 LanguageModel 而是三元描述符，
 * 真正的 SDK 实例在宿主侧构造——脚本因此永远碰不到真实 fetch 与 apiKey 载体。
 * 新增可用 provider = 扩描述符里的 provider 闭集，**不是**放宽描述符校验。
 */
class UserJsModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  /** 沙箱 realm 的初始化脚本；编译一次，所有实例共用。 */
  private static readonly ContextSetupScript = new Script(UserAdapterContextSetupSource, {
    filename: UserAdapterFilename,
  })

  /** 按实参个数编译好的跨边界调用脚本。 */
  private static readonly CallScripts = UserAdapterCallSources.map(
    (source) => new Script(source, { filename: UserAdapterFilename })
  )

  /** 在沙箱里 parse 宿主值的脚本。 */
  private static readonly JsonCloneScript = new Script(UserAdapterJsonCloneSource, {
    filename: UserAdapterFilename,
  })

  /** 在沙箱里 stringify 沙箱值的脚本。 */
  private static readonly JsonStringifyScript = new Script(UserAdapterJsonStringifySource, {
    filename: UserAdapterFilename,
  })

  private readonly evaluatedAdapterCache = new Map<string, EvaluatedUserAdapter>()

  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollectionApi) {
    super(providerIds, providers)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const adapter = this.evaluateAdapter(config)
    const createFactory =
      adapter.exports.createLanguageModelFactory ??
      adapter.exports.default?.createLanguageModelFactory

    if (!isFunction(createFactory)) {
      throw new AppError(
        ModelErrorCodes.customAdapterInvalid,
        'Custom adapter 必须导出 createLanguageModelFactory({ config, helpers })。'
      )
    }

    const factory = callUserAdapterFunction<LanguageModelFactory>(
      adapter,
      createFactory,
      [
        createUserAdapterFactoryInput(
          adapter,
          config,
          'Custom adapter 初始化失败',
          UserJsModelAdapter.JsonCloneScript
        ),
      ],
      'Custom adapter 初始化失败',
      UserJsModelAdapter.CallScripts
    )

    if (!isFunction(factory)) {
      throw new AppError(
        ModelErrorCodes.customAdapterInvalid,
        'Custom adapter 的 createLanguageModelFactory 必须返回一个函数。'
      )
    }

    return (modelId, options) => {
      const safeOptions = cloneValueForVm(
        adapter,
        options,
        'Custom adapter model factory 执行失败',
        UserJsModelAdapter.JsonCloneScript
      )
      const descriptor = cloneValueFromVm<unknown>(
        adapter,
        callUserAdapterFunction(
          adapter,
          factory,
          [modelId, safeOptions],
          'Custom adapter model factory 执行失败',
          UserJsModelAdapter.CallScripts
        ),
        'Custom adapter model factory 执行失败',
        UserJsModelAdapter.JsonStringifyScript
      )
      return languageModelWrappers.withPromptCache(
        createLanguageModelFromDescriptor(
          config,
          normalizeLanguageModelDescriptor(descriptor, 'Custom adapter model factory 执行失败')
        )
      )
    }
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    const adapter = this.evaluateAdapter(config)
    const createEmbeddingRequest =
      adapter.exports.createEmbeddingRequest ?? adapter.exports.default?.createEmbeddingRequest

    if (!isFunction(createEmbeddingRequest))
      return super.createEmbeddingRequest(config, model, texts)

    const input = createUserAdapterFactoryInput(
      adapter,
      config,
      'Custom adapter embedding 初始化失败',
      UserJsModelAdapter.JsonCloneScript
    ) as UserAdapterFactoryInput & {
      model: string
      texts: string[]
    }
    input.model = model
    input.texts = cloneValueForVm(
      adapter,
      texts,
      'Custom adapter embedding 初始化失败',
      UserJsModelAdapter.JsonCloneScript
    )

    const request = cloneValueFromVm<unknown>(
      adapter,
      callUserAdapterFunction(
        adapter,
        createEmbeddingRequest,
        [input],
        'Custom adapter embedding 初始化失败',
        UserJsModelAdapter.CallScripts
      ),
      'Custom adapter embedding 初始化失败',
      UserJsModelAdapter.JsonStringifyScript
    )

    return normalizeUserAdapterEmbeddingRequest(request, 'Custom adapter embedding 初始化失败')
  }

  private evaluateAdapter(config: ModelAdapterConfig): EvaluatedUserAdapter {
    const source = config.adapter?.source?.trim() ?? ''

    if (isBlank(source)) {
      throw new AppError(ModelErrorCodes.customAdapterInvalid, '请先上传 Custom Adapter JS 文件。')
    }

    const cacheKey = buildUserAdapterCacheKey(config, source)
    const cached = this.evaluatedAdapterCache.get(cacheKey)
    if (cached) return cached

    const context = createUserAdapterVmContext(UserJsModelAdapter.ContextSetupScript)

    try {
      const script = new Script(`"use strict";\n${source}`, {
        filename: config.adapter?.filename || UserAdapterFilename,
      })
      runUserAdapterScript(script, context)

      const evaluated = {
        context,
        exports: context.module.exports,
        helpers: context.helpers,
      }
      this.rememberEvaluatedAdapter(cacheKey, evaluated)
      return evaluated
    } catch (error) {
      throw new AppError(
        ModelErrorCodes.customAdapterInvalid,
        `Custom adapter 加载失败：${AppError.getMessage(error)}`
      )
    }
  }

  private rememberEvaluatedAdapter(cacheKey: string, adapter: EvaluatedUserAdapter): void {
    if (this.evaluatedAdapterCache.size >= ModelTuning.userAdapter.evaluationCacheEntries) {
      const oldestKey = this.evaluatedAdapterCache.keys().next().value
      if (isString(oldestKey)) {
        this.evaluatedAdapterCache.delete(oldestKey)
      }
    }

    this.evaluatedAdapterCache.set(cacheKey, adapter)
  }
}

export { UserJsModelAdapter }
