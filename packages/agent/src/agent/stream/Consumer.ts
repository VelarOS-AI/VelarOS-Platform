import type { TextStreamPart, ToolSet } from "ai";

import type {
  AppLocale,
  ChatRuntimeEvent,
  StreamAssistantGeneratedFilePayload,
  StreamAssistantSourcePayload,
  StreamReasoningPayload,
  StreamToolCallPayload,
  StreamToolMetadataPayload,
} from "@velaros-ai/agent/protocol";
import { ChatRuntimeEvents } from "@velaros-ai/agent/protocol";
import {
  isEmpty,
  isNotNull,
  isNull,
  isObject,
  isPresent,
  isString,
  toNullable,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import { logRuntime } from "@velaros-ai/core/logger";
import { TimerScope } from "@velaros-ai/core/utils/TimerScope";

import type {
  KernelContextEpoch,
  KernelContextEpochClaim,
  KernelContextEpochGuardLike,
  ProviderTurnEventReducer,
  ProviderTurnSnapshot,
  ProviderTurnUsage,
} from "../../kernel";
import { recordKernelContextEpochDiagnostic } from "../../kernel";
import {
  createProviderToolReferenceCanonicalizer,
  ToolExecutionPolicy,
  type ToolExecutionPolicyRegistry,
} from "../../tools";
import type { AssistantContentPart } from "../history";
import { normalizeModelRequestError } from "../model/ModelRequestError";

import { AgentStreamDiagnosticHelper } from "./diagnostics";
import {
  buildEmptyAssistantStreamError,
  shouldRecoverEmptyStreamAsContextPressure,
} from "./EmptyStreamRecovery";
import {
  readGeneratedFilePayload,
  readSourcePayload,
} from "./generated-artifacts";
import {
  readNextStreamPartWithIdleTimeout,
  returnStreamIteratorQuietly,
} from "./idle-read";
import {
  createInlineReasoningTagSplitState,
  flushInlineReasoningTagTail,
  type InlineReasoningSegment,
  splitInlineReasoningTagDelta,
} from "./inline-reasoning-tags";
import {
  createLeakedToolMarkupFilterState,
  filterLeakedToolMarkupDelta,
  flushLeakedToolMarkupTail,
} from "./leaked-tool-markup";
import {
  createOutputTruncationError,
  isRecoverableOutputTruncationDiagnostic,
} from "./OutputTruncationRecovery";
import { createProviderTurnToolCallIdAllocator } from "./tool-call-id";
import {
  applyProviderToolInputStreamPart,
  buildToolInputReadyMetadata,
  diagnoseRejectedProviderToolInput,
  parseRecoverableProviderToolInputDraft,
  type ProviderToolInputDraft,
  type ProviderToolNameResolution,
  resolveProviderExecutableToolInput,
  resolveProviderFinalToolCallIdentity,
  summarizeProviderToolInputDraft,
} from "./tool-input";
import type { StreamDiagnostics } from "./types";

const StreamIdleThinkingNoticeDelayMs = 15_000;

/** 内联 `<think>` 标签抽出来的思考增量共用同一个 reasoning stream id（相邻续写并成一块）。 */
const InlineReasoningTagStreamId = "inline-think";

/** 从 raw 分片兜底抽出的思考增量共用的 reasoning stream id（取值沿用历史）。 */
const RawReasoningStreamId = "deepseek-reasoning";

interface StreamConsumerTurnState {
  /**
   * 面向界面的轮次计数轴；主 Agent 是确定 turn（number），子 Agent（QueryTurn 装配）没有 UI 轮次轴，
   * 传 null——telemetry / 日志 / 错误上下文一路容忍 nullable turn。
   */
  turn: Nullable<number>;
  hasToolUse: boolean;
  /** At least one accepted tool call crossed into ToolExecutor and may already have side effects. */
  hasDispatchedToolUse?: boolean;
  accumulatedText: string;
  hasVisibleOutput: boolean;
  /** Reasoning actually projected to the event bus; distinct from a visible answer. */
  hasReasoningOutput?: boolean;
  /** 供应方返回的真实输入 token 数（若有）；用于 MMU 用量校准反馈。 */
  inputTokens?: LooseOptional<number>;
  /**
   * 本回合的执行观测富化字段（#37 阶段 C 片 1）。供应方回合收敛时从 stream diagnostics /
   * 请求指纹取出，随 {@link StreamTurnResult} 交回 SoloLoop 挂到确定 turn 的 model span（D5），
   * 与既有 inputTokens 走同一条回传通道。缺席一律 null。
   */
  outputTokens?: LooseOptional<number>;
  costUsd?: LooseOptional<number>;
  /** 推理 token（已含在 outputTokens 里）与输入里命中 / 写入缓存的部分：计价时按各自单价拆开算。 */
  reasoningTokens?: LooseOptional<number>;
  cacheReadInputTokens?: LooseOptional<number>;
  cacheWriteInputTokens?: LooseOptional<number>;
  finishReason?: LooseOptional<string>;
  requestFingerprint?: LooseOptional<string>;
}

interface StreamConsumerToolExecutor {
  configureProviderTurnReducer?(
    input: ProviderTurnEventReducer,
    onSnapshot?: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>,
  ): void;
  enqueue(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    isConcurrencySafe: boolean,
    authorization?: {
      requestAdvertised: boolean;
      providerToolName: string;
    },
  ): void;
}

interface StreamConsumerEvents {
  emitRuntime?(event: ChatRuntimeEvent): void;
  emitReasoningDelta(payload: StreamReasoningPayload): void;
  emitTextDelta(text: string): void;
  emitGeneratedFile(payload: StreamAssistantGeneratedFilePayload): void;
  emitSource(payload: StreamAssistantSourcePayload): void;
  emitToolStart(payload: StreamToolCallPayload): void;
  emitToolMetadata?(payload: StreamToolMetadataPayload): void;
}

interface InterruptedStreamPartial {
  assistantContent: AssistantContentPart[];
  hasPendingToolCalls: boolean;
}

interface ConsumeAssistantStreamArgs {
  abortSignal: AbortSignal;
  executor: StreamConsumerToolExecutor;
  events: StreamConsumerEvents;
  /**
   * 模型流静默多久后把状态拉回「思考中」（毫秒）。字段名沿用历史叫法以保持公开 API 兼容；
   * 静默期早已不再上报重连。
   */
  idleReconnectDelayMs?: number;
  idleStallTimeoutMs?: number;
  model: string;
  contextPressure?: {
    percent: number;
    usableContextWindow: number;
  };
  requestFingerprint?: unknown;
  /** Immutable provider name -> canonical id map captured for this exact request. */
  providerToCanonicalToolNames?: Readonly<Record<string, string>>;
  contextEpoch?: KernelContextEpoch;
  contextEpochClaim?: LooseOptional<KernelContextEpochClaim>;
  contextEpochGuard?: LooseOptional<KernelContextEpochGuardLike>;
  providerTurnReducer?: ProviderTurnEventReducer;
  toolContext?: {
    locale?: AppLocale;
    resolveCurrentVisibleCanonicalToolName?: (
      providerToolName: string,
    ) => LooseOptional<string>;
    resolveKnownCanonicalToolName?: (
      providerToolName: string,
    ) => LooseOptional<string>;
  };
  /**
   * 空流恢复错误的来源标签（装配面差异）：主 Agent 流 = 'stream'，子 Agent 装配 = 'query'。
   * 它决定 reasoning-only 空响应的 `context.source`，QueryLoop 的 reasoning-only 恢复靠这个标签匹配，
   * 不能一律写死 'stream'，否则子 Agent 丢掉 reasoning-only 空流恢复抗体。缺省 'stream'。
   */
  emptyStreamSource?: "stream" | "query";
  onInterruptedPartial?: (partial: InterruptedStreamPartial) => void;
}

interface PendingStreamToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  providerToolName: string;
  requestAdvertised: boolean;
  streamedInput?: {
    inputText: string;
  };
}

