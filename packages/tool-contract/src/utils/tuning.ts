/** 可调参数表：本包内部的阈值集中在这里，每项一句说明。对外承诺的上限不在这里，在 `contract/constants.ts`。 */

/** 工具契约的可调参数：说明长度两道闸、schema 包的内联阈值、宽容修正的补项上限。 */
export const ToolContractTuning = Object.freeze({
  /** 模型面工具说明。 */
  description: Object.freeze({
    /** 单个工具说明的开发期硬上限（字符）：保底闸，不是预算；正常单一职责的工具够不到。 */
    maxChars: 6_000,
    /** 单个工具说明的软预算（字符）：复杂用法属于技能文书，不该每轮随工具清单进上下文。 */
    budgetChars: 1_800,
  }),
  /** 发给模型的工具 schema 包。 */
  schemaBundle: Object.freeze({
    /** 共享定义短于多少字符时直接内联，不单独建 $defs。 */
    inlineSharedDefChars: 120,
  }),
  /** 宽容 schema 的自动修正。 */
  forgiving: Object.freeze({
    /** 宽容 schema 修正时单个数组最多补几项。 */
    maxItems: 10,
  }),
})
