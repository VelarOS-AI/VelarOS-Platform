import { randomUUID } from "node:crypto";

import type {
  BudgetUsage,
  ContextResidencyEvent,
  DriverCapabilities,
  ExecutorIdentity,
  JsonObject,
  JsonValue,
  LegSpec,
  Observation,
  ObservationCoverage,
  ObservationFace,
  ObservationPhase,
  SessionHandle,
  SessionSpec,
  ToolCallRecord,
  TranscriptBlock,
  TurnRecord,
  UsageAccount,
} from "../protocol/index.js";
import {
  createUnobservedObservation,
  EmptyBudgetUsage,
  ObservationFaces,
} from "../protocol/index.js";

import type {
  NativeExecutionState,
  PollingDriverAdapter,
  PollingDriverPolicy,
} from "./PollingDriver.js";
import { createPollingDriver } from "./PollingDriver.js";
import { VelarHooksClient } from "./VelarHooksClient.js";

interface RecordValue {
  readonly [key: string]: unknown;
}

export interface VelarHooksDriverOptions {
  readonly id: string;
  readonly identity: ExecutorIdentity;
  readonly capabilities?: Partial<DriverCapabilities>;
  readonly client?: VelarHooksClient;
  readonly commandExtras?: JsonObject;
  readonly polling?: Partial<PollingDriverPolicy>;
  readonly createSessionId?: (spec: SessionSpec) => string;
  readonly resolveWorkspaceRoot?: (spec: SessionSpec) => string | null;
  readonly resolveSpace?: (spec: SessionSpec) => string;
  readonly sendParameters?: (
    session: SessionHandle,
    leg: LegSpec,
  ) => JsonObject;
  readonly classifyUnavailable?: (
    transcript: readonly TranscriptBlock[],
  ) => string | null;
  readonly prepare?: PollingDriverAdapter["prepare"];
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dataOf(value: unknown): unknown {
  return isRecord(value) ? value.data : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolResultIsError(part: RecordValue, output: unknown): boolean | null {
  const explicit =
    nullableBoolean(part.isError) ??
    (isRecord(output) ? nullableBoolean(output.isError) : null);
  if (explicit !== null) return explicit;
  if (!isRecord(output)) return null;
  const type = nullableString(output.type);
  return type === "error-text" || type === "error" ? true : null;
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, json(item)]),
    );
  return null;
}

function object(value: unknown): JsonObject {
  return isRecord(value) ? (json(value) as JsonObject) : {};
}

function coverage(
  entries: Partial<Record<ObservationFace, ObservationCoverage>>,
): Readonly<Record<ObservationFace, ObservationCoverage>> {
  return Object.fromEntries(
    ObservationFaces.map((face) => [face, entries[face] ?? "none"]),
  ) as Record<ObservationFace, ObservationCoverage>;
}

function transcriptBlocks(input: unknown): readonly TranscriptBlock[] {
  const messages =
    isRecord(input) && Array.isArray(input.messages) ? input.messages : [];
  return messages.flatMap((messageValue, messageIndex) => {
    if (!isRecord(messageValue)) return [];
    const messageId =
      nullableString(messageValue.id) ?? `message-${messageIndex}`;
    const roleValue = nullableString(messageValue.role);
    const role: TranscriptBlock["role"] =
      roleValue === "assistant" ||
      roleValue === "system" ||
      roleValue === "tool" ||
      roleValue === "user"
        ? roleValue
        : "unknown";
    const blocks = Array.isArray(messageValue.blocks)
      ? messageValue.blocks
      : [];
    return blocks.flatMap(
      (blockValue, blockIndex): readonly TranscriptBlock[] => {
        if (!isRecord(blockValue)) return [];
        const rawKind =
          nullableString(blockValue.kind) ?? nullableString(blockValue.type);
        const kind: TranscriptBlock["kind"] =
          rawKind === "tool" || rawKind === "tool-call"
            ? "tool-call"
            : rawKind === "tool-result"
              ? "tool-result"
              : rawKind === "html-artifact" || rawKind === "artifact"
                ? "artifact"
                : rawKind === "reasoning"
                  ? "reasoning"
                  : rawKind === "text"
                    ? "text"
                    : "unknown";
        const toolCallId =
          nullableString(blockValue.toolCallId) ??
          nullableString(blockValue.callId);
        return [
          {
            id:
              nullableString(blockValue.id) ??
              `${messageId}:${toolCallId ?? `${kind}-${blockIndex}`}`,
            messageId,
            role,
            kind,
            text: nullableString(blockValue.text),
            toolCallId,
            toolName:
              nullableString(blockValue.toolName) ??
              nullableString(blockValue.tool),
            toolInput: json(blockValue.input ?? blockValue.args ?? null),
            toolResult: json(
              blockValue.result ?? blockValue.serializedResult ?? null,
            ),
            isError: nullableBoolean(blockValue.isError),
            isRunning: nullableBoolean(
              blockValue.isRunning ?? blockValue.running,
            ),
            isStreaming: nullableBoolean(blockValue.isStreaming),
          },
        ];
      },
    );
  });
}

