/**
 * 常量表：工具与 mod 的身份、工具在目录里的排位、各工具的公开上限、入参契约版本、宿主代码查询的语言服务动作、内核缺省策略。
 * 工具说明和 schema 都引这里的数字，改一处模型看到的跟着变。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/project/contracts` 取）。
 */

/** 项目空间七个模型面工具的名字。 */
export const ProjectToolNames = Object.freeze({
  read: 'project:read',
  list: 'project:list',
  search: 'project:search',
  edit: 'project:edit',
  code: 'project:code',
  run: 'project:run',
  sandbox: 'project:sandbox',
} as const)

/** 七个模型面工具之一的名字。 */
export type ProjectToolName = (typeof ProjectToolNames)[keyof typeof ProjectToolNames]

/** 可选工具 project:code-analysis 的名字：宿主有代码图后端时单独登记，不在七个默认工具里。 */
export const ProjectCodeAnalysisToolName = 'project:code-analysis' as const

/** 本包的版本，写进 mod 清单、内核模块清单和内置插件；和 package.json 的 version 一致，check:arch 核对。 */
export const ProjectPackageVersion = '2.2.0' as const

/** 项目空间作为官方内置 mod 的身份。 */
export const ProjectModId = 'velaros.project' as const

/** 项目空间自己的身份，mod 清单里声明的空间用它。 */
export const ProjectSpaceId = 'project' as const

/**
 * 项目空间对外承诺的错误原因：`ProjectError` 的 reason，模型和宿主按它分支处理。码本身是契约，不得改名；
 * 新的失败形态先在这里加一项，不要拿 INVALID_INPUT 兜底。
 */
