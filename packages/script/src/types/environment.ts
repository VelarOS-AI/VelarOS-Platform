/** 运行环境公开的标准 npm 包；directory 是拥有 node_modules 的安装根。 */
export interface NodeRuntimePackage {
  /** npm 或 Skill 的公开身份。 */
  readonly name: string
  /** 锁定的实际安装版本。 */
  readonly version: string
  /** 资源和依赖所在的绝对目录。 */
  readonly directory: string
  /** 提供此包的 Skill；基础包省略。 */
  readonly skill?: string
}

/** 本次程序入口可发现的包；工作区解析优先，查询失败只影响对应条目。 */
export interface NodeRuntimePackageReference {
  /** 程序使用的导入名，可能与 npm alias 对应的原包名不同。 */
  readonly name: string
  /** 当前入口解析的来源；runtime 表示使用运行环境的后备安装。 */
  readonly source: 'workspace' | 'runtime'
  /** 实际包清单的版本；清单未声明或无法读取时省略。 */
  readonly version?: string
  /** 提供后备安装的 Skill；工作区依赖及基础包省略。 */
  readonly skill?: string
  /** 实际包目录，可读取随版本安装的文档、声明和实现。 */
  readonly root?: string
  /** 当前安装包的原始 package.json，包含 API 导出与类型入口。 */
  readonly packageJson?: string
  /** 包自带 README 的绝对路径；没有提供时省略。 */
  readonly readme?: string
  /** 查询失败的原始诊断；不替换成其他版本，也不阻止无关程序执行。 */
  readonly error?: { readonly code: string; readonly message: string }
}

/** Skill 的发现卡片；说明正文和资源保留在安装目录，按需读取。 */
export interface NodeRuntimeSkill {
  /** npm 或 Skill 的公开身份。 */
  readonly name: string
  /** 锁定的实际安装版本。 */
  readonly version: string
  /** 用于按需发现的简短用途。 */
  readonly description: string
  /** 资源和依赖所在的绝对目录。 */
  readonly directory: string
  /** 包内说明入口的相对路径。 */
  readonly instructions?: string
  /** Agent 可直接导入的标准 npm 包。 */
  readonly packages: readonly string[]
  /** 当前授权的宿主能力模块。 */
  readonly capabilities: readonly string[]
}

/** 不可变的运行环境快照；宿主可在每次执行时获取新的依赖版本。 */
export interface NodeRuntimeEnvironment {
  /** 固定本次依赖与所选 Skill 的环境身份。 */
  readonly id: string
  /** Agent 可直接导入的标准 npm 包。 */
  readonly packages: readonly NodeRuntimePackage[]
  /** 按需加载说明与资源的 Skill 卡片。 */
  readonly skills: readonly NodeRuntimeSkill[]
}
