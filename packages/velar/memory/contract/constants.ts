/**
 * 约定的常量表（对外合同的一部分）：`velar:memory` 的四个类别与公开上限。
 * 上限直接被入参核对引用，也是模型在声明里看到的数字（两边一致由验收核对）；包内可调、不对外承诺的参数在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./memory/contracts` 入口出单元。
 */

/** 记忆的四个类别，也是开场索引里分组的顺序：user 用户、feedback 反馈、work 工作、reference 参考。 */
export const MemoryTypes = Object.freeze(['user', 'feedback', 'work', 'reference'] as const)

/** `velar:memory` 对外承诺的上限。 */
export const MemoryLimits = Object.freeze({
  /** id 最多几个字符：id 就是文件名。 */
  idChars: 64,
  /** 标题最多几个字符。 */
  titleChars: 100,
  /** 描述（进索引的那一句）最多几个字符。 */
  descriptionChars: 200,
  /** 正文最多几个字符。 */
  contentChars: 20_000,
  /** 一条最多几个标签。 */
  tagCount: 8,
  /** 一个标签最多几个字符。 */
  tagChars: 32,
})
