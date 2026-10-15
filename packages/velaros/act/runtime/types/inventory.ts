/** 当前授权能力的简短入口；完整声明与示例按需查询。 */
export interface RuntimeCapabilityHint {
  /** 程序导入的公共模块名。 */
  readonly module: string
  /** 系统组合包的值导出名。 */
  readonly member?: string
  /** 与真实模块目录同源的用途。 */
  readonly summary: string
}

/** 已安装的环境依赖；工作区覆盖以实际执行入口解析为准。 */
export interface RuntimePackageHint {
  /** npm 导入名，alias 保留别名。 */
  readonly name: string
  /** 显式选择本次宿主安装的 import，版本取 fallbackVersion。 */
  readonly runtimeImport?: string
  /** 后备安装清单的版本；工作区包可覆盖它，实际身份由执行进程目录提供。 */
  readonly fallbackVersion?: string
  /** 提供该包的已选择 Skill。 */
  readonly skill?: string
  /** 对应安装的读取诊断，避免将损坏条目误报为可用。 */
  readonly error?: string
}

/** 所选 Skill 的按需使用引子。 */
export interface RuntimeSkillHint {
  /** Skill 身份。 */
  readonly name: string
  /** 本次环境中的版本。 */
  readonly version: string
  /** 简短用途，资源正文从运行时目录按需读取。 */
  readonly description: string
}

/** 首帧及后续每帧的环境索引，数量包括因预算折叠的条目。 */
export interface RuntimeInventory {
  /** 当前已授权并可按需导入的能力。 */
  readonly capabilities: readonly RuntimeCapabilityHint[]
  /** 基础包、所选 Skill 和自管环境的已安装直接依赖。 */
  readonly packages: readonly RuntimePackageHint[]
  /** 当前 Node 环境选择的 Skill。 */
  readonly skills: readonly RuntimeSkillHint[]
  /** 各目录完整数量，超过展示数量时按需读取完整目录。 */
  readonly totals: {
    readonly capabilities: number
    readonly packages: number
    readonly skills: number
  }
  /** 当前 npm 快照身份与读取失败的诊断。 */
  readonly npm?: { readonly environment?: string; readonly error?: string }
}
