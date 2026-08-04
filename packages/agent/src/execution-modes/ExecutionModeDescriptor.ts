// 域：执行模式能力化（宪章 §2「执行模式能力化」法条）。
//
// 一个执行模式 = 一份 ExecutionModeDescriptor 声明式捆绑：提示词段投影 + 工具面投影 +
// 会话粘性规则 + 完成语义。三个官方模式（目标 / 计划 / 方案）重表达为首批预制 descriptor，
// 经注册表装配；新模式 = 纯声明零改码。descriptor 只承载 host 无关的模式契约，
// 只依赖 `@velaros-ai/agent/protocol` 的提示词特性 id。
import type { ChatPromptFeatureId } from '@velaros-ai/agent/protocol'

/** 三个官方执行模式的稳定 id。新增预制模式在此并集追加。 */
export type ExecutionModeId = 'goal' | 'plan' | 'proposal'

/**
 * 提示词构建面投影声明。
 *
 * `snapshotFlag` 是本模式在 `RuntimePromptSnapshot` 上驱动提示词段（段 `when()` 判定）的
 * 布尔标志名——登记「哪个标志属于哪个模式」的单源；`promptFeatureId` 是激活本模式的
 * 提示词特性 id，goal 模式无对应特性（走 goalMode 布尔 / 活跃目标推断），故为 null。
 */
export interface ExecutionModePromptProjection {
  snapshotFlag: 'goalMode' | 'userRequestedPlan' | 'proposalMode'
  promptFeatureId: Nullable<ChatPromptFeatureId>
}

/**
 * 工具面投影声明。
 *
 * `readOnlyExecutionBoundary=true` 表示宿主级只读边界（方案模式：非 inspect 工具默认拒绝
 * 执行）；`executionGateAllowedNonInspectTools` 是只读边界下仍放行执行的非 inspect 工具名，
 * 是宿主执行门（`ToolExecutionPolicy`）的单源白名单。非只读边界的模式该列表为空。
 *
 * 注：方案模式另有一套「工具面曝光」白名单（`SoloRunPlanPreparer` 的 required/exposure 集合），
 * 与本执行门白名单是两条独立校准的抗体（成员刻意不同），不并入本字段——见 registry 深水登记。
 */
export interface ExecutionModeToolProjection {
  readOnlyExecutionBoundary: boolean
  executionGateAllowedNonInspectTools: readonly string[]
}

/** 会话粘性声明：选中后是否跨回合 / 跨 hook send 会话级粘滞。 */
export interface ExecutionModeStickiness {
  sessionSticky: boolean
}

/** 完成语义：`manual-exit`=用户手动退出；`auto-exit-on-approval`=批准后下轮自动退出（方案模式）。 */
export type ExecutionModeCompletionKind = 'manual-exit' | 'auto-exit-on-approval'

export interface ExecutionModeCompletion {
  kind: ExecutionModeCompletionKind
}

/**
 * 执行模式描述符——一个模式的声明式单源。
 *
 * 消费点（提示词构建 / 工具门控 / 粘性 / 完成）经注册表解析本描述符，不再各自硬编码
 * `if (planningMode)` / `if (proposalMode)` 与散装特性 id 判定。
 */
export interface ExecutionModeDescriptor {
  id: ExecutionModeId
  label: string
  prompt: ExecutionModePromptProjection
  toolProjection: ExecutionModeToolProjection
  stickiness: ExecutionModeStickiness
  completion: ExecutionModeCompletion
}