function debugTurns(input: unknown): readonly TurnRecord[] {
  const turns =
    isRecord(input) && Array.isArray(input.turns) ? input.turns : [];
  const results = new Map<
    string,
    { readonly result: JsonValue; readonly isError: boolean | null }
  >();
  for (const turnValue of turns) {
    if (!isRecord(turnValue)) continue;
    const messages = Array.isArray(turnValue.messages)
      ? turnValue.messages
      : [];
    for (const messageValue of messages) {
      if (!isRecord(messageValue)) continue;
      const content = Array.isArray(messageValue.content)
        ? messageValue.content
        : [];
      for (const partValue of content) {
        if (!isRecord(partValue) || partValue.type !== "tool-result") continue;
        const callId = nullableString(partValue.toolCallId);
        if (!callId || results.has(callId)) continue;
        const output = partValue.output ?? partValue.result ?? null;
        results.set(callId, {
          result: json(output),
          isError: toolResultIsError(partValue, output),
        });
      }
    }
  }
  const seenCalls = new Set<string>();
  return turns.flatMap((turnValue, turnIndex): readonly TurnRecord[] => {
    if (!isRecord(turnValue)) return [];
    const turnId = nullableString(turnValue.id) ?? `turn-${turnIndex}`;
    const calls: ToolCallRecord[] = [];
    const finishReasons: string[] = [];
    const messages = Array.isArray(turnValue.messages)
      ? turnValue.messages
      : [];
    for (const [messageIndex, messageValue] of messages.entries()) {
      if (!isRecord(messageValue)) continue;
      const content = Array.isArray(messageValue.content)
        ? messageValue.content
        : [];
      for (const [partIndex, partValue] of content.entries()) {
        if (!isRecord(partValue)) continue;
        const type = nullableString(partValue.type);
        if (type === "finish" && typeof partValue.reason === "string") {
          finishReasons.push(partValue.reason);
        }
        if (type !== "tool-call") continue;
        const id =
          nullableString(partValue.toolCallId) ??
          `anonymous-call-${turnIndex}-${messageIndex}-${partIndex}`;
        if (seenCalls.has(id)) continue;
        seenCalls.add(id);
        const result = results.get(id);
        calls.push({
          id,
          turnId,
          name: nullableString(partValue.toolName) ?? "unknown",
          input: json(partValue.input ?? partValue.args ?? null),
          result: result?.result ?? null,
          isError: result?.isError ?? null,
          startedAt: null,
          finishedAt: null,
        });
      }
    }
    return [{ id: turnId, index: turnIndex, toolCalls: calls, finishReasons }];
  });
}

function usageFrom(debug: unknown): UsageAccount | null {
  const context =
    isRecord(debug) && isRecord(debug.context) ? debug.context : null;
  const telemetry =
    context && isRecord(context.usageTelemetry) ? context.usageTelemetry : null;
  if (!telemetry) return null;
  return {
    inputTokens: nullableNumber(telemetry.inputTokens),
    outputTokens: nullableNumber(telemetry.outputTokens),
    cacheReadTokens: nullableNumber(telemetry.cacheReadTokens),
    cacheWriteTokens: nullableNumber(telemetry.cacheWriteTokens),
    reasoningTokens: nullableNumber(telemetry.reasoningTokens),
    totalTokens: nullableNumber(telemetry.totalTokens),
    costUsd: nullableNumber(telemetry.costUsd),
  };
}

