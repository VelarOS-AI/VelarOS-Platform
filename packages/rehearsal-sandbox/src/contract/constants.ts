/**
 * 常量表：演练沙箱的公开上限与落回审批的操作身份。`velar:sandbox` 的声明、项目空间的工具说明与 schema、宿主的沙箱实现都引这里的数字。
 * 不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/rehearsal-sandbox/contracts` 取）。
 */

/** 演练沙箱的公开上限。 */
export const RehearsalSandboxLimits = Object.freeze({
  /** 一个宿主内核同时最多几个沙箱。 */
  sandboxes: 5,
  /** 源目录最多多少个文件，再多建不出。 */
  files: 200_000,
  /** 源目录最多多少字节，再多建不出。 */
  bytes: 2 * 1024 * 1024 * 1024,
  /** diff 新增与修改两列缺省各列多少条。 */
  diffFiles: 200,
  /** diff 新增与修改两列最多各列多少条（maxFiles 的上限）；apply 前向用户确认用的是不截断的完整差量，不受它限制。 */
  diffFilesMax: 2000,
  /** 一次 diff 最多附多少个文本差量。 */
  textDiffs: 200,
  /** 单个文本差量最多多少字符。 */
  diffFileChars: 200_000,
  /** 一次 diff 的文本差量总共最多多少字符。 */
  diffTotalChars: 2_000_000,
  /** apply 一次最多点名多少个路径。 */
  applyPaths: 500,
  /** 沙箱 id 最长多少字符。 */
  idChars: 64,
  /** 拒绝落回时报错里最多点名几条路径。 */
  reportedPaths: 10,
})

/** 落回审批的操作身份种类：参数是沙箱 id、确认时的差量指纹与三列条数；镜像在确认之后又变过，就不是同一个操作。 */
export const SandboxApplyOperationKind = 'sandbox-apply' as const