interface RejectedStreamToolCall {
  toolCallId: string;
  toolName: string;
  reason: string;
  receivedType: string;
  inputChars: number;
  diagnostic: ReturnType<typeof diagnoseRejectedProviderToolInput>;
}

interface StreamIdleThinkingNotifier {
  dispose(): void;
  markChunkReceived(): void;
}

/**
 * StreamConsumer — AI SDK `fullStream` 的消费者。
 *
 * 职责：把 `streamText` 返回的 `AsyncIterable<TextStreamPart>` 转换成
 *   1) 推送到 UI 的 textDelta / reasoningDelta 事件（通过 ExecutionEventBus），
 *   2) 推送到 ToolExecutor 的 tool-call（统一在这里通过 ToolExecutionPolicy 做参数校验和权限检查），
 *   3) 累积出 assistant 这一轮的 content parts，供 AgentTurnHistoryHelper 写回 history。
 *
 * 设计要点：
 * - 通过 AgentStreamDiagnosticHelper 同步记录每个 chunk 的诊断信息，
 *   一旦遇到非标准的 raw chunk（如 Anthropic content_block_delta），会尝试用
 *   AgentRawStreamTextExtractor 把视觉文本/reasoning 抢救出来作为兜底——只在 SDK
 *   整条流都没给出对应文本（非空 text-delta / reasoning-delta）时才用，不与之叠加。
 * - 对 abortSignal 全程响应：循环开头检查，避免在已取消的情况下继续推 UI 事件。
 * - tool-call 不在这里同步执行，仅注册到 ToolExecutor；执行/取消由外层 ToolExecutor 统一调度，
 *   保证“并发安全工具并发执行 / 非并发安全工具串行” 的策略一致。
 */
class StreamConsumer {
  private readonly log = logRuntime.tag("StreamConsumer");
  private readonly streamDiagnosticHelper = new AgentStreamDiagnosticHelper();
  private readonly executionPolicy: ToolExecutionPolicy;

  constructor(toolRegistry: ToolExecutionPolicyRegistry) {
    this.executionPolicy = new ToolExecutionPolicy(toolRegistry);
  }

