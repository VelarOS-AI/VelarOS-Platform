/**
 * 常量表：版本、错误原因、读写与代码查询的公开上限、内核缺省策略、宿主代码查询的语言服务动作。
 * 不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/velaros/project/contracts` 取）。
 */

/** 本单元的版本，写进内置插件；和 `@velaros-ai/velaros` 的 package.json 一致，check:project-arch 核对。 */
export const ProjectPackageVersion = '0.6.15' as const

/**
 * 项目的两件工具与内核对外承诺的错误原因：`ProjectError` 的 reason，模型和宿主按它分支处理。码本身是契约，不得改名；
 * 新的失败形态先在这里加一项，不要拿 INVALID_INPUT 兜底。
 */
export const ProjectErrorCodes = Object.freeze({
  /** 路径出了项目（含经符号链接指到项目外）。 */
  permissionDenied: 'PERMISSION_DENIED',
  /** 文件（或列举出的目录）在读取之后被改过，手里的版本已经过期；重读、重列再来。 */
  baseRevisionMismatch: 'BASE_REVISION_MISMATCH',
  /** 要读、要改的文件、符号或原文片段找不到。 */
  targetNotFound: 'TARGET_NOT_FOUND',
  /** 定位条件匹配到不止一处，定不下改哪一处。 */
  ambiguousTarget: 'AMBIGUOUS_TARGET',
  /** 要新建的路径已经存在。 */
  targetExists: 'TARGET_EXISTS',
  /** 补丁套不上当前内容。 */
  patchApplyError: 'PATCH_APPLY_ERROR',
  /** 超出允许的范围：要改的文件太大整份读不全、符号引用不属于当前项目、一个事务的文件数或行数超过预算，或者一次读、列、搜的量超过守内存的上限。 */
  scopeViolation: 'SCOPE_VIOLATION',
  /** 校验器没通过，改动没有提交。 */
  validationFailed: 'VALIDATION_FAILED',
  /** 提交或撤销时发现文件被外部改过，拒绝覆盖。 */
  conflictWithExternalEdit: 'CONFLICT_WITH_EXTERNAL_EDIT',
  /** 重启后恢复中断的事务时遇到无法归属的外部改动，保留现场、拒绝覆盖。 */
  transactionRecoveryConflict: 'TRANSACTION_RECOVERY_CONFLICT',
  /** 当前环境、文件类型或宿主不支持这个操作。 */
  notSupported: 'NOT_SUPPORTED',
  /** 入参不合法。 */
  invalidInput: 'INVALID_INPUT',
} as const)

/** 项目的错误原因之一。 */
export type ProjectErrorCode = (typeof ProjectErrorCodes)[keyof typeof ProjectErrorCodes]

/**
 * `velaros:project` 对外承诺的上限：模型在声明里看到的就是这些数（两边一致由验收核对）。
 * 一次事务实际能改几个文件、几行，还受内核策略 `ProjectPolicyDefaults` 的 maxChangedFilesPerTransaction（缺省 100）、
 * maxChangedLinesPerFile、maxChangedLinesPerTransaction 约束，宿主可以调高。
 */
