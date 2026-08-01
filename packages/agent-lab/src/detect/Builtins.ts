import type {
  DetectorContext,
  DetectorDefinition,
  Finding,
  FindingSeverity,
  JsonObject,
  JsonValue,
  Observation,
  ObservationReference,
  ToolCallRecord,
} from "../protocol/index.js";

import type { RegisteredDetector } from "./Catalog.js";
import { collectToolCalls, normalizeObservation } from "./Normalize.js";

export interface LoopThresholds {
  readonly retryWarn: number;
  readonly retryAbort: number;
  readonly toolMapReadWarn: number;
  readonly toolMapReadAbort: number;
  readonly turnDensityWarn: number;
  readonly turnDensityAbort: number;
}

export const DefaultLoopThresholds = Object.freeze({
  retryWarn: 4,
  retryAbort: 6,
  toolMapReadWarn: 3,
  toolMapReadAbort: 4,
  turnDensityWarn: 40,
  turnDensityAbort: 80,
}) satisfies LoopThresholds;

const TerminalFinishReasons = new Set([
  "stop",
  "end_turn",
  "end-turn",
  "tool_calls",
  "tool-calls",
  "aborted",
  "abort",
]);
const InteractiveToolNames = new Set(["ask_user"]);
const PlaceholderLeakPattern = /连接中断。请检查网络|请检查网络或稍后再试/;
const ProtocolLeakPattern = /<\/artifact>/;
const ToolFailurePattern =
  /"isError"\s*:\s*true|tool_execution_failed|VALIDATION|schema_validation_failed|PERMISSION_DENIED/;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const fields = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
  return `{${fields.join(",")}}`;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reference(
  face: ObservationReference["face"],
  id: string,
  detail: string | null = null,
): ObservationReference {
  return { face, id, detail };
}

function finding(
  detectorId: string,
  severity: FindingSeverity,
  failureClass: Finding["failureClass"],
  summary: string,
  references: readonly ObservationReference[],
  evidence: JsonObject = {},
): Finding {
  return { detectorId, severity, failureClass, summary, references, evidence };
}

function definition(
  id: string,
  face: DetectorDefinition["face"],
  phases: DetectorDefinition["phases"],
  defaultSeverity: FindingSeverity,
  abortClass: DetectorDefinition["abortClass"],
  description: string,
): DetectorDefinition {
  return {
    id,
    version: 1,
    face,
    phases,
    defaultSeverity,
    abortClass,
    description,
  };
}

function detector(
  detectorDefinition: DetectorDefinition,
  detect: (
    observation: Observation,
    context: DetectorContext,
  ) => readonly Finding[],
): RegisteredDetector {
  return { definition: detectorDefinition, detect };
}

function toolResultText(call: ToolCallRecord): string {
  if (typeof call.result === "string") return call.result;
  return canonicalJson(call.result);
}

