/**
 * 可移植数据：一条 .gitignore 规则、匹配选项、一个待判定的遍历条目。不 import、不用 Node 类型、不带函数成员。
 */

/**
 * 一条解析好的 .gitignore 规则。`patterns` 是这一行展开成的、相对规则根的 glob（不含「它下面的一切」，
 * 那一层由判定时按各级上级目录推出来）：不锚定的规则展开成「本目录下」与「任意层级下」两条。
 */
export interface GitignoreRule {
  /** `!` 开头的反向规则：命中时把路径从忽略里捞回来。 */
  readonly negated: boolean
  /** 以 `/` 结尾的规则只匹配目录：同名的文件不算命中，目录里的东西照样连带命中。 */
  readonly directoryOnly: boolean
  /** 这一行展开成的 glob。 */
  readonly patterns: readonly string[]
}

/** 匹配路径时的选项。 */
export interface PathMatchOptions {
  /** 区不区分大小写；缺省区分（git 自己的规则就是区分的），大小写不敏感的盘上按路径身份判定时传 false。 */
  readonly caseSensitive?: boolean
}

/** 一个待判定的遍历条目：绝对路径，以及它是不是目录（目录限定的规则要用）。 */
export interface IgnoreCandidate {
  readonly absolutePath: string
  readonly isDirectory: boolean
}

/** 忽略规则从哪一级算起：`repository` 先往上找版本库根（找不到就什么都不跳）；`root` 就以给的根为准。 */
export type IgnoreRulesOrigin = 'repository' | 'root'
