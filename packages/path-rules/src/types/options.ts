/**
 * 带注入口的选项数据：建忽略策略时怎么算规则、问不问 git。只放数据；带行为的接口在各自的类上方（`impl/`），由 `contract/provides.ts` 登记。
 */

import type { GitCheckIgnoreRunner } from '../contract/requires.js'

import type { IgnoreRulesOrigin } from './path-rules.js'

/** 建一份遍历忽略策略的选项。 */
export interface IgnorePolicyOptions {
  /** 不受限：什么都不跳过。 */
  unrestricted?: boolean
  /** 规则从哪一级算起，缺省 `root`（给的根就是规则根，工作区用）；`repository` 先往上找版本库根（搜索用）。 */
  rulesFrom?: IgnoreRulesOrigin
  /** 问 git 的执行口；不给或返回 null 时按本地 .gitignore 规则判。 */
  gitCheckIgnore?: GitCheckIgnoreRunner
}