export function createBuiltinDetectors(
  thresholds: LoopThresholds = DefaultLoopThresholds,
): readonly RegisteredDetector[] {
  const settled = ["archive", "idle"] as const;
  const all = ["archive", "idle", "running"] as const;

  return [
    detector(
      definition(
        "stuck-streaming-block",
        "transcript",
        settled,
        "fail",
        "fail",
        "Streaming output remains open after settlement.",
      ),
      (observation) =>
        observation.transcript
          .filter(
            (block) => block.kind === "artifact" && block.isStreaming === true,
          )
          .map((block) =>
            finding(
              "stuck-streaming-block",
              "fail",
              "state-corruption",
              "制品块在会话收敛后仍处于流式状态",
              [reference("transcript", block.id, block.messageId)],
            ),
          ),
    ),
    detector(
      definition(
        "stuck-running-tool",
        "transcript",
        settled,
        "fail",
        "fail",
        "Tool execution remains open after settlement.",
      ),
      (observation) =>
        observation.transcript
          .filter(
            (block) => block.kind === "tool-call" && block.isRunning === true,
          )
          .map((block) =>
            finding(
              "stuck-running-tool",
              "fail",
              "state-corruption",
              `工具在会话收敛后仍处于执行态: ${block.toolName ?? "unknown"}`,
              [reference("transcript", block.id, block.toolCallId)],
            ),
          ),
    ),
    detector(
      definition(
        "orphan-tool-call",
        "transcript",
        settled,
        "warn",
        null,
        "Tool call has no terminal result.",
      ),
      (observation) =>
        observation.transcript
          .filter(
            (block) =>
              block.kind === "tool-call" &&
              block.isRunning !== true &&
              block.toolResult === null,
          )
          .map((block) => {
            const interactive = InteractiveToolNames.has(block.toolName ?? "");
            return finding(
              "orphan-tool-call",
              interactive ? "info" : "warn",
              "state-corruption",
              `工具调用没有终态结果: ${block.toolName ?? "unknown"}`,
              [reference("transcript", block.id, block.toolCallId)],
              { interactive },
            );
          }),
    ),
    detector(
      definition(
        "placeholder-leak",
        "transcript",
        all,
        "fail",
        "fail",
        "Connection placeholder is persisted as an answer.",
      ),
      (observation) =>
        observation.transcript
          .filter(
            (block) =>
              block.role === "assistant" &&
              block.kind === "text" &&
              typeof block.text === "string" &&
              PlaceholderLeakPattern.test(block.text),
          )
          .map((block) =>
            finding(
              "placeholder-leak",
              "fail",
              "output-contract",
              "连接占位文案被当作 agent 回答写入",
              [reference("transcript", block.id, block.messageId)],
            ),
          ),
    ),
    detector(
      definition(
        "protocol-leak",
        "transcript",
        all,
        "warn",
        null,
        "Raw artifact protocol leaks into assistant text.",
      ),
      (observation) =>
        observation.transcript
          .filter(
            (block) =>
              block.role === "assistant" &&
              block.kind === "text" &&
              typeof block.text === "string" &&
              block.text.length > 800 &&
              ProtocolLeakPattern.test(block.text) &&
              !observation.transcript.some(
                (candidate) =>
                  candidate.messageId === block.messageId &&
                  candidate.kind === "artifact",
              ),
          )
          .map((block) =>
            finding(
              "protocol-leak",
              "warn",
              "output-contract",
              "assistant 文本疑似泄漏完整制品协议",
              [reference("transcript", block.id, block.messageId)],
            ),
          ),
    ),
    detector(
      definition(
        "empty-final-answer",
        "transcript",
        settled,
        "warn",
        null,
        "Final assistant message is empty.",
      ),
      (observation) => {
        const lastAssistant = [...observation.transcript]
          .reverse()
          .find((block) => block.role === "assistant");
        if (!lastAssistant) return [];
        const messageBlocks = observation.transcript.filter(
          (block) =>
            block.role === "assistant" &&
            block.messageId === lastAssistant.messageId,
        );
        const hasSubstance = messageBlocks.some((block) => {
          if (block.kind === "text") return Boolean(block.text?.trim());
          return block.kind === "artifact" || block.kind === "tool-call";
        });
        if (hasSubstance) return [];
        return [
          finding(
            "empty-final-answer",
            "warn",
            "output-contract",
            "最后一条 assistant 消息没有实质内容",
            [
              reference(
                "transcript",
                lastAssistant.id,
                lastAssistant.messageId,
              ),
            ],
          ),
        ];
      },
    ),
    detector(
      definition(
        "context-estimate-sanity",
        "runtime",
        all,
        "fail",
        "fail",
        "Context estimates must remain physically plausible.",
      ),
      (observation) => {
        const runtime = observation.runtime;
        if (!runtime) return [];
        const findings: Finding[] = [];
        if (runtime.contextWindow !== null && runtime.contextWindow <= 0) {
          findings.push(
            finding(
              "context-estimate-sanity",
              "fail",
              "context-governance",
              "上下文窗口不是正数",
              [reference("runtime", "context-window")],
            ),
          );
        }
        if (
          runtime.contextPercent !== null &&
          (runtime.contextPercent < 0 || runtime.contextPercent > 150)
        ) {
          findings.push(
            finding(
              "context-estimate-sanity",
              "warn",
              "context-governance",
              `上下文占用百分比异常: ${runtime.contextPercent}%`,
              [reference("runtime", "context-percent")],
            ),
          );
        }
        if (
          runtime.contextTokens !== null &&
          runtime.contextWindow !== null &&
          runtime.contextTokens > runtime.contextWindow * 1.2
        ) {
          findings.push(
            finding(
              "context-estimate-sanity",
              "warn",
              "context-governance",
              "上下文估算超出模型窗口 20% 以上",
              [reference("runtime", "context-tokens")],
            ),
          );
        }
        return findings;
      },
    ),
    detector(
      definition(
        "finish-truncation",
        "turns",
        all,
        "fail",
        null,
        "Model output ends because of a length or content limit.",
      ),
      (observation) =>
        observation.turns.flatMap((turn) =>
          turn.finishReasons.flatMap((reason) => {
            if (reason === "length")
              return [
                finding(
                  "finish-truncation",
                  "fail",
                  "output-contract",
                  "模型输出因长度上限被截断",
                  [reference("turns", turn.id, reason)],
                ),
              ];
            if (/content.?filter/i.test(reason))
              return [
                finding(
                  "finish-truncation",
                  "warn",
                  "output-contract",
                  `模型输出因 ${reason} 被截断`,
                  [reference("turns", turn.id, reason)],
                ),
              ];
            return [];
          }),
        ),
    ),
    detector(
      definition(
        "finish-unknown",
        "turns",
        all,
        "info",
        null,
        "Unknown finish reasons are surfaced.",
      ),
      (observation) =>
        observation.turns.flatMap((turn) =>
          turn.finishReasons
            .filter(
              (reason) =>
                !TerminalFinishReasons.has(reason) &&
                reason !== "length" &&
                !/content.?filter/i.test(reason),
            )
            .map((reason) =>
              finding(
                "finish-unknown",
                "info",
                "unclassified",
                `未知 finish reason: ${reason}`,
                [reference("turns", turn.id, reason)],
              ),
            ),
        ),
    ),
    detector(
      definition(
        "tool-failure",
        "turns",
        all,
        "fail",
        null,
        "Tool failures are explicit diagnostic outcomes.",
      ),
      (observation) =>
        collectToolCalls(observation)
          .filter(
            (call) =>
              call.isError === true ||
              ToolFailurePattern.test(toolResultText(call)),
          )
          .map((call) =>
            finding(
              "tool-failure",
              "fail",
              "tool-failure",
              `工具调用失败: ${call.name}`,
              [reference("turns", call.id, call.turnId)],
            ),
          ),
    ),
    detector(
      definition(
        "tool-retry-loop",
        "turns",
        all,
        "warn",
        "loop",
        "Repeated identical tool calls indicate a loop.",
      ),
      (observation) => {
        const groups = new Map<
          string,
          { call: ToolCallRecord; count: number }
        >();
        for (const call of collectToolCalls(observation)) {
          if (call.input === null) continue;
          const serializedInput = canonicalJson(call.input);
          if (serializedInput === "{}") continue;
          const key = `${call.name}\u0000${serializedInput}`;
          const current = groups.get(key);
          groups.set(key, { call, count: (current?.count ?? 0) + 1 });
        }
        return [...groups.values()]
          .filter(({ count }) => count >= thresholds.retryWarn)
          .map(({ call, count }) =>
            finding(
              "tool-retry-loop",
              "warn",
              "loop",
              `同一工具与参数重复 ${count} 次: ${call.name}`,
              [reference("turns", call.id, call.turnId)],
              { count, abortAt: thresholds.retryAbort },
            ),
          );
      },
    ),
    detector(
      definition(
        "toolmap-read-loop",
        "turns",
        all,
        "warn",
        "loop",
        "Repeated tool-map page reads indicate discovery failure.",
      ),
      (observation) => {
        const reads = new Map<
          string,
          { call: ToolCallRecord; count: number }
        >();
        for (const call of collectToolCalls(observation)) {
          if (call.name !== "tool_map") continue;
          if (!isJsonObject(call.input) || call.input.op !== "read") continue;
          const page = canonicalJson(call.input.ids ?? call.input.id ?? "");
          const current = reads.get(page);
          reads.set(page, { call, count: (current?.count ?? 0) + 1 });
        }
        return [...reads.values()]
          .filter(({ count }) => count >= thresholds.toolMapReadWarn)
          .map(({ call, count }) =>
            finding(
              "toolmap-read-loop",
              "warn",
              "tool-selection",
              `同一工具目录页重复读取 ${count} 次`,
              [reference("turns", call.id, call.turnId)],
              { count, abortAt: thresholds.toolMapReadAbort },
            ),
          );
      },
    ),
    detector(
      definition(
        "turn-tool-density",
        "turns",
        all,
        "warn",
        "loop",
        "Excessive tool calls in one turn indicate loss of control.",
      ),
      (observation) =>
        normalizeObservation(observation)
          .turns.filter(
            (turn) => turn.toolCalls.length > thresholds.turnDensityWarn,
          )
          .map((turn) =>
            finding(
              "turn-tool-density",
              "warn",
              "loop",
              `单轮工具调用达到 ${turn.toolCalls.length} 次`,
              [reference("turns", turn.id)],
              {
                count: turn.toolCalls.length,
                abortAt: thresholds.turnDensityAbort,
              },
            ),
          ),
    ),
  ];
}
