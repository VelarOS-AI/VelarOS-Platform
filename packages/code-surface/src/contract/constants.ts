/**
 * 约定的常量表：身份、错误码、对外承诺的上限。
 * 这里的数字是**对外承诺**（模型看得到、宿主按它排期），可调参数在 `utils/tuning.ts`。
 */

/** 本包作为内核模块的身份。 */
export const CodeSurfaceModId = 'velaros.code-surface' as const

/** 代码面的错误码；模型与宿主都按码判断，不按报错文字。 */
export const CodeSurfaceErrorCodes = Object.freeze({
  /** 程序自己抛了。 */
  programError: 'PROGRAM_ERROR',
  /** 超过时间上限被终止。 */
  timeout: 'TIMEOUT',
  /** 被用户或宿主中止。 */
  aborted: 'ABORTED',
  /** 隔离进程没起来或中途死了。 */
  runnerCrashed: 'RUNNER_CRASHED',
  /** 程序调了一个宿主没有登记的能力。 */
  unknownOperation: 'UNKNOWN_OPERATION',
  /** 程序超过了体量上限（源码、blobs、返回值）。 */
  tooLarge: 'TOO_LARGE',
  /** 在上一份程序上改的那组编辑落不下去（找不到、不唯一、重叠、没有上一份）。 */
  editFailed: 'EDIT_FAILED',
  /** 调用的入参没过能力那一侧的校验；程序**还没动手**。 */
  invalidInput: 'INVALID_INPUT',
  /** 能力自己失败了且没给出码。 */
  operationFailed: 'OPERATION_FAILED',
} as const)

/** 九个错误码之一。 */
export type CodeSurfaceErrorCode = (typeof CodeSurfaceErrorCodes)[keyof typeof CodeSurfaceErrorCodes]

/**
 * 审批模块的命名空间：`import { request } from 'velar:approval'`。
 *
 * 审批自成一个模块，而不是每次调用时弹一次，换来两件事：
 * 一是**类型系统替我们把门焊死**——要 grant 的操作在声明里就要一个 grant 参数，
 * 拿不到 grant 的程序**编译不过**，根本轮不到运行期去拦；
 * 二是宿主**看得见程序什么时候在等人**（就是这个命名空间的调用），于是能把等人的时间从超时里扣掉。
 */
export const ApprovalNamespace = 'approval' as const

/**
 * 「找不到这个模块」的 TypeScript 诊断码。
 *
 * `import { x } from 'velar:git'` 而 git 没授权时就是它。认这个专属码就够了，不用自己写判定——
 * **那道「非常驻能力必须先导入」的闸是语言给的**，我们只是认出它。
 */
export const CodeSurfaceDiagnosticCodes = Object.freeze({
  /** `Cannot find module 'velar:git'`：import 了没授权的能力模块。 */
  unresolvedModule: 2307,
} as const)

/**
 * 对外承诺的上限。超过就拒，不截断后照跑——半截程序跑出来的结果比不跑更坏。
 * 返回值与日志是例外：它们在跑完之后才知道大小，按预算截断并在 `notices` 里说明。
 */
export const CodeSurfaceLimits = Object.freeze({
  /** 程序正文的字符上限。 */
  sourceChars: 60_000,
  /** 所有 blobs 加起来的字符上限。 */
  blobChars: 400_000,
  /** 返回值序列化之后的字符上限，超出按结尾保留截断。 */
  valueChars: 40_000,
  /** 日志总字符上限，超出保留结尾。 */
  logChars: 8_000,
  /** 一次程序最多能发多少次能力调用；防住 `while(true)` 里调接口。 */
  calls: 200,
  /** 程序的墙钟上限（毫秒）。 */
  timeoutMs: 120_000,
} as const)
