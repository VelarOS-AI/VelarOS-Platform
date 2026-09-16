import type { TextStreamPart, ToolSet } from "ai";

import {
  isEmpty,
  toNullable,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import { logRuntime } from "@velaros-ai/core/logger";
import { TimerScope } from "@velaros-ai/core/utils/TimerScope";

import type { AssistantContentPart } from '../../types/history.js'
import type { ConsumeAssistantStreamArgs, InlineReasoningSegment, PendingStreamToolCall, ProviderToolInputDraft, ProviderToolNameResolution, StreamDiagnostics, StreamIdleThinkingNotifier } from '../../types/loop.js'
import type { ProviderTurnRecorder } from '../../types/records.js'
import type { ToolExecutionPolicyRegistry } from '../../types/tools.js'
import { appendStreamTextDelta, emitStreamUsageTelemetry } from '../../utils/loop/stream-consumer-emit'
import { normalizeModelRequestError } from "../../utils/model/model-request-error";
import {
  buildEmptyAssistantStreamError,
  shouldRecoverEmptyStreamAsContextPressure,
} from "../../utils/stream/empty-stream-recovery";
import {
  readGeneratedFilePayload,
  readSourcePayload,
} from "../../utils/stream/generated-artifacts";
import {
  readNextStreamPartWithIdleTimeout,
  returnStreamIteratorQuietly,
} from "../../utils/stream/idle-read";
import { createInlineReasoningTagSplitState, flushInlineReasoningTagTail, splitInlineReasoningTagDelta } from "../../utils/stream/inline-reasoning-tags";
import {
  createLeakedToolMarkupFilterState,
  filterLeakedToolMarkupDelta,
  flushLeakedToolMarkupTail,
} from "../../utils/stream/leaked-tool-markup";
import {
  createOutputTruncationError,
  isRecoverableOutputTruncationDiagnostic,
} from "../../utils/stream/output-truncation-recovery";
import { createProviderTurnToolCallIdAllocator } from "../../utils/stream/tool-call-id";
import { applyProviderToolInputStreamPart, buildToolInputReadyMetadata, diagnoseRejectedProviderToolInput, parseRecoverableProviderToolInputDraft, resolveProviderExecutableToolInput, resolveProviderFinalToolCallIdentity, summarizeProviderToolInputDraft } from "../../utils/stream/tool-input";
import { AgentTuning } from "../../utils/tuning";
import { ChatRuntimeEvents } from '../../utils/wire/chat-runtime.js'
import { createProviderToolReferenceCanonicalizer } from "../tools/ProviderToolReferenceCanonicalizer";
import { ToolExecutionPolicy } from "../tools/ToolExecutionPolicy";

import { recordKernelContextEpochDiagnostic } from "./KernelContextEpochGuard";
import { AgentStreamDiagnosticHelper } from "./StreamDiagnosticsHelper";

/**
 * 一次尝试的流消费状态：由 turn helper 在每次尝试前整体新建（不是复用后重置），
 * 交给 `consumeAssistantStream` 逐块就地写入，消费结束后由 turn helper 读出来组装本轮结果。
 *
 * 它同时是重试与恢复的判据来源：`RetryPolicy` 靠 hasVisibleOutput / hasToolUse 决定能不能重发，
 * 所以这份状态必须诚实反映「已经泼出去的水」——每次尝试整体新建正是为了让失败尝试的残留不误导下一次。
 */
interface StreamConsumerTurnState {
  /**
   * 面向界面的轮次计数轴；主 Agent 是确定 turn（number），子 Agent（QueryTurn 装配）没有 UI 轮次轴，
   * 传 null——telemetry / 日志 / 错误上下文一路容忍 nullable turn。
   */
  turn: Nullable<number>;
  /** 本轮是否接下过合法工具调用（含流结束后从草稿抢救出来的）。true 则本轮结果要走工具结果回填那条路。 */
  hasToolUse: boolean;
  /** 是否已有工具调用真的交给 ToolExecutor、可能产生副作用；运行时插话能否算「安全截断」看它。 */
  hasDispatchedToolUse?: boolean;
  /** 本轮累计的可见正文（过滤泄漏标记、抽走内联思考之后的净文本）；子 Agent 直接拿它当返回文本。 */
  accumulatedText: string;
  /** 本轮有没有产出过可见输出（正文、生成文件或已接受的工具调用）。它一旦为真，这次请求就不能重放。 */
  hasVisibleOutput: boolean;
  /** 本轮有没有向事件总线投过思考增量。思考不算可见答复：只出思考时要再要一次可见回答。 */
  hasReasoningOutput?: boolean;
  /** 供应方返回的真实输入 token 数（若有）；用于 MMU 用量校准反馈。 */
  inputTokens?: LooseOptional<number>;
  /**
   * 本回合的执行观测富化字段（#37 阶段 C 片 1）。供应方回合收敛时从 stream diagnostics /
   * 请求指纹取出，随 {@link StreamTurnResult} 交回 SoloLoop 挂到确定 turn 的 model span（D5），
   * 与既有 inputTokens 走同一条回传通道。缺席一律 null。
   */
  outputTokens?: LooseOptional<number>;
  /** 本轮的美元成本，来自网关回报；自建 provider 通常没有这笔账，缺席即 null。 */
  costUsd?: LooseOptional<number>;
  /** 推理 token（已含在 outputTokens 里）与输入里命中 / 写入缓存的部分：计价时按各自单价拆开算。 */
  reasoningTokens?: LooseOptional<number>;
  /** 输入里命中缓存的 token 数（便宜的那部分）。 */
  cacheReadInputTokens?: LooseOptional<number>;
  /** 输入里写入缓存的 token 数（首次建缓存要额外计价的那部分）。 */
  cacheWriteInputTokens?: LooseOptional<number>;
  /**
   * 供应方给的结束原因（取第一个，拿不到就退回 raw 里的那个）。与 usage 无关，所以在 usage 门之前就写：
   * 即便这一轮没有任何 token 回报，收敛态也要带着它，否则截断事故事后零痕迹。
   */
  finishReason?: LooseOptional<string>;
  /** 本次请求指纹的稳定 id；出事后按它把 model span、回合账本、上下文回放三处对上号。 */
  requestFingerprint?: LooseOptional<string>;
}

interface RejectedStreamToolCall {
  toolCallId: string;
  toolName: string;
  reason: string;
  receivedType: string;
  inputChars: number;
  diagnostic: ReturnType<typeof diagnoseRejectedProviderToolInput>;
}

/**
 * StreamConsumer — AI SDK `fullStream` 的消费者。
 *
 * 职责：把 `streamText` 返回的 `AsyncIterable<TextStreamPart>` 转换成
 *   1) 推送到 UI 的 textDelta / reasoningDelta 事件（通过 ExecutionEventBus），
 *   2) 推送到 ToolExecutor 的 tool-call（统一在这里通过 ToolExecutionPolicy 做参数校验和权限检查），
 *   3) 累积出 assistant 这一轮的 content parts，供 TurnHistory 写回 history。
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
export interface StreamConsumerApi {
  /**
   * 把一条 provider 流从头消费到尾：文本与思考增量投给事件总线、工具调用校验后排进
   * `args.executor`、用量与结束原因写进 `turnState`，最后返回本轮的 assistant 内容供上层写回历史。
   *
   * 全内核唯一的流消费引擎：主面（`StreamTurn`）与子 Agent 面（`QueryTurn`）共用它，
   * 差异只在装配（是否投影界面、turn 轴、空流来源标签），消费规则逐字一致。
   *
   * 什么时候返回、什么时候抛：
   *  - 正常收尾 → 返回 assistant 内容；期间每个分片都复核上下文纪元，被插队即抛陈旧错打断本轮。
   *  - 中断信号亮起 → 立刻停止消费并把已有内容收成 partial（不再推送任何界面事件）。
   *  - 工具参数不完整、流在工具可执行前结束、整条流没有可展示输出、上游 length 截断 →
   *    抛对应的 AppError，抛之前先经 `onInterruptedPartial` 把已产出的部分交出去，
   *    好让 turn helper 保住已展示的正文再去续写。
   */
  consumeAssistantStream(
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
    turnState: StreamConsumerTurnState,
    args: ConsumeAssistantStreamArgs,
  ): Promise<AssistantContentPart[]>
}