export const ProjectFileLimits = Object.freeze({
  /** read 一次最多读几个文件。 */
  readFiles: 20,
  /**
   * read 一次交回的正文总共最多多少字符。**只为守住内存**：读回来的东西不进模型的上下文，看多少由程序定；
   * 装不下的文件在 issues 里，单独读或用 range 读一段。
   */
  readChars: 20_000_000,
  /** list、search 的 include / exclude 各最多几条 glob。 */
  patterns: 20,
  /** list 的 depth 给数字时最多几层（不给就是整棵树）。 */
  listDepth: 30,
  /** list 一次最多列多少条，同样只为守住内存：超了整个调用失败，收窄 path、include 或 depth 再列。 */
  listEntries: 100_000,
  /** search 一次最多多少处命中，同样只为守住内存：超了整个调用失败，收窄 query、path 或 include 再搜。 */
  searchHits: 5_000,
  /** search 合并重叠窗口后，一次交回的正文总共最多多少 Unicode 字符；超了整个调用失败。 */
  searchChars: 20_000_000,
  /** search 不给 contextLines 时每处命中前后各带几行。 */
  searchContextLinesDefault: 1,
  /** edit 一次最多几步。 */
  steps: 1000,
  /** 一步 edit 里最多几处编辑。 */
  editsPerFile: 1000,
  /** select 一次最多定位的目标数。 */
  selectTargets: 1000,
  /** 一次 select 的独立源码文件数上限。 */
  selectFiles: 100,
  /** 歧义项最多返回的完整候选数，超出时要求收窄。 */
  selectionCandidates: 20,
  /** 一个 recode 步骤最多转换几个文件。 */
  recodePaths: 1000,
})

/** 声明式纯快照计划的公开预算；完整捕获仍逐轮实际读取。 */
export const ProjectSnapshotLimits = Object.freeze({
  /** 一份计划最多组合的文件数。 */
  files: 20,
  /** 每次前后捕获的正文总字符上限。 */
  chars: 500_000,
  /** 输出身份最长字符数。 */
  keyChars: 96,
  /** 输出用途最长字符数。 */
  purposeChars: 1000,
  /** JSON Pointer 最长字符数。 */
  pointerChars: 1024,
})

/** 代码理解能力（`velaros:code` 的 query、analyze）的公开上限与缺省值。 */
export const ProjectCodeLimits = Object.freeze({
  /** 一次查询最多交回几条结果。只为守住内存：结果不进模型的上下文，看多少由程序定。 */
  results: 5_000,
  /** 按扩展名过滤时最多给几个扩展名。 */
  extensions: 20,
  /** 扫描目录时最多往下几层。 */
  scanDepth: 16,
  /** callers、callees、impact 沿关系走几层。 */
  relationDepthDefault: 2,
})

/** 变更记录与有限事务面的公开上限。 */
export const ProjectTransactionLimits = Object.freeze({
  /** 列变更记录时不给 limit 列几条。 */
  listDefault: 100,
  /** 列变更记录一次最多几条。 */
  listMax: 1000,
  /** 事务号最长多少字节（UTF-8）。 */
  transactionIdBytes: 512,
})

/**
 * 内核缺省策略：宿主建内核时不给 `corePolicy` 就用这些值，给了就按字段覆盖。
 * 只管正确性与守内存：整文件读取有上限、编辑要带读取时的版本、事务有规模预算。没有读写名单，也没有要人审的写入。README 写的事务预算就是这里的数。
 */
export const ProjectPolicyDefaults = Object.freeze({
  /** 编辑必须带读取时拿到的版本（baseRevision），证明是在最新内容上改的。 */
  requireBaseRevision: true,
  /** 定位目标必须唯一：匹配到多处时拒绝，不猜。 */
  requireUniqueTarget: true,
  /** 整个文件读进内存的上限，字节；更大的文件只能按行范围或 maxBytes 读。 */
  maxFileSizeToReadBytes: 5 * 1024 * 1024,
  /** 搜索时跳过大于这么多字节的文件。 */
  maxSearchFileSizeBytes: 1024 * 1024,
  /** 版本号按内容指纹算：同样长度、修改时间又被保留的外部改动也能发现。 */
  revisionStrategy: 'content',
  /** 有 ripgrep 时先用它搜，失败了回退到适配器逐文件扫描。 */
  enableRipgrepSearch: true,
  /** ripgrep 子进程的超时，毫秒。 */
  ripgrepTimeoutMs: 120_000,
  /** 一个事务最多改几个文件。 */
  maxChangedFilesPerTransaction: 100,
  /** 一个事务里单个文件最多净变更多少行。 */
  maxChangedLinesPerFile: 20_000,
  /** 一个事务最多净变更多少行。 */
  maxChangedLinesPerTransaction: 50_000,
  /** 批处理同时最多跑几个任务；调用方给的并发只能比它小。 */
  maxConcurrentBatchTasks: 8,
} as const)

