/**
 * 路径判定的工作数据：搜索跳过受保护目录时的入参。只在包内用，不出包。
 */

/** 判断一个候选目录是不是受系统保护、搜索时要跳过的目录：平台、家目录、搜索根、候选路径。 */
export interface SystemSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}
