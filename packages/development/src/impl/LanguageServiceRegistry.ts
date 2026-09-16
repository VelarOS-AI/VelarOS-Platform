import { AppError, isEmpty, isNonBlankString } from '@velaros-ai/core'

import type { LanguageNavigationService } from '../types/language.js'
import { languageLabelWords, serviceMatchesExtensions } from '../utils/language-queries.js'
import { normalizeExtension, sourceFileExtension } from '../utils/source-files.js'

import { jsTsLanguageService } from './JsTsLanguageService.js'
import { pythonLanguageService } from './PythonLanguageService.js'

/**
 * 内置语言服务的登记处：装着哪几个语言服务，以及「这次查询该由谁来答」。
 *
 * 实例是 `languageServiceRegistry`，构造时就装好两个内置服务——注册不再是 import 时的副作用，
 * `src` 下没有一个文件光被 import 就会改变进程状态。
 */
export interface LanguageServiceRegistryApi {
  /** 列出全部已装的语言服务。 */
  listServices(): LanguageNavigationService[]
  /**
   * 把调用方给的 `language` 解析成语言服务。
   *
   * 模型很少知道内部 id（`jsts`），常写 `typescript`、`ts`、`py`；所以服务 id、名称里的语言词、
   * 扩展名简写都认，大小写不敏感。认不出时返回空数组。
   */
  resolveLanguageServices(language: string): LanguageNavigationService[]
  /**
   * `language` 认不出就当场失败并列出可用值。
   *
   * 静默选中零个服务只会得到一份看似「无结果」的空答复，模型会当成「项目里没有」。
   * 没写 `language` 时直接放行，由路径扩展名选服务。失败时抛 `VALIDATION`。
   */
  assertKnownLanguage(language: LooseOptional<string>): void
  /**
   * 选出这次查询要问的语言服务：写了 `language` 就按它，否则按具体路径的扩展名，
   * 再否则按调用方给的 `extensions` 过滤；都没有就是全部服务。
   */
  selectLanguageServices(input: {
    language?: string
    path?: string
    targetPath?: string
    extensions?: string[]
  }): LanguageNavigationService[]
}

/** 内置语言服务的登记处，见接口说明。 */
class LanguageServiceRegistry implements LanguageServiceRegistryApi {
  private readonly services: readonly LanguageNavigationService[] = [
    jsTsLanguageService,
    pythonLanguageService,
  ]

  public listServices(): LanguageNavigationService[] {
    return [...this.services]
  }

  public resolveLanguageServices(language: string): LanguageNavigationService[] {
    const requested = language.trim().toLowerCase()
    const byId = this.services.filter((service) => service.id.toLowerCase() === requested)
    if (!isEmpty(byId)) return [...byId]

    const extension = normalizeExtension(requested)
    return this.services.filter(
      (service) =>
        service.extensions.map(normalizeExtension).includes(extension) ||
        languageLabelWords(service.label).includes(requested)
    )
  }

  public assertKnownLanguage(language: LooseOptional<string>): void {
    if (!isNonBlankString(language) || !isEmpty(this.resolveLanguageServices(language))) return

    const available = this.services
      .map((service) => `${service.id}（${service.label}）`)
      .join('、')
    throw new AppError(
      'VALIDATION',
      `language "${language}" 没有对应的语言服务，可用：${available}。省略 language 时按 path 的扩展名自动选择。`
    )
  }

  public selectLanguageServices(input: {
    language?: string
    path?: string
    targetPath?: string
    extensions?: string[]
  }): LanguageNavigationService[] {
    if (isNonBlankString(input.language)) return this.resolveLanguageServices(input.language)

    const concretePath = input.targetPath ?? input.path
    const extension = concretePath ? sourceFileExtension(concretePath) : ''
    if (extension) {
      const matched = this.services.filter((service) =>
        service.extensions.map(normalizeExtension).includes(extension)
      )
      if (!isEmpty(matched)) return [...matched]
    }

    return this.services.filter((service) => serviceMatchesExtensions(service, input.extensions))
  }
}

/** 进程内唯一的一份登记处。 */
export const languageServiceRegistry: LanguageServiceRegistryApi = new LanguageServiceRegistry()
