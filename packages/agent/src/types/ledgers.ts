/** 引擎负责分配、追加输入不得携带的基字段。 */

import type { ExecutionSpan, ExecutionSpanMetrics, ExecutionSpanStatus, SessionEntry } from './agent.js'
import type { ProviderRequestSnapshot } from './context.js'


export type EngineAssignedField = 'id' | 'parentId' | 'createdAt'

/**
 * 判别联合上的分配式 Omit：逐变体去字段后重新联合，保住判别字段（会话 entry 的 `type`、span 的 `category`）的收窄能力。
 * 会话账本的追加输入与执行 span 的开 span 输入共用这一份。
 */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * 追加输入：{@link SessionEntry} 去掉引擎负责分配的基字段（id/parentId/createdAt 由账本层填写）。
 *
 * 调用方只声明「这是哪一类 entry + 该类的负载」，树形指针与身份由引擎在串行写内原子分配，避免调用方
 * 各自拼 parentId 造成竞态分叉。
 */
export type SessionEntryDraft = DistributiveOmit<SessionEntry, EngineAssignedField>

/** 非致命恢复事件回落（尾行截断 / 开档修复等）。缺席时事件仅进账本 handle 的内存 warnings。 */
export type SessionLedgerWarn = (message: string, detail: Record<string, unknown>) => void

/** 引擎负责分配、开 span 时不得携带的字段。 */
export type EngineAssignedSpanField = 'spanId' | 'startedAt' | 'endedAt' | 'status' | 'metrics'

/**
 * 开 span 输入：{@link ExecutionSpan} 去掉引擎分配字段。
 *
 * 类别特有的**收敛期字段**（tool 的 `errorCode` / model 的 `finishReason`）开 span 时
 * 先置 null 占位，收敛时经 `end` 的 patch 补上——形状恒全、消费面无需分支。
 */
export type ExecutionSpanStart = DistributiveOmit<ExecutionSpan, EngineAssignedSpanField>

/** 收敛一条 span 的产出：状态（缺省 ok）+ 度量增补 + 类别收敛期字段 patch。 */
export interface ExecutionSpanOutcome {
  status?: ExecutionSpanStatus
  metrics?: Partial<ExecutionSpanMetrics>
  /** 类别收敛期字段（errorCode / finishReason / found 等）；未知键由 strictObject 校验拦截。 */
  patch?: Record<string, unknown>
}

/** 录制器装配依赖。除 emit 外均可缺省；缺省用系统时钟 / randomUUID。 */
export interface ExecutionSpanRecorderDeps {
  emit: (span: ExecutionSpan) => void
  now?: () => number
  nextSpanId?: () => string
}

/** fork 出新会话账本的工厂：把当前叶谱系原样播种进新文件并打开 handle。 */
/**
 * 会话账本的最小形状：谁拿到一份已开档的账本就能做这些事。
 * 类实现在 impl/ledgers/SessionLedger.ts，这里只登记调用方看得到的那一面。
 */
export interface SessionLedgerApi {
  /** 这份账本对应的会话 id。 */
  readonly sessionId: string
  /** 当前叶子 id（当前位置）；空账本为 null。 */
  readonly currentLeafId: Nullable<string>
  /** 开档以来累积的非致命告警（尾行修复等）。 */
  readonly warnings: readonly string[]
  /** 追加一条 entry：引擎在串行写内原子分配 id / parentId(=当前叶子) / createdAt，schema 校验后落盘并推进叶子。 */
  append(draft: SessionEntryDraft): Promise<SessionEntry>
  /** 把当前位置移到既有 entry 上，后续 append 就此分叉出旁支；entry 不存在时抛错。 */
  branch(entryId: string): Promise<void>
  /** 把当前叶子的谱系（根→当前叶）复制成一个新会话账本并打开其 handle。 */
  fork(newSessionId: string): Promise<SessionLedgerApi>
  /** 整棵会话树投影（根 / 按 id 节点 / 叶子集合）。 */
  getTree(): SessionTree
  /** 全部 entry（追加序快照拷贝）。 */
  getEntries(): readonly SessionEntry[]
  /** 从当前叶子回溯到根、尊重 CompactionEntry 边界拼出的上下文序列。 */
  buildContextEntries(): SessionEntry[]
  /** 排空写队列并关闭 FileHandle；幂等。 */
  close(): Promise<void>
}

