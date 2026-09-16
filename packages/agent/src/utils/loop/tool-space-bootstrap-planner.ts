
import { isEmpty, isNumber, optionalWhen,toNullable, truncate } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type { ToolCategoryId } from '../../types/agent.js'
import type { IntentDomainMatch,ToolSpaceBootstrapDecisionKind, ToolSpaceBootstrapPlan, ToolSpaceBootstrapPlannerInput, ToolSpaceBootstrapState, ToolSpaceForcedToolChoice } from '../../types/loop.js'
import { AgentTuning } from '../tuning'

import { detectAgentIntentSignals, extractLatestUserTextFromMessages, isLowSignalIntentText, normalizeIntentText } from './intent-signals'

const KernelDiscoveryTools = new Set(['tooling:map'])

/**
 * 对这句话跑一遍意图分类，只取其中的域清单（`requires*` 那几个汇总标志本层用不上）。
 * 这批域随后决定要静默预换入哪些工具类别，以及算不算跨域复杂任务（≥2 域就要强制先建工具地图）。
 */
function detectIntentDomains(
  text: string,
  capabilityPorts?: AgentRuntimeCapabilityPorts
): IntentDomainMatch[] {
  return detectAgentIntentSignals(text, capabilityPorts).domains
}

/**
 * 选这一轮要强制调的发现工具。目前内核只有一个（`KernelDiscoveryTools` 也只登记了 `tooling:map`），
 * 所以无论命中哪些域都返回它；域清单照收是为了将来按域分流到别的发现工具时不用改调用点。
 */
function resolveDiscoveryTool(_domains: readonly IntentDomainMatch[]): 'tooling:map' {
  return 'tooling:map'
}

/**
 * 给一次侦察决策算指纹：`决策类型:被强制的工具名:意图前 80 字`。它的用处是认出「还是刚才那件事」，
 * 从而让下面的连发抑制生效。意图截到 80 字是刻意的——同一诉求换个措辞、补两句细节仍应落在同一指纹上，
 * 否则模型只要改一个字就能绕开抑制、被无限推回侦察。
 */
function buildFingerprint(input: {
  kind: ToolSpaceBootstrapDecisionKind
  forcedToolName: Nullable<string>
  intentText: string
}): string {
  const toolPart = input.forcedToolName ?? 'none'
  return `${input.kind}:${toolPart}:${truncate(input.intentText, 80)}`
}

/**
 * 判定这一轮该不该放弃「强制先调 tooling:map」。两种情况为真：本轮还没走到状态里记的
 * `suppressedUntilTurn`（上游显式压了一段时间），或同一指纹已经强制过
 * `AgentTuning.loop.forcedDiscoveryPerFingerprint`（2）次。
 * 抑制生效后计划退回静默预载或不干预，改由模型自己决定要不要查工具页，不再被反复推回侦察。
 */
function shouldSuppressForcedDiscovery(input: {
  fingerprint: string
  state?: ToolSpaceBootstrapState
  turn?: number
}): boolean {
  if (
    isNumber(input.state?.suppressedUntilTurn) &&
    isNumber(input.turn) &&
    input.turn < input.state!.suppressedUntilTurn!
  ) return true

  return (
    input.state?.lastDecisionFingerprint === input.fingerprint &&
    (input.state?.forcedDiscoveryCount ?? 0) >= AgentTuning.loop.forcedDiscoveryPerFingerprint
  )
}

/**
 * 算出要带进下一轮的侦察状态：本轮指纹一律记下；只有真的强制了发现且没被抑制才把计数加一，
 * 并且换了指纹就从 0 重数——这个计数的含义是「同一件事强制过几次」，不是全局累计次数。
 * 未强制或被抑制的轮次只刷新指纹、不计数，免得把「没强制」也算进配额里提前触发抑制。
 */
function buildNextState(input: {
  fingerprint: string
  forced: boolean
  suppressed: boolean
  state?: ToolSpaceBootstrapState
}): ToolSpaceBootstrapState {
  if (!input.forced || input.suppressed) return {
      ...input.state,
      lastDecisionFingerprint: input.fingerprint,
    }

  const previousCount =
    input.state?.lastDecisionFingerprint === input.fingerprint
      ? input.state?.forcedDiscoveryCount ?? 0
      : 0

  return {
    ...input.state,
    lastDecisionFingerprint: input.fingerprint,
    forcedDiscoveryCount: previousCount + 1,
  }
}

/**
 * 模型确实动手调工具之后调一次，把当前指纹的强制计数直接顶到上限，等于宣告「这件事的侦察已经满足」：
 * 同一请求的后续轮次不会再被强制先查工具地图。还没记过指纹（本执行尚未做过侦察决策）时原样返回，
 * 不凭空写入一个配额。
 */
function markToolSpaceBootstrapDiscoverySatisfied(
  state: ToolSpaceBootstrapState
): ToolSpaceBootstrapState {
  if (!state.lastDecisionFingerprint) return state

  return {
    ...state,
    forcedDiscoveryCount: Math.max(
      state.forcedDiscoveryCount ?? 0,
      AgentTuning.loop.forcedDiscoveryPerFingerprint
    ),
  }
}

/**
 * 拼强制侦察那一轮压进 history 的内部提醒：说明为什么要先查（跨域任务先建全局地图 / 需先确认工具空间）、
 * 本轮已经预换入了哪些候选类别（一个都没有就写明不会自动换入高风险或需用户动作的类别），
 * 并明确要求先调 `tooling:map`、按意图选 `op="find"` 或 `op="map"`，不许拿现有工具凑答案。
 */
