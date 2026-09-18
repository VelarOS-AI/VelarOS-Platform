/**
 * 常量表：本包对外约定的身份与上限。
 * 不 import 任何东西，渲染进程与浏览器都能用（从 `@velaros-ai/development/contracts` 取）。
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
  { id: 'basedpyright', command: 'basedpyright-langserver', args: ['--stdio'], extensions: ['.py', '.pyi'], languageId: 'python' },
  { id: 'pyright', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py', '.pyi'], languageId: 'python' },
  { id: 'gopls', command: 'gopls', args: ['serve'], extensions: ['.go'], languageId: 'go' },
  { id: 'rust-analyzer', command: 'rust-analyzer', args: [], extensions: ['.rs'], languageId: 'rust' },
  { id: 'clangd', command: 'clangd', args: ['--background-index=0'], extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'], languageId: 'cpp' },
  { id: 'json', command: 'vscode-json-language-server', args: ['--stdio'], extensions: ['.json', '.jsonc'], languageId: 'json' },
  { id: 'css', command: 'vscode-css-language-server', args: ['--stdio'], extensions: ['.css', '.less', '.scss'], languageId: 'css' },
  { id: 'html', command: 'vscode-html-language-server', args: ['--stdio'], extensions: ['.html', '.htm'], languageId: 'html' },
  { id: 'vue', command: 'vue-language-server', args: ['--stdio'], extensions: ['.vue'], languageId: 'vue' },
] as const)

/** 内置语言服务 id 的取值。 */
export type LanguageServiceId = (typeof LanguageServiceIds)[keyof typeof LanguageServiceIds]

/** 代码查询结果来源的取值。 */
export type CodeQuerySource = (typeof CodeQuerySources)[keyof typeof CodeQuerySources]
