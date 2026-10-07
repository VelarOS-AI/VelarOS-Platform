import { AppError, isEmpty, isNonBlankString } from '@velaros-ai/core'

import type { LanguageNavigationService } from '../../types/language.js'
import {
  languageLabelWords,
  serviceMatchesExtensions,
} from '../../utils/language/language-queries.js'
import { normalizeExtension, sourceFileExtension } from '../../utils/language/source-files.js'

import { jsTsLanguageService } from './JsTsLanguageService.js'
import { pythonLanguageService } from './PythonLanguageService.js'

/**
 * 内置语言服务的登记处：装着哪几个语言服务，以及「这次查询该由谁来答」。
 *
 * 每轮实例按所选语言 Skill 固定服务集合；SDK 默认实例 `languageServiceRegistry` 提供全部内置服务。
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
export class LanguageServiceRegistry implements LanguageServiceRegistryApi {
  private readonly services: readonly LanguageNavigationService[]

  public constructor(languages?: readonly string[]) {
    const available = [jsTsLanguageService, pythonLanguageService]
    if (languages?.some((id) => !available.some((service) => service.id === id)))
      throw new AppError('UNAVAILABLE', '所选语言 Skill 的宿主服务不可用')
    this.services = languages
      ? available.filter((service) => languages.includes(service.id))
      : available
  }

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

    const available = this.services.map((service) => `${service.id}（${service.label}）`).join('、')
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

/** SDK 默认登记处；会话组合使用各自的实例。 */
export const languageServiceRegistry: LanguageServiceRegistryApi = new LanguageServiceRegistry()
