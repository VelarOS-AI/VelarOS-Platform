import type { RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { ChatPromptFeatureId } from '../../types/agent'
import { uniquePromptFeatures } from '../../utils/tools/prompt-feature-policy'

/**
 * 宿主没有注入提示词特性策略时的缺省实现：只做去重，其余一律空结论。
 *
 * 特性与工具类别的对应关系是产品知识，包内不做假设；缺省实现保证组装链路
 * 在无宿主策略时也能走通，而不是各处 `?.` 兜底。
 */
class DefaultPromptFeaturePolicy implements RuntimePromptFeaturePolicy {
  /** 去重，保序。 */
  public normalize(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[] {
    return uniquePromptFeatures(features)
  }

  /** 缺省下没有产品文案，直接用特性 id 当标签。 */
  public getLabel(feature: ChatPromptFeatureId): string {
    return feature
  }

  /** 缺省下不认识特性与工具类别的对应关系。 */
  public getCategoriesForFeatures(): [] {
    return []
  }

  /** 缺省下不认识工具类别与特性的对应关系。 */
  public getFeaturesForCategories(): [] {
    return []
  }

  /** 缺省下没有工具强制要求某个特性。 */
  public getRequiredFeatureForTool(): null {
    return null
  }

  /** 缺省下不认识 office 特性。 */
  public isOfficeFeature(): false {
    return false
  }
}

/** 宿主未注入时使用的缺省提示词特性策略实例。 */
const defaultRuntimePromptFeaturePolicy: RuntimePromptFeaturePolicy = new DefaultPromptFeaturePolicy()

export { defaultRuntimePromptFeaturePolicy }
