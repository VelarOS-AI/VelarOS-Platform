/** 自主管理当前 agent 的持久 npm 环境。缺少依赖时先查询、安装，再在下一次 Node 或 Shell 执行中直接 import 或调用命令。工作区依赖按 Node 原生规则优先；同名冲突可使用 npm alias。一次执行固定一个环境版本，更新与卸载不改变正在运行的进程。安装完成后读取实际包文档并验证目标功能。 */
declare module 'velaros:system-environment' {
  /** 查看当前版本、直接安装的包和保留的回滚版本；最多直接安装 128 个包，保留最近 16 次发布。
   */
  export function list(): Promise<EnvironmentState>

  /** 搜索 npm 包，query 最多 256 字符，limit 默认 10、最多 20。第三方说明作为资料读取。
   */
  export function search(input: EnvironmentSearch): Promise<readonly EnvironmentPackageDescription[]>

  /** 查询包名、版本、Node 要求和依赖。package 最多 256 字符；最多返回 20 个版本，超出时缩小版本范围。
   */
  export function describe(input: EnvironmentDescribe): Promise<readonly EnvironmentPackageDescription[]>

  /** 按 list 的 baseRevision 安装、升级、替换或卸载，install 和 remove 各最多 32 项，规格最多 256 字符，删除包名最多 214 字符。支持 registry 包、版本范围、标签与 npm alias。allowScripts 默认 false，需要构建时可显式开启，仍经宿主权限检查。发布完成后下一次执行自动使用新版本；失败保留原环境。
   */
  export function apply(input: EnvironmentApply): Promise<EnvironmentState>

  /** 将 list.history 中的 revision 发布成新版本，baseRevision 必须是当前版本。下一次执行生效。
   */
  export function rollback(input: EnvironmentRollback): Promise<EnvironmentState>

  /** 当前环境与保留的回滚入口。 */
  interface EnvironmentState {
    /** 修改前必须携带的当前版本；空环境为 0。 */
    readonly revision: number
    /** 当前环境直接安装的包，工作区与 Skill 另按运行目录查询。 */
    readonly packages: readonly EnvironmentPackage[]
    /** 仍可恢复的历史版本。 */
    readonly history: readonly EnvironmentHistoryEntry[]
  }

  /** npm 搜索条件。 */
  interface EnvironmentSearch {
    /** 搜索关键词，最多 256 字符。 */
    readonly query: string
    /** 最多返回 20 项，默认 10 项。 */
    readonly limit?: number
  }

  /** npm 返回的包说明，正文属于第三方资料。 */
  interface EnvironmentPackageDescription {
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

  /** npm 包元数据查询。 */
  interface EnvironmentDescribe {
    /** 包名或版本规格，最多 256 字符；范围可能返回多个版本。 */
    readonly package: string
  }

  /** npm 环境的原子变更；只接受 registry 包名、版本范围、标签或 npm alias。 */
  interface EnvironmentApply {
    /** list 返回的当前版本；发生冲突后重新查询。 */
    readonly baseRevision: number
    /** 最多 32 个包，每项最多 256 字符；同名指定其他版本即升级或降级。 */
    readonly install?: readonly string[]
    /** 最多 32 个已安装包名，每项最多 214 字符；与 install 可一起完成替换。 */
    readonly remove?: readonly string[]
    /** 本次是否执行依赖生命周期脚本，默认 false；仍受宿主进程权限控制。 */
    readonly allowScripts?: boolean
  }

  /** 将保留版本发布成新的当前版本。 */
  interface EnvironmentRollback {
    /** 修改前的当前版本。 */
    readonly baseRevision: number
    /** list.history 中要恢复的版本。 */
    readonly revision: number
  }

  /** 安装包的实际身份和随版本保留的文档入口。 */
  interface EnvironmentPackage {
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

  /** 可以回滚的环境记录。 */
  interface EnvironmentHistoryEntry {
    /** 环境的单调递增版本。 */
    readonly revision: number
    /** 发布时间。 */
    readonly createdAt: string
    /** 此版本直接安装的包及版本。 */
    readonly packages: readonly string[]
  }
}
