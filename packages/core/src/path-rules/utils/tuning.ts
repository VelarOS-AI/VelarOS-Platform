/**
 * 可调参数：编译好的匹配器缓存多少条。对外承诺的东西不在这里，在 `contract/constants.ts`。
 */

/** 本包的可调参数，一处改全包生效。 */
export const PathRulesTuning = Object.freeze({
  /** glob 匹配。 */
  glob: Object.freeze({
    /** 编译好的 glob 匹配器最多缓存几条（按 pattern 与大小写敏感与否分别算一条），超了淘汰最久没用的。 */
    matcherCacheEntries: 256,
  }),
})