  public async consumeAssistantStream(
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
    turnState: StreamConsumerTurnState,
    args: ConsumeAssistantStreamArgs,
  ): Promise<AssistantContentPart[]> {
    const assistantContent: AssistantContentPart[] = [];
    const diagnostics = this.streamDiagnosticHelper.createStreamDiagnostics();
    const idleThinkingNotifier = this.createIdleThinkingNotifier(
      args,
      turnState,
    );
    let currentText = "";
    let pendingRawTextFallback = "";
    let hasTextOutput = false;
    // 过滤泄漏的原生工具调用标记（`<｜DSML｜...`），别把它当正文推给 UI/历史。
    const leakedToolMarkupState = createLeakedToolMarkupFilterState();
    const toolReferenceCanonicalizer =
      createProviderToolReferenceCanonicalizer(
        args.providerToCanonicalToolNames ?? {},
      );
    const reasoningToolReferenceCanonicalizer =
      createProviderToolReferenceCanonicalizer(
        args.providerToCanonicalToolNames ?? {},
      );
    let reasoningStreamId = "reasoning";
    const appendReasoningDelta = (text: string): void => {
      if (!text) return;
      assistantContent.push({ type: "reasoning", text });
      args.providerTurnReducer?.apply({
        type: "assistant-reasoning-delta",
        text,
      });
      turnState.hasReasoningOutput = true;
      args.events.emitReasoningDelta({ id: reasoningStreamId, text });
    };
    const emitReasoningDelta = (id: string, rawText: string): void => {
      if (!rawText) return;
      if (id !== reasoningStreamId) {
        appendReasoningDelta(reasoningToolReferenceCanonicalizer.flush());
        reasoningStreamId = id;
      }
      appendReasoningDelta(reasoningToolReferenceCanonicalizer.push(rawText));
    };
    const flushReasoningTail = (): void => {
      appendReasoningDelta(reasoningToolReferenceCanonicalizer.flush());
    };
    // 思考每条流只认一个来源：SDK 给出了结构化思考文本（非空 reasoning-delta）就只用它，raw 分片里
    // 抽出的同一份思考一律丢弃；整条流都没有结构化思考文本时（如 `.chat()` 不认 `reasoning_content`，
    // 或网关把整段思考塞进 content_block_start / output_item.done）才用 raw 兜底——与正文只看非空
    // text-delta 的 raw 兜底对称。SDK 对同一个 SSE 分片先发 raw 再发解析出的部分，所以 raw 抽出的思考
    // 先压着，等到下一个非 reasoning 分片再补发；其间来了带文本的 reasoning-delta 就作废。
    let hasStructuredReasoning = false;
    let pendingRawReasoning = "";
    const flushPendingRawReasoning = (): void => {
      if (!pendingRawReasoning) return;
      const text = pendingRawReasoning;
      pendingRawReasoning = "";
      emitReasoningDelta(RawReasoningStreamId, text);
    };
    // 把可见正文里内联的 `<think>...</think>` 抽成 reasoning；没有标签时是纯透传。
    const inlineReasoningTagState = createInlineReasoningTagSplitState();
    const emitInlineReasoningDelta = (text: string): void => {
      if (!text) return;
      // 先把已缓冲的正文提交，保证 assistantContent 里 text/reasoning 顺序与流一致。
      flushCurrentText();
      // 刻意不置 hasVisibleOutput：与结构化 reasoning-delta 一致，纯思考无可见答复仍触发
      // 「补一个可见答复」的恢复逻辑。
      emitReasoningDelta(InlineReasoningTagStreamId, text);
    };
    const routeInlineReasoningSegments = (
      segments: InlineReasoningSegment[],
    ): void => {
      for (const segment of segments) {
        if (!segment.text) continue;
        if (segment.kind === "reasoning") {
          emitInlineReasoningDelta(segment.text);
          continue;
        }
        this.appendTextDelta(
          segment.text,
          turnState,
          args.events,
          (text) => {
            currentText += text;
          },
          args.providerTurnReducer,
        );
      }
    };
    const emitAssistantTextDelta = (rawText: string): void => {
      const visible = filterLeakedToolMarkupDelta(
        leakedToolMarkupState,
        rawText,
      );
      if (!visible) return;
      const canonical = toolReferenceCanonicalizer.push(visible);
      if (!canonical) return;
      routeInlineReasoningSegments(
        splitInlineReasoningTagDelta(inlineReasoningTagState, canonical),
      );
    };
    const flushToolReferenceTail = (): void => {
      const canonical = toolReferenceCanonicalizer.flush();
      if (!canonical) return;
      routeInlineReasoningSegments(
        splitInlineReasoningTagDelta(inlineReasoningTagState, canonical),
      );
    };
    const pendingToolCalls: PendingStreamToolCall[] = [];
    const pendingToolInputDrafts = new Map<string, ProviderToolInputDraft>();
    const rejectedToolCalls: RejectedStreamToolCall[] = [];
    const allocateToolCallId = createProviderTurnToolCallIdAllocator();
    if (args.providerTurnReducer && !args.providerTurnReducer.hasStarted()) {
      args.providerTurnReducer.apply({ type: "turn-started" });
    }
    if (args.providerTurnReducer && args.contextEpoch) {
      recordKernelContextEpochDiagnostic(
        args.providerTurnReducer,
        args.contextEpoch,
        {
          claim: args.contextEpochClaim,
          current: args.contextEpochClaim ? true : undefined,
        },
      );
    }
    const assertContextEpochCurrent = (): void => {
      if (!args.contextEpochClaim) return;
      args.contextEpochGuard?.assertCurrent(args.contextEpochClaim);
    };
    const flushPendingRawTextFallback = (): void => {
      if (hasTextOutput || !pendingRawTextFallback) return;

      hasTextOutput = true;
      emitAssistantTextDelta(pendingRawTextFallback);
      pendingRawTextFallback = "";
    };
    const flushCurrentText = (): void => {
      if (!currentText) return;

      assistantContent.push({ type: "text", text: currentText });
      currentText = "";
    };
    const flushPendingToolCalls = (): void => {
      if (isEmpty(pendingToolCalls) || args.abortSignal.aborted) return;

      flushReasoningTail();
      flushToolReferenceTail();
      flushCurrentText();

      for (const toolCall of pendingToolCalls) {
        assistantContent.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        });

        args.events.emitRuntime?.(ChatRuntimeEvents.phase("executing-tool"));
        this.log.info("tool call received", {
          turn: turnState.turn,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        });
        args.events.emitToolStart({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.input,
          categoryId:
            this.executionPolicy.getToolCategoryId(toolCall.toolName) ||
            undefined,
        });
        if (toolCall.streamedInput) {
          args.events.emitToolMetadata?.({
            toolCallId: toolCall.toolCallId,
            metadata: buildToolInputReadyMetadata(
              toolCall.streamedInput.inputText,
            ),
            timestamp: Date.now(),
          });
        }

        args.executor.enqueue(
          toolCall.toolCallId,
          toolCall.toolName,
          toolCall.input,
          this.isToolConcurrencySafe(toolCall.toolName, toolCall.input),
          {
            requestAdvertised: toolCall.requestAdvertised,
            providerToolName: toolCall.providerToolName,
          },
        );
        turnState.hasDispatchedToolUse = true;
      }