export const ProjectErrorCodes = Object.freeze({
  /** 路径出了项目（含经符号链接指到项目外），或被项目策略、授权、脱敏规则拒绝。 */
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
  /** 超出允许的范围：range 超出 fileRef 实际显示的范围、符号引用不属于当前项目，或者一个事务的文件数、行数超过预算。 */
  scopeViolation: 'SCOPE_VIOLATION',
  /** 目标在项目策略的受保护文件里。 */
  protectedFile: 'PROTECTED_FILE',
  /** 目标匹配项目策略的生成文件；改生成器的输入再重新生成。 */
  generatedFile: 'GENERATED_FILE',
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

/** 项目空间的错误原因之一。 */
export type ProjectErrorCode = (typeof ProjectErrorCodes)[keyof typeof ProjectErrorCodes]

/** 模型面工具入参契约的版本：失败调用的入参复用只在同一版本内进行。 */
export const ProjectToolContract = Object.freeze({
  /** 当前模型面工具入参的契约版本；第 3 版是改动三合一、代码查询改 intent、list 改 depth 这一轮。 */
  inputVersion: 3,
})

/**
 * 工具在模型工具目录里的档位与排位：common 是常用档，situational 是按情况用的；同一档里 rank 小的排前面。
 * 运行档位要裁剪工具数量时按它取舍。
 */
export const ProjectToolExposure = Object.freeze({
  read: Object.freeze({
    tier: 'common',
    /** 常用档第 1 位。 */
    rank: 10,
  } as const),
  list: Object.freeze({
    tier: 'common',
    /** 常用档第 2 位。 */
    rank: 20,
  } as const),
  search: Object.freeze({
    tier: 'common',
    /** 常用档第 3 位。 */
    rank: 30,
  } as const),
  edit: Object.freeze({
    tier: 'common',
    /** 常用档第 4 位。 */
    rank: 40,
  } as const),
  run: Object.freeze({
    tier: 'common',
    /** 常用档第 5 位。 */
    rank: 50,
  } as const),
  sandbox: Object.freeze({
    tier: 'common',
    /** 常用档最后一位，第 6 位。 */
    rank: 60,
  } as const),
  code: Object.freeze({
    tier: 'situational',
    /** 按情况档第 1 位。 */
    rank: 20,
  } as const),
  codeAnalysis: Object.freeze({
    tier: 'situational',
    /** 按情况档第 2 位。 */
    rank: 30,
  } as const),
})

/** 读取类工具（project:read、project:list、project:search）的公开上限与缺省值。 */
export const ProjectFileLimits = Object.freeze({
  /** project:read 一次最多读几个文件。 */
  readFiles: 20,
  /** project:read 一次调用所有文件共用的字符预算最多多大。 */
  readChars: 500_000,
  /** project:read 不给 maxChars 时一次调用所有文件共用的字符预算。 */
  readCharsDefault: 24_000,
  /** project:list、project:search 的 include / exclude 各最多几条 glob。 */
  patterns: 20,
  /** project:list 的 depth 最多给到几层（depth='all' 不受它限制）。 */
  listDepth: 30,
  /** project:list 不给 depth 时往下几层。 */
  listDepthDefault: 3,
  /** project:list 每页最多几条。 */
  listPage: 2_000,
  /** project:list 不给 limit 时每页几条。 */
  listPageDefault: 200,
  /** project:search 最多返回几处命中。 */
  searchHits: 100,
  /** project:search 不给 limit 时最多返回几处命中。 */
  searchHitsDefault: 30,
  /** project:search 每处命中前后最多各带几行。 */
  searchContextLines: 10,
  /** project:search 不给 contextLines 时每处命中前后各带几行。 */
  searchContextLinesDefault: 1,
})

/**
 * 改动类工具（project:edit）的公开上限：这些是 schema 的上限；
 * 一次事务实际能改几个文件、几行，还受内核策略 `ProjectPolicyDefaults` 的 maxChangedFilesPerTransaction（缺省 100）、
 * maxChangedLinesPerFile、maxChangedLinesPerTransaction 约束，宿主可以调高。
 */
export const ProjectChangeLimits = Object.freeze({
  /** 一个 recode 步骤最多转换几个文件。 */
  recodePaths: 1000,
  /** 一步 edit 里最多几处编辑。 */
  editsPerFile: 1000,
  /** project:edit 一次 apply 最多几步。 */
  steps: 1000,
})

/** 代码理解类工具（project:code、project:code-analysis）的公开上限与缺省值。 */
export const ProjectCodeLimits = Object.freeze({
  /** 一次查询最多返回几条结果。 */
  results: 200,
  /** 不给 limit 时一次查询返回几条结果。 */
  resultsDefault: 30,
  /** 按扩展名过滤时最多给几个扩展名。 */
  extensions: 20,
  /** 扫描目录时最多往下几层。 */
  scanDepth: 16,
  /** callers、callees、impact 沿关系走几层。 */
  relationDepthDefault: 2,
  /** cycles 至少扫多少个文件。 */
  cycleFilesMin: 10,
  /** cycles 最多扫多少个文件。 */
  cycleFiles: 120,
  /** deadcode 最多返回几个候选。 */
  deadCodeCandidates: 80,
})

/** project:run 与沙箱里 run 的公开上限。 */
export const ProjectCommandLimits = Object.freeze({
  /** 命令超时最长多少毫秒。 */
  timeoutMs: 600_000,
  /** stdout / stderr 最多返回多少字符。 */
  outputChars: 50_000,
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
 * 内核缺省策略：宿主建内核时不给 `corePolicy` 就用这些值，给了就按字段覆盖（`approval` 按子字段合并）。
 * 取向保守：整文件读取有上限、编辑要带读取时的版本、事务有规模预算、回滚恢复不了原文的写入要人审。README 写的事务预算就是这里的数。
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
  /** 不许读的路径 glob。 */
  readDeny: Object.freeze([]),
  /**
   * 不许写的路径 glob。缺省挡住版本库内部：`.git` 里的 hooks 与 config（`core.fsmonitor`、`core.pager` 这些）一旦被改，
   * 内核自己后续的 git 调用（`git add -N`、`git check-ignore`）就会执行写进去的命令——普通一次编辑就变成任意命令执行。
   * 要提交、切分支、改仓库配置，用 `project:run` 跑 git 命令。
   */
  writeDeny: Object.freeze(['.git', '.git/**', '**/.git', '**/.git/**']),
  /** 能读、但没有策略明确允许时不改的文件 glob。 */
  protectedFiles: Object.freeze([]),
  /** 当作生成文件的 glob：改生成器的输入再重新生成，不直接改。 */
  generatedFiles: Object.freeze(['**/*.generated.*', '**/*.gen.*', '**/generated/**']),
  /** 审批。 */
  approval: Object.freeze({
    /** 回滚恢复不了原文的高风险写入，必须经宿主审批。 */
    requireForHighRiskPatch: true,
  }),
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
