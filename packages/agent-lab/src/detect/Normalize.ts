import type {
  Observation,
  ToolCallRecord,
  TranscriptBlock,
  TurnRecord,
} from "../protocol/index.js";

function deduplicateById<T extends { readonly id: string }>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function deduplicateTurns(turns: readonly TurnRecord[]): readonly TurnRecord[] {
  const seenCalls = new Set<string>();
  return deduplicateById(turns).map((turn) => {
    const toolCalls: ToolCallRecord[] = [];
    for (const call of turn.toolCalls) {
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      toolCalls.push(call);
    }
    return { ...turn, toolCalls };
  });
}

function deduplicateTranscript(
  blocks: readonly TranscriptBlock[],
): readonly TranscriptBlock[] {
  const seenBlocks = new Set<string>();
  const seenCalls = new Set<string>();
  const unique: TranscriptBlock[] = [];
  for (const block of blocks) {
    if (seenBlocks.has(block.id)) continue;
    if (block.kind === "tool-call" && block.toolCallId) {
      if (seenCalls.has(block.toolCallId)) continue;
      seenCalls.add(block.toolCallId);
    }
    seenBlocks.add(block.id);
    unique.push(block);
  }
  return unique;
}

/**
 * Applies the canonical unique-tool-call measurement basis before detectors or metrics run.
 */
export function normalizeObservation(observation: Observation): Observation {
  return {
    ...observation,
    transcript: deduplicateTranscript(observation.transcript),
    turns: deduplicateTurns(observation.turns),
    contextResidency: deduplicateById(observation.contextResidency),
    artifacts: deduplicateById(observation.artifacts),
  };
}

export function collectToolCalls(
  observation: Observation,
): readonly ToolCallRecord[] {
  return normalizeObservation(observation).turns.flatMap(
    (turn) => turn.toolCalls,
  );
}
