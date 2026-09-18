/**
 * 约定的常量表：身份、错误码、对外承诺的上限。
 * 这里的数字是**对外承诺**（模型看得到、宿主按它排期），可调参数在 `utils/tuning.ts`。
 */

/** 本包作为内核模块的身份。 */
export const CodeSurfaceModId = 'velaros.code-surface' as const

/** 内核模块的版本：门的工具形状（名字、入参、回执）变了就升。 */
export const CodeSurfaceKernelModuleVersion = '0.2.0' as const

/**
 * 门在模型面上的四个工具。改东西的只有 exec：跑脚本、存脚本、重放都是它的步骤；另外三个只读时间线。
 * 别的能力都在脚本里 import。
 */
export const CodeSurfaceToolNames = Object.freeze({
  /** 一次给几步，按顺序做：跑脚本、存进脚本库、改版本、退回旧版本、按记录重放。 */
  exec: 'script:exec',
  /** 列时间线：每次调用、每一步做了什么。 */
  history: 'script:history',
  /** 看时间线上的一样东西：一次调用、一步、一版脚本，或者脚本库目录。 */
  show: 'script:show',
  /** 比两样东西：两版代码逐行比，两个时间点按文件比。 */
  diff: 'script:diff',
} as const)

/** 门的工具名。 */
export type CodeSurfaceToolName = (typeof CodeSurfaceToolNames)[keyof typeof CodeSurfaceToolNames]

/** 门的工具类别：宿主在会话里打开它，门才出现在模型面前。 */
export const CodeSurfaceToolCategoryId = 'script' as const

/**
 * `script:exec` 一步能做的六件事。
 * write、edit、restore 改脚本库（先过类型检查，不跑），remove 把一个脚本从库里拿掉（各版本还在时间线上）；
 * run 跑一段代码；replay 按记录把之前的一步（或一段）再跑一遍。
 */
export const ScriptStepOps = Object.freeze(['write', 'edit', 'restore', 'remove', 'run', 'replay'] as const)

/** 一步做的事。 */
export type ScriptStepOp = (typeof ScriptStepOps)[number]

/** `script:diff` 比的是什么：两版代码逐行比，还是两个时间点之间的工作区按文件比。 */
export const ScriptDiffKinds = Object.freeze(['code', 'files'] as const)

/** diff 比的东西。 */
export type ScriptDiffKind = (typeof ScriptDiffKinds)[number]

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
  /** 在底稿上改的那组编辑落不下去（找不到、不唯一、重叠）。 */
  editFailed: 'EDIT_FAILED',
  /** 能力自己失败了且没给出码。 */
  operationFailed: 'OPERATION_FAILED',
  /** 没过类型检查：代码一行都没执行，也没存进脚本库。 */
  checkFailed: 'CHECK_FAILED',
  /** 头一次 import 按需模块：这一步没执行，交回了那个模块的完整声明。 */
  modulesNeeded: 'MODULES_NEEDED',
  /** 引用的调用、步骤或脚本版本不存在。 */
  refNotFound: 'REF_NOT_FOUND',
  /** 步骤的写法不对：字段和它的 op 对不上、脚本路径不合规。 */
  invalidStep: 'INVALID_STEP',
  /** 重放对不上：跑之前文件已经不是当时改前的样子，或者跑出来的和当时不一样。 */
  replayMismatch: 'REPLAY_MISMATCH',
} as const)

/** 十三个错误码之一。 */
export type CodeSurfaceErrorCode = (typeof CodeSurfaceErrorCodes)[keyof typeof CodeSurfaceErrorCodes]

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
  /** 一份脚本正文的字符上限。 */
  sourceChars: 60_000,
  /** 一步的 blobs 加上 input（按 JSON 算）的字符上限。 */
  blobChars: 400_000,
  /**
   * **一次提交回给模型的全部东西**（返回值、日志、插手记录、失败说明、执行账，或者诊断）序列化之后的总上限。
   *
   * 下面每条通道各有自己的上限，加起来不超过它；它自己再作为最后一道硬闸兜底——
   * 哪条通道将来加了新东西、忘了设上限，这道闸照样拦得住。这是代码面对上下文的**唯一承诺**：
   * 程序读了多大的文件、抛了多长的错、调了多少次能力，回到模型那里的都不超过这个数。
   */
  resultChars: 60_000,
  /** 返回值序列化之后的字符上限，超出按结尾保留截断。 */
  valueChars: 40_000,
  /** 日志总字符上限，超出保留结尾。 */
  logChars: 8_000,
  /**
   * 失败说明的字符上限，超出保留开头。程序可以 `throw new Error(整个文件)`——
   * 没有这一格，「正文不进上下文」就被错误通道原样走私进来了（实测过：500 万字符）。
   */
  failureChars: 2_000,
  /** 系统插手记录的总字符上限；连着的同一件事折成一条，超出的只留开头并说明省了几条。 */
  noticeChars: 4_000,
  /** 一次最多列几条诊断。后面的多半是前面那几处连带出来的，先改前面的。 */
  diagnostics: 20,
  /** 诊断的总字符上限；一条类型错的说明可以把整个展开的类型打出来，单条也要截。 */
  diagnosticChars: 8_000,
  /**
   * 一次程序最多交给模型几张图。
   *
   * 取 20 是对齐 API：一个请求里超过 20 张图时，**每张**都得不超过 2000 px，否则整个请求被拒——
   * 而且历史里重发的图也算。一次程序自己先守住 20 张，单次不会把请求推过那条线。
   */
  images: 20,
  /** 一次程序交出的图 base64 合计上限；请求体整个才 32 MB，还得给历史留地方。 */
  imageChars: 20 * 1024 * 1024,
  /** 一次程序最多能发多少次能力调用；防住 `while(true)` 里调接口。 */
  calls: 200,
  /** 程序的墙钟上限（毫秒）。 */
  timeoutMs: 120_000,
  /** `script:exec` 一次最多几步。 */
  steps: 50,
  /** `script:history` 一次最多列几条。 */
  historyEntries: 200,
  /** `script:history` 不给 limit 时列最近几条。 */
  historyDefaultEntries: 30,
  /** 脚本库路径的字符上限。 */
  scriptPathChars: 160,
} as const)