function residencyFrom(debug: unknown): readonly ContextResidencyEvent[] {
  const context =
    isRecord(debug) && isRecord(debug.context) ? debug.context : null;
  const ledger =
    context && Array.isArray(context.residencyLedger)
      ? context.residencyLedger
      : [];
  return ledger.flatMap(
    (eventValue, index): readonly ContextResidencyEvent[] => {
      if (!isRecord(eventValue)) return [];
      return [
        {
          id: nullableString(eventValue.id) ?? `residency-${index}`,
          epoch: nullableNumber(eventValue.epoch) ?? index,
          turn: nullableNumber(eventValue.turn),
          cause: nullableString(eventValue.cause) ?? "unknown",
          beforeTokens: nullableNumber(eventValue.beforeTokens),
          afterTokens: nullableNumber(eventValue.afterTokens),
          cacheReadDropNextRequest: nullableNumber(
            eventValue.cacheReadDropNextRequest,
          ),
          distillCostTokens: nullableNumber(eventValue.distillCostTokens),
          payload: object(eventValue),
        },
      ];
    },
  );
}

function assistantRevision(transcript: unknown): string | null {
  const messages =
    isRecord(transcript) && Array.isArray(transcript.messages)
      ? transcript.messages
      : [];
  for (const value of [...messages].reverse()) {
    if (isRecord(value) && value.role === "assistant")
      return nullableString(value.id) ?? JSON.stringify(value);
  }
  return null;
}

function budgetUsage(
  debug: unknown,
  wallClockMs: number | null = null,
): BudgetUsage {
  const turns = debugTurns(debug);
  const usage = usageFrom(debug);
  return {
    ...EmptyBudgetUsage,
    toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0),
    wallClockMs,
    tokens: usage?.totalTokens ?? null,
  };
}

function requireCommandSuccess(
  command: string,
  response: { readonly ok: boolean; readonly error?: JsonValue },
): void {
  if (response.ok) return;
  throw new Error(
    `Velar hooks ${command} failed: ${JSON.stringify(response.error ?? null)}`,
  );
}

