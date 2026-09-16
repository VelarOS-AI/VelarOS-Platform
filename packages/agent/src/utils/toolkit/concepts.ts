/** 工具说明共用的约束句：表与取值都在 `@velaros-ai/tool-contract`，这里按原名转发。 */

import { GlobalToolConcepts, toolDescriptions } from '@velaros-ai/tool-contract'

import type { ToolConceptRegistry } from '../../types/toolkit.js'

/** 登记一张工具概念表（概念 id → 写给模型看的中文约束句）；运行期原样返回，只为让 TS 推出字面量 key 类型。 */
function defineToolConcepts<TConcepts extends ToolConceptRegistry>(concepts: TConcepts): TConcepts {
  return toolDescriptions.defineConcepts(concepts)
}

/** 基于一张概念表造一个取值函数：id 必须是表里已登记的 key，写错在编译期就报错。 */
function createToolConceptLookup<TConcepts extends ToolConceptRegistry>(concepts: TConcepts) {
  return toolDescriptions.conceptLookup(concepts)
}

/** 取一句全局共用的约束句；概念 id 写错是编译期错误。 */
function globalToolConcept<TId extends keyof typeof GlobalToolConcepts>(
  id: TId
): (typeof GlobalToolConcepts)[TId] {
  return toolDescriptions.concept(id)
}

export {
  createToolConceptLookup,
  defineToolConcepts,
  globalToolConcept,
  GlobalToolConcepts,
}
