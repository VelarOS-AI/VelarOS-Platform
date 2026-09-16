/** 可调参数：只放数字，每项一句说明、每项都有人用。对外承诺的上限不在这里，在 `contract/constants.ts`。 */
export const DevelopmentTuning = Object.freeze({
  /** 语言导航的通用缺省（utils/source-files.ts）。 */
  navigation: Object.freeze({
    /** 七个动作的缺省结果条数：调用方不给 limit 时用它。 */
    defaultLimit: 100,
    /** 目录遍历缺省最深几层：调用方不给 maxDepth 时用它。 */
    maxDepth: 12,
    /** 单个源文件最多读多少字节；再大的文件按不可读跳过。 */
    maxReadableSourceBytes: 1_000_000,
    /** 指定路径以外的整体选文件上限：内核遍历最多带回这么多候选源文件。 */
    maxSelectedFiles: 2_500,
  }),
  /** 选文件规模：按结果条数放大成扫描面，再夹在下限与上限之间（utils/source-files.ts）。 */
  fileBudget: Object.freeze({
    /** 找符号：每条结果按几个文件的扫描面换算。 */
    symbolsPerResult: 25,
    /** 列导出：每条结果按几个文件的扫描面换算。 */
    exportsPerResult: 30,
    /** 列引入与找引用：每条结果按几个文件的扫描面换算。 */
    importsPerResult: 40,
    /** 找引用方：每条结果按几个文件的扫描面换算（要扫全项目才数得准）。 */
    importersPerResult: 50,
    /** 扫描面的下限：limit 很小时也至少扫这么多文件。 */
    minFiles: 500,
    /** 扫描面的上限：limit 很大时也不超过这么多文件。 */
    maxFiles: 5_000,
  }),
  /** 影响面分析的追查规模（utils/language-results.ts）。 */
  impact: Object.freeze({
    /** 最多沿几个声明文件去找引用方；声明再多也不无限展开。 */
    maxDeclarationTargets: 10,
    /** 最多列出多少个相关测试文件。 */
    maxRelatedTestPaths: 50,
  }),
  /** TypeScript 语言服务池（impl/TypeScriptProjectPool.ts、utils/typescript-config.ts）。 */
  typescriptProject: Object.freeze({
    /** 一个项目最多把多少个源文件装进 TypeScript 程序；超出的文件不参与类型检查。 */
    maxFiles: 2_000,
    /** 最多解析多少个依赖包的类型入口，用来喂自动导入候选。 */
    maxPackageTypeEntries: 256,
    /** 池里最多留几个活的语言服务，按最近使用淘汰；每个都含最多 maxFiles 个文件的全文。 */
    maxPooledProjects: 8,
  }),
  /** 外部语言服务的 stdio JSON-RPC 客户端（impl/ExternalLanguageService*.ts）。 */
  externalLanguageServer: Object.freeze({
    /** 一次 JSON-RPC 请求最多等多少毫秒。 */
    requestTimeoutMs: 15_000,
    /** 一个文件最多等多少毫秒的 publishDiagnostics；超时按「结果不完整」记账，不当成没问题。 */
    diagnosticsTimeoutMs: 8_000,
    /** 关闭握手与等进程退出各最多等多少毫秒；超时就直接杀进程。 */
    shutdownTimeoutMs: 1_000,
    /** 语言服务 stderr 最多留多少字符作为失败说明。 */
    stderrChars: 4_000,
    /** 超时告警里最多点名几个文件，其余只报个数。 */
    reportedTimedOutFiles: 10,
  }),
  /** 结果里的文本摘录（utils/source-files.ts）。 */
  excerpt: Object.freeze({
    /** 语句原文压成一行后最多保留多少字符，超出的用省略号收尾。 */
    maxChars: 240,
  }),
})