export function createVelarHooksDriver(options: VelarHooksDriverOptions) {
  const client = options.client ?? new VelarHooksClient();
  const commandExtras = options.commandExtras ?? {};
  const openedAt = new Map<string, number>();
  const latest = new Map<
    string,
    { status: unknown; transcript: unknown; debug: unknown }
  >();
  const legBaselines = new Map<
    string,
    {
      readonly blockIds: ReadonlySet<string>;
      readonly toolCallIds: ReadonlySet<string>;
    }
  >();
  const capabilities: DriverCapabilities = {
    observes: coverage({
      transcript: "full",
      turns: "partial",
      runtime: "full",
      usage: "partial",
      "context-residency": "partial",
    }),
    settleSignal: "coordinator-idle",
    canApproveInline: true,
    canAbortMidRun: true,
    verifierIsolation: "separate",
    preservesNativeExecution: true,
    ...options.capabilities,
  };

  async function snapshot(session: SessionHandle) {
    const [statusResponse, transcriptResponse, debugResponse] =
      await Promise.all([
        client.command({
          kind: "get_runtime_status",
          sessionId: session.externalId ?? session.id,
        }),
        client
          .command({
            kind: "get_transcript",
            sessionId: session.externalId ?? session.id,
            limit: 200,
          })
          .catch(() => null),
        client
          .command({
            kind: "get_debug",
            sessionId: session.externalId ?? session.id,
            limit: 200,
            full: true,
          })
          .catch(() => null),
      ]);
    const value = {
      status: dataOf(statusResponse),
      transcript: dataOf(transcriptResponse),
      debug: dataOf(debugResponse),
    };
    latest.set(session.id, value);
    return value;
  }

  return createPollingDriver(
    {
      id: options.id,
      capabilities: async () => capabilities,
      identity: async () => options.identity,
      openSession: async (spec) => {
        const id =
          options.createSessionId?.(spec) ??
          `lab-${spec.trial.id}-${randomUUID()}`;
        const workspaceRoot =
          options.resolveWorkspaceRoot?.(spec) ?? spec.workspaceRoot;
        const space = options.resolveSpace?.(spec) ?? spec.journey.space;
        openedAt.set(id, Date.now());
        return {
          id,
          executorId: spec.trial.executorId,
          externalId: id,
          metadata: {
            workspaceRoot,
            space,
            trialId: spec.trial.id,
            journeyId: spec.journey.id,
          },
        };
      },
      prepare: options.prepare ?? (async () => undefined),
      send: async (session, leg) => {
        const before = latest.get(session.id);
        legBaselines.set(session.id, {
          blockIds: new Set(
            transcriptBlocks(before?.transcript).map((block) => block.id),
          ),
          toolCallIds: new Set(
            debugTurns(before?.debug).flatMap((turn) =>
              turn.toolCalls.map((call) => call.id),
            ),
          ),
        });
        const response = await client.command({
          ...commandExtras,
          ...(options.sendParameters?.(session, leg) ?? leg.driverParameters),
          kind: "send_task",
          sessionId: session.externalId ?? session.id,
          workspaceRoot: session.metadata.workspaceRoot ?? null,
          space: session.metadata.space ?? null,
          message: leg.prompt,
        });
        requireCommandSuccess("send_task", response);
      },
      readState: async (session): Promise<NativeExecutionState> => {
        const value = await snapshot(session);
        const status = isRecord(value.status) ? value.status : {};
        const transcript = transcriptBlocks(value.transcript);
        const unavailableDetail =
          options.classifyUnavailable?.(transcript) ?? null;
        return {
          running: status.running === true,
          awaitingConfirmation: status.hasPendingConfirmation === true,
          awaitingInput: status.hasPendingInput === true,
          revision: assistantRevision(value.transcript),
          usage: budgetUsage(
            value.debug,
            Date.now() - (openedAt.get(session.id) ?? Date.now()),
          ),
          unavailable: unavailableDetail ? { detail: unavailableDetail } : null,
        };
      },
      collect: async (
        session,
        phase: ObservationPhase,
      ): Promise<Observation> => {
        const value = latest.get(session.id) ?? (await snapshot(session));
        const status = isRecord(value.status) ? value.status : {};
        const baseline = legBaselines.get(session.id);
        const turns = debugTurns(value.debug)
          .map((turn) => ({
            ...turn,
            toolCalls: turn.toolCalls.filter(
              (call) => !baseline?.toolCallIds.has(call.id),
            ),
          }))
          .filter(
            (turn) =>
              turn.toolCalls.length > 0 || turn.finishReasons.length > 0,
          );
        const transcript = transcriptBlocks(value.transcript).filter(
          (block) => !baseline?.blockIds.has(block.id),
        );
        const usage = usageFrom(value.debug);
        const contextResidency = residencyFrom(value.debug);
        return {
          ...createUnobservedObservation(phase),
          coverage: coverage({
            transcript: value.transcript === null ? "none" : "full",
            turns: value.debug === null ? "none" : "partial",
            runtime: "full",
            usage: value.debug === null ? "none" : "partial",
            "context-residency": value.debug === null ? "none" : "partial",
          }),
          transcript,
          turns,
          runtime: {
            running: nullableBoolean(status.running),
            awaitingConfirmation: nullableBoolean(
              status.hasPendingConfirmation,
            ),
            awaitingInput: nullableBoolean(status.hasPendingInput),
            status: nullableString(status.status),
            contextTokens: nullableNumber(status.contextTokens),
            contextWindow: nullableNumber(status.contextWindow),
            contextPercent: nullableNumber(status.contextPercent),
          },
          usage,
          contextResidency,
          metadata: {
            hookSessionId: session.externalId ?? session.id,
            toolCalls: turns.reduce(
              (sum, turn) => sum + turn.toolCalls.length,
              0,
            ),
          },
        };
      },
      resolveConfirmation: async (session, approved, rejectionMessage) => {
        const response = await client.command({
          kind: "resolve_confirmation",
          sessionId: session.externalId ?? session.id,
          approved,
          rejectionMessage,
        });
        requireCommandSuccess("resolve_confirmation", response);
      },
      abort: async (session, reason) => {
        const response = await client.command({
          kind: "abort_session",
          sessionId: session.externalId ?? session.id,
          reason,
        });
        requireCommandSuccess("abort_session", response);
        const responseData = isRecord(response.data) ? response.data : null;
        if (responseData?.aborted === false) {
          throw new Error(
            "Velar hooks abort_session reported that no active execution was aborted",
          );
        }
      },
      closeSession: async (session) => {
        openedAt.delete(session.id);
        latest.delete(session.id);
        legBaselines.delete(session.id);
      },
    },
    options.polling,
  );
}
