/**
 * 代码理解能力（`velar:code`）的入参与回执：模型面上就这几个类型。
 * 入参是按 intent 分支的联合类型——哪个 intent 要哪些字段由类型说了算，检查器在模型写程序时就拦，不另设 schema。
 * 只放类型；查询怎么翻译成宿主的后端调用在 `utils/agent/code-query.ts`。
 */

import type { ProjectCodeScope } from './project.js'

/**
 * @AgentView
 * 要查的那个符号：符号名，可带声明所在的文件与容器名收窄；不给 path 就按名字在整个项目里找，
 * 找到多个会把候选一起回给你（每个候选都带一份现成的 `target`，挑一个原样传回来就行）。
 */
export interface CodeTarget {
  path?: string
  symbol: string
  container?: string
}

/**
 * @AgentView
 * 问代码：一个 intent 就是一句「要知道什么」。
 * outline 这个文件里有什么、definition 符号定义在哪、references 谁在用它、callers 谁调用它、callees 它调用谁、
 * imports 这个文件引了谁、importers 谁引它、impact 改了会波及谁、diagnostics 这个文件报什么错。
 * `language` 只查这一种语言（不给就按扩展名交给能处理它的语言服务），`extensions`、`maxDepth` 收窄扫描范围。路径都相对项目根。
 * 结果全部交回，看多少在程序里定。
 */
export type CodeQueryInput =
  | (ProjectCodeScope & { intent: 'outline'; path: string })
  | (ProjectCodeScope & { intent: 'definition'; target: CodeTarget })
  | (ProjectCodeScope & { intent: 'references'; target: CodeTarget; path?: string })
  | (ProjectCodeScope & { intent: 'callers' | 'callees'; target: CodeTarget })
  | (ProjectCodeScope & { intent: 'imports' | 'importers'; path: string })
  | (ProjectCodeScope & { intent: 'impact'; target: CodeTarget; path?: string })
  | (ProjectCodeScope & { intent: 'diagnostics'; path: string })

/**
 * @AgentView
 * 四类要代码图谱后端才答得了的分析：trace 追两个符号之间的调用路径、cycles 找依赖环、
 * deadcode 找没用到的代码候选、routing 列框架路由（framework 只列这个框架的）。宿主没接图后端时整个调用失败（`UNAVAILABLE`）。
 */
export type CodeAnalysisInput =
  | { intent: 'trace'; from: CodeTarget; to: CodeTarget }
  | { intent: 'cycles' }
  | { intent: 'deadcode' }
  | { intent: 'routing'; framework?: string }

/** @AgentView 这次结果由哪个后端给出（语言服务、代码图谱、本地适配器）。 */
export interface CodeResultSource {
  backend: string
  services?: unknown
}

/**
 * @AgentView
 * 这次查询覆盖到哪儿：范围、语言、扫了多少文件、结果绑没绑文件版本。
 * truncated 为真是后端没给全（超过 5000 条，或者后端自己设了上限）：收窄 path、extensions 或 maxDepth 再问。
 */
export interface CodeResultCoverage {
  path: string
  language?: string
  scannedFiles?: unknown
  truncated: boolean
  /** 结果绑在确定的文件版本上才为真；为假时它只是「现在看到的位置」，改动之后可能就不对了。 */
  versioned: boolean
  revisions: Array<{ revision: string; scope: string }>
}

/**
 * @AgentView
 * 一次代码查询的回执。**正文的形状随 intent 与后端而定**，所以除了下面几项，正文按名字直接取、按拿到的样子用（类型是 any）；
 * 拿不准有哪些键就先看 `Object.keys(result)`。先看 `degraded` 再决定信到什么程度。
 */
export interface CodeResult {
  /** 这次问的是哪个 intent，原样回给你，便于程序分支。 */
  intent: string
  sources: CodeResultSource[]
  coverage: CodeResultCoverage
  /** 不为空时结果只是候选：按名字找到的符号与引用不等于精确绑定，空诊断也不等于没问题。 */
  degraded: string[]
  /**
   * 具体结果按 intent 放在各自的键上：outline、definition 是 symbols（definition 另有 declaration、body 两个范围），
   * references 是 references，imports、importers 是 imports、importers，impact 是 references、importers、relatedTestPaths，
   * diagnostics 是 diagnostics，callers、callees 是图后端给的调用关系（callers 或 callees，有的后端给 nodes 与 relations）。
   */
  [key: string]: any
}
