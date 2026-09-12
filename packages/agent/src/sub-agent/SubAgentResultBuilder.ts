import type {
  SubAgentTaskArtifacts,
  SubAgentTaskResult,
  SubAgentTaskResultStatus,
  SubAgentToolDigestEntry,
  SubAgentUsage,
  SubAgentWindDownReason,
  TeamModelSelectionTrace,
} from '@velaros-ai/agent/protocol'
import { isEmpty, toOptional } from '@velaros-ai/core'

import type { CodingSessionSnapshot } from '../reminders/types'

import type { SubAgentThreadRetention } from './SubAgentSessionStore'

interface BuildSubAgentTaskResultInput {
  threadId: string
  text: string
  status: SubAgentTaskResultStatus
  windDownReason?: SubAgentWindDownReason
  codingSnapshot?: CodingSessionSnapshot
  modelTrace?: TeamModelSelectionTrace
  toolDigest?: SubAgentToolDigestEntry[]
  structuredOutput?: unknown
  usage?: SubAgentUsage
  /** 线程能否续跑；给出时落成结果里的 resumable / retained_until，缺省表示本结果不作判断。 */
  retention?: SubAgentThreadRetention
}

function buildArtifactsFromSnapshot(
  snapshot: Optional<CodingSessionSnapshot>
): SubAgentTaskArtifacts | undefined {
  if (!snapshot) return undefined

  const artifacts: SubAgentTaskArtifacts = {}
  if (!isEmpty(snapshot.modifiedPaths)) {
    artifacts.changed_paths = [...snapshot.modifiedPaths]
  }
  if (snapshot.latestVerificationStatus) {
    artifacts.verification = {
      status:
        snapshot.latestVerificationStatus === 'passed'
          ? 'passed'
          : snapshot.latestVerificationStatus === 'failed' ||
              snapshot.latestVerificationStatus === 'timed-out'
            ? 'failed'
            : 'skipped',
      command: snapshot.activeVerificationFailure?.command,
    }
  }
  if (!artifacts.changed_paths && !artifacts.verification) return undefined
  return artifacts
}

/** 只有可续跑的线程才有保留期限；不可续跑或关闭了跨执行保留时不出这一格。 */
function resolveRetainedUntil(retention: Optional<SubAgentThreadRetention>): Optional<number> {
  if (!retention?.resumable) return undefined
  return toOptional(retention.retainedUntil)
}

function buildSubAgentTaskResult(input: BuildSubAgentTaskResultInput): SubAgentTaskResult {
  const summary = input.text.trim() || '子智能体已完成，但没有返回文本。'
  return {
    thread_id: input.threadId,
    status: input.status,
    summary,
    structured_output: input.structuredOutput,
    usage: input.usage,
    artifacts: buildArtifactsFromSnapshot(input.codingSnapshot),
    tool_digest: input.toolDigest,
    model_trace: input.modelTrace,
    wind_down_reason: input.windDownReason,
    resumable: input.retention?.resumable,
    retained_until: resolveRetainedUntil(input.retention),
  }
}

function formatSubAgentToolResult(result: SubAgentTaskResult): string {
  const payload = JSON.stringify(result)
  return `${result.summary}\n\n<subagent-result type="application/json">\n${payload}\n</subagent-result>`
}

function parseSubAgentToolResult(value: string): Nullable<SubAgentTaskResult> {
  const openMarker = '<subagent-result type="application/json">'
  const closeMarker = '</subagent-result>'
  const open = value.indexOf(openMarker)
  if (open < 0) return null
  const bodyStart = open + openMarker.length
  const close = value.indexOf(closeMarker, bodyStart)
  if (close < 0) return null
  const body = value.slice(bodyStart, close).trim()
  if (!body) return null
  try {
    return JSON.parse(body) as SubAgentTaskResult
  } catch {
    // arch-guard:silent-catch-ok 输入是模型产出的文本，非法 JSON 是**预期内**的常态而非故障；
    // null 就是「这段不是结构化子 Agent 结果」的信号，调用方据此回落到纯文本路径。
    return null
  }
}

export {
  buildSubAgentTaskResult,
  formatSubAgentToolResult,
  parseSubAgentToolResult,
}
export type { BuildSubAgentTaskResultInput }
