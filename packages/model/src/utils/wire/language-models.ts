/** 语言模型对象的规格判定：谁能被本包的包装层包住。 */

import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import { isString } from '@velaros-ai/core'

/** 只有 v3 的模型对象包得住：字符串模型与老规格返回 null，调用方原样用原模型。 */
export function asWrappableLanguageModel(model: LanguageModel): Nullable<LanguageModelV3> {
  if (isString(model) || model.specificationVersion !== 'v3') return null

  return model
}
