/**
 * 模型面工具的入参：七个 project 工具与可选的 project:code-analysis，每个工具一个类型，和工具定义里的 schema 一一对应（解析之后的形状，
 * 带缺省值的字段是必有的）。project:edit 一步一步的形状在 editing.ts。只放类型。
 */

import type { ProjectEditStep, ProjectLineRange } from './editing.js'
import type { ProjectCodeScope, ProjectShellKind } from './project.js'

/** project:read 的入参：files（每项一个文件，可带 range）或 continuation 二选一；maxChars 是这次调用所有文件共用的字符预算。 */
export type ProjectReadInput = {
  files?: Array<{ path: string; range?: ProjectLineRange }>
  continuation?: string
  maxChars?: number
}

/** project:list 的入参：目录、include/exclude glob、往下列几层、每页条数；续页只传 cursor 和可选 limit。 */
export type ProjectListInput = {
  path?: string
  include?: string[]
  exclude?: string[]
  depth?: number | 'all'
  limit: number
  cursor?: string
}

/** project:search 的入参：字面文本或正则、搜索范围与 glob、大小写、命中上限与每处前后带几行。 */
export type ProjectSearchInput = {
  query: string
  path?: string
  include?: string[]
  exclude?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
  contextLines?: number
}

/** project:edit 的入参：apply 只带 steps（一步一个目标）；inspect、undo 只带 changeRef。 */
export type ProjectEditInput = {
  action: 'apply' | 'inspect' | 'undo'
  steps?: ProjectEditStep[]
  changeRef?: string
}

/** project:run 的入参：命令、项目内的工作目录、用哪个 shell（不传用默认的）、超时、是否后台、输出上限。 */
export type ProjectRunInput = {
  command: string
  cwd?: string
  shell?: ProjectShellKind
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
}

/** project:sandbox 的入参：action 选动作；create 用 source、network、ignored，run 用 command、shell、timeoutMs、maxOutputChars，diff 用 maxFiles，apply 用 paths；除 create 外都要 sandboxId。 */
export type ProjectSandboxInput = {
  action: 'create' | 'run' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: 'link' | 'copy' | 'skip'
  sandboxId?: string
  command?: string
  shell?: ProjectShellKind
  timeoutMs?: number
  maxOutputChars?: number
  paths?: string[]
  maxFiles?: number
}

/** 代码查询的目标符号：前一次查询返回的 symbolRef，或者符号名（可带声明所在文件与容器名收窄；不给 path 就按名字在整个项目里找）。 */
export type ProjectCodeTarget = { symbolRef: string } | { path?: string; symbol: string; container?: string }

/**
 * project:code 的入参：一个 intent 说明要知道什么，字段只有目标、范围与条数。
 * schema 的根是一个平对象加 intent 枚举（宿主扁平化根级组合时不会丢分支），每个 intent 的必填与互斥由 superRefine 保证，解析之后就是下面这些形状。
 */
export type ProjectCodeInput =
  | (ProjectCodeScope & { intent: 'outline'; path: string })
  | (ProjectCodeScope & { intent: 'definition'; target: ProjectCodeTarget })
  | (ProjectCodeScope & { intent: 'references'; target: ProjectCodeTarget; path?: string })
  | (ProjectCodeScope & { intent: 'callers' | 'callees'; target: ProjectCodeTarget })
  | (ProjectCodeScope & { intent: 'imports' | 'importers'; path: string })
  | (ProjectCodeScope & { intent: 'impact'; target: ProjectCodeTarget; path?: string })
  | (ProjectCodeScope & { intent: 'diagnostics'; path: string })

/** project:code-analysis 的入参：trace、cycles、deadcode、routing 四类图分析，词表与 project:code 一样用 intent。 */
export type ProjectCodeAnalysisInput =
  | { intent: 'trace'; from: ProjectCodeTarget; to: ProjectCodeTarget }
  | { intent: 'cycles'; maxFiles?: number }
  | { intent: 'deadcode'; limit?: number }
  | { intent: 'routing'; framework?: string }
