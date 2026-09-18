declare module 'velar:code' {
  /**
   * 问代码，而不是自己读文件猜：定义在哪、谁在用它、改了波及谁、这个文件报什么错。
   * 路径都相对项目根。结果里 `degraded` 不为空时只是候选——按名字找到的符号与引用不等于精确绑定，空诊断也不等于没问题。
   * 找文本用 `velar:project` 的 search，读正文用它的 read；这里只回答「代码之间的关系」。
   */

  /**
   * 问代码：一个 intent 就是一句「要知道什么」。
   * outline 这个文件里有什么、definition 符号定义在哪、references 谁在用它、callers 谁调用它、callees 它调用谁、
   * imports 这个文件引了谁、importers 谁引它、impact 改了会波及谁、diagnostics 这个文件报什么错。
   * `language` 只查这一种语言（不给就按扩展名交给能处理它的语言服务），`limit` 最多返回几条（缺省 30、最多 200），
   * `extensions`、`maxDepth` 收窄扫描范围。路径都相对项目根。
   */
  type CodeQueryInput =
    | (ProjectCodeScope & { intent: 'outline'; path: string })
    | (ProjectCodeScope & { intent: 'definition'; target: CodeTarget })
    | (ProjectCodeScope & { intent: 'references'; target: CodeTarget; path?: string })
    | (ProjectCodeScope & { intent: 'callers' | 'callees'; target: CodeTarget })
    | (ProjectCodeScope & { intent: 'imports' | 'importers'; path: string })
    | (ProjectCodeScope & { intent: 'impact'; target: CodeTarget; path?: string })
    | (ProjectCodeScope & { intent: 'diagnostics'; path: string })

  /**
   * 一次代码查询的回执。**正文的形状随 intent 与后端而定**（symbols、references、callers、diagnostics……），
   * 所以除了下面几项之外按名字取值：先看 `degraded` 再决定信到什么程度。
   */
  interface CodeResult {
    /** 这次问的是哪个 intent，原样回给你，便于程序分支。 */
    intent: string
    sources: CodeResultSource[]
    coverage: CodeResultCoverage
    /** 不为空时结果只是候选：按名字找到的符号与引用不等于精确绑定，空诊断也不等于没问题。 */
    degraded: string[]
    /** 具体结果按 intent 放在各自的键上（outline 是 symbols，references 是 references，diagnostics 是 diagnostics……）。 */
    [key: string]: unknown
  }

  /**
   * 四类要代码图谱后端才答得了的分析：trace 追两个符号之间的调用路径、cycles 找依赖环、
   * deadcode 找没用到的代码候选、routing 列框架路由。宿主没接图后端时整个调用失败（`UNAVAILABLE`）。
   */
  type CodeAnalysisInput =
    | { intent: 'trace'; from: CodeTarget; to: CodeTarget }
    | { intent: 'cycles'; maxFiles?: number }
    | { intent: 'deadcode'; limit?: number }
    | { intent: 'routing'; framework?: string }

  /**
   * 代码查询共用的范围：language 只查这一种语言、limit 最多返回几条（1–200）、extensions 只扫这些扩展名（最多 20 个）、maxDepth 往下扫几层目录（0–16）。
   * 模型的 `velar:code` 入参与宿主收到的语言服务查询共用它；路径一律相对项目根。
   */
  interface ProjectCodeScope {
    language?: string
    limit?: number
    extensions?: string[]
    maxDepth?: number
  }

  /**
   * 要查的那个符号：符号名，可带声明所在的文件与容器名收窄；不给 path 就按名字在整个项目里找，
   * 找到多个会把候选一起回给你（每个候选都带一份现成的 `target`，挑一个原样传回来就行）。
   */
  interface CodeTarget {
    path?: string
    symbol: string
    container?: string
  }

  /** 这次结果由哪个后端给出（语言服务、代码图谱、本地适配器）。 */
  interface CodeResultSource {
    backend: string
    services?: unknown
  }

  /** 这次查询覆盖到哪儿：范围、语言、扫了多少文件、有没有被条数截断、结果绑没绑文件版本。 */
  interface CodeResultCoverage {
    path: string
    language?: string
    scannedFiles?: unknown
    truncated: boolean
    limit: number
    /** 结果绑在确定的文件版本上才为真；为假时它只是「现在看到的位置」，改动之后可能就不对了。 */
    versioned: boolean
    revisions: Array<{ revision: string; scope: string }>
  }

  /**
   * 按一个 intent 问：outline / definition / references / callers / callees / imports / importers / impact / diagnostics。
   * 语言服务没装或这个文件它不认时，结果会降级成按名字找到的候选，`degraded` 里说清楚。
   */
  export function query(input: CodeQueryInput): Promise<CodeResult>

  /**
   * 要代码图谱后端才答得了的四类：trace（两个符号之间的调用路径）、cycles（依赖环）、deadcode（没用到的代码候选）、routing（框架路由）。
   * 宿主没接图后端时整个调用失败，报 `UNAVAILABLE`——这时改用 query 的 references、impact 凑合看。
   */
  export function analyze(input: CodeAnalysisInput): Promise<CodeResult>
}
