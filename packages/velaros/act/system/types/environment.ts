/** @AgentView 安装包的实际身份和随版本保留的文档入口。 */
export interface EnvironmentPackage {
  /** 程序使用的 import 名，npm alias 使用别名。 */
  readonly name: string
  /** 包实际声明的名称。 */
  readonly package: string
  /** 已安装的精确版本。 */
  readonly version: string
  /** 拥有 node_modules 的绝对目录。 */
  readonly directory: string
  /** 原始包清单的绝对路径。 */
  readonly packageJson: string
  /** 包内 README，未提供时为空。 */
  readonly readme?: string
  /** 包声明的命令名。 */
  readonly commands: readonly string[]
}

/** @AgentView 可以回滚的环境记录。 */
export interface EnvironmentHistoryEntry {
  /** 环境的单调递增版本。 */
  readonly revision: number
  /** 发布时间。 */
  readonly createdAt: string
  /** 此版本直接安装的包及版本。 */
  readonly packages: readonly string[]
}

/** @AgentView 当前环境与保留的回滚入口。 */
export interface EnvironmentState {
  /** 修改前必须携带的当前版本；空环境为 0。 */
  readonly revision: number
  /** 当前环境直接安装的包，工作区与 Skill 另按运行目录查询。 */
  readonly packages: readonly EnvironmentPackage[]
  /** 仍可恢复的历史版本。 */
  readonly history: readonly EnvironmentHistoryEntry[]
}

/** @AgentView npm 环境的原子变更；只接受 registry 包名、版本范围、标签或 npm alias。 */
export interface EnvironmentApply {
  /** list 返回的当前版本；发生冲突后重新查询。 */
  readonly baseRevision: number
  /** 最多 32 个包，每项最多 256 字符；同名指定其他版本即升级或降级。 */
  readonly install?: readonly string[]
  /** 最多 32 个已安装包名，每项最多 214 字符；与 install 可一起完成替换。 */
  readonly remove?: readonly string[]
  /** 本次是否执行依赖生命周期脚本，默认 false；仍受宿主进程权限控制。 */
  readonly allowScripts?: boolean
}

/** @AgentView 将保留版本发布成新的当前版本。 */
export interface EnvironmentRollback {
  /** 修改前的当前版本。 */
  readonly baseRevision: number
  /** list.history 中要恢复的版本。 */
  readonly revision: number
}

/** @AgentView npm 搜索条件。 */
export interface EnvironmentSearch {
  /** 搜索关键词，最多 256 字符。 */
  readonly query: string
  /** 最多返回 20 项，默认 10 项。 */
  readonly limit?: number
}

/** @AgentView npm 包元数据查询。 */
export interface EnvironmentDescribe {
  /** 包名或版本规格，最多 256 字符；范围可能返回多个版本。 */
  readonly package: string
}

/** @AgentView npm 返回的包说明，正文属于第三方资料。 */
export interface EnvironmentPackageDescription {
  /** npm 包名。 */
  readonly name: string
  /** npm 返回的精确版本。 */
  readonly version: string
  /** 有界用途说明。 */
  readonly description?: string
  /** 项目主页。 */
  readonly homepage?: string
  /** 需要的 Node 和工具版本。 */
  readonly engines?: Readonly<Record<string, string>>
  /** 直接依赖。 */
  readonly dependencies?: Readonly<Record<string, string>>
  /** 宿主需要同时提供的依赖。 */
  readonly peerDependencies?: Readonly<Record<string, string>>
}

/** 持久环境的不可变安装内容。 */
export interface EnvironmentGeneration {
  /** 独占安装目录的 UUID。 */
  readonly id: string
  /** 已完成核验的直接包。 */
  readonly packages: readonly EnvironmentPackage[]
  /** 清单和锁文件内容指纹。 */
  readonly digest: string
}

/** 当前环境指针和有界历史，整份原子发布。 */
export interface EnvironmentIndex {
  /** 存储格式版本。 */
  readonly format: 1
  /** 当前指针的单调版本。 */
  readonly revision: number
  /** 按发布顺序保留的完整记录，最后一项是当前环境。 */
  readonly entries: readonly EnvironmentRevision[]
}

/** 单次环境发布的持久记录。 */
export interface EnvironmentRevision {
  /** 发布版本。 */
  readonly revision: number
  /** 发布时刻。 */
  readonly createdAt: string
  /** 已核验的安装内容；回滚复用同一内容。 */
  readonly generation: EnvironmentGeneration
}