class StreamConsumer implements StreamConsumerApi {
  /** 内联 `<think>` 标签抽出来的思考增量共用同一个 reasoning stream id（相邻续写并成一块）。 */
  private static readonly InlineReasoningTagStreamId = "inline-think";
  /** 从 raw 分片兜底抽出的思考增量共用的 reasoning stream id（取值沿用历史）。 */
  private static readonly RawReasoningStreamId = "deepseek-reasoning";

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
      emitReasoningDelta(StreamConsumer.RawReasoningStreamId, text);
    };
    // 把可见正文里内联的 `<think>...</think>` 抽成 reasoning；没有标签时是纯透传。
    const inlineReasoningTagState = createInlineReasoningTagSplitState();
    const emitInlineReasoningDelta = (text: string): void => {
      if (!text) return;
      // 先把已缓冲的正文提交，保证 assistantContent 里 text/reasoning 顺序与流一致。
      flushCurrentText();
      // 刻意不置 hasVisibleOutput：与结构化 reasoning-delta 一致，纯思考无可见答复仍触发
      // 「补一个可见答复」的恢复逻辑。
      emitReasoningDelta(StreamConsumer.InlineReasoningTagStreamId, text);
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
        appendStreamTextDelta(
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
        const next = await readNextStreamPartWithIdleTimeout(streamIterator, {
          abortSignal: args.abortSignal,
          idleStallTimeoutMs: args.idleStallTimeoutMs,
          model: args.model,
          requestFingerprint: args.requestFingerprint,
          source: "stream-idle-stall",
          timerName: "StreamConsumer.idleStall",
          turn: turnState.turn,
        });
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
        const pendingToolCall: PendingStreamToolCall = {
          toolCallId,
          toolName,
          providerToolName: toolNameResolution.providerToolName,
          requestAdvertised: toolNameResolution.requestAdvertised,
          input,
        };
        if (streamedInput) {
          pendingToolCall.streamedInput = { inputText: streamedInput.inputText };
        }
        pendingToolCalls.push(pendingToolCall);
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
      emitStreamUsageTelemetry(diagnostics, turnState, args);
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
          emitStreamUsageTelemetry(diagnostics, turnState, args);
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
        emitStreamUsageTelemetry(diagnostics, turnState, args);
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
    emitStreamUsageTelemetry(diagnostics, turnState, args);
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

  private recordAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics,
    providerTurnReducer?: ProviderTurnRecorder,
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
      args.idleReconnectDelayMs ??
      AgentTuning.loop.streamIdleThinkingNoticeDelayMs;
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

  private isToolConcurrencySafe(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    return this.executionPolicy.resolveConcurrencySafe(toolName, input);
  }
}

export { StreamConsumer };
export type { StreamConsumerTurnState };
export { StreamConsumer as AgentStreamConsumerHelper };
