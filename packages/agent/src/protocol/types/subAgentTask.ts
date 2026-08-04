import type { RunProfileId } from './agent'
import type { TeamModelRouteCategory, TeamModelSelectionTrace, ThinkingDepth } from './team'
import type { ToolCategoryId } from './tool'

export type SubAgentTaskMode = 'sync' | 'async'
/** Opaque worker type id registered by the product composition root. */
export type SubAgentTypeId = string

export type SubAgentSessionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'wind_down'

export type SubAgentWindDownReason = 'time' | 'turn_cap' | 'user_interrupt'

export type SubAgentToolScope = 'type_default' | 'inherit' | 'custom'

export type SubAgentTaskResultStatus =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'wind_down'
  | 'running'

export interface SubAgentToolDigestEntry {
  tool: string
  outcome: 'ok' | 'error'
  hint?: LooseOptional<string>
}

export interface SubAgentTaskArtifacts {
  changed_paths?: string[]
  discovery_paths?: string[]
  verification?: {
    status: 'passed' | 'failed' | 'skipped'
    command?: LooseOptional<string>
  }
}

export interface SubAgentTaskRequest {
  agent_name?: LooseOptional<string>
  subagent_type: SubAgentTypeId
  /** 文件式自定义 agent id；存在时 subagent_type 为其 base 内置类型。 */
  custom_agent_id?: LooseOptional<string>
  prompt: string
  description?: LooseOptional<string>
  tool_scope?: LooseOptional<SubAgentToolScope>
  tool_categories?: LooseOptional<ToolCategoryId[]>
  thread_id?: LooseOptional<string>
  mode?: LooseOptional<SubAgentTaskMode>
  readonly?: LooseOptional<boolean>
  model?: LooseOptional<string>
  route_category?: LooseOptional<TeamModelRouteCategory>
  attachments?: LooseOptional<string[]>
  interrupt?: LooseOptional<boolean>
  run_profile?: LooseOptional<RunProfileId>
}

/**
 * 文件式自定义子智能体定义（storage/agents/<id>.md）。
 *
 * 设计为「内置 base 类型 + 覆盖项」的预设：路由/阶段映射/写租约语义全部沿用 base，
 * 自定义只覆盖提示词、工具分类、模型与只读默认值——避免自定义 id 渗入
 * SubAgentTypeId 的封闭枚举。
 */
export interface CustomSubAgentDefinition {
  /** slug = 文件名（不含 .md），派发时作为 subagent_type 引用。 */
  id: string
  name: string
  /** 一句话适用边界；会注入主 Agent 提示词，用于判断何时派发（防滥用的第一道闸）。 */
  description: string
  /** 继承的内置类型；缺省 general。 */
  base: SubAgentTypeId
  /** 覆盖 base 默认工具分类；null 表示沿用 base。 */
  toolCategories: Nullable<ToolCategoryId[]>
  /** 覆盖模型 id；null 表示走团队路由。 */
  model: Nullable<string>
  /** 覆盖 reasoning effort（思考力度档）；null 表示继承会话 effort。 */
  effort: Nullable<ThinkingDepth>
  /** 覆盖只读默认值；null 表示沿用 base。 */
  readonly: Nullable<boolean>
  /** 正文 = 追加到子 Agent 指令的系统提示词。 */
  promptMarkdown: string
  filePath: string
  updatedAt: number
}

/** 自定义 agent 的轻量描述符（注入主 Agent 提示词/设置页列表用）。 */
export interface CustomSubAgentDescriptor {
  id: string
  name: string
  description: string
  base: SubAgentTypeId
  updatedAt: number
}

/** 自定义 agent 市场条目（远端 manifest + 本地安装状态合成）。 */
export interface CustomAgentMarketEntry {
  id: string
  name: string
  description: string
  version: string
  installState: 'not-installed' | 'installed' | 'update-available'
  install?: {
    phase: 'installing' | 'failed'
    error?: string
  }
}

export interface CustomAgentMarketCatalog {
  generatedAt: number
  entries: CustomAgentMarketEntry[]
}

/**
 * 子 Agent 一次运行的 token/成本用量汇总（跨全部轮次累加）。
 * 由 QueryLoop 从每轮 model span 的四字段冒泡，经派发结果 envelope 回传父 Agent，
 * 供父侧成本感知（不派/派便宜模型的调度依据）。缺字段表示该次运行未回报对应指标。
 */
export interface SubAgentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
}

export interface SubAgentTaskResult {
  thread_id: string
  status: SubAgentTaskResultStatus
  summary: string
  /** 调用方声明 output schema 时，经 QueryLoop 校验通过的规范化 JSON 值。 */
  structured_output?: LooseOptional<unknown>
  /** 本次子 Agent 运行的 token/成本用量汇总（跨全部轮次累加）。 */
  usage?: LooseOptional<SubAgentUsage>
  artifacts?: LooseOptional<SubAgentTaskArtifacts>
  tool_digest?: LooseOptional<SubAgentToolDigestEntry[]>
  model_trace?: LooseOptional<TeamModelSelectionTrace>
  wind_down_reason?: LooseOptional<SubAgentWindDownReason>
  full_digest_ref?: LooseOptional<string>
}

export interface SubAgentSessionRecord {
  thread_id: string
  execution_id: string
  parent_session_id: string
  subagent_type: SubAgentTypeId
  status: SubAgentSessionStatus
  created_at: number
  updated_at: number
  request: SubAgentTaskRequest
  results: SubAgentTaskResult[]
}

export interface SubAgentWorkerOutcome {
  text: string
  result: SubAgentTaskResult
}