/** 宿主代码查询里由语言服务执行的七个动作；其余动作属于代码索引，宿主有代码图谱时执行。 */
export const ProjectCodeLanguageActions = Object.freeze([
  'find_symbols',
  'list_exports',
  'find_imports',
  'find_importers',
  'find_references',
  'language_diagnostics',
  'analyze_symbol_impact',
] as const)

/**
 * 常量表：本包对外约定的身份与上限。
 * 不 import 任何东西，渲染进程与浏览器都能用（从 `@velaros-ai/velaros/project/contracts` 取）。
 */

/** 内置语言服务的 id：模型写 `language` 时认得出这两个，也认语言名与扩展名简写。 */
export const LanguageServiceIds = Object.freeze({
  /** JavaScript / TypeScript 语言服务。 */
  jsts: 'jsts',
  /** Python 语言服务。 */
  python: 'python',
} as const)

/** 代码查询结果里 `source` 字段的两种来源：内置语言服务，或宿主的代码图谱后端。 */
export const CodeQuerySources = Object.freeze({
  /** 本包的内置语言服务给出的结果。 */
  languageService: 'language-service',
  /** 宿主代码图谱后端给出的结果。 */
  codeGraph: 'codegraph',
} as const)

/**
 * 目录诊断的公开上限：README 与交给模型的 note 都写着这两个数，是对外承诺。
 *
 * 同属一个 TypeScript 程序的文件共用一次程序构建，常规目录远在预算之内；预算兜住超大程序或慢盘，
 * 超出时带说明返回已完成的部分，由调用方缩小 `path` 续查。
 */
export const DevelopmentCodeLimits = Object.freeze({
  /** 一次目录诊断最多选多少个源文件；超出就按遍历顺序截断，并在 note 里写明还有文件没诊断。 */
  diagnosticFiles: 200,
  /** 一次目录诊断的耗时预算（毫秒）；超出就停在当前文件，已完成的部分照常返回并说明。 */
  diagnosticTimeBudgetMs: 20_000,
} as const)

/**
 * 内置的外部语言服务规格：命令、参数、认的扩展名与 LSP languageId。
 *
 * 这些命令要由用户自己装（`basedpyright-langserver`、`gopls`、`rust-analyzer`…）；本包只按这张表
 * 拉起进程，不下载、不安装、不改名。宿主可以在 `createExternalLanguageService` 时给自己的表替换它。
 */
export const BuiltinExternalLanguageServers = Object.freeze([
  {
    id: 'basedpyright',
    command: 'basedpyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    languageId: 'python',
  },
  {
    id: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    languageId: 'python',
  },
  { id: 'gopls', command: 'gopls', args: ['serve'], extensions: ['.go'], languageId: 'go' },
  {
    id: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    languageId: 'rust',
  },
  {
    id: 'clangd',
    command: 'clangd',
    args: ['--background-index=0'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    languageId: 'cpp',
  },
  {
    id: 'json',
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    extensions: ['.json', '.jsonc'],
    languageId: 'json',
  },
  {
    id: 'css',
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    extensions: ['.css', '.less', '.scss'],
    languageId: 'css',
  },
  {
    id: 'html',
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    extensions: ['.html', '.htm'],
    languageId: 'html',
  },
  {
    id: 'vue',
    command: 'vue-language-server',
    args: ['--stdio'],
    extensions: ['.vue'],
    languageId: 'vue',
  },
] as const)

/** 内置语言服务 id 的取值。 */
export type LanguageServiceId = (typeof LanguageServiceIds)[keyof typeof LanguageServiceIds]

/** 代码查询结果来源的取值。 */
export type CodeQuerySource = (typeof CodeQuerySources)[keyof typeof CodeQuerySources]
