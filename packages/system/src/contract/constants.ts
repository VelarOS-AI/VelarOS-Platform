/**
 * 约定的常量表（对外合同的一部分）：操作名、mod 与空间身份、错误码、环境变量表、公开的上限。
 * 宿主按这里的名字登记操作、按错误码判断失败、按环境变量表配置本包；上限直接被操作方法引用，是模型看到的数字。
 * 包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/** 代码面上七个操作的名字：模型写 `read(...)`，宿主按它登记。 */
export const SystemOperationNames = Object.freeze({
  read: 'read',
  view: 'view',
  edit: 'edit',
  run: 'run',
  refreshEnvironment: 'refreshEnvironment',
  listTasks: 'listTasks',
  sandbox: 'sandbox',
} as const)

/** 七个操作名之一。 */
export type SystemOperationName = (typeof SystemOperationNames)[keyof typeof SystemOperationNames]

/** 系统空间作为官方内置 mod 的身份。 */
export const SystemModId = 'velaros.system' as const

/** 系统空间自己的身份，mod 清单里声明的空间用它。 */
export const SystemSpaceId = 'system' as const

/**
 * 系统空间对外承诺的错误语义。
 *
 * 失败关闭是默认姿态：拿不到安全的执行条件时拒绝执行，而不是降级成裸进程或静默跳过。
 *
 * 错误分两类：
 * 1. 下面两个专属错误码。调用方可以按码分支处理，码本身是契约的一部分，不得改名。
 * 2. 通用 `AppError` 码，含义沿用 `@velaros-ai/core`：
 *    - `VALIDATION`：入参不合法，包括 wire 面出现未知字段（schema 一律严格）。
 *    - `PERMISSION`：路径或操作越过了审批边界、宿主未开放该能力，或后台任务不属于当前会话。
 *    - `NOT_FOUND`：路径、进程或后台任务不存在。
 *    - `PLATFORM`：当前操作系统不支持该操作，或平台命令本身执行失败。
 *    - `INVARIANT`：内部状态自相矛盾，属于实现缺陷，不是用户错误。
 */
export const SystemErrorCodes = Object.freeze({
  /** 找不到任何可用的命令 shell。Windows 上建议安装 Git for Windows 后刷新命令环境。 */
  shellUnavailable: 'SYSTEM_SHELL_UNAVAILABLE',
  /** 请求了受约束的进程模式，但当前宿主没有可用后端。实现必须拒绝执行，不得退回裸进程。 */
  processConfinementUnavailable: 'SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE',
  /** edit 整批定不下来（找不到、多处匹配、重叠、版本过期）：什么都没写，错误 cause.details.problems 列出每个问题，入参可复用。 */
  editUnresolved: 'SYSTEM_EDIT_UNRESOLVED',
  /** edit 里有文件的写入被用户拒绝：什么都没写。 */
  editDenied: 'SYSTEM_EDIT_DENIED',
  /** sandbox 落回时源目录里的文件自建沙箱以来变过，或者上级路径是符号链接、会写到源目录外：什么都没写，错误 cause.details.conflicts 列出每处冲突。 */
  sandboxConflict: 'SYSTEM_SANDBOX_CONFLICT',
  /** sandbox 落回时镜像在用户确认之后又变过（镜像里可能还有命令在跑）：什么都没写，重新 diff、重新确认。 */
  sandboxChanged: 'SYSTEM_SANDBOX_CHANGED',
} as const)

/**
 * 本包读写的全部环境变量。环境变量也是注入：宿主设什么、本包读什么，都在这张表里，别处不许再冒出新的变量名。
 *
 * - `input`：宿主可以设、本包读取的配置。
 * - `marker`：本包写进子进程环境的标记，子进程里的脚本可以读，宿主不要设。
 */
export const SystemEnvironmentVariables = Object.freeze({
  shellPath: {
    name: 'VELAROS_SHELL_PATH',
    direction: 'input',
    description: 'Windows 上指定用哪个 shell 的完整路径；子进程环境里也会写上实际使用的 shell 路径。',
  },
  gitBash: {
    name: 'VELAROS_GIT_BASH',
    direction: 'input',
    description: 'Windows 上 Git Bash 的 bash.exe 路径，优先于自动查找。',
  },
  processHost: {
    name: 'VELAROS_PROCESS_HOST',
    direction: 'input',
    description: 'Windows 原生进程宿主的路径，优先于默认位置。',
  },
  shellKind: {
    name: 'VELAROS_SHELL_KIND',
    direction: 'marker',
    description: '子进程所在 shell 的种类。',
  },
  shellReadiness: {
    name: 'VELAROS_SHELL_READINESS',
    direction: 'marker',
    description: 'shell 只是检测到（detected）还是已经通过自检（ready）。',
  },
  shellVersion: {
    name: 'VELAROS_SHELL_VERSION',
    direction: 'marker',
    description: '自检读到的 shell 版本。',
  },
} as const)
/** 读、看、写的上限；读看写三个工具的说明与 schema 直接引用这里，改了模型看到的数字跟着变。 */
export const SystemFileLimits = Object.freeze({
  /** 文本一次调用总共最多返回多少字符；每个文件的 maxChars 上限与缺省值也是它。 */
  readChars: 200_000,
  /** read 一次最多几个文件。 */
  readFiles: 20,
  /** view 一次最多几张图片。 */
  viewFiles: 10,
  /** edit 一次最多几个文件。 */
  editFiles: 20,
  /** edit 一个文件一次最多改几处。 */
  editsPerFile: 50,
  /** edit 改完后改动那段不超过这么多字符时，结果整段给出新内容。 */
  editWholeChars: 20_000,
  /** edit 改完后每处前后各带多少字符的新样子。 */
  editContextChars: 200,
  /** 交给模型的一张图片最大多少字节。 */
  imageBytes: 5 * 1024 * 1024,
  /** 读进来的文件最大多少字节，再大就让模型用系统命令截取。 */
  fileBytes: 20 * 1024 * 1024,
  /** 能做精确替换的文件最大多少字节。 */
  editableBytes: 2 * 1024 * 1024,
})

/** run 与 list-tasks 的上限；两个工具的说明与 schema 直接引用这里。 */
export const SystemCommandLimits = Object.freeze({
  /** run 的超时最多给多少毫秒。 */
  timeoutMs: 600_000,
  /** run 的 stdout、stderr 各最多返回多少字符。 */
  outputChars: 50_000,
  /** 后台任务条目里的 recentOutput 保留输出末尾多少字符。 */
  recentOutputChars: 4_000,
  /** list-tasks 一次最多列多少条。 */
  taskListItems: 100,
  /** 后台任务 id 最长多少字符。 */
  taskIdChars: 120,
})

