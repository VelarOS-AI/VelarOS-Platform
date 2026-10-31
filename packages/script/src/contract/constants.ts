/**
 * 约定的常量表：身份、错误码、对外承诺的上限。
 * 这里的数字是**对外承诺**（模型看得到、宿主按它排期），可调参数在 `utils/tuning.ts`。
 */

/** 标准 Node 子进程的宿主桥环境变量。 */
export const NodeEnvironmentVariables = Object.freeze({
  directory: {
    name: 'VELAROS_HOST_DIR',
    direction: 'output',
    description: '本次执行可读取的宿主能力目录。',
  },
  output: {
    name: 'VELAROS_OUTPUT_FILE',
    direction: 'output',
    description: '本次执行的有界结构化输出归档文件。',
  },
  socket: {
    name: 'VELAROS_HOST_SOCKET',
    direction: 'output',
    description: '本次执行连接的本机能力桥地址。',
  },
  token: {
    name: 'VELAROS_HOST_TOKEN',
    direction: 'output',
    description: '本次执行的短期能力桥凭据。',
  },
})

/** 标准进程与宿主桥的内存、磁盘预算。 */
export const NodeExecutionLimits = Object.freeze({
  /** 单次能力参数上限；覆盖大文本合同与 JSON 转义，最终仍由领域核验数据预算。 */
  requestBytes: 128 * 1024 * 1024,
  /** 结构化 JSON 归档的 UTF-8 字节上限，覆盖多字节文本与元数据。 */
  outputBytes: 8 * 1024 * 1024,
  /** 单次能力结果的 UTF-8 字节上限。 */
  responseBytes: 128 * 1024 * 1024,
  /** 单次程序输出归档的字节上限。 */
  logBytes: 16 * 1024 * 1024,
  /** stdout 与 stderr 各自可见的字符上限。 */
  previewChars: 24_000,
  /** 单次执行最多派发的能力调用数。 */
  calls: 200,
})

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
  /** 能力自己失败了且没给出码。 */
  operationFailed: 'OPERATION_FAILED',
} as const)

/** 脚本执行错误码之一。 */
export type CodeSurfaceErrorCode =
  (typeof CodeSurfaceErrorCodes)[keyof typeof CodeSurfaceErrorCodes]

/**
 * import 落不到时的诊断码，沿用 TypeScript 的编号：和 ES 模块链接时一样，这两种在执行之前就报。
 *
 * `import { x } from 'velaros:git'` 而 git 没授权时是 `unresolvedModule`；
 * 模块在、名字不在（`import { readFile } from 'velaros:project'`）时是 `missingExport`。
 */
export const CodeSurfaceDiagnosticCodes = Object.freeze({
  /** 找不到模块：import 了没授权的能力模块、不是能力模块的名字，或者库里没有的脚本。 */
  unresolvedModule: 2307,
  /** 模块没有这个导出：名字照声明核对。 */
  missingExport: 2305,
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
  /** 程序的缺省计时上限及观察程序的最大计时（毫秒）。 */
  timeoutMs: 120_000,
  /** Node 一次性程序显式申请的最大计时；父任务取消仍独立生效（毫秒）。 */
  maxExecutionTimeoutMs: 86_400_000,
  /** 程序附属模块的相对路径字符上限。 */
  scriptPathChars: 160,
} as const)

/** 单次增量提交的定位数量上限，全文提交沿用源码体量限制。 */
export const CodeProgramEditLimits = Object.freeze({
  /** 一次提交最多定位 32 处替换。 */
  edits: 32,
})

/**
 * 输出采集和展示的硬上限；原始值与模型展示分别计量。
 * 写进 output 声明的数与这里一致由验收核对；validateOutputOptions 要整段注入隔离堆、不能引用这张表，它的边界同样由验收对着这张表核对。
 */
export const ScriptOutputLimits = Object.freeze({
  /** 一次执行的输出块上限。 */
  blocks: 64,
  /** 原始 JSON 输出合计上限，避免 IPC 和归档无限增长。 */
  rawChars: 1_000_000,
  /** 单份声明或问题的字符上限。 */
  metadataChars: 4000,
  /** 默认展示预算。 */
  displayChars: 16_000,
  /** 允许申请的最大展示预算，实际分配仍由请求编译器决定。 */
  maxDisplayChars: 200_000,
  /** 捕获问题最多保留条数。 */
  issues: 16,
  /** JSON 值嵌套层数上限。 */
  depth: 64,
  /** 输出 key 最多多少字符。 */
  keyChars: 96,
  /** 输出 purpose 最多多少字符。 */
  purposeChars: 1000,
  /** 代码块的语言标签最多多少字符。 */
  languageChars: 80,
  /** view.paths 最多几个 JSON Pointer。 */
  paths: 64,
})

/** 显式导入本次宿主 npm 安装；裸包名仍按工作区 Node 规则解析。 */
export const NodeRuntimePackagePrefix = 'velaros:npm/' as const

/** Node 执行环境预装的标准 npm 包；工作区自带依赖优先。 */
export const NodeDefaultPackages = Object.freeze([
  'execa',
  '@vscode/ripgrep',
  'globby',
  'diff',
  'yaml',
  'fs-extra',
  'ts-morph',
  'typescript',
  'prettier',
  'cheerio',
  'csv-parse',
  'csv-stringify',
  'lodash-es',
  'date-fns',
  'p-limit',
  'jszip',
  'zod',
] as const)