export type ForkFactory = (newSessionId: string, lineage: readonly SessionEntry[]) => Promise<SessionLedgerApi>

/** 打开一个账本 handle 所需的内部上下文（引擎装配，调用方不见）。 */
export interface SessionLedgerContext {
  sessionId: string
  path: string
  entries: SessionEntry[]
  warnings: string[]
  now: () => number
  nextEntryId: () => string
  warn: SessionLedgerWarn
  forkFactory: ForkFactory
  /** 关闭 handle 时回落给工厂，撤销该 path 的「已开档」登记（双开断言用，P1-10）。 */
  releaseHandle: () => void
}

/** 宿主能力的会话级观测输入；领域字段全部收进不透明 metadata。 */
export interface CapabilitySpanInput {
  name: string
  capabilityId: string
  operationId: string
  metadata?: Readonly<Record<string, unknown>>
}

/** 非 run 作用域的通用能力观测端口，由宿主按需注入。 */
export interface ExecutionCapabilitySpanRecorder {
  recordCapabilitySpan(
    sessionId: string,
    input: CapabilitySpanInput
  ): void
}

/** 一条 tool span 的收敛产出。`errorCode` 成功用 null。 */
export interface ToolSpanOutcome {
  status: ExecutionSpanStatus
  errorCode: Nullable<string>
}

/** 一条进行中 tool span 的 handle。`end` 契约上**绝不抛出**（默认实现内部隔离）。 */
export interface ToolSpanHandle {
  end(outcome: ToolSpanOutcome): void
}

/**
 * tool span 开启器——注入执行三件套（ToolExecutor）的**窄端口**。
 *
 * ToolExecutor 只依赖这一个动词：不认 runId / parentSpanId（那些由绑定本开启器的 turn scope 内部持有），
 * 令执行器与观测账本的树形记账解耦。缺省（`undefined`）= 该执行器不产 tool span。
 */
export interface ToolSpanOpener {
  /** 开一条挂在当前 turn 下的 tool span；观测停用或开启失败返回 null（执行器据此跳过收敛）。 */
  beginToolSpan(input: {
    toolCallId: string
    toolName: string
    toolCategoryId: Nullable<string>
    toolEffectKind: Nullable<string>
  }): Nullable<ToolSpanHandle>
}

/** 一条 model span 的收敛产出（D5：usage 挂在此确定 turn 的 model span 上，无 null turn）。 */
export interface ModelSpanOutcome {
  status: ExecutionSpanStatus
  finishReason: Nullable<string>
  errorCode: Nullable<string>
  errorMessage: Nullable<string>
  tokensIn: Nullable<number>
  tokensOut: Nullable<number>
  costUsd: Nullable<number>
  /**
   * 请求指纹（Ring0 `ProviderRequestFingerprint.id`，与 context-replays 对齐）。仅在回合收敛后才可知
   * （拼装期计算），故 open 时置 null、收敛时 patch 补上。缺席用 null。
   */
  requestFingerprint: Nullable<string>
}

/** 一条进行中 model span 的 handle。`end` 契约上绝不抛出。 */
export interface ModelSpanHandle {
  end(outcome: ModelSpanOutcome): void
}

/**
 * turn 级 scope：一次 provider 生成回合内 model / tool / capability / policy span 的来源。
 *
 * 继承 {@link ToolSpanOpener} 令其可直接注入 ToolExecutor 作 tool span 开启器。
 */
export interface TurnSpanScope extends ToolSpanOpener {
  /** 开本轮 provider 请求的 model span（挂本确定 turn；usage 在 end 时补上）。 */
  beginModelSpan(input: {
    provider: string
    model: string
    requestFingerprint: Nullable<string>
  }): Nullable<ModelSpanHandle>
  /** 记一条 policy 点事件 span（收编 control-plane ledger 决策）。 */
  recordPolicySpan(input: { name: string; source: string; action: string; reason: string }): void
  /** 记一条宿主注入能力的点事件 span；Kernel 不解释 operationId/metadata。 */
  recordCapabilitySpan(input: CapabilitySpanInput): void
  /**
   * D3：把本回合的**重内容**（系统提示词全文 / promptSegments / capabilityContextAudit）写进 prompt 审计侧信道
   * （独立文件，靠 `requestFingerprint` 关联回本回合 model span）。span 侧只留指标 + 指纹保持轻/高频；
   * 无 sidecar 装配（`resolvePromptAuditPath` 缺席）时 no-op。**绝不进会话账本**。
   */
  recordPromptAudit(input: {
    requestFingerprint: Nullable<string>
    systemPrompt: string
    promptSegments: readonly unknown[]
    skippedPromptSegments: readonly unknown[]
    capabilityContextAudit: readonly unknown[]
    providerRequest: Nullable<ProviderRequestSnapshot>
  }): void
  /** 收敛本 turn span。 */
  end(outcome: { status: ExecutionSpanStatus }): void
}

