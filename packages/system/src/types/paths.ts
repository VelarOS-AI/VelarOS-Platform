/**
 * 路径判定的工作数据：敏感路径与凭证文件判定时的环境，搜索跳过受保护目录时的入参。只在包内用，不出包。
 */

/** 判断敏感路径、凭证文件时的环境：平台、家目录、临时目录、环境变量，缺省取当前进程的。临时目录不触发敏感路径审批；Windows 与 macOS 的路径按大小写不敏感比较。 */
export interface SensitiveSystemMutationPathOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  tempDir?: string
  env?: NodeJS.ProcessEnv
}

/** 判断一个候选目录是不是受系统保护、搜索时要跳过的目录：平台、家目录、搜索根、候选路径。 */
export interface SystemSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}
