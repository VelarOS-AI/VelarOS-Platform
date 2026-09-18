/**
 * 常量表：演练沙箱的公开上限。`velar:sandbox` 的声明与宿主的沙箱实现都引这里的数字。
 * 不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/velar/sandbox/contracts` 取）。
 */

/** 演练沙箱的公开上限。 */
export const RehearsalSandboxLimits = Object.freeze({
  /** 一个宿主内核同时最多几个沙箱。 */
  sandboxes: 5,
  /** 源目录最多多少个文件，再多建不出。 */
  files: 200_000,
  /** 源目录最多多少字节，再多建不出。 */
  bytes: 2 * 1024 * 1024 * 1024,
  /**
   * 单个文本差量最多多少字符。**只为守住内存**：差量不进模型的上下文，看多少由程序定；比这还大的文件不附差量（note 里说），
   * 渲染出来的差量超过它只留开头并标 truncated。
   */
  diffFileChars: 5_000_000,
  /** 一次 diff 的文本差量总共最多多少字符，同样只为守住内存；装不下的文件不附差量，用 paths 分几次看。 */
  diffTotalChars: 20_000_000,
  /** apply 一次最多点名多少个路径。 */
  applyPaths: 500,
  /** 沙箱 id 最长多少字符。 */
  idChars: 64,
  /** 拒绝落回时报错里最多点名几条路径。 */
  reportedPaths: 10,
})
