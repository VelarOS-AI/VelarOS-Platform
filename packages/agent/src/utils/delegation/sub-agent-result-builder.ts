import { isEmpty, toOptional } from '@velaros-ai/core'

import type { SubAgentTaskArtifacts, SubAgentTaskResult } from '../../types/agent.js'
import type { BuildSubAgentTaskResultInput,SubAgentThreadRetention } from '../../types/delegation.js'
import type { CodingSessionSnapshot } from '../../types/session.js'

/**
 * 从子 Agent 的编码会话快照里提炼父 Agent 要看的结构化制品：改动路径清单 + 验证结论。
 * 验证状态收成三档：passed 原样；failed / timed-out 都算 failed（超时对父的决策等价于没过）；
 * 其余（跳过、进行中等）算 skipped。两项都没有时返回 undefined，让结果里干脆不出 artifacts 这一格。
 */
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

/**
 * 把一次子 Agent 运行的各路结果装配成对外的 SubAgentTaskResult。
 * summary 取子 Agent 最终文本去空白后的内容，**空文本兜底成一句占位**——父 Agent 拿到空摘要无从判断，
 * 宁可明说"已完成但没有返回文本"。其余字段（结构化输出、用量、工具摘要、模型轨迹、收尾原因、续跑保留期）原样带出。
 */
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

/**
 * 序列化成工具返回文本：人读的 summary 在前，完整结果以 `<subagent-result type="application/json">`
 * 包一段 JSON 跟在后面。双层是刻意的——模型直接读上半段就够，下游要精确字段时再用
 * parseSubAgentToolResult 把下半段解回来。
 */
function formatSubAgentToolResult(result: SubAgentTaskResult): string {
  const payload = JSON.stringify(result)
  return `${result.summary}\n\n<subagent-result type="application/json">\n${payload}\n</subagent-result>`
}

/**
 * formatSubAgentToolResult 的逆操作：从工具返回文本里取出 `<subagent-result>` 包裹的 JSON。
 * 找不到标记、标记未闭合、正文为空或不是合法 JSON 一律返回 null——这是"这段不是结构化子 Agent 结果"
 * 的正常信号（输入本就是模型产出的文本），调用方据此回落到纯文本路径，不当故障处理。
 */
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
