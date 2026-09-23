/**
 * 观测归一：把驱动报上来的东西折成 `unique-tool-call` 这一个测量口径，探测器与指标都从这里之后开始算。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import type {
  ObservationCoverage,
  ObservationFace,
  ObservationPhase,
} from '../../contract/constants.js'
import { ObservationFaces } from '../../contract/constants.js'
import type {
  Observation,
  ToolCallRecord,
  TranscriptBlock,
  TurnRecord,
} from '../../types/agent-lab.js'

/** 按 `id` 去重，保留第一次出现的那条。 */
function deduplicateById<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    unique.push(item)
  }
  return unique
}

/** 轮去重，同时把跨轮重复上报的同一个 `toolCallId` 只留一次。 */
function deduplicateTurns(turns: readonly TurnRecord[]): readonly TurnRecord[] {
  const seenCalls = new Set<string>()
  return deduplicateById(turns).map((turn) => {
    const toolCalls: ToolCallRecord[] = []
    for (const call of turn.toolCalls) {
      if (seenCalls.has(call.id)) continue
      seenCalls.add(call.id)
      toolCalls.push(call)
    }
    return { ...turn, toolCalls }
  })
}

/** 转写块去重：块 id 重复的丢掉，同一个 `toolCallId` 的工具调用块只留第一条。 */
function deduplicateTranscript(blocks: readonly TranscriptBlock[]): readonly TranscriptBlock[] {
  const seenBlocks = new Set<string>()
  const seenCalls = new Set<string>()
  const unique: TranscriptBlock[] = []
  for (const block of blocks) {
    if (seenBlocks.has(block.id)) continue
    if (block.kind === 'tool-call' && block.toolCallId) {
      if (seenCalls.has(block.toolCallId)) continue
      seenCalls.add(block.toolCallId)
    }
    seenBlocks.add(block.id)
    unique.push(block)
  }
  return unique
}

/** 在探测器与指标跑起来之前，先把观测折成规范的 `unique-tool-call` 口径。 */
export function normalizeObservation(observation: Observation): Observation {
  return {
    ...observation,
    transcript: deduplicateTranscript(observation.transcript),
    turns: deduplicateTurns(observation.turns),
    contextResidency: deduplicateById(observation.contextResidency),
    artifacts: deduplicateById(observation.artifacts),
  }
}

/** 取归一之后的全部工具调用，按轮的顺序摊平。 */
export function collectToolCalls(observation: Observation): readonly ToolCallRecord[] {
  return normalizeObservation(observation).turns.flatMap((turn) => turn.toolCalls)
}

/** 造一次「什么都没看到」的观测：七个面全是 `none`，缺的就是缺的，不拿空数组冒充看到了空。 */
export function createUnobservedObservation(phase: ObservationPhase): Observation {
  const coverage = Object.fromEntries(
    ObservationFaces.map((face) => [face, 'none' as ObservationCoverage])
  ) as Record<ObservationFace, ObservationCoverage>
  return {
    phase,
    coverage,
    transcript: [],
    turns: [],
    runtime: null,
    usage: null,
    contextResidency: [],
    artifacts: [],
    metadata: {},
  }
}