/** run 级 scope：一次完整 agent 执行的根，派生 turn scope。 */
export interface RunSpanScope {
  beginTurn(input: {
    turn: number
    roleId: Nullable<string>
    model: Nullable<string>
  }): TurnSpanScope
  end(outcome: { status: ExecutionSpanStatus }): void
}

export interface LedgerTurnSpanScopeDeps {
  /** 本 turn 的元数据，供 D3 prompt 审计记录带上（span 侧已单独记，此处审计侧信道复用）。 */
  turnMeta: { turn: number; roleId: Nullable<string>; model: Nullable<string> }
  now: () => number
  /** D3：prompt 审计写入器（fire-and-forget）；null → recordPromptAudit no-op。 */
  promptAuditAppend: Nullable<(record: PromptAuditRecord) => void>
}

/**
 * 一条 prompt 审计记录：一次 provider 请求的重内容快照，靠 `requestFingerprint` 关联回同回合的 model span。
 * 全字段落盘保形（缺席用 null / 空数组），读侧无需分支。
 */
export interface PromptAuditRecord {
  capturedAt: number
  sessionId: string
  runId: string
  /** 关联键：与 model span 的 `requestFingerprint` 同值（缺席用 null）。 */
  requestFingerprint: Nullable<string>
  /** 子 Agent 无界面轮次轴时为 null（对齐 span 侧的确定 turn 语义，此处按调用方传入）。 */
  turn: Nullable<number>
  roleId: Nullable<string>
  model: Nullable<string>
  /** 系统提示词全文（重内容之家；span 侧只留 chars 指标）。 */
  systemPrompt: string
  /** 逐段提示词轨迹（含文本）；内容态由调用方原样传入，审计侧不解释。 */
  promptSegments: readonly unknown[]
  skippedPromptSegments: readonly unknown[]
  capabilityContextAudit: readonly unknown[]
  /** 最终 provider-visible system/messages/tools/toolChoice；旧记录缺席。 */
  providerRequest?: LooseOptional<ProviderRequestSnapshot>
}

/** 读取审计侧信道文件的结果：记录序列 + 是否发生过尾行截断修复。 */
export interface PromptAuditReadResult {
  records: PromptAuditRecord[]
  truncatedTail: boolean
}

/** 非致命恢复事件回落（尾行截断 / 开档修复等）。缺省时事件仅进账本 handle 的内存 warnings。 */
export type SpanLedgerWarn = (message: string, detail: Record<string, unknown>) => void

/**
 * entry 分类（宪章 §6 entry 类型学的**语义单源**，P1-5）。三类派生出全仓所有「entry 该不该进某序列」的判定：
 *   - `transcript`：真实对话转录（message / custom-message），进 provider 上下文、是 renderer 快照投影的产物；
 *   - `governance`：治理产物（compaction / branch-summary），在 provider 上下文里**顶替**被折叠的转录段；
 *   - `metadata`：会话级元数据（session-info / model-change）与开放数据面 custom——**落盘不进上下文**。
 *
 * 单源杜绝散落的 `type !== 'compaction' && type !== 'session-info'` 硬编码副本（曾让 session-info 头 entry
 * 漏进 provider 序列 / 让镜像与直投对账假 drift）。buildContextEntries / ReadAssembler 影子 diff / lab 过滤全部派生此表。
 */
export type SessionEntryClass = 'transcript' | 'governance' | 'metadata'

/** 树节点：一条 entry + 其子 entry id（按追加序）。 */
export interface SessionTreeNode {
  entry: SessionEntry
  childIds: string[]
}

