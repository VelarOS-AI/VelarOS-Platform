// 域：子 Agent 派发的**结果与状态文案格式化**（纯函数，不依赖派发器实例状态）。
//
// 包含守护资产：`formatSubAgentTaskResultForParent` 的【子agent「Name」的返回】前缀——并行多个
// 子 Agent 时让父可靠区分各自结果、避免把 A 的结论错标成 B（实测防护，语义一字不动）。
import type { SubAgentTaskResult } from '@velaros-ai/agent/protocol'
import { truncate } from '@velaros-ai/core'

import { formatSubAgentToolResult, type SubAgentThreadUnresumableReason } from '../../sub-agent'

const FallbackSubAgentCodenames = [
  'Atlas',
  'Beacon',
  'Cipher',
  'Forge',
  'Harbor',
  'Lumen',
  'Nova',
  'Orion',
  'Pioneer',
  'Quest',
  'Relay',
  'Scout',
  'Vector',
  'Warden',
]

/** 解析子 Agent 展示名：合法的字母名直接用，否则按 threadId 稳定散列取一个代号。 */
function resolveSubAgentAgentName(value: LooseOptional<string>, threadId: string): string {
  const normalized = value?.trim()
  if (normalized && /^[A-Za-z][A-Za-z -]*$/.test(normalized)) return normalized

  let hash = 0
  for (const char of threadId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return FallbackSubAgentCodenames[hash % FallbackSubAgentCodenames.length] ?? 'Atlas'
}

/**
 * 把子 Agent 任务结果格式化为父工具调用的返回文本。
 *
 * 携带真实子结果时加上子 agent 名字前缀，让父在并行多个子 agent 时能可靠区分各自的结果、
 * 避免把 A 的结论错标成 B（并行 dispatch 合成串台的实测防护）。
 */
function formatSubAgentTaskResultForParent(
  result: SubAgentTaskResult,
  agentName?: string
): string {
  const formatted = formatSubAgentToolResult(result)
  const name = agentName?.trim()
  return name ? `【子 agent「${name}」的返回】\n${formatted}` : formatted
}

type SubAgentBackgroundArtifactFormatResult =
  | { artifact: string; degraded: false }
  | { artifact: string; degraded: true; error: unknown }

/** 后台制品序列化是可降级的旁路，不得反向改写子 Agent 已收敛的终态。 */
function formatSubAgentBackgroundArtifact(
  result: SubAgentTaskResult
): SubAgentBackgroundArtifactFormatResult {
  try {
    return {
      artifact: formatSubAgentTaskResultForParent(result),
      degraded: false,
    }
  } catch (error) {
    return {
      artifact: result.summary.trim() || '子智能体已收敛，但结果无法序列化。',
      degraded: true,
      error,
    }
  }
}

/**
 * 失败后的结构化重派引导：给父 Agent 明确的收敛路径，同时提醒熔断规则，
 * 防止"原样重发直到成功"的滥用循环。续跑那一条只在线程真有可续的上下文时才给。
 */
function formatSubAgentFailureRedispatchGuidance(threadId: string, resumable: boolean): string {
  return [
    '下一步建议（按优先级）：',
    '1. 优先自行接手剩余工作——多数失败任务由主 Agent 直接完成更快。',
    resumable
      ? `2. 若属临时性错误（网络/超时），可带 thread_id="${threadId}" 续跑：它保留着已有上下文，只需在 prompt 里写接下来要做的。`
      : '2. 该线程没有可续跑的上下文；若属临时性错误（网络/超时），可不带 thread_id、用自包含的 prompt 重派一次。',
    '3. 若疑似模型能力不足，可换 model 或 route_category 重派一次；换角度重新拆分任务也算有效路径。',
    '注意：相同 prompt 的重复派发会被熔断拒跑，不要原样重发。',
  ].join('\n')
}

/** 带了 thread_id 却查无此线程（过期释放 / 被挤出 / 从未存在）时回给父 Agent 的说明。 */
function formatSubAgentThreadUnavailableMessage(threadId: string): string {
  return [
    `子智能体线程 ${threadId} 已不存在：可能已过期释放（线程只在本会话内保留有限时间）、被更新的线程挤出，或从未创建。`,
    '本次没有启动任何子 Agent。要继续这项工作，请不带 thread_id 重新派发，并在 prompt 里写全目标、已知事实、范围和成功标准。',
  ].join('\n')
}

/** 线程还在但不能续跑时回给父 Agent 的说明。 */
function formatSubAgentThreadUnresumableMessage(
  threadId: string,
  reason: SubAgentThreadUnresumableReason
): string {
  switch (reason) {
    case 'empty-history':
      return [
        `子智能体线程 ${threadId} 没有可续跑的上下文（上次运行在完成第一轮之前就结束了）。`,
        '本次没有启动任何子 Agent。请不带 thread_id 重新派发，并在 prompt 里写全目标、已知事实、范围和成功标准。',
      ].join('\n')
    case 'history-too-large':
      return [
        `子智能体线程 ${threadId} 的上下文已经过大，续跑比重新派发更贵。`,
        '本次没有启动任何子 Agent。请不带 thread_id 新派一个子 Agent，把需要沿用的结论写进 prompt。',
      ].join('\n')
    case 'not-found':
      return formatSubAgentThreadUnavailableMessage(threadId)
  }
}

function formatSubAgentHighRiskConfirmationStatus(message: string): string {
  const detail = message.trim()
  return detail
    ? `等待父线程确认高风险操作：${truncate(detail, 180)}`
    : '等待父线程确认高风险操作。'
}

function formatSubAgentStartedMessage(
  title: string,
  backgroundJobId: Nullable<string>,
  dispatchMode: 'sync' | 'async'
): string {
  const lines = [
    title,
    dispatchMode === 'async'
      ? '子智能体正在后台运行；完成后系统会自动注入结果通知。'
      : 'sync 子智能体已在后台启动；父 Agent 可以继续处理非重叠工作，需要结果时主动等待。',
  ]
  if (backgroundJobId) {
    lines.push(`后台 job id: ${backgroundJobId}`)
    lines.push(
      `需要查看后台输出时，调用 job:read_output(job_id="${backgroundJobId}")——它会返回子 Agent 运行中的实时进展轨迹（工具调用/失败）；需要收束结果时，调用 job:wait(job_ids=["${backgroundJobId}"])。`
    )
  }
  lines.push(
    '不要 sleep、轮询状态或重复它正在处理的同一文件/主题；继续非重叠任务，或在下一步依赖结果时调用 job:wait。'
  )
  return lines.join('\n')
}

export {
  formatSubAgentBackgroundArtifact,
  formatSubAgentFailureRedispatchGuidance,
  formatSubAgentHighRiskConfirmationStatus,
  formatSubAgentStartedMessage,
  formatSubAgentTaskResultForParent,
  formatSubAgentThreadUnavailableMessage,
  formatSubAgentThreadUnresumableMessage,
  resolveSubAgentAgentName,
}
export type { SubAgentBackgroundArtifactFormatResult }
