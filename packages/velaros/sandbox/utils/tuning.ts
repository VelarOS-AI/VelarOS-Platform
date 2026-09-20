/**
 * 包内可调参数：读多少字节、点名多少条。都是取舍，没有唯一正确的值；要调就改这一个文件，全单元跟着变。
 * 对外承诺的上限不在这里，在 `contract/constants.ts`（`RehearsalSandboxLimits`）。
 */

/** 演练沙箱的可调参数。 */
export const SandboxTuning = Object.freeze({
  /** 镜像时 `.git` 链接文件只读开头这么多字节，认出它指向哪个仓库。 */
  gitLinkBytes: 8192,
  /** 报错里最多点名多少条路径（冲突、没有变化的路径）；完整清单在错误的 context 里。 */
  listedPaths: 20,
})