/** 会话树投影：根、按 id 索引的节点、叶子集合。 */
export interface SessionTree {
  /** 根 entry id（parentId 为 null 的那条）；空账本为 null。 */
  rootId: Nullable<string>
  nodesById: Record<string, SessionTreeNode>
  /** 没有子节点的 entry id 集合（追加序）。 */
  leafIds: string[]
}

/** 读取账本的结果：解析出的 entry 序列 + 是否发生过尾行截断修复。 */
export interface LedgerReadResult {
  entries: SessionEntry[]
  /** 是否检测到并跳过了半截尾行（调用方据此决定是否回写修复）。 */
  truncatedTail: boolean
}

/** 读取账本的结果：解析出的 span 序列 + 是否发生过尾行截断修复。 */
export interface SpanLedgerReadResult {
  spans: ExecutionSpan[]
  /** 是否检测到并跳过了半截尾行（调用方据此决定是否回写修复）。 */
  truncatedTail: boolean
}

/** 树节点：一条 span + 其子 span id（按 startedAt 升序，tie-break spanId）。 */
export interface ExecutionSpanTreeNode {
  span: ExecutionSpan
  childIds: string[]
}

/** 执行 span 树投影：根集合、按 id 索引的节点、孤儿集合。 */
export interface ExecutionSpanTree {
  /** parentSpanId 为 null 的顶层 span（通常是 run span），按 startedAt 升序。 */
  rootIds: string[]
  nodesById: Record<string, ExecutionSpanTreeNode>
  /** parentSpanId 指向账本中不存在 span 的孤儿（活读时父未落盘），按 startedAt 升序。 */
  orphanIds: string[]
}

/** 一条 tool span 的调试投影（结构化错误码 / 分类 / 延迟）。 */
export interface ExecutionSpanDebugTool {
  toolCallId: string
  toolName: string
  toolCategoryId: Nullable<string>
  toolEffectKind: Nullable<string>
  status: ExecutionSpanStatus
  errorCode: Nullable<string>
  latencyMs: Nullable<number>
}

/** 一条宿主注入能力 span 的调试投影；metadata 对 Kernel 保持不透明。 */
export interface ExecutionSpanDebugCapability {
  capabilityId: string
  operationId: string
  metadata: Readonly<Record<string, unknown>>
  latencyMs: Nullable<number>
}

/** 一条 policy span 的调试投影（收编 control-plane 决策）。 */
export interface ExecutionSpanDebugPolicy {
  source: string
  action: string
  reason: string
}

/**
 * 逐轮执行观测投影，与 get_debug turns 形状字段对齐（turn/role/model 同名同义），另附 span 独有的
 * 执行指标（token/cost/finishReason/指纹/延迟）。full=false 略去 tools/capabilities/policy 明细。
 */
export interface ExecutionSpanDebugTurn {
  /**
   * 所属 run 的 id——令摊平后的逐轮记录可归属回 run（区分父/子 Agent run，#37 阶段 C 片 2）。
   * span 契约的 runId 已放宽 nullable（会话级非 run 记录），故投影如实带 Nullable；turn 行恒有真实 runId。
   */
  runId: Nullable<string>
  /** 与 legacy turn 对齐：轮序号。 */
  turn: Nullable<number>
  /** 与 legacy turn 对齐：角色 id（span 无 roleLabel，故只投 roleId 口径）。 */
  role: Nullable<string>
  /** 与 legacy turn 对齐：模型 id（span 为字符串口径，legacy 为 roleRuntimeModel 对象）。 */
  model: Nullable<string>
  provider: Nullable<string>
  status: ExecutionSpanStatus
  latencyMs: Nullable<number>
  tokensIn: Nullable<number>
  tokensOut: Nullable<number>
  costUsd: Nullable<number>
  finishReason: Nullable<string>
  requestFingerprint: Nullable<string>
  toolCount: number
  toolErrorCount: number
  /** full-only：本轮工具 span 明细。 */
  tools?: ExecutionSpanDebugTool[]
  /** full-only：本轮宿主注入能力 span 明细。 */
  capabilities?: ExecutionSpanDebugCapability[]
  /** full-only：本轮控制/审批 span 明细。 */
  policy?: ExecutionSpanDebugPolicy[]
  /**
   * full-only：D3 prompt 审计侧信道带出的本回合重内容（系统提示词全文/promptSegments/capabilityContextAudit），
   * 靠 requestFingerprint 关联匹配。sidecar 缺失或指纹不匹配时缺席（fallback 语义）。
   */
  promptAudit?: ExecutionSpanDebugPromptAudit
}

