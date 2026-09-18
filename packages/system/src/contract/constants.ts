/**
 * 约定的常量表（对外合同的一部分）：错误码与环境变量表。
 * 宿主按错误码判断失败、按环境变量表配置本包。模型看得见的上限在各能力包的常量表里（`@velaros-ai/velar/files` 的 `FileLimits`、
 * `@velaros-ai/velar/shell` 的 `ShellLimits`）；包内可调、不对外承诺的参数在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/**
 * 本地内核对外承诺的错误语义。
 *
 * 失败关闭是默认姿态：拿不到安全的执行条件时拒绝执行，而不是降级成裸进程或静默跳过。
 *
 * 错误分两类：
 * 1. 下面这几个专属错误码。调用方可以按码分支处理，码本身是契约的一部分，不得改名。
 * 2. 通用 `AppError` 码，含义沿用 `@velaros-ai/core`：
 *    - `VALIDATION`：入参不合法，或挑了本机没有的 shell。
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
  /** 沙箱落回时源目录里的文件自建沙箱以来变过，或者上级路径是符号链接、会写到源目录外：什么都没写，message 列出每处冲突。 */
  sandboxConflict: 'SYSTEM_SANDBOX_CONFLICT',
  /** 沙箱落回时镜像在用户确认之后又变过（镜像里可能还有命令在跑）：什么都没写，重新 diff、重新确认。 */
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
