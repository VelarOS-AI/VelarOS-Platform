/**
 * 模型面工具的入参：九个 project 工具与可选的 project:code-analysis，每个工具一个类型，和工具定义里的 schema 一一对应（解析之后的形状，
 * 带缺省值的字段是必有的）。project:file、project:edit、project:change 的入参在 editing.ts。只放类型。
 */

import type { ProjectChangeStep, ProjectLineRange } from './editing.js'

/** project:read 的入参：path（可带 range）、files（每项各自的 range）、continuation 三选一；maxChars 是这次调用所有文件共用的字符预算。 */
export type ProjectReadInput = {
  path?: string
  range?: ProjectLineRange
  files?: Array<{ path: string; range?: ProjectLineRange }>
  continuation?: string
  maxChars?: number
}

/** project:list 的入参：目录、include/exclude glob、是否递归与最大深度、每页条数；续页只传 cursor 和可选 limit。 */
export type ProjectListInput = {
  path?: string
  include?: string[]
  exclude?: string[]
  recursive: boolean
  maxDepth?: number
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

/** project:change 的入参：apply 只带 steps；inspect、undo 只带 changeRef。 */
export type ProjectChangeInput = {
  action: 'apply' | 'inspect' | 'undo'
  steps?: ProjectChangeStep[]
  changeRef?: string
}

/** project:run 的入参：命令、项目内的工作目录、超时、是否后台、输出上限。 */
export type ProjectRunInput = {
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
}

/** project:sandbox 的入参：action 选动作；create 用 source、network、ignored，run 用 command、timeoutMs、maxOutputChars，diff 用 maxFiles，apply 用 paths；除 create 外都要 sandboxId。 */
export type ProjectSandboxInput = {
  action: 'create' | 'run' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: 'link' | 'copy' | 'skip'
  sandboxId?: string
  command?: string
  timeoutMs?: number
  maxOutputChars?: number
  paths?: string[]
  maxFiles?: number
}

/** 代码查询的目标符号：前一次查询返回的 symbolRef，或者文件路径加符号名（可带容器名区分同名符号）。 */
export type ProjectCodeTarget = { symbolRef: string } | { path: string; symbol: string; container?: string }

/** 代码查询共用的范围：语言、工作目录、条数上限、扩展名与目录深度。 */
type ProjectCodeScope = {
  language?: string
  cwd?: string
  limit?: number
  extensions?: string[]
  maxDepth?: number
}

/** project:code 的入参：symbols、references、dependencies（incoming / outgoing）、relations、impact、diagnostics 六类动作。 */
export type ProjectCodeInput =
  | (ProjectCodeScope & {
    action: 'symbols'
    query?: string
    path?: string
    kinds?: string[]
    exact?: boolean
    exportedOnly?: boolean
    includeReExports?: boolean
    target?: ProjectCodeTarget
  })
  | (ProjectCodeScope & { action: 'references'; target: ProjectCodeTarget; path?: string })
  | (ProjectCodeScope & { action: 'dependencies'; direction: 'incoming'; path?: string; specifier?: string; within?: string; includeReExports?: boolean })
  | (ProjectCodeScope & { action: 'dependencies'; direction: 'outgoing'; path?: string; specifier?: string; kind?: string; includeExternal?: boolean })
  | { action: 'relations'; cwd?: string; limit?: number; target: ProjectCodeTarget; kind: 'calls' | 'types' | 'related'; direction: 'incoming' | 'outgoing' | 'both'; depth: number }
  | (ProjectCodeScope & { action: 'impact'; target: ProjectCodeTarget; path?: string; kinds?: string[]; depth: number })
  | (ProjectCodeScope & { action: 'diagnostics'; path: string })

/** project:code-analysis 的入参：trace、cycles、deadcode、routing 四类图分析。 */
export type ProjectCodeAnalysisInput =
  | { action: 'trace'; from: ProjectCodeTarget; to: ProjectCodeTarget }
  | { action: 'cycles'; maxFiles?: number }
  | { action: 'deadcode'; limit?: number }
  | { action: 'routing'; framework?: string }