function buildDiscoveryReminder(input: {
  toolName: 'tooling:map'
  intentText: string
  pageInCategories: readonly ToolCategoryId[]
  complex: boolean
}): string {
  const categoryText = !isEmpty(input.pageInCategories)
    ? `已预换入候选类别：${input.pageInCategories.join('、')}。`
    : '当前不自动换入高风险或需用户动作的类别。'
  const scopeText = input.complex
    ? '这是跨域或多能力任务，先建立全局工具地图。'
    : '这是需要工具空间确认的任务，先查候选工具页。'

  return [
    `[系统] ContextOS 工具空间启动：${scopeText}`,
    categoryText,
    `本轮必须先调用 ${input.toolName}，按最近用户意图选择 op="find" 或 op="map"，必要时用 domainIds、toolOsStates 或 categoryIds 收窄。`,
    '不要在未确认工具页状态、依赖和 schema 前直接用现有工具凑答案。',
  ].join('\n')
}

/**
 * 每轮发模型之前决定工具空间怎么开场，只出三档：
 * - `none`：这句话是打招呼/继续这类无信号文本，或压根没识别出域、也没有要换入的类别——完全不干预。
 * - `preload`：识别到具体域，把它们要而当前还没启用的类别静默预换入，不打断模型。
 * - `discover`：意图模糊（命中 `unknown` 域）或跨 ≥2 个域，且 `tooling:map` 这一轮确实在可见工具里，
 *   才强制本轮先调它，并附一条 `buildDiscoveryReminder` 的提醒。
 *
 * 强制档还要再过一遍连发抑制（同一指纹最多两次）：被抑制就降级回 `preload` 或 `none`，
 * 免得模型卡在「反复被推回侦察」的环里。返回的 `nextState` 必须由调用方存回会话，否则抑制计数不生效，
 * 抑制也就形同虚设。
 */
function planToolSpaceBootstrap(input: ToolSpaceBootstrapPlannerInput): ToolSpaceBootstrapPlan {
  const latestUserText = extractLatestUserTextFromMessages(input.messages)
  const intentText = normalizeIntentText(latestUserText ?? '')
  const emptyState: ToolSpaceBootstrapState = input.state ?? {}

  if (isLowSignalIntentText(intentText)) return {
      decision: { kind: 'none' },
      pageInCategories: [],
      pageInTools: [],
      forcedToolChoice: null,
      internalReminder: null,
      nextState: emptyState,
    }

  const domains = detectIntentDomains(intentText, input.capabilityPorts)
  const pageInCategories = [
    ...new Set(
      domains
        .flatMap((domain) => domain.categories)
        .filter((categoryId) => !input.enabledToolCategories.includes(categoryId))
    ),
  ]

  if (isEmpty(domains) && isEmpty(pageInCategories)) return {
      decision: { kind: 'none' },
      pageInCategories: [],
      pageInTools: [],
      forcedToolChoice: null,
      internalReminder: null,
      nextState: emptyState,
    }

  // 已确认的发现策略：只有意图模糊（capability-uncertainty 命中的 unknown 域）或跨 ≥2 能力域的
  // 复杂任务才强制全局 tooling:map 发现；能直接定位到具体类别（如 category-*）的单域意图改走静默
  // 预载（下方 pageInCategories → 'preload'），不再每次干活前都逼模型先调一次 tooling:map。
  const complex = domains.length >= 2 || domains.some((domain) => domain.id === 'unknown')
  const hasDiscoveryNeed = complex
  const requestedDiscoveryTool = hasDiscoveryNeed ? resolveDiscoveryTool(domains) : null
  const discoveryToolVisible =
    requestedDiscoveryTool && input.currentVisibleToolNames.includes(requestedDiscoveryTool)
  const forcedToolChoice =
    requestedDiscoveryTool && discoveryToolVisible && KernelDiscoveryTools.has(requestedDiscoveryTool)
      ? ({ type: 'tool', toolName: requestedDiscoveryTool } satisfies ToolSpaceForcedToolChoice)
      : null
  const decisionKind: ToolSpaceBootstrapDecisionKind = forcedToolChoice ? 'discover' : 'preload'
  const fingerprint = buildFingerprint({
    kind: decisionKind,
    forcedToolName: toNullable(forcedToolChoice?.toolName),
    intentText,
  })
  const suppressed = shouldSuppressForcedDiscovery({
    fingerprint,
    state: input.state,
    turn: input.turn,
  })
  const effectiveForcedToolChoice = suppressed ? null : forcedToolChoice
  const effectiveDecisionKind: ToolSpaceBootstrapDecisionKind = effectiveForcedToolChoice
    ? 'discover'
    : !isEmpty(pageInCategories)
      ? 'preload'
      : 'none'
  return {
    decision: {
      kind: effectiveDecisionKind,
      reason: effectiveForcedToolChoice
        ? complex
          ? 'complex-multi-domain-discovery'
          : 'intent-discovery'
        : optionalWhen(!isEmpty(pageInCategories), 'intent-preload'),
    },
    pageInCategories,
    pageInTools: [],
    forcedToolChoice: effectiveForcedToolChoice,
    internalReminder: effectiveForcedToolChoice
      ? buildDiscoveryReminder({
          toolName: effectiveForcedToolChoice.toolName,
          intentText,
          pageInCategories,
          complex,
        })
      : null,
    nextState: buildNextState({
      fingerprint,
      forced: !!forcedToolChoice,
      suppressed,
      state: input.state,
    }),
  }
}

export { planToolSpaceBootstrap }
export { markToolSpaceBootstrapDiscoverySatisfied }
