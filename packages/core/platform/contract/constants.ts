/**
 * 约定的常量表（对外合同的一部分）：本包读的环境变量。宿主设什么、本包读什么，都在这里。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/** 本包读的全部环境变量：宿主设什么、本包读什么，都在这张表里，别处不许再冒出新的变量名。 */
export const PlatformEnvironmentVariables = Object.freeze({
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
  sharedDataRoot: {
    name: 'VELAROS_SHARED_DATA_ROOT',
    direction: 'input',
    description: 'VelarOS 产品家族共享数据的根目录，覆盖按平台算出的默认位置。',
  },
} as const)

/** 环境变量表里的一项。 */
export type PlatformEnvironmentVariable = (typeof PlatformEnvironmentVariables)[keyof typeof PlatformEnvironmentVariables]
