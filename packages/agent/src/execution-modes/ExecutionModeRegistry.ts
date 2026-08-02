// 执行模式注册表：三个官方模式的首批预制 descriptor + 解析函数。
//
// 行为逐字节不变——预制 descriptor 只是把此前散在提示词构建 / 工具门控 / 会话粘性三处的
// 硬编码事实（提示词特性 id、方案模式执行门白名单、快照标志名、粘性/完成语义）**重表达为
// 声明**，消费点改经本注册表解析单源。新模式 = 纯声明零改码（构造一份 descriptor 即可）。
import { isNotNull, toNullable } from '@velaros-ai/core'
import type { ChatPromptFeatureId } from '@velaros-ai/core/types'

import type { ExecutionModeDescriptor, ExecutionModeId } from './ExecutionModeDescriptor'

/**
 * 目标模式（goal）。
 *
 * 无对应提示词特性——经 `AgentExecutionConfig.goalMode` 布尔 / 活跃目标推断驱动（见 PromptState 的
 * `goalMode: isTrue(goalMode) || hasActiveGoal`）。不施加工具执行边界；工具面另有
 * `GoalModeRequiredToolNames`（goal:get/goal:create/goal:update）保护集，属 SoloRunPlanPreparer
 * 曝光深水域，不并入执行门白名单。
 */
const goalModeDescriptor: ExecutionModeDescriptor = {
  id: 'goal',
  label: '目标模式',
  prompt: { snapshotFlag: 'goalMode', promptFeatureId: null },
  toolProjection: { readOnlyExecutionBoundary: false, executionGateAllowedNonInspectTools: [] },
  stickiness: { sessionSticky: false },
  completion: { kind: 'manual-exit' },
}

/**
 * 计划模式（plan）。
 *
 * 由 `plan` 提示词特性激活；提示词面注入计划维护/预览/建议段（`userRequestedPlan` 快照标志）。
 * 工具面**不限制执行**（ExecutionPolicy 的 planning-mode 门恒放行）。会话级粘滞。
 */
const planModeDescriptor: ExecutionModeDescriptor = {
  id: 'plan',
  label: '计划模式',
  prompt: { snapshotFlag: 'userRequestedPlan', promptFeatureId: 'plan' },
  toolProjection: { readOnlyExecutionBoundary: false, executionGateAllowedNonInspectTools: [] },
  stickiness: { sessionSticky: true },
  completion: { kind: 'manual-exit' },
}

/**
 * 方案模式（proposal）。
 *
 * 由 `proposal` 提示词特性激活；施加宿主级只读执行边界——非 inspect 工具默认拒绝执行，
 * 仅放行下列白名单（`ToolExecutionPolicy` 执行门单源）。会话级粘滞；完成语义为
 * 「批准后下轮自动退出」（`proposal:review` 批准返回 disabledPromptFeatures=['proposal']，
 * 由消费方一次性关停模式）。
 *
 * 注：本白名单是**执行门**白名单，与 `SoloRunPlanPreparer` 的**工具面曝光**白名单是两条独立
 * 校准的抗体（前者含 tooling:map、后者含 proposal:get，成员刻意不同），不可合并——曝光集合仍留
 * SoloRunPlanPreparer 深水域。
 */
const proposalModeDescriptor: ExecutionModeDescriptor = {
  id: 'proposal',
  label: '方案模式',
  prompt: { snapshotFlag: 'proposalMode', promptFeatureId: 'proposal' },
  toolProjection: {
    readOnlyExecutionBoundary: true,
    executionGateAllowedNonInspectTools: [
      'ask_user',
      'proposal:review',
      'artifact:produce',
      'agent:dispatch',
      'agent:run_workflow',
      'job:read_output',
      'job:wait',
      'job:cancel',
      // 工具空间三件套都是只读/编排操作:tooling:map 看目录、tooling:read 读 schema、tooling:replace 换页。
      // 拦掉 map/read 会把方案模式的调研发现链路整个掐断(模型连有什么工具都查不了)。
      'tooling:map',
      'tooling:read',
      'tooling:replace',
    ],
  },
  stickiness: { sessionSticky: true },
  completion: { kind: 'auto-exit-on-approval' },
}

/** 官方预制模式注册表（封闭轴集合，新增预制在此追加；用户/harness 亦可零改码构造新 descriptor）。 */
const ExecutionModeRegistry: Readonly<Record<ExecutionModeId, ExecutionModeDescriptor>> = {
  goal: goalModeDescriptor,
  plan: planModeDescriptor,
  proposal: proposalModeDescriptor,
}

/** 按 id 解析预制执行模式描述符。 */
function getExecutionMode(id: ExecutionModeId): ExecutionModeDescriptor {
  return ExecutionModeRegistry[id]
}

/** 列出全部预制执行模式描述符。 */
function listExecutionModes(): readonly ExecutionModeDescriptor[] {
  return [goalModeDescriptor, planModeDescriptor, proposalModeDescriptor]
}

/** 由提示词特性反查其激活的执行模式（goal 无特性，永不命中）。 */
function resolveExecutionModeForPromptFeature(
  feature: ChatPromptFeatureId
): Nullable<ExecutionModeDescriptor> {
  return toNullable(
    listExecutionModes().find((descriptor) => descriptor.prompt.promptFeatureId === feature)
  )
}

/**
 * 判定某执行模式是否被本轮选中——单源「哪个提示词特性 id 意味着哪个模式」的激活谓词。
 * 取代散装的 `promptFeatures?.includes('plan'|'proposal')`；goal 模式无特性恒 false。
 */
function isExecutionModeSelected(
  id: ExecutionModeId,
  promptFeatures: readonly ChatPromptFeatureId[]
): boolean {
  const feature = getExecutionMode(id).prompt.promptFeatureId
  return isNotNull(feature) && promptFeatures.includes(feature)
}

export {
  ExecutionModeRegistry,
  getExecutionMode,
  isExecutionModeSelected,
  listExecutionModes,
  resolveExecutionModeForPromptFeature,
}
