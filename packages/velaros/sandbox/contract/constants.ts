/**
 * 常量表：演练沙箱的公开上限与本机沙箱（`./local` 入口）的专属错误码。`velaros:sandbox` 的声明与宿主的沙箱实现都引这里的数字。
 * 不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/velaros/sandbox/contracts` 取）。
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

/**
 * 落回失败的专属错误码：两种都是什么都没写，调用方按码分支，码本身是契约的一部分，不得改名。
 * 没有约束后端建不出沙箱时报的是 shell 的 `SHELL_CONFINEMENT_UNAVAILABLE`（约束由跑命令的那一侧兑现）。
 */
export const SandboxErrorCodes = Object.freeze({
  /** 源目录里的文件自建沙箱以来变过，或者上级路径是符号链接、会写到源目录外：message 列出每处冲突，完整清单在 context.conflicts。 */
  conflict: 'SANDBOX_CONFLICT',
  /** 镜像在落回前核对之后又变过（镜像里可能还有命令在跑）：重新 diff 再落。 */
  changed: 'SANDBOX_CHANGED',
} as const)
