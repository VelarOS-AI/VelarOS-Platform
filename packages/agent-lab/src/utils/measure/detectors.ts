/**
 * 十三个内置探测器：看一次观测，给出零条或多条判词。全是纯函数，不碰 Node 模块、不发请求。
 * 探测器不认任何产品的工具名——要按工具名判的两类（工具目录页、会向用户提问的工具）由宿主在注册时给名单。
 */
import type { FindingSeverity, ObservationPhase } from '../../contract/constants.js'
import type { RegisteredDetector } from '../../contract/requires.js'
import type {
  DetectorContext,
  DetectorDefinition,
  Finding,
  JsonObject,
  JsonValue,
  Observation,
  ObservationReference,
  ToolCallRecord,
} from '../../types/agent-lab.js'
import type { ResolvedDetectorSettings } from '../../types/internal.js'
import { canonicalJson } from '../canonical-json.js'
import { AgentLabTuning } from '../tuning.js'

import { collectToolCalls, normalizeObservation } from './normalize.js'

/** 这些结束原因是正常终止，不用报未知。 */
const TerminalFinishReasons = new Set(['stop', 'end_turn', 'end-turn', 'tool_calls', 'tool-calls', 'aborted', 'abort'])

/** 连接占位文案：它被当成 agent 的回答写进会话就是输出契约破了。 */
const PlaceholderLeakPattern = /连接中断。请检查网络|请检查网络或稍后再试/

/** 制品协议的闭合标签：出现在很长的 assistant 纯文本里，多半是整段协议泄漏。 */
const ProtocolLeakPattern = /<\/artifact>/

/** 工具回执里表示失败的几种痕迹。 */
const ToolFailurePattern = /"isError"\s*:\s*true|tool_execution_failed|VALIDATION|schema_validation_failed|PERMISSION_DENIED/

/** 结束原因是不是内容过滤。 */
const ContentFilterPattern = /content.?filter/i

/** 判词能观测到的阶段：收敛之后。 */
const SettledPhases: readonly ObservationPhase[] = ['archive', 'idle']

/** 判词能观测到的阶段：全程。 */
const AllPhases: readonly ObservationPhase[] = ['archive', 'idle', 'running']

/** 这个 JSON 值是不是一个对象。 */
function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 造一条指向观测某一处的引用。 */
function reference(face: ObservationReference['face'], id: string, detail: string | null = null): ObservationReference {
  return { face, id, detail }
}

/** 造一条判词。 */
function finding(
  detectorId: string,
  severity: FindingSeverity,
  failureClass: Finding['failureClass'],
  summary: string,
  references: readonly ObservationReference[],
  evidence: JsonObject = {},
): Finding {
  return { detectorId, severity, failureClass, summary, references, evidence }
}

/** 造一份探测器自述。 */
function definition(
  id: string,
  face: DetectorDefinition['face'],
  phases: readonly ObservationPhase[],
  defaultSeverity: FindingSeverity,
  abortClass: DetectorDefinition['abortClass'],
  description: string,
): DetectorDefinition {
  return { id, version: 1, face, phases, defaultSeverity, abortClass, description }
}

/** 把自述和实现拼成一个可注册的探测器。 */
function detector(
  detectorDefinition: DetectorDefinition,
  detect: (observation: Observation, context: DetectorContext) => readonly Finding[],
): RegisteredDetector {
  return { definition: detectorDefinition, detect }
}

/** 把一次工具调用的结果折成一段可以拿去匹配的文字。 */
function toolResultText(call: ToolCallRecord): string {
  return typeof call.result === 'string' ? call.result : canonicalJson(call.result)
}

