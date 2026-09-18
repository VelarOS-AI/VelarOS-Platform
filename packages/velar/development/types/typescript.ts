/**
 * TypeScript 语言服务池的包内工作类型：一次解析出来的项目配置、两级缓存的条目、一次 acquire 的凭据。
 * 引 `typescript` 的类型，所以不放进可移植数据文件，也不出包。
 */
import type * as ts from 'typescript'

/** 一个（项目根，tsconfig）解析出来的配置：编译选项、根文件与用来判失效的指纹。 */
export interface TypeScriptProjectConfig {
  /** 项目根的绝对路径。 */
  projectRoot: string
  /** 配置所在目录（没有配置时退到最近的 package.json 目录或项目根）。 */
  projectDirectory: string
  /** 命中的 tsconfig / jsconfig 绝对路径；一个都没有时为 `null`。 */
  configPath: Nullable<string>
  /** 解析后的编译选项，已按请求文件做过 allowJs 与模块推断的微调。 */
  compilerOptions: ts.CompilerOptions
  /** 配置展开出来的根文件；无配置时为空数组，由磁盘枚举兜底。 */
  fileNames: string[]
  /** 配置声明的项目引用。 */
  projectReferences?: readonly ts.ProjectReference[]
  /** 参与推断的 package.json 路径（最近的那个在前）。 */
  packageJsonPaths: string[]
  /** 配置、源码与依赖清单的指纹；变了就整项重建。 */
  fingerprint: string
}

/** 配置缓存的一条：解析好的配置加那一刻的磁盘源码快照。 */
export interface TypeScriptProjectCacheEntry {
  /** 缓存键，`项目根\0配置路径`，池与配置缓存同用一把。 */
  cacheKey: string
  /** 解析好的配置。 */
  config: TypeScriptProjectConfig
  /** 磁盘上的源码快照：overlay 退场时按它还原。 */
  diskFiles: Map<string, string>
}

/** 池里一个活的 `ts.LanguageService` 及它的文件表、版本表与 overlay 集合。 */
export interface PooledTypeScriptProject {
  /** 项目根的绝对路径。 */
  projectRoot: string
  /** 语言服务的当前目录。 */
  projectDirectory: string
  /** 这个服务用的编译选项。 */
  compilerOptions: ts.CompilerOptions
  /** 这个服务用的项目引用。 */
  projectReferences?: readonly ts.ProjectReference[]
  /** 磁盘源码快照，overlay 退场时按它还原。 */
  diskFiles: Map<string, string>
  /** 语言服务真正看到的正文（磁盘快照叠上 overlay）。 */
  liveFiles: Map<string, string>
  /** 每个文件的版本号；只在正文真的变了才加一，增量缓存才留得住。 */
  fileVersions: Map<string, number>
  /** 当前这一轮塞进去的脏文件路径。 */
  overlayPaths: Set<string>
  /** 本项目编译选项对应的默认标准库文件；`null` 表示没有候选目录能提供完整的标准库。 */
  defaultLibFilePath: Nullable<string>
  /** 活的语言服务本体。 */
  service: ts.LanguageService
}

/** 一次 acquire 拿到的凭据：语言服务、它看到的文件，以及这次结果能不能信任类型层。 */
export interface TypeScriptLanguageServiceLease {
  /** 拿到的语言服务。 */
  service: ts.LanguageService
  /** 语言服务看到的全部正文。 */
  files: Map<string, string>
  /** 这个服务用的编译选项。 */
  compilerOptions: ts.CompilerOptions
  /** 这次用到的项目配置。 */
  config: TypeScriptProjectConfig
  /** 为 `false` 时语义诊断会把标准库全局名报成缺失，调用方只能信任语法层结果。 */
  standardLibraryAvailable: boolean
  /**
   * 该服务是否仍是池中的活服务。跨 `await` 持有结果的调用方在继续使用前必须检查：
   * 期间并发的 acquire 可能因指纹变化 dispose 了它，而被 dispose 的服务一调用就崩。
   */
  isCurrent(): boolean
}

/** 解析一个 tsconfig / jsconfig 的函数；分组时传一份带缓存的实现，同一次分组里每个配置只解析一次。 */
export type ParseTypeScriptConfig = (configPath: string) => Nullable<ts.ParsedCommandLine>
