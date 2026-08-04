import type {
  SubAgentTaskArtifacts,
  SubAgentTaskResult,
  SubAgentTaskResultStatus,
  SubAgentToolDigestEntry,
  SubAgentUsage,
  SubAgentWindDownReason,
  TeamModelSelectionTrace,
} from '@velaros-ai/agent/protocol'

import type { CodingSessionSnapshot } from '../reminders/types'

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
}

function buildArtifactsFromSnapshot(
  snapshot: CodingSessionSnapshot | undefined
): SubAgentTaskArtifacts | undefined {
  if (!snapshot) return undefined

  const artifacts: SubAgentTaskArtifacts = {}
  if (snapshot.modifiedPaths.length > 0) {
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
  }
}

function formatSubAgentToolResult(result: SubAgentTaskResult): string {
  const payload = JSON.stringify(result)
  return `${result.summary}\n\n<subagent-result type="application/json">\n${payload}\n</subagent-result>`
}

function parseSubAgentToolResult(value: string): Nullable<SubAgentTaskResult> {
  const match = value.match(
    /<subagent-result type="application\/json">\s*([\s\S]*?)\s*<\/subagent-result>/
  )
  if (!match?.[1]) return null
  try {
    return JSON.parse(match[1]) as SubAgentTaskResult
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
