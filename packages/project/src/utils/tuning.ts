/**
 * 包内可调参数：超时、预算、上限、保留条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限（写进工具说明和 schema 的）在 contract/constants.ts；规则本身的数据跟着规则写在各自的 utils 文件里；类里固定用的写成类的 private static readonly。
 */

/** 项目包的可调参数，按用途分组。 */
export const ProjectTuning = Object.freeze({
  /** project:read。 */
  read: Object.freeze({
    /** 没给 maxChars 时一次调用所有文件共用的字符预算。 */
    defaultMaxChars: 24_000,
  }),
  /** project:search。 */
  search: Object.freeze({
    /** 命中合成的源码窗口总共最多多少字符（按呈现给模型的 JSON 算，含路径、版本、引用这些固定元数据）；装不下的命中只留定位。 */
    windowBudgetChars: 12_000,
  }),
  /** project:list。 */
  list: Object.freeze({
    /** 一次最多扫描多少个条目；超过就提示收窄 path 或 include。 */
    maxEntries: 100_000,
  }),
})