/** 造齐十三个内置探测器；阈值与两份工具名单由调用方定型后传进来。 */
export function createBuiltinDetectors(settings: ResolvedDetectorSettings): readonly RegisteredDetector[] {
  const { thresholds } = settings
  const interactiveToolNames = new Set(settings.interactiveToolNames)
  const catalogToolNames = new Set(settings.catalogToolNames)

  return [
    detector(
      definition('stuck-streaming-block', 'transcript', SettledPhases, 'fail', 'fail', '会话已经收敛，流式输出还开着。'),
      (observation) =>
        observation.transcript
          .filter((block) => block.kind === 'artifact' && block.isStreaming === true)
          .map((block) =>
            finding('stuck-streaming-block', 'fail', 'state-corruption', '制品块在会话收敛后仍处于流式状态', [
              reference('transcript', block.id, block.messageId),
            ]),
          ),
    ),
    detector(
      definition('stuck-running-tool', 'transcript', SettledPhases, 'fail', 'fail', '会话已经收敛，工具还在执行态。'),
      (observation) =>
        observation.transcript
          .filter((block) => block.kind === 'tool-call' && block.isRunning === true)
          .map((block) =>
            finding(
              'stuck-running-tool',
              'fail',
              'state-corruption',
              `工具在会话收敛后仍处于执行态: ${block.toolName ?? 'unknown'}`,
              [reference('transcript', block.id, block.toolCallId)],
            ),
          ),
    ),
    detector(
      definition('orphan-tool-call', 'transcript', SettledPhases, 'warn', null, '工具调用没有终态结果。'),
      (observation) =>
        observation.transcript
          .filter((block) => block.kind === 'tool-call' && block.isRunning !== true && block.toolResult === null)
          .map((block) => {
            const interactive = interactiveToolNames.has(block.toolName ?? '')
            return finding(
              'orphan-tool-call',
              interactive ? 'info' : 'warn',
              'state-corruption',
              `工具调用没有终态结果: ${block.toolName ?? 'unknown'}`,
              [reference('transcript', block.id, block.toolCallId)],
              { interactive },
            )
          }),
    ),
    detector(
      definition('placeholder-leak', 'transcript', AllPhases, 'fail', 'fail', '连接占位文案被当作回答留了下来。'),
      (observation) =>
        observation.transcript
          .filter(
            (block) =>
              block.role === 'assistant' &&
              block.kind === 'text' &&
              typeof block.text === 'string' &&
              PlaceholderLeakPattern.test(block.text),
          )
          .map((block) =>
            finding('placeholder-leak', 'fail', 'output-contract', '连接占位文案被当作 agent 回答写入', [
              reference('transcript', block.id, block.messageId),
            ]),
          ),
    ),
    detector(
      definition('protocol-leak', 'transcript', AllPhases, 'warn', null, '制品协议原文泄漏进了 assistant 文本。'),
      (observation) =>
        observation.transcript
          .filter(
            (block) =>
              block.role === 'assistant' &&
              block.kind === 'text' &&
              typeof block.text === 'string' &&
              block.text.length > AgentLabTuning.detectors.protocolLeakMinChars &&
              ProtocolLeakPattern.test(block.text) &&
              !observation.transcript.some(
                (candidate) => candidate.messageId === block.messageId && candidate.kind === 'artifact',
              ),
          )
          .map((block) =>
            finding('protocol-leak', 'warn', 'output-contract', 'assistant 文本疑似泄漏完整制品协议', [
              reference('transcript', block.id, block.messageId),
            ]),
          ),
    ),
    detector(
      definition('empty-final-answer', 'transcript', SettledPhases, 'warn', null, '最后一条 assistant 消息是空的。'),
      (observation) => {
        const lastAssistant = [...observation.transcript].reverse().find((block) => block.role === 'assistant')
        if (!lastAssistant) return []
        const messageBlocks = observation.transcript.filter(
          (block) => block.role === 'assistant' && block.messageId === lastAssistant.messageId,
        )
        const hasSubstance = messageBlocks.some((block) => {
          if (block.kind === 'text') return Boolean(block.text?.trim())
          return block.kind === 'artifact' || block.kind === 'tool-call'
        })
        if (hasSubstance) return []
        return [
          finding('empty-final-answer', 'warn', 'output-contract', '最后一条 assistant 消息没有实质内容', [
            reference('transcript', lastAssistant.id, lastAssistant.messageId),
          ]),
        ]
      },
    ),
    detector(
      definition('context-estimate-sanity', 'runtime', AllPhases, 'fail', 'fail', '上下文估算必须是物理上说得通的数。'),
      (observation) => {
        const runtime = observation.runtime
        if (!runtime) return []
        const findings: Finding[] = []
        if (runtime.contextWindow !== null && runtime.contextWindow <= 0) {
          findings.push(
            finding('context-estimate-sanity', 'fail', 'context-governance', '上下文窗口不是正数', [
              reference('runtime', 'context-window'),
            ]),
          )
        }
        if (
          runtime.contextPercent !== null &&
          (runtime.contextPercent < 0 || runtime.contextPercent > AgentLabTuning.detectors.contextPercentCeiling)
        ) {
          findings.push(
            finding(
              'context-estimate-sanity',
              'warn',
              'context-governance',
              `上下文占用百分比异常: ${runtime.contextPercent}%`,
              [reference('runtime', 'context-percent')],
            ),
          )
        }
        if (
          runtime.contextTokens !== null &&
          runtime.contextWindow !== null &&
          runtime.contextTokens > runtime.contextWindow * AgentLabTuning.detectors.contextOverrunRatio
        ) {
          findings.push(
            finding('context-estimate-sanity', 'warn', 'context-governance', '上下文估算超出模型窗口 20% 以上', [
              reference('runtime', 'context-tokens'),
            ]),
          )
        }
        return findings
      },
    ),
    detector(
      definition('finish-truncation', 'turns', AllPhases, 'fail', null, '模型输出因长度或内容限制被截断。'),
      (observation) =>
        observation.turns.flatMap((turn) =>
          turn.finishReasons.flatMap((reason) => {
            if (reason === 'length') return [
                finding('finish-truncation', 'fail', 'output-contract', '模型输出因长度上限被截断', [
                  reference('turns', turn.id, reason),
                ]),
              ]
            if (ContentFilterPattern.test(reason)) return [
                finding('finish-truncation', 'warn', 'output-contract', `模型输出因 ${reason} 被截断`, [
                  reference('turns', turn.id, reason),
                ]),
              ]
            return []
          }),
        ),
    ),
    detector(
      definition('finish-unknown', 'turns', AllPhases, 'info', null, '认不出的结束原因照实报出来。'),
      (observation) =>
        observation.turns.flatMap((turn) =>
          turn.finishReasons
            .filter(
              (reason) =>
                !TerminalFinishReasons.has(reason) && reason !== 'length' && !ContentFilterPattern.test(reason),
            )
            .map((reason) =>
              finding('finish-unknown', 'info', 'unclassified', `未知 finish reason: ${reason}`, [
                reference('turns', turn.id, reason),
              ]),
            ),
        ),
    ),
    detector(
      definition('tool-failure', 'turns', AllPhases, 'fail', null, '工具失败是明确的诊断结论，不是噪音。'),
      (observation) =>
        collectToolCalls(observation)
          .filter((call) => call.isError === true || ToolFailurePattern.test(toolResultText(call)))
          .map((call) =>
            finding('tool-failure', 'fail', 'tool-failure', `工具调用失败: ${call.name}`, [
              reference('turns', call.id, call.turnId),
            ]),
          ),
    ),
    detector(
      definition('tool-retry-loop', 'turns', AllPhases, 'warn', 'loop', '同一工具与同一参数反复调用说明在打转。'),
      (observation) => {
        const groups = new Map<string, { call: ToolCallRecord; count: number }>()
        let previousKey: string | null = null
        let consecutiveCount = 0
        for (const call of collectToolCalls(observation)) {
          if (call.input === null) {
            previousKey = null
            consecutiveCount = 0
            continue
          }
          const serializedInput = canonicalJson(call.input)
          if (serializedInput === '{}') {
            previousKey = null
            consecutiveCount = 0
            continue
          }
          const key = `${call.name}\u0000${serializedInput}`
          const current = groups.get(key)
          consecutiveCount = key === previousKey ? consecutiveCount + 1 : 1
          groups.set(key, { call, count: Math.max(current?.count ?? 0, consecutiveCount) })
          previousKey = key
        }
        return [...groups.values()]
          .filter(({ count }) => count >= thresholds.retryWarn)
          .map(({ call, count }) =>
            finding(
              'tool-retry-loop',
              'warn',
              'loop',
              `同一工具与参数连续重复 ${count} 次: ${call.name}`,
              [reference('turns', call.id, call.turnId)],
              { count, abortAt: thresholds.retryAbort },
            ),
          )
      },
    ),
    detector(
      definition('toolmap-read-loop', 'turns', AllPhases, 'warn', 'loop', '同一张工具目录页反复读，说明没找到该用的工具。'),
      (observation) => {
        const reads = new Map<string, { call: ToolCallRecord; count: number }>()
        for (const call of collectToolCalls(observation)) {
          if (!catalogToolNames.has(call.name)) continue
          if (!isJsonObject(call.input) || call.input.op !== 'read') continue
          const page = canonicalJson(call.input.ids ?? call.input.id ?? '')
          const current = reads.get(page)
          reads.set(page, { call, count: (current?.count ?? 0) + 1 })
        }
        return [...reads.values()]
          .filter(({ count }) => count >= thresholds.toolMapReadWarn)
          .map(({ call, count }) =>
            finding(
              'toolmap-read-loop',
              'warn',
              'tool-selection',
              `同一工具目录页重复读取 ${count} 次`,
              [reference('turns', call.id, call.turnId)],
              { count, abortAt: thresholds.toolMapReadAbort },
            ),
          )
      },
    ),
    detector(
      definition('turn-tool-density', 'turns', AllPhases, 'warn', 'loop', '单轮工具调用过多，说明已经失控。'),
      (observation) =>
        normalizeObservation(observation)
          .turns.filter((turn) => turn.toolCalls.length > thresholds.turnDensityWarn)
          .map((turn) =>
            finding(
              'turn-tool-density',
              'warn',
              'loop',
              `单轮工具调用达到 ${turn.toolCalls.length} 次`,
              [reference('turns', turn.id)],
              { count: turn.toolCalls.length, abortAt: thresholds.turnDensityAbort },
            ),
          ),
    ),
  ]
}
