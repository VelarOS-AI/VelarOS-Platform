/**
 * 常量表：工具与 mod 的身份、工具在目录里的排位、各工具的公开上限、入参契约版本、宿主代码查询的语言服务动作。
 * 工具说明和 schema 都引这里的数字，改一处模型看到的跟着变。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/project/contracts` 取）。
 */

/** 项目空间九个模型面工具的名字。 */
export const ProjectToolNames = Object.freeze({
  read: 'project:read',
  list: 'project:list',
  search: 'project:search',
  file: 'project:file',
  edit: 'project:edit',
  code: 'project:code',
  change: 'project:change',
  run: 'project:run',
  sandbox: 'project:sandbox',
} as const)

/** 九个模型面工具之一的名字。 */
export type ProjectToolName = (typeof ProjectToolNames)[keyof typeof ProjectToolNames]

/** 可选工具 project:code-analysis 的名字：宿主有代码图后端时单独登记，不在九个默认工具里。 */
export const ProjectCodeAnalysisToolName = 'project:code-analysis' as const

/** 本包的版本，写进 mod 清单、内核模块清单和内置插件；和 package.json 的 version 一致，check:arch 核对。 */
export const ProjectPackageVersion = '2.2.0' as const

/** 项目空间作为官方内置 mod 的身份。 */
export const ProjectModId = 'velaros.project' as const

/** 代码图分析扩展作为可选内置 mod 的身份，只贡献 project:code-analysis。 */
export const ProjectCodeAnalysisModId = 'velaros.project.code-analysis' as const

/** 项目空间自己的身份，mod 清单里声明的空间用它。 */
export const ProjectSpaceId = 'project' as const

/** 模型面工具入参契约的版本：失败调用的入参复用只在同一版本内进行。 */
export const ProjectToolContract = Object.freeze({
  /** 当前模型面工具入参的契约版本。 */
  inputVersion: 2,
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
  file: Object.freeze({
    tier: 'common',
    /** 常用档第 4 位。 */
    rank: 40,
  } as const),
  edit: Object.freeze({
    tier: 'common',
    /** 常用档第 5 位。 */
    rank: 50,
  } as const),
  run: Object.freeze({
    tier: 'common',
    /** 常用档第 5 位，与 project:edit 并列。 */
    rank: 50,
  } as const),
  sandbox: Object.freeze({
    tier: 'common',
    /** 常用档第 6 位。 */
    rank: 60,
  } as const),
  change: Object.freeze({
    tier: 'situational',
    /** 按情况档第 1 位。 */
    rank: 20,
  } as const),
  code: Object.freeze({
    tier: 'situational',
    /** 按情况档第 2 位。 */
    rank: 30,
  } as const),
  codeAnalysis: Object.freeze({
    tier: 'situational',
    /** 按情况档第 3 位。 */
    rank: 40,
  } as const),
})

/** 读取类工具（project:read、project:list、project:search）的公开上限。 */
export const ProjectFileLimits = Object.freeze({
  /** project:read 一次最多读几个文件。 */
  readFiles: 20,
  /** project:read 一次调用所有文件共用的字符预算最多多大。 */
  readChars: 500_000,
  /** project:list、project:search 的 include / exclude 各最多几条 glob。 */
  patterns: 20,
  /** project:list 递归时最多往下几层。 */
  listDepth: 30,
  /** project:list 每页最多几条。 */
  listPage: 2_000,
  /** project:list 不给 limit 时每页几条。 */
  listPageDefault: 200,
  /** project:search 最多返回几处命中。 */
  searchHits: 100,
  /** project:search 每处命中前后最多各带几行。 */
  searchContextLines: 10,
})

/** 改动类工具（project:file、project:edit、project:change）的公开上限。 */
export const ProjectChangeLimits = Object.freeze({
  /** project:file 一次、project:change 一个 file 步骤最多几个文件动作。 */
  fileActions: 1000,
  /** 一个 recode 动作最多转换几个文件。 */
  recodePaths: 1000,
  /** project:edit 一次、project:change 一个 edit 步骤最多改几个文件。 */
  editFiles: 1000,
  /** 一个文件里最多几处编辑。 */
  editsPerFile: 1000,
  /** project:change 一次 apply 最多几步。 */
  steps: 1000,
})

/** 代码理解类工具（project:code、project:code-analysis）的公开上限。 */
export const ProjectCodeLimits = Object.freeze({
  /** 一次查询最多返回几条结果。 */
  results: 200,
  /** 按扩展名过滤时最多给几个扩展名。 */
  extensions: 20,
  /** 扫描目录时最多往下几层。 */
  scanDepth: 16,
  /** 按符号种类过滤时最多给几种。 */
  kinds: 12,
  /** relations、impact 沿关系最多走几层。 */
  relationDepth: 5,
  /** relations、impact 不给 depth 时走几层。 */
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

/** project:sandbox 的公开上限（和 system:sandbox 一致）。 */
export const ProjectSandboxLimits = Object.freeze({
  /** 沙箱 id 最长多少字符。 */
  idChars: 64,
  /** apply 一次最多点名几条路径。 */
  applyPaths: 500,
  /** diff 的新增与修改各列最多列多少条（maxFiles 的上限）。 */
  diffFilesMax: 2000,
  /** diff 不给 maxFiles 时各列列多少条。 */
  diffFiles: 200,
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
