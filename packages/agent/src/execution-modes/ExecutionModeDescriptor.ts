// 域：执行模式能力化（宪章 §2「执行模式能力化」法条）。
//
// 一个执行模式 = 一份 ExecutionModeDescriptor 声明式捆绑：提示词段投影 + 会话粘性规则。
// 两个官方模式（目标 / 计划）重表达为首批预制 descriptor，经注册表装配；新模式 = 纯声明零改码。
// descriptor 只承载 host 无关的模式契约，只依赖 `@velaros-ai/agent/protocol` 的提示词特性 id。
//
// **执行模式不带工具面投影**（2026-08-05 裁决，见 Desktop `docs/design-principles.md` §7）：
// 「先方案后实施」这类工作流编排纪律只许走提示词与技能文书，禁运行时拦截。旧的
// `toolProjection`（只读执行边界 + 执行门白名单）随方案模式一并处决，模式不再是工具门的输入。
import type { ChatPromptFeatureId, ExecutionModeId } from '@velaros-ai/agent/protocol'

export type { ExecutionModeId }

/**
 * 提示词构建面投影声明。
 *
 * `snapshotFlag` 是本模式在 `RuntimePromptSnapshot` 上驱动提示词段（段 `when()` 判定）的
 * 布尔标志名——登记「哪个标志属于哪个模式」的单源。
 *
 * `legacyPromptFeatureId` 是**拆轴前**用来激活本模式的提示词特性 id：模式曾与插件能力挤在
 * 同一根 `promptFeatures` 数组里（goal 走布尔、plan 走特性 id，两档形态还不一样）。拆轴后
 * 权威源是 `executionModes`，这个 id 只剩一个用途——把存量会话 / 旧宿主请求里粘着的旧形态
 * 折算回模式轴（{@link resolveExecutionModes}），并从能力轴上剥掉。goal 从来没有特性 id，为 null。
 */
export interface ExecutionModePromptProjection {
  snapshotFlag: 'goalMode' | 'userRequestedPlan'
  legacyPromptFeatureId: Nullable<ChatPromptFeatureId>
}

/** 会话粘性声明：选中后是否跨回合 / 跨 hook send 会话级粘滞。 */
export interface ExecutionModeStickiness {
  sessionSticky: boolean
}

/**
 * 执行模式描述符——一个模式的声明式单源。
 *
 * 消费点（提示词构建 / 粘性）经注册表解析本描述符，不再各自硬编码 `if (planningMode)`
 * 与散装特性 id 判定。
 */
export interface ExecutionModeDescriptor {
  id: ExecutionModeId
  label: string
  prompt: ExecutionModePromptProjection
  stickiness: ExecutionModeStickiness
}