/** D3 prompt 审计投影（full-only；内容态原样带出，脱敏见 prompt-audit.ts 裁决点）。 */
export interface ExecutionSpanDebugPromptAudit {
  systemPromptChars: number
  systemPrompt: string
  promptSegments: readonly unknown[]
  skippedPromptSegments: readonly unknown[]
  capabilityContextAudit: readonly unknown[]
  providerRequest?: PromptAuditRecord['providerRequest']
}

/** 一次 run 的调试投影（按 runId 分组，与 §2.3「一会话多次 run 追加同文件」对齐）。 */
export interface ExecutionSpanDebugRun {
  /** run 的 id；span 契约放宽 nullable 后投影如实带 Nullable，run 行恒有真实 runId。 */
  runId: Nullable<string>
  status: ExecutionSpanStatus
  startedAt: number
  endedAt: number
  latencyMs: Nullable<number>
  turnCount: number
  /** 子 Agent 身份/角色名（主 Agent 根 run 用 null）——区分同会话内父/子 run 树（#37 阶段 C 片 2）。 */
  agentName: Nullable<string>
  /** 派发来源（子 Agent 的父角色；主 Agent 根 run 用 null）。 */
  dispatchSource: Nullable<string>
}

/** 执行 span 调试投影：run 分组 + 摊平后的逐轮记录（供 turns 对齐消费）。 */
export interface ExecutionSpanDebugProjection {
  runCount: number
  turnCount: number
  runs: ExecutionSpanDebugRun[]
  /** 跨 run 摊平的逐轮观测，按 startedAt 升序；调用方可 slice(-limit) 取尾窗。 */
  turns: ExecutionSpanDebugTurn[]
  /** 不隶属具体 run 的宿主能力观测，按 at 升序。 */
  capabilityObservations: Array<ExecutionSpanDebugCapability & { at: number }>
}

export interface ProjectExecutionSpanDebugOptions {
  /** full=true 附带 tools/capabilities/policy 明细 + D3 prompt 审计；否则只投逐轮指标摘要。 */
  full?: boolean
  /** 仅保留最近 limit 轮（对齐 legacy turns.slice(-limit)）；缺省全保留。 */
  limit?: number
  /**
   * D3：本会话 prompt 审计侧信道记录（full 档按 requestFingerprint 关联挂到逐轮投影）。
   * 缺省/空 = 不带 prompt 审计（sidecar 缺失的 fallback）。
   */
  promptAudit?: readonly PromptAuditRecord[]
}

/** 逐行解析结果：解析出的记录序列 + 是否检测到并跳过了半截尾行。 */
export interface JsonlParseResult<T> {
  records: T[]
  /** 调用方据此决定是否 `truncateJsonlToLineCount` 回写修复。 */
  truncatedTail: boolean
}

/** {@link LedgerExecutionSpanScopeFactory} 装配依赖。 */
export interface LedgerExecutionSpanScopeFactoryDeps {
  /** 每会话执行账本文件路径（数据根下与 session ledger 平行目录）。 */
  resolveLedgerPath: (sessionId: string) => string
  /**
   * D3：每会话 prompt 审计侧信道文件路径（与 span 账本物理平行，如 `execution-spans/<id>.prompts.jsonl`）。
   * 缺省关闭——`recordPromptAudit` 降级 no-op（不装配 sidecar = 不落重内容）。
   */
  resolvePromptAuditPath?: (sessionId: string) => string
  /** 非致命恢复事件回落（尾行修复等）；缺省进 warn 日志。 */
  warn?: SpanLedgerWarn
  /** 取当前时刻（epoch 毫秒）的时钟，交给录制器算 span 时长；缺省 `Date.now`，property 电池注入确定性时钟复现字节。 */
  now?: () => number
  /** 分配 span 身份的工厂；缺省由录制器回落到 `randomUUID`，测试注入递增序号让落盘 span 逐字节可比。 */
  nextSpanId?: () => string
}

export type ExecutionSpanCategory = 'capability' | 'run' | 'turn' | 'model' | 'tool' | 'policy'