      pendingToolCalls.length = 0;
    };
    let didCaptureInterruptedPartial = false;
    const captureInterruptedPartial = (): void => {
      if (didCaptureInterruptedPartial) return;
      didCaptureInterruptedPartial = true;

      flushPendingRawReasoning();
      flushReasoningTail();
      flushPendingRawTextFallback();
      flushToolReferenceTail();
      flushCurrentText();
      const hasPendingToolCalls =
        !isEmpty(pendingToolCalls) ||
        pendingToolInputDrafts.size > 0 ||
        !isEmpty(rejectedToolCalls);
      if (isEmpty(assistantContent) && !hasPendingToolCalls) return;

      args.onInterruptedPartial?.({
        assistantContent: assistantContent.map((part) => ({ ...part })),
        hasPendingToolCalls,
      });
    };
    const recoverStreamedToolInputDrafts = (): void => {
      if (pendingToolInputDrafts.size === 0) return;

      for (const draft of [...pendingToolInputDrafts.values()]) {
        const input = parseRecoverableProviderToolInputDraft(draft, {
          model: args.model,
          turn: turnState.turn,
        });
        if (!input) continue;

        pendingToolInputDrafts.delete(draft.id);
        pendingToolCalls.push({
          toolCallId: draft.id,
          toolName: draft.toolName,
          providerToolName: draft.providerToolName,
          requestAdvertised: draft.requestAdvertised,
          input,
          streamedInput: { inputText: draft.inputText },
        });
        args.providerTurnReducer?.apply({
          type: "tool-started",
          toolCallId: draft.id,
          toolName: draft.toolName,
          args: input,
        });
        diagnostics.toolCallCount += 1;
        turnState.hasToolUse = true;
      }
    };
    const streamIterator = fullStream[Symbol.asyncIterator]();
    let shouldReturnStreamIterator = false;
    try {
      // 消费 AI SDK fullStream；文本和 reasoning 形成宿主增量，tool-call 进入 ToolExecutor。
      while (true) {
        const next = await this.readNextStreamPart(
          streamIterator,
          args,
          turnState,
        );
        if (next.done) {
          shouldReturnStreamIterator =
            args.abortSignal.aborted && shouldReturnStreamIterator;
          break;
        }

        shouldReturnStreamIterator = true;
        const chunk = next.value;
        idleThinkingNotifier.markChunkReceived();
        if (args.abortSignal.aborted) {
          break;
        }

        assertContextEpochCurrent();
        const part = chunk;
        this.streamDiagnosticHelper.recordStreamPartDiagnostics(
          diagnostics,
          part,
        );

        if (
          part.type === "reasoning-start" ||
          part.type === "reasoning-delta" ||
          part.type === "reasoning-end"
        ) {
          // 起止标记和空增量（如签名）不带思考文本，不定来源，也不补发压着的 raw 思考。
          if (part.type !== "reasoning-delta" || !part.text) continue;

          // SDK 给出了思考文本：从此只认结构化来源，同一分片 raw 里抽出、还压着的那份作废。
          hasStructuredReasoning = true;
          pendingRawReasoning = "";
          emitReasoningDelta(part.id, part.text);
          continue;
        }

        // 其余分片前先补发上一个 raw 分片压着的兜底思考，保持思考与后续输出的先后。
        flushPendingRawReasoning();

        if (part.type === "text-delta") {
          // 普通文本增量走 ExecutionEventBus.emitTextDelta，最终由宿主 stream bridge 发送到渲染端。
          flushReasoningTail();
          hasTextOutput = !!part.text || hasTextOutput;
          emitAssistantTextDelta(part.text);
          continue;
        }

        const generatedFile = readGeneratedFilePayload(part);
        if (generatedFile) {
          turnState.hasVisibleOutput = true;
          args.events.emitGeneratedFile(generatedFile);
          continue;
        }

        const source = readSourcePayload(part);
        if (source) {
          args.events.emitSource(source);
          continue;
        }

        if (part.type === "raw") {
          const reasoningText =
            this.streamDiagnosticHelper.extractReasoningDeltaFromRawChunk(
              part.rawValue,
            );
          diagnostics.rawReasoningChars += reasoningText.length;
          if (!hasStructuredReasoning) pendingRawReasoning += reasoningText;
          const visibleText =
            this.streamDiagnosticHelper.extractVisibleTextFromRawChunk(
              part.rawValue,
            );
          diagnostics.rawVisibleChars += visibleText.length;
          if (visibleText) flushReasoningTail();
          pendingRawTextFallback += visibleText;
          continue;
        }

        if (part.type === "error") {
          captureInterruptedPartial();
          throw normalizeModelRequestError(part.error);
        }

        if (part.type === "abort") {
          throw new AppError("EXECUTION_ABORTED", part.reason ?? "运行被终止");
        }

        if (
          applyProviderToolInputStreamPart(part, pendingToolInputDrafts, {
            model: args.model,
            turn: turnState.turn,
            markVisibleOutput: () => {
              turnState.hasVisibleOutput = true;
            },
            resolveToolName: (toolName) =>
              this.resolveRequestToolName(toolName, args),
          })
        ) {
          continue;
        }

        if (part.type !== "tool-call") {
          continue;
        }

        flushPendingRawTextFallback();

        diagnostics.toolCallCount += 1;
        const toolCallId = allocateToolCallId(part.toolCallId);
        const identity = resolveProviderFinalToolCallIdentity(
          pendingToolInputDrafts,
          {
            toolCallId: part.toolCallId,
            finalToolName: part.toolName,
            model: args.model,
            turn: turnState.turn,
            resolveToolName: (toolName) =>
              this.resolveRequestToolName(toolName, args),
          },
        );
        const toolNameResolution = identity.toolNameResolution;
        const toolName = toolNameResolution.toolName;
        const streamedInput = identity.streamedInput;
        const inputResolution = resolveProviderExecutableToolInput(
          part.input,
          streamedInput,
        );
        if (!inputResolution.ok) {
          rejectedToolCalls.push({
            toolCallId,
            toolName,
            reason: inputResolution.reason,
            receivedType: inputResolution.receivedType,
            inputChars: inputResolution.inputChars,
            diagnostic: diagnoseRejectedProviderToolInput(
              part.input,
              streamedInput,
            ),
          });
          continue;
        }

        const input = inputResolution.input;
        if (inputResolution.source === "ended-stream-draft") {
          this.log.info(
            "recovered final tool input from completed stream draft",
            {
              turn: turnState.turn,
              model: args.model,
              toolCallId,
              toolName,
              inputChars: streamedInput?.inputText.length ?? 0,
            },
          );
        }
        turnState.hasVisibleOutput = true;
        pendingToolCalls.push({
          toolCallId,
          toolName,
          providerToolName: toolNameResolution.providerToolName,
          requestAdvertised: toolNameResolution.requestAdvertised,
          input,
          ...(streamedInput
            ? { streamedInput: { inputText: streamedInput.inputText } }
            : {}),
        });
        args.providerTurnReducer?.apply({
          type: "tool-started",
          toolCallId,
          toolName,
          args: input,
        });
        turnState.hasToolUse = true;
      }
    } catch (error) {
      captureInterruptedPartial();
      throw error;
    } finally {
      idleThinkingNotifier.dispose();
      if (shouldReturnStreamIterator) {
        await returnStreamIteratorQuietly(streamIterator, "stream-consumer");
      }
    }

    recoverStreamedToolInputDrafts();

    if (!isEmpty(rejectedToolCalls)) {
      const finishDiagnostic = this.recordAbnormalFinishReasonDiagnostic(
        diagnostics,
        args.providerTurnReducer,
      );
      this.emitUsageTelemetry(diagnostics, turnState, args);
      captureInterruptedPartial();
      this.log.warn(
        "provider finalized an invalid tool-call input; rejecting before execution",
        {
          turn: turnState.turn,
          model: args.model,
          rejectedToolCalls,
          finishReasons: diagnostics.finishReasons,
          rawFinishReasons: diagnostics.rawFinishReasons,
          outputTokens: diagnostics.outputTokens,
        },
      );
      throw new AppError(
        "MODEL_STREAM_INTERRUPTED",
        isRecoverableOutputTruncationDiagnostic(finishDiagnostic)
          ? "模型输出达到长度限制，工具参数未完整生成，已在执行前中止本轮请求。"
          : "模型服务返回了不完整的工具参数，已在执行前中止本轮请求。",
        undefined,
        {
          source: "stream-tool-input",
          turn: turnState.turn,
          model: args.model,
          rejectedToolCalls,
          finishReason: toNullable(
            finishDiagnostic?.details.normalizedFinishReason,
          ),
        },
      );
    }

    if (pendingToolInputDrafts.size > 0) {
      captureInterruptedPartial();
      throw new AppError(
        "MODEL_STREAM_INTERRUPTED",
        "模型流在工具参数生成完成后、工具调用可执行前结束，已中止本轮请求。",
        undefined,
        {
          source: "stream-tool-input",
          turn: turnState.turn,
          model: args.model,
          pendingToolInputs: [...pendingToolInputDrafts.values()].map((draft) =>
            summarizeProviderToolInputDraft(draft),
          ),
        },
      );
    }

    flushPendingRawReasoning();
    flushReasoningTail();
    flushPendingRawTextFallback();
    // 承接的尾巴始终没凑成泄漏标记 → 是正常正文，补发；已抑制则内部丢弃。
    const leakedTail = flushLeakedToolMarkupTail(leakedToolMarkupState);
    if (leakedTail) {
      const canonical = toolReferenceCanonicalizer.push(leakedTail);
      routeInlineReasoningSegments(
        splitInlineReasoningTagDelta(inlineReasoningTagState, canonical),
      );
    }
    flushToolReferenceTail();
    // 思考标签承接的尾巴始终没凑成完整标签 → 是真内容，按当前上下文补发。
    routeInlineReasoningSegments(
      flushInlineReasoningTagTail(inlineReasoningTagState),
    );
    flushCurrentText();
    flushPendingToolCalls();

    if (
      !args.abortSignal.aborted &&
      !turnState.hasVisibleOutput &&
      !turnState.hasToolUse
    ) {
      if (diagnostics.totalChunks > 0) {
        if (
          shouldRecoverEmptyStreamAsContextPressure(
            diagnostics,
            args.contextPressure,
          )
        ) {
          this.log.warn("assistant stream empty under high context pressure", {
            turn: turnState.turn,
            model: args.model,
            diagnostics:
              this.streamDiagnosticHelper.summarizeStreamDiagnostics(
                diagnostics,
              ),
            contextPressure: args.contextPressure,
          });
          this.emitUsageTelemetry(diagnostics, turnState, args);
          throw buildEmptyAssistantStreamError({
            diagnostics,
            contextPressure: args.contextPressure,
            requestFingerprint: args.requestFingerprint,
            source: args.emptyStreamSource ?? "stream",
            turn: turnState.turn,
          });
        }
        const fallbackText =
          this.streamDiagnosticHelper.buildNonDisplayableResponseMessage(
            diagnostics,
            args.toolContext?.locale,
          );
        this.log.warn("assistant stream completed without displayable output", {
          turn: turnState.turn,
          model: args.model,
          diagnostics:
            this.streamDiagnosticHelper.summarizeStreamDiagnostics(diagnostics),
        });
        this.emitUsageTelemetry(diagnostics, turnState, args);
        throw buildEmptyAssistantStreamError({
          diagnostics,
          contextPressure: args.contextPressure,
          fallbackText,
          requestFingerprint: args.requestFingerprint,
          source: args.emptyStreamSource ?? "stream",
          turn: turnState.turn,
        });
      }

      throw buildEmptyAssistantStreamError({
        diagnostics,
        contextPressure: args.contextPressure,
        requestFingerprint: args.requestFingerprint,
        source: args.emptyStreamSource ?? "stream",
        turn: turnState.turn,
      });
    }

    const finishDiagnostic = this.recordAbnormalFinishReasonDiagnostic(
      diagnostics,
      args.providerTurnReducer,
    );
    // 无条件留痕:finishReason 曾只活在内存 diagnostics 里,截断/异常关流事故事后零痕迹、
    // 无法区分「模型自己 stop」「上游 length 截断」「流缺 finish part」。这行是永久探针。
    this.log.info("assistant stream finished", {
      turn: turnState.turn,
      model: args.model,
      finishReasons: diagnostics.finishReasons,
      rawFinishReasons: diagnostics.rawFinishReasons,
      hasToolUse: turnState.hasToolUse,
      outputTokens: diagnostics.outputTokens,
      reasoningTokens: diagnostics.reasoningTokens,
    });
    this.emitUsageTelemetry(diagnostics, turnState, args);
    if (
      !turnState.hasToolUse &&
      isRecoverableOutputTruncationDiagnostic(finishDiagnostic)
    ) {
      // Provider 正常关流不代表回答完整；保留已展示正文并交给 StreamTurn 自动续写。
      captureInterruptedPartial();
      throw createOutputTruncationError(finishDiagnostic, {
        model: args.model,
        turn: turnState.turn,
      });
    }

    return assistantContent;
  }

  private resolveRequestToolName(
    toolName: string,
    args: Pick<
      ConsumeAssistantStreamArgs,
      "providerToCanonicalToolNames" | "toolContext"
    >,
  ): ProviderToolNameResolution {
    const requestCanonicalName = args.providerToCanonicalToolNames?.[toolName];
    if (requestCanonicalName)
      return {
        toolName: requestCanonicalName,
        providerToolName: toolName,
        requestAdvertised: true,
      };

    if (
      args.providerToCanonicalToolNames &&
      Object.values(args.providerToCanonicalToolNames).includes(toolName)
    )
      return {
        toolName,
        providerToolName: toolName,
        requestAdvertised: true,
      };

    if (args.providerToCanonicalToolNames) {
      const knownCanonicalName =
        args.toolContext?.resolveKnownCanonicalToolName?.(toolName);
      if (knownCanonicalName)
        return {
          toolName: knownCanonicalName,
          providerToolName: toolName,
          requestAdvertised: false,
        };

      return {
        toolName,
        providerToolName: toolName,
        requestAdvertised: false,
      };
    }

    // 无请求级计划的 headless/旧适配器保留规范名称解析；正常的 StreamTurn 与 QueryTurn
    // 始终会传入计划，因此会在上方按 fail-closed 规则拒绝。
    return {
      toolName: this.executionPolicy.resolveCanonicalToolName(
        toolName,
        undefined,
        args.toolContext,
      ),
      providerToolName: toolName,
      requestAdvertised: true,
    };
  }

  private async readNextStreamPart(
    iterator: AsyncIterator<TextStreamPart<ToolSet>>,
    args: ConsumeAssistantStreamArgs,
    turnState: StreamConsumerTurnState,
  ): Promise<IteratorResult<TextStreamPart<ToolSet>>> {
    return readNextStreamPartWithIdleTimeout(iterator, {
      abortSignal: args.abortSignal,
      idleStallTimeoutMs: args.idleStallTimeoutMs,
      model: args.model,
      requestFingerprint: args.requestFingerprint,
      source: "stream-idle-stall",
      timerName: "StreamConsumer.idleStall",
      turn: turnState.turn,
    });
  }

  private emitUsageTelemetry(
    diagnostics: StreamDiagnostics,
    turnState: StreamConsumerTurnState,
    args: ConsumeAssistantStreamArgs,
  ): void {
    // 观测富化（#37 阶段 C 片 1）：finishReason / 请求指纹与 usage 无关，先于 usage 门捕获，
    // 供 SoloLoop 挂 model span（即便供应方未回 token，收敛态仍应带 finishReason/fingerprint）。
    turnState.finishReason = toNullable(
      diagnostics.finishReasons[0] ?? diagnostics.rawFinishReasons[0],
    );
    turnState.requestFingerprint = readRequestFingerprintId(
      args.requestFingerprint,
    );

    const hasProviderUsage =
      isNotNull(diagnostics.inputTokens) ||
      isNotNull(diagnostics.outputTokens) ||
      isNotNull(diagnostics.totalTokens) ||
      isNotNull(diagnostics.reasoningTokens) ||
      isNotNull(toNullable(diagnostics.cacheReadInputTokens)) ||
      isNotNull(toNullable(diagnostics.cacheWriteInputTokens)) ||
      isNotNull(diagnostics.costUsd);

    if (!hasProviderUsage) return;

    // 把真实输入 token 暴露给上层 turn helper，用于 MMU 用量校准反馈。
    turnState.inputTokens = diagnostics.inputTokens;
    // 观测富化：outputTokens / costUsd 与 inputTokens 同源同回传通道（#37 阶段 C 片 1）。
    turnState.outputTokens = diagnostics.outputTokens;
    turnState.costUsd = diagnostics.costUsd;
    turnState.reasoningTokens = diagnostics.reasoningTokens;
    turnState.cacheReadInputTokens = toNullable(diagnostics.cacheReadInputTokens);
    turnState.cacheWriteInputTokens = toNullable(diagnostics.cacheWriteInputTokens);
    const usage: ProviderTurnUsage = {};
    if (isPresent(diagnostics.inputTokens)) {
      usage.inputTokens = diagnostics.inputTokens;
    }
    if (isPresent(diagnostics.outputTokens)) {
      usage.outputTokens = diagnostics.outputTokens;
    }
    if (isPresent(diagnostics.totalTokens)) {
      usage.totalTokens = diagnostics.totalTokens;
    }
    args.providerTurnReducer?.apply({
      type: "usage",
      ...usage,
    });

    args.events.emitRuntime?.(
      ChatRuntimeEvents.usageTelemetry({
        turn: turnState.turn,
        model: args.model,
        inputTokens: diagnostics.inputTokens,
        outputTokens: diagnostics.outputTokens,
        visibleOutputTokens: diagnostics.visibleOutputTokens,
        totalTokens: diagnostics.totalTokens,
        reasoningTokens: diagnostics.reasoningTokens,
        cachedInputTokens: diagnostics.cachedInputTokens,
        cacheReadInputTokens: diagnostics.cacheReadInputTokens,
        cacheWriteInputTokens: diagnostics.cacheWriteInputTokens,
        costUsd: diagnostics.costUsd,
        finishReasons: isEmpty(diagnostics.finishReasons)
          ? undefined
          : [...diagnostics.finishReasons],
        rawFinishReasons: isEmpty(diagnostics.rawFinishReasons)
          ? undefined
          : [...diagnostics.rawFinishReasons],
        source: isNull(diagnostics.costUsd) ? "provider" : "gateway-cost",
        confidence: "high",
      }),
    );
  }

  private recordAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics,
    providerTurnReducer?: ProviderTurnEventReducer,
  ): ReturnType<
    AgentStreamDiagnosticHelper["buildAbnormalFinishReasonDiagnostic"]
  > {
    const diagnostic =
      this.streamDiagnosticHelper.buildAbnormalFinishReasonDiagnostic(
        diagnostics,
      );
    if (!diagnostic) return null;

    providerTurnReducer?.apply({
      type: "diagnostic",
      ...diagnostic,
    });
    return diagnostic;
  }

  /**
   * 模型流静默看门狗：连续 `delayMs` 没收到任何分片时记一条诊断日志，并把状态拉回「思考中」。
   *
   * 静默 ≠ 断线：推理模型思考时本来就会十几秒甚至更久不出字。过去这里每 15 秒发一次
   * `reconnecting`，界面便显示「连接中断，正在重连」——明明什么都没断、也没有重连在发生，
   * 误导用户去查网络。「重连中」只属于真正发生重试的路径（`AgentConnectionRetryHelper`、
   * `retryingTurn`）；这里只负责让静默期的状态停在「思考中」。
   */
  private createIdleThinkingNotifier(
    args: ConsumeAssistantStreamArgs,
    turnState: StreamConsumerTurnState,
  ): StreamIdleThinkingNotifier {
    const delayMs =
      args.idleReconnectDelayMs ?? StreamIdleThinkingNoticeDelayMs;
    if (!args.events.emitRuntime || delayMs <= 0)
      return {
        dispose: () => undefined,
        markChunkReceived: () => undefined,
      };

    const timers = new TimerScope({ name: "StreamConsumer.idleThinking" });
    let idleTicks = 0;
    let idleNoticeActive = false;
    let lease: Nullable<ReturnType<TimerScope["after"]>> = null;

    const cancelLease = (): void => {
      lease?.cancel();
      lease = null;
    };
    const schedule = (): void => {
      cancelLease();
      if (args.abortSignal.aborted || timers.isDisposed) return;

      lease = timers.after(
        delayMs,
        () => {
          if (args.abortSignal.aborted || timers.isDisposed) return;

          idleTicks += 1;
          this.log.warn("model stream idle while waiting for provider chunks", {
            turn: turnState.turn,
            idleTicks,
            delayMs,
          });
          // 一段静默只拉一次状态；之后每个周期只记日志，不重复刷事件。
          if (!idleNoticeActive)
            args.events.emitRuntime?.(ChatRuntimeEvents.phase("executing"));
          idleNoticeActive = true;
          schedule();
        },
        {
          label: "stream-idle-thinking",
          signal: args.abortSignal,
          unref: true,
        },
      );
    };

    schedule();

    return {
      dispose: () => timers.dispose(),
      markChunkReceived: () => {
        idleNoticeActive = false;
        schedule();
      },
    };
  }

  private appendTextDelta(
    text: string,
    turnState: StreamConsumerTurnState,
    events: Pick<StreamConsumerEvents, "emitTextDelta">,
    appendCurrentText: (text: string) => void,
    providerTurnReducer?: ProviderTurnEventReducer,
  ): void {
    if (!text) return;

    appendCurrentText(text);
    turnState.accumulatedText += text;
    turnState.hasVisibleOutput = true;
    providerTurnReducer?.apply({ type: "assistant-text-delta", text });
    events.emitTextDelta(text);
  }

  private isToolConcurrencySafe(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    return this.executionPolicy.resolveConcurrencySafe(toolName, input);
  }
}

/**
 * 从传入的请求指纹取稳定 id 字符串（{@link ProviderRequestFingerprint} 的 `id`），供 model span
 * 的 `requestFingerprint` 字段（与 context-replays 对齐）。类型是 `unknown`，非对象/无 id 返回 null。
 */
function readRequestFingerprintId(fingerprint: unknown): Nullable<string> {
  if (!isObject(fingerprint)) return null;
  const id = (fingerprint as { id?: unknown }).id;
  return isString(id) ? id : null;
}

export { StreamConsumer };
export type {
  ConsumeAssistantStreamArgs,
  InterruptedStreamPartial,
  StreamConsumerEvents,
  StreamConsumerToolExecutor,
  StreamConsumerTurnState,
};
export { StreamConsumer as AgentStreamConsumerHelper };
