// 域：工具执行中枢（模型发出工具调用 → 结果回到历史之间的全部编排）。
//
// **为什么需要这份导览**：本文件同时是五条链的交汇点，任何一条读者都可能从别处跳进来——
// 并发编排 / 策略与审批门 / mod seam 派发 / 结果中间件与证据账本 / 观测 span。
// 五条互相有顺序要求，读单条会得出错误结论。
//
// ## 组织（读的顺序）
//  1. `PendingTool` / `ToolResult`：一次工具调用的全生命周期状态与其唯一出口形状；
//  2. `enqueue` 一族：流式片段一到就入队开跑（不等模型流收尾），并发安全者并行、有副作用者串行；
//  3. `runOne`：单次执行的**顺序契约**（见下）；
//  4. `finalizeResult`：**唯一终结点**——所有成功/失败/中止路径都必须经它收敛。
//
// ## 关键不变量（改这些会破什么）
//  - **`finalizeResult` 单点终结**：结果物化、span 收束、证据入账、事件发射都经它完成。
//    绕过它直接 return 结果 = span 泄漏 + 证据丢账 + 前端收不到终态。
//  - **扩展后处理保真**：执行完成后，中间件取消或失败保留原始回执；后处理失败另行终止执行链。
//  - **顺序：`tool-call:before` seam → 可用性/参数校验与去重 → 审批 → 执行**。seam 只能「拦下」或
//    「改写入参」，改写后的入参**照样走完整策略门**；把 seam 挪到门之后 = mod 可绕过审批。
//  - **结果按接收顺序输出**（不按完成顺序）：消息历史必须与模型看到的调用顺序一致，否则
//    下一轮上下文里工具结果与调用错位。
//  - **同轮失败即取消其余**：一个工具报错时同轮其他执行中的工具被取消，避免半成品副作用叠加。
//  - **span 是纯旁路**：观测失败不得冒泡进执行主路（端口缺省时 `spanHandle` 恒空）。
//
// 派发点与 seam 闭集见 `../mods/AgentModSeams.ts` 与 docs/agent-mod-trunk.md；
// 策略门与审批语义见 `./ExecutionPolicy.ts`。
import {
  type AgentEvent,
  type ChatRuntimeEvent,
  type StreamToolCallPayload,
  type StreamToolMetadataPayload,
  type StreamToolProgressPayload,
  type StreamToolResultEffects,
  type StreamToolResultPayload,
  type ToolResultModelContentPart,
} from "@velaros-ai/agent/protocol";
import {
  isArray,
  isEmpty,
  isPlainObject,
  isPresent,
  isString,
  isTrue,
  toNullable,
  toOptional,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import { logRuntime } from "@velaros-ai/core/logger";
import { TimerScope } from "@velaros-ai/core/utils/TimerScope";

import type { ContextPayloadStore } from "../agent/context/ContextPayloadStore";
import {
  resolveToolResultMiddlewares,
  type ToolResultMiddleware,
  type ToolResultModelImage,
} from "../capabilities";
import {
  completeProviderTurnSnapshot,
  ContextPayloadKernelToolOutputStore,
  type ExecutionSpanStatus,
  isKernelWriteLikeTool,
  type KernelToolFailureBatchEntry,
  KernelToolLoopGuard,
  type KernelToolOutputStore,
  KernelToolResultMaterializer,
  type ProviderTurnEventReducer,
  type ProviderTurnSnapshot,
  type ToolSpanHandle,
  type ToolSpanOpener,
} from "../kernel";
import type { AgentModSeamDispatcher } from "../mods/AgentModSeams";

import type {
  ToolExecutionPolicy,
  ToolExecutionPolicyContext,
  ToolExecutionPrepared,
  ToolFailureResult,
} from "./ExecutionPolicy";
import {
  buildToolFailureResult as buildStructuredToolFailureResult,
  type ToolFailureBuildOptions,
} from "./ExecutionPolicyFailures";
import { liftGenericModelContent } from "./modelImageLift";

const log = logRuntime.tag("ToolExecutor");
const ToolAbortSettlementGraceMs = 250;
const ToolCancelledByUserReason = "Cancelled by user";
const MaxConcurrentConcurrencySafeTools = 8;

interface ToolExecutorEvents {
  emitRuntime(event: ChatRuntimeEvent): void;
  emitNotice(event: Extract<AgentEvent, { type: "notice" }>): void;
  emitToolStart(payload: StreamToolCallPayload): void;
  emitToolProgress?(payload: StreamToolProgressPayload): void;
  emitToolMetadata?(payload: StreamToolMetadataPayload): void;
  emitToolDone(payload: StreamToolResultPayload): void;
}

interface ActiveToolExecutionContext {
  toolName: string;
  args: Record<string, unknown>;
  isConcurrencySafe: boolean;
  toolContext: ToolExecutionPolicyContext;
}

interface ToolExecutorPayloadContext {
  contextPayloadStore?: LooseOptional<ContextPayloadStore>;
}

interface ToolEffectiveAdmission {
  state: "pending" | "waiting" | "active" | "released";
  isConcurrencySafe?: boolean;
  resolve?: (admitted: boolean) => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export interface PendingTool {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 是否可与其他工具并发执行 */
  isConcurrencySafe: boolean;
  status: "queued" | "executing" | "done";
  promise?: Promise<ToolResult>;
  result?: ToolResult;
  /**
   * 本工具的观测 tool span handle（可选端口装配时才有；缺省 = 不产 span）。
   * 在 {@link ToolExecutor.runOne} 开工时开启，在 {@link ToolExecutor.finalizeResult}（唯一终结点）
   * 收敛后置空——单开单闭、纯旁路，span 失败不冒泡进执行主路。
   */
  spanHandle?: LooseOptional<ToolSpanHandle>;
}

interface ScheduledTool extends PendingTool {
  /** before/schema/surface normalize 后，按接收顺序授予的实际调用槽。 */
  effectiveAdmission: ToolEffectiveAdmission;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result: unknown;
  modelResult?: unknown;
  error?: string;
  modelContent?: ToolResultModelContentPart[];
  modelImage?: ToolResultModelImage;
  effects?: StreamToolResultEffects;
  notices?: Array<Extract<AgentEvent, { type: "notice" }>>;
}

type ToolExecutionSettlement =
  | { status: "completed"; result: ToolResult }
  | { status: "failed"; error: unknown }
  | { status: "aborted" };

/**
 * 工具执行编排器。
 *
 * 核心思路：
 * 1. 工具调用片段进入流时立即开始执行，不等待模型流结束
 * 2. 标记为并发安全的工具之间可以并行
 * 3. 有副作用的工具必须串行执行
 * 4. 结果按工具接收顺序输出，保证消息历史一致性
 * 5. 某个工具出错时，取消其他正在执行的同轮工具
 */
export class ToolExecutor {
  private readonly tools: ScheduledTool[] = [];
  private readonly ctx: ToolExecutionPolicyContext;
  private readonly events: ToolExecutorEvents;
  private siblingAbort: AbortController;
  private siblingErrored = false;
  private siblingErrorName = "";
  private terminalError: LooseOptional<AppError> = null;
  private readonly executionPolicy: ToolExecutionPolicy;
  private readonly resultMiddlewares: ReadonlyArray<ToolResultMiddleware<any>>;
  private readonly materializer: KernelToolResultMaterializer;
  private readonly loopGuard: KernelToolLoopGuard;
  private failureBatchResultCursor = 0;
  private providerTurnReducer: LooseOptional<ProviderTurnEventReducer>;
  private onProviderTurnSnapshot: LooseOptional<
    (snapshot: ProviderTurnSnapshot) => void
  >;
  private providerTurnSnapshotEmitted = false;
  /**
   * 可选观测 span 开启器（D6 端口纪律）——注入时每次 {@link runOne} 开一条 tool span，
   * 缺省 no-op（web 桥/子 Agent 零观测零付费）。span 发射是纯旁路，端口内部已隔离失败。
   */
  private readonly toolSpanOpener: LooseOptional<ToolSpanOpener>;
  /**
   * 可选 mod 拦截 seam 派发器（裁决 9 机制②）——注入时在调用前/结果后各派发一次；
   * 缺省 null → 全链 no-op。钩子只能拦下或改写，**不能放行**被策略门拒绝的调用：
   * 入参改写发生在 {@link ToolExecutionPolicy.prepareExecution} 之前，改写后照样过完整策略门。
   */
  private readonly seams: LooseOptional<AgentModSeamDispatcher>;

  constructor(
    ctx: ToolExecutionPolicyContext,
    events: ToolExecutorEvents,
    executionPolicy: ToolExecutionPolicy,
    options: {
      providerTurnReducer?: LooseOptional<ProviderTurnEventReducer>;
      onProviderTurnSnapshot?: LooseOptional<
        (snapshot: ProviderTurnSnapshot) => void
      >;
      outputStore?: LooseOptional<KernelToolOutputStore>;
      loopGuard?: KernelToolLoopGuard;
      toolSpanOpener?: LooseOptional<ToolSpanOpener>;
      seams?: LooseOptional<AgentModSeamDispatcher>;
    } = {},
  ) {
    this.ctx = ctx;
    this.events = events;
    this.executionPolicy = executionPolicy;
    this.loopGuard = options.loopGuard ?? new KernelToolLoopGuard();
    this.toolSpanOpener = toNullable(options.toolSpanOpener);
    this.seams = toNullable(options.seams);
    this.resultMiddlewares = resolveToolResultMiddlewares(
      this.ctx.capabilityPorts,
    );
    this.providerTurnReducer = toNullable(options.providerTurnReducer);
    this.onProviderTurnSnapshot = toNullable(options.onProviderTurnSnapshot);
    this.materializer = new KernelToolResultMaterializer({
      outputStore:
        toNullable(options.outputStore) ??
        this.createContextPayloadOutputStore(),
    });
    // 当某个工具出错时只取消兄弟工具，不影响整个 agent
    this.siblingAbort = new AbortController();
  }

  public configureProviderTurnReducer(
    input: ProviderTurnEventReducer,
    onSnapshot?: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>,
  ): void {
    this.providerTurnReducer = input;
    this.providerTurnSnapshotEmitted = false;
    if (onSnapshot) {
      this.onProviderTurnSnapshot = onSnapshot;
    }
  }

  /**
   * 注册一个工具并立即尝试执行
   */
  public enqueue(
    toolCallId: string,
    toolName: string,
    args: LooseOptional<Record<string, unknown>>,
    isConcurrencySafe: boolean,
    authorization?: {
      requestAdvertised: boolean;
      providerToolName: string;
    },
  ): void {
    // tool-call 从模型流进入这里；并发安全工具可并行，有副作用工具排队串行。
    const canonicalToolName = this.executionPolicy.resolveCanonicalToolName(
      toolName,
      this.ctx.capabilityPorts,
      this.ctx,
    );
    const providerArgs = this.readProviderToolArgs(canonicalToolName, args);
    const pendingArgs = providerArgs.ok ? providerArgs.args : {};
    const canonicalConcurrencySafe = !providerArgs.ok
      ? false
      : canonicalToolName === toolName
        ? isConcurrencySafe
        : this.executionPolicy.resolveConcurrencySafe(
            canonicalToolName,
            pendingArgs,
          );
    const pending: ScheduledTool = {
      toolCallId,
      toolName: canonicalToolName,
      args: pendingArgs,
      isConcurrencySafe: canonicalConcurrencySafe,
      effectiveAdmission: { state: "pending" },
      status: "queued",
    };
    this.tools.push(pending);
    if (authorization && !authorization.requestAdvertised) {
      const reason = `模型返回了本轮未发布的工具「${authorization.providerToolName}」，调用已在执行前拒绝。`;
      pending.status = "executing";
      pending.promise = this.finalizeResult(pending, {
        toolCallId,
        toolName: canonicalToolName,
        args: pendingArgs,
        error: reason,
        result: this.executionPolicy.buildBlockedFailureResult(
          canonicalToolName,
          reason,
          this.ctx,
        ),
      }).finally(() => {
        this.releaseEffectiveAdmission(pending);
        pending.status = "done";
        this.drainQueue();
      });
      return;
    }
    if (!providerArgs.ok) {
      pending.status = "executing";
      pending.promise = this.finalizeResult(pending, {
        toolCallId,
        toolName: canonicalToolName,
        args: pendingArgs,
        error: providerArgs.reason,
        result: providerArgs.result,
      }).finally(() => {
        this.releaseEffectiveAdmission(pending);
        pending.status = "done";
        this.drainQueue();
      });
      return;
    }
    const unavailableDecision =
      this.executionPolicy.prepareUnavailableExecution({
        toolCallId,
        toolName: canonicalToolName,
        args: pendingArgs,
        baseContext: this.ctx,
        abortSignal: this.ctx.abortSignal,
        emitProgress: (chunk) => this.emitToolProgress(toolCallId, chunk),
        updateMetadata: (payload) => this.emitToolMetadata(toolCallId, payload),
      });
    if (unavailableDecision) {
      const executionToolName =
        unavailableDecision.toolName ?? canonicalToolName;
      pending.status = "executing";
      pending.promise = this.finalizeResult(pending, {
        toolCallId,
        toolName: executionToolName,
        args: pendingArgs,
        error: unavailableDecision.error,
        result: this.executionPolicy.buildBlockedFailureResult(
          executionToolName,
          unavailableDecision.error,
          this.ctx,
        ),
      }).finally(() => {
        this.releaseEffectiveAdmission(pending);
        pending.status = "done";
        this.drainQueue();
      });
      return;
    }
    this.drainQueue();
  }

  /**
   * 等待所有未完成的工具执行完毕，按顺序收集结果
   */
  public async collectAll(): Promise<ToolResult[]> {
    // 本轮 stream 结束后等待所有工具收敛，结果按接收顺序返回给 history。
    while (this.hasPending) {
      this.drainQueue();
      const promises = this.tools
        .filter((tool) => tool.status === "executing" && tool.promise)
        .map((tool) => tool.promise!);
      if (isEmpty(promises)) {
        // 不变量：只要 hasPending=true，drainQueue 之后必定有处于 executing 的工具
        // （否则就一直没人会 done）。走到这里意味着调度器/canRun 出现 bug，例如
        // 队列里全是 unsafe 但被自己阻塞、或某轮 race 条件导致 promise 字段被清空。
        // 静默 break 会带着只完成一半的 tool-result 写回 history，破坏 tool-call/result 配对，
        // 因此宁可显式抛出让上层把这一轮判为失败，也不要让历史悄悄半截。
        const queuedTools = this.tools
          .filter((t) => t.status === "queued")
          .map((t) => ({ name: t.toolName, safe: t.isConcurrencySafe }));
        log.error("工具收集不变量被破坏：存在待处理工具但没有执行中的工具", {
          queued: queuedTools,
          totalTools: this.tools.length,
          completedTools: this.tools.filter((t) => t.status === "done").length,
        });
        throw new AppError(
          "TOOL_INVARIANT",
          "ToolExecutor 调度异常：还有等待中的工具但调度器没启动任何 promise；终止本轮以避免历史损坏。",
          undefined,
          { queuedToolCount: queuedTools.length },
        );
      }

      const settlements = await Promise.allSettled(promises);
      for (const settlement of settlements) {
        if (settlement.status === "rejected") {
          this.terminalError ??= AppError.from(settlement.reason);
          log.error("tool settlement failed", { error: AppError.getMessage(settlement.reason) });
        }
      }
    }

    const results = this.tools
      .filter((t) => isPresent(t.result))
      .map((t) => t.result!);
    if (results.length !== this.tools.length) {
      throw this.terminalError ?? new AppError(
        "TOOL_INVARIANT",
        "Tool settlement completed without a result for every accepted call.",
      );
    }
    this.applyRepeatedFailureBatchGuard(results);
    this.emitProviderTurnSnapshot();
    return results;
  }

  /** 返回本轮工具执行过程中记录的终止错误。 */
  public getTerminalError(): LooseOptional<AppError> {
    return this.terminalError;
  }

  /** 是否还有未完成的工具 */
  get hasPending(): boolean {
    return this.tools.some((t) => t.status !== "done");
  }

  // ─── 内部 ───────────────────────────────────────────────────────────────────

  private drainQueue(): void {
    while (true) {
      const next = this.tools.find((tool) => tool.status === "queued");
      if (!next) return;

      if (!this.canPrepare()) return;

      this.execute(next);
    }
  }

  private canPrepare(): boolean {
    const executing = this.tools.filter((t) => t.status === "executing");
    return executing.length < MaxConcurrentConcurrencySafeTools;
  }

  private execute(tool: ScheduledTool): void {
    tool.status = "executing";

    tool.promise = this.runOne(tool).finally(() => {
      this.releaseEffectiveAdmission(tool);
      tool.status = "done";
      // 有工具完成后尝试推进队列
      this.drainQueue();
    });
  }

  private async runOne(tool: ScheduledTool): Promise<ToolResult> {
    if (this.siblingErrored && this.siblingAbort.signal.aborted) {
      const reason = `Cancelled: sibling tool "${this.siblingErrorName}" failed`;
      return this.finalizeResult(tool, {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        error: reason,
        result: this.buildToolFailureResult(
          "tool_cancelled",
          reason,
          tool.toolName,
        ),
      });
    }

    if (this.ctx.abortSignal.aborted) {
      const reason = ToolCancelledByUserReason;
      return this.finalizeResult(tool, {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        error: reason,
        result: this.buildToolFailureResult(
          "tool_cancelled",
          reason,
          tool.toolName,
        ),
      });
    }

    const startedAt = Date.now();
    // 每个工具独立的 AbortController（可被 sibling cancel）
    const toolAbort = new AbortController();
    const parentOff = () => toolAbort.abort("parent");
    const siblingOff = () => toolAbort.abort("sibling");
    this.ctx.abortSignal.addEventListener("abort", parentOff, { once: true });
    this.siblingAbort.signal.addEventListener("abort", siblingOff, {
      once: true,
    });

    let result: ToolResult;
    let activeExecutionContext: LooseOptional<ActiveToolExecutionContext> =
      null;
    try {
      // mod 接缝：调用前派发（策略门之前）。拦下走与其他失败同构的结构化失败结果；
      // 入参改写只是替换 tool.args，后续可用性、参数校验、去重与审批一条不少。
      if (this.seams?.has("tool-call:before")) {
        const outcome = await this.seams.dispatchToolCallBefore({
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          args: tool.args,
          sessionId: this.readSessionId(),
        });
        if (toolAbort.signal.aborted) {
          const reason = this.resolveAbortSettlementReason();
          return await this.finalizeResult(tool, {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            error: reason,
            result: this.buildToolFailureResult("tool_cancelled", reason, tool.toolName),
          });
        }
        if (outcome.args) tool.args = outcome.args;
        if (outcome.block) {
          const reason = outcome.block.reason;
          return await this.finalizeResult(tool, {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            error: reason,
            result: this.buildToolFailureResult(
              "tool_blocked",
              reason,
              tool.toolName,
            ),
          });
        }
      }

      log.info("tool execute start", {
        name: tool.toolName,
        id: tool.toolCallId,
      });

      // 观测接缝：本工具真正进入执行时开一条 tool span（收敛在唯一终结点 finalizeResult）。
      // 端口缺省 → null → 全链 no-op；toolCategoryId 从执行策略注册表查（#37 阶段 C 片 1，未知用 null）。
      tool.spanHandle = toNullable(
        this.toolSpanOpener?.beginToolSpan({
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          toolCategoryId: toNullable(
            this.executionPolicy.getToolCategoryId(tool.toolName),
          ),
          toolEffectKind: toNullable(
            this.executionPolicy.getToolEffectKind(tool.toolName),
          ),
        }),
      );

      // 执行工具前先做权限、参数和可执行性检查；失败也作为 tool result 返回模型。
      const decision = this.executionPolicy.prepareExecution({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: tool.args,
        baseContext: this.ctx,
        abortSignal: toolAbort.signal,
        emitProgress: (chunk) => this.emitToolProgress(tool.toolCallId, chunk),
        updateMetadata: (payload) =>
          this.emitToolMetadata(tool.toolCallId, payload),
      });
      if (!decision.allowed) {
        const executionToolName = decision.toolName ?? tool.toolName;
        log.warn("tool execute end", {
          name: executionToolName,
          id: tool.toolCallId,
          status: "blocked",
          durationMs: Date.now() - startedAt,
        });
        return await this.finalizeResult(tool, {
          toolCallId: tool.toolCallId,
          toolName: executionToolName,
          error: decision.error,
          result: this.executionPolicy.buildBlockedFailureResult(
            executionToolName,
            decision.error,
            this.ctx,
          ),
        });
      }

      const executionToolName = decision.prepared.toolName;
      const effectiveArgs = decision.prepared.effectiveArgs ?? tool.args ?? {};
      const effectiveConcurrencySafe = this.executionPolicy.resolveConcurrencySafe(
        executionToolName,
        effectiveArgs,
        tool.isConcurrencySafe,
      );
      tool.isConcurrencySafe = effectiveConcurrencySafe;
      const admitted = await this.acquireEffectiveAdmission(
        tool,
        effectiveConcurrencySafe,
        toolAbort.signal,
      );
      if (!admitted) {
        const reason = this.resolveAbortSettlementReason();
        return await this.finalizeResult(tool, {
          toolCallId: tool.toolCallId,
          toolName: executionToolName,
          args: effectiveArgs,
          error: reason,
          result: this.buildToolFailureResult(
            "tool_cancelled",
            reason,
            executionToolName,
          ),
        });
      }
      const revalidationError = this.executionPolicy.revalidatePreparedExecution(
        decision.prepared,
        effectiveArgs,
      );
      if (revalidationError) {
        log.warn("tool execute end", {
          name: executionToolName,
          id: tool.toolCallId,
          status: "blocked",
          reason: "effective_admission_revalidation",
          durationMs: Date.now() - startedAt,
        });
        return await this.finalizeResult(tool, {
          toolCallId: tool.toolCallId,
          toolName: executionToolName,
          args: effectiveArgs,
          error: revalidationError,
          result: this.executionPolicy.buildBlockedFailureResult(
            executionToolName,
            revalidationError,
            this.ctx,
          ),
        });
      }
      const writeLike = isKernelWriteLikeTool({
        toolName: executionToolName,
        args: effectiveArgs,
        permissions: decision.prepared.tool.permissions,
        capabilities: decision.prepared.tool.capabilities,
      });
      const loopGuardMessage = this.loopGuard.checkRepeatedWriteLikeSuccess({
        toolName: executionToolName,
        args: effectiveArgs,
        writeLike,
      });
      if (loopGuardMessage) {
        log.warn("tool execute end", {
          name: executionToolName,
          id: tool.toolCallId,
          status: "blocked",
          reason: "tool_loop_guard",
          durationMs: Date.now() - startedAt,
        });
        return await this.finalizeResult(tool, {
          toolCallId: tool.toolCallId,
          toolName: executionToolName,
          args: effectiveArgs,
          error: loopGuardMessage,
          result: this.buildToolFailureResult(
            "tool_loop_guard",
            loopGuardMessage,
            executionToolName,
          ),
        });
      }

      // 工具函数在这里被调用；输出通过 emitToolDone 通知宿主，并在外层追加进下一轮模型 history。
      activeExecutionContext = {
        toolName: executionToolName,
        args: effectiveArgs,
        isConcurrencySafe: tool.isConcurrencySafe,
        toolContext: decision.prepared.toolContext,
      };
      result = await this.executePreparedToolWithAbortSettlement(
        tool,
        decision.prepared,
        tool.args,
        executionToolName,
        toolAbort.signal,
      );
      if (!result.error) {
        this.loopGuard.recordSuccess({
          toolName: executionToolName,
          args: effectiveArgs,
          writeLike,
        });
      }
      const status = result.error ? "error" : "completed";
      const logEnd = result.error ? log.warn.bind(log) : log.info.bind(log);
      logEnd("tool execute end", {
        name: tool.toolName,
        id: tool.toolCallId,
        status,
        error: toOptional(result.error),
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const appError = this.buildExecutionAppError(
        err,
        activeExecutionContext?.toolContext,
      );
      // 把工具失败回灌到 coding session：这样 deduper 能识别"模型忽视 hint 反复
      // 撞同样错误"的模式，下次同参数重试时直接拦截升级提示，省掉一次内核往返。
      this.applyExecutionFailureSideEffects({
        toolName: activeExecutionContext?.toolName ?? tool.toolName,
        args: activeExecutionContext?.args ?? tool.args,
        isConcurrencySafe:
          activeExecutionContext?.isConcurrencySafe ?? tool.isConcurrencySafe,
        toolContext: activeExecutionContext?.toolContext,
        error: appError,
      });
      const failureResult = this.executionPolicy.buildExecutionFailureResult(
        activeExecutionContext?.toolName ?? tool.toolName,
        appError,
      );
      result = {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: activeExecutionContext?.args ?? tool.args,
        result: failureResult,
        error: appError.message,
      };

      log.warn("tool execute end", {
        name: tool.toolName,
        id: tool.toolCallId,
        status: "error",
        code: failureResult.code ?? appError.code,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.ctx.abortSignal.removeEventListener("abort", parentOff);
      this.siblingAbort.signal.removeEventListener("abort", siblingOff);
    }

    return this.finalizeResult(tool, result);
  }

  /**
   * before/schema/surface normalize 完成后才进入实际调用门。门按 tool 接收顺序折叠：
   * safe 共享最多 8 个槽，unsafe 独占；更早但尚未准备完成的调用会阻止后来者越序。
   */
  private acquireEffectiveAdmission(
    tool: ScheduledTool,
    isConcurrencySafe: boolean,
    abortSignal: AbortSignal,
  ): Promise<boolean> {
    const admission = tool.effectiveAdmission;
    admission.isConcurrencySafe = isConcurrencySafe;
    if (abortSignal.aborted) {
      admission.state = "released";
      this.drainEffectiveAdmissions();
      return Promise.resolve(false);
    }

    admission.state = "waiting";
    return new Promise<boolean>((resolve) => {
      const abortListener = () => {
        if (admission.state !== "waiting") return;
        admission.state = "released";
        abortSignal.removeEventListener("abort", abortListener);
        admission.resolve = undefined;
        admission.abortSignal = undefined;
        admission.abortListener = undefined;
        resolve(false);
        this.drainEffectiveAdmissions();
      };
      admission.resolve = resolve;
      admission.abortSignal = abortSignal;
      admission.abortListener = abortListener;
      abortSignal.addEventListener("abort", abortListener, { once: true });
      this.drainEffectiveAdmissions();
    });
  }

  private drainEffectiveAdmissions(): void {
    let activeCount = 0;
    let activeExclusive = false;
    for (const tool of this.tools) {
      const admission = tool.effectiveAdmission;
      if (admission.state !== "active") continue;
      activeCount += 1;
      if (!isTrue(admission.isConcurrencySafe)) activeExclusive = true;
    }

    for (const tool of this.tools) {
      const admission = tool.effectiveAdmission;
      if (admission.state === "released" || admission.state === "active") continue;
      if (admission.state === "pending") return;

      const canAdmit = activeCount === 0 || (
        isTrue(admission.isConcurrencySafe)
        && !activeExclusive
        && activeCount < MaxConcurrentConcurrencySafeTools
      );
      if (!canAdmit) return;

      admission.state = "active";
      if (
        isPresent(admission.abortSignal)
        && isPresent(admission.abortListener)
      ) {
        admission.abortSignal.removeEventListener(
          "abort",
          admission.abortListener,
        );
      }
      const resolve = admission.resolve;
      admission.resolve = undefined;
      admission.abortSignal = undefined;
      admission.abortListener = undefined;
      activeCount += 1;
      if (!isTrue(admission.isConcurrencySafe)) activeExclusive = true;
      resolve?.(true);
      if (activeExclusive) return;
    }
  }

  private releaseEffectiveAdmission(tool: ScheduledTool): void {
    const admission = tool.effectiveAdmission;
    if (admission.state === "released") return;
    if (
      isPresent(admission.abortSignal)
      && isPresent(admission.abortListener)
    ) {
      admission.abortSignal.removeEventListener(
        "abort",
        admission.abortListener,
      );
    }
    if (admission.state === "waiting") admission.resolve?.(false);
    admission.state = "released";
    admission.resolve = undefined;
    admission.abortSignal = undefined;
    admission.abortListener = undefined;
    this.drainEffectiveAdmissions();
  }

  private emitToolProgress(toolCallId: string, chunk: string): void {
    emitToolProgressEvent(this.events, toolCallId, chunk);
  }

  private emitToolMetadata(
    toolCallId: string,
    payload: { title?: string; metadata?: Record<string, unknown> },
  ): void {
    emitToolMetadataEvent(this.events, toolCallId, payload);
  }

  private buildExecutionAppError(
    error: unknown,
    _toolContext?: LooseOptional<ToolExecutionPolicyContext>,
  ): AppError {
    return AppError.from(error);
  }

  private applyExecutionFailureSideEffects(input: {
    toolName: string;
    args: Record<string, unknown>;
    isConcurrencySafe: boolean;
    toolContext?: LooseOptional<ToolExecutionPolicyContext>;
    error: AppError;
  }): LooseOptional<AppError> {
    // 有副作用的工具出错时广播取消兄弟工具
    if (
      this.executionPolicy.shouldAbortSiblings({
        toolName: input.toolName,
        error: input.error,
        isConcurrencySafe: input.isConcurrencySafe,
      })
    ) {
      this.siblingErrored = true;
      this.siblingErrorName = input.toolName;
      this.siblingAbort.abort("sibling_error");
    }

    const terminalError = this.executionPolicy.isTerminalExecutionError(
      input.error,
    )
      ? input.error
      : null;
    if (terminalError && !this.terminalError) {
      this.terminalError = terminalError;
    }
    // 终止级别错误（用户拒绝确认 / EXECUTION_ABORTED 等）必须立刻取消所有兄弟工具：
    // shouldAbortSiblings 可能因为 isConcurrencySafe 等启发式条件返回 false，
    // 但终止类错误一旦出现就不应再让其他工具继续跑下去。
    if (terminalError && !this.siblingAbort.signal.aborted) {
      this.siblingErrored = true;
      this.siblingErrorName = input.toolName;
      this.siblingAbort.abort("terminal_error");
    }

    return terminalError;
  }

  private async executePreparedTool(
    tool: ScheduledTool,
    prepared: ToolExecutionPrepared,
    args: LooseOptional<Record<string, unknown>>,
    toolName: string,
    abortSignal: AbortSignal,
    onOperationCompleted: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const effectiveArgs = prepared.effectiveArgs ?? args ?? {};
    const output = await this.executionPolicy.executePrepared(
      prepared,
      args,
      toolName,
    );
    const completedOperationResult: ToolResult = {
      toolCallId: tool.toolCallId,
      toolName,
      args: effectiveArgs,
      result: output,
    };
    // 扩展中间件只负责后处理；取消等待不能抹掉执行器已经返回的真实回执。
    onOperationCompleted(completedOperationResult);
    let enhanced = completedOperationResult;
    try {
      for (const middleware of this.resultMiddlewares) {
        if (abortSignal.aborted) break;
        const context = {
          toolCallId: tool.toolCallId,
          toolName,
          args: effectiveArgs,
          result: enhanced.result,
          executionContext: this.ctx,
        };
        if (middleware.matches && !middleware.matches(context)) continue;
        if (abortSignal.aborted) break;
        const transformed = await middleware.transform(context);
        // 迟到的扩展结果不再覆盖本次回执，也不能启动后续中间件。
        if (abortSignal.aborted) break;
        if (!transformed) continue;
        const middlewareModelContent = [...(transformed.modelContent ?? [])];
        if (
          transformed.modelImage &&
          ![...(enhanced.modelContent ?? []), ...middlewareModelContent].some(
            (part) =>
              part.type === "image-data" &&
              part.data === transformed.modelImage?.data &&
              part.mediaType === transformed.modelImage.mediaType,
          )
        ) {
          middlewareModelContent.push({
            type: "image-data",
            data: transformed.modelImage.data,
            mediaType: transformed.modelImage.mediaType,
          });
        }
        enhanced = {
          ...enhanced,
          result: transformed.result,
          modelContent: !isEmpty(middlewareModelContent)
            ? [...(enhanced.modelContent ?? []), ...middlewareModelContent]
            : enhanced.modelContent,
          modelImage: transformed.modelImage ?? enhanced.modelImage,
          effects: transformed.effects ?? enhanced.effects,
          notices: [...(enhanced.notices ?? []), ...(transformed.notices ?? [])],
        };
      }
      const result = abortSignal.aborted ? completedOperationResult : enhanced;
      return liftGenericModelContent(result, result.result);
    } catch (error) {
      if (abortSignal.aborted)
        return liftGenericModelContent(
          completedOperationResult,
          completedOperationResult.result,
        );
      const finalizationError = new AppError(
        "TOOL_RESULT_FINALIZATION_FAILED",
        `Tool result finalization failed for "${toolName}". The operation may already have taken effect; inspect its state before retrying.`,
        error,
      );
      this.applyExecutionFailureSideEffects({
        toolName,
        args: effectiveArgs,
        isConcurrencySafe: tool.isConcurrencySafe,
        toolContext: prepared.toolContext,
        error: finalizationError,
      });
      log.error("tool result middleware failed", {
        toolCallId: tool.toolCallId,
        toolName,
        error: AppError.getMessage(error),
      });
      return liftGenericModelContent(
        completedOperationResult,
        completedOperationResult.result,
      );
    }
  }

  private async executePreparedToolWithAbortSettlement(
    tool: ScheduledTool,
    prepared: ToolExecutionPrepared,
    args: LooseOptional<Record<string, unknown>>,
    toolName: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    const operation: { result: Nullable<ToolResult> } = { result: null };
    const execution = this.executePreparedTool(
      tool,
      prepared,
      args,
      toolName,
      abortSignal,
      (result) => { operation.result = result; },
    ).then(
      (result): ToolExecutionSettlement => ({ status: "completed", result }),
      (error): ToolExecutionSettlement => ({ status: "failed", error }),
    );
    const abortSettlement = this.createAbortSettlement(abortSignal);

    try {
      const settlement = await Promise.race([
        execution,
        abortSettlement.promise,
      ]);
      switch (settlement.status) {
        case "completed":
          return settlement.result;
        case "failed":
          throw settlement.error;
        case "aborted": {
          if (operation.result)
            return liftGenericModelContent(
              operation.result,
              operation.result.result,
            );
          const reason = this.resolveAbortSettlementReason();
          log.warn("tool ignored abort; settling as cancelled", {
            name: toolName,
            id: tool.toolCallId,
            graceMs: ToolAbortSettlementGraceMs,
            reason,
          });
          return {
            toolCallId: tool.toolCallId,
            toolName,
            args: prepared.effectiveArgs ?? args ?? {},
            error: reason,
            result: this.buildToolFailureResult(
              "tool_cancelled",
              reason,
              toolName,
              {
                details: {
                  graceMs: ToolAbortSettlementGraceMs,
                },
              },
            ),
          };
        }
      }
    } finally {
      abortSettlement.cleanup();
    }
  }

  private createAbortSettlement(abortSignal: AbortSignal): {
    promise: Promise<ToolExecutionSettlement>;
    cleanup: () => void;
  } {
    const timers = new TimerScope({ name: "ToolExecutor.abortSettlement" });
    let onAbort: Nullable<() => void> = null;
    let cleaned = false;
    const promise = new Promise<ToolExecutionSettlement>((resolve) => {
      const scheduleSettlement = (): void => {
        if (cleaned) return;

        timers.after(
          ToolAbortSettlementGraceMs,
          () => resolve({ status: "aborted" }),
          {
            label: "ToolExecutor.abortSettlement.grace",
          },
        );
      };

      if (abortSignal.aborted) {
        scheduleSettlement();
        return;
      }

      onAbort = scheduleSettlement;
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });

    return {
      promise,
      cleanup: () => {
        cleaned = true;
        if (onAbort) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        timers.dispose();
      },
    };
  }

  private resolveAbortSettlementReason(): string {
    if (this.siblingErrored && this.siblingAbort.signal.aborted)
      return `Cancelled: sibling tool "${this.siblingErrorName}" failed`;

    return ToolCancelledByUserReason;
  }

  private async finalizeResult(
    tool: ScheduledTool,
    result: ToolResult,
  ): Promise<ToolResult> {
    try {
      return await this.materializeResult(tool, result);
    } catch (error) {
      const reason = `Tool result finalization failed for "${result.toolName}". The operation may already have taken effect; inspect its state before retrying.`;
      this.terminalError ??= new AppError("TOOL_RESULT_FINALIZATION_FAILED", reason, error);
      this.siblingErrored = true;
      this.siblingErrorName = result.toolName;
      this.siblingAbort.abort("result_finalization_failed");
      log.error("tool result finalization failed", {
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        error: AppError.getMessage(error),
      });
      // A publisher may throw after committing the result. Keep that result and
      // let the history owner terminate the run through getTerminalError().
      if (tool.result) return tool.result;

      const failure = this.buildToolFailureResult(
        "tool_result_finalization_failed", reason, result.toolName,
        { details: { executionError: toNullable(result.error) } },
      );
      const fallback: ToolResult = {
        ...result,
        args: result.args ?? tool.args,
        error: reason,
        result: failure,
        modelResult: failure,
      };
      tool.result = fallback;
      try {
        this.endToolSpan(tool, fallback);
        this.settleProviderTurnTool(fallback);
        this.events.emitToolDone({
          toolCallId: fallback.toolCallId,
          result: failure,
          error: reason,
          effects: result.effects,
        });
      } catch (publishError) {
        log.error("tool finalization failure notification failed", {
          toolCallId: result.toolCallId,
          error: AppError.getMessage(publishError),
        });
      }
      return fallback;
    }
  }

  private async materializeResult(
    tool: ScheduledTool,
    result: ToolResult,
  ): Promise<ToolResult> {
    const effectiveArgs = result.args ?? tool.args;
    // mod 接缝：结果收敛派发（物化之前）。放在物化前是为了让改写后的结果与
    // displayResult / modelResult 全链保持同源，不出现「模型看到 A、UI 看到 B」。
    if (this.seams?.has("tool-result:after")) {
      const outcome = await this.seams.dispatchToolResultAfter({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        args: effectiveArgs,
        result: result.result,
        error: toNullable(result.error),
        sessionId: this.readSessionId(),
      });
      if ("result" in outcome) result.result = outcome.result;
      if (isString(outcome.error)) result.error = outcome.error;
    }

    // 提取 capability notice（嵌在结果里）、
    const materialized = await this.materializer.materialize({
      sessionId: this.readSessionId(),
      localInstructionClaimScope: this.providerTurnReducer?.snapshot().turnId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      args: effectiveArgs,
      result: result.result,
      error: result.error,
      effects: result.effects,
      notices: result.notices,
      // 发现/索引类工具（如 tooling:map）声明 outputInline：输出禁止 page-out，
      // 否则模型拿到的是 __kernelRef 桩、还得 context:recall 召回，自我抵消。
      keepOutputInline: this.executionPolicy.isToolOutputInline(
        result.toolName,
      ),
    });

    // 推送结果对象里提取出来的 notice 事件
    for (const notice of materialized.notices) {
      this.events.emitNotice(notice);
    }

    // capability-auto-approval notice 由 CodingSessionTracker 持有，不嵌在工具结果里；
    // 在此消费并独立推送，整会话只触发一次
    if (!result.error) {
      const capNotice = this.executionPolicy.consumePendingAutoApprovalNotice(
        result.toolName,
        this.ctx,
      );
      if (capNotice) {
        this.events.emitNotice({
          type: "notice",
          kind: "capability-auto-approval",
          payload: capNotice,
        });
      }
    }

    const finalResult: ToolResult = {
      ...result,
      args: effectiveArgs,
      result: materialized.displayResult,
      modelResult: materialized.modelResult,
    };
    tool.result = finalResult;
    // 唯一终结点收敛 tool span：所有终结路径（sibling/abort/blocked/loop-guard/正常/异常）都汇到此。
    // 用未物化的原始 result 派生状态/错误码（结构化失败码在 result.result.error），收敛后置空 handle，
    // 纵使某路径二次 finalize 也不会双闭（防双计时/双落盘）。
    this.endToolSpan(tool, result);
    this.settleProviderTurnTool(finalResult);

    this.events.emitToolDone({
      toolCallId: finalResult.toolCallId,
      result: finalResult.result,
      error: finalResult.error,
      effects: materialized.effects,
      modelImage: finalResult.modelImage
        ? {
            data: finalResult.modelImage.data,
            mediaType: finalResult.modelImage.mediaType,
          }
        : undefined,
      modelContent: finalResult.modelContent,
    });
    return finalResult;
  }

  /** 收敛一条 tool span（唯一终结点调用；无 handle 直接跳过，端口内部已隔离失败）。 */
  private endToolSpan(tool: ScheduledTool, result: ToolResult): void {
    const handle = tool.spanHandle;
    if (!handle) return;
    tool.spanHandle = null;
    const errorCode = this.readToolSpanErrorCode(result);
    const status: ExecutionSpanStatus = !result.error
      ? "ok"
      : errorCode === "tool_cancelled"
        ? "aborted"
        : "error";
    handle.end({ status, errorCode });
  }

  /** 从结果派生 tool span 结构化错误码（成功 null；取结构化失败的 error 码，否则兜 'ERROR'）。 */
  private readToolSpanErrorCode(result: ToolResult): Nullable<string> {
    if (!result.error) return null;
    const structured = isPlainObject(result.result) ? result.result : null;
    return isString(structured?.error) ? structured.error : "ERROR";
  }

  private createContextPayloadOutputStore(): Nullable<KernelToolOutputStore> {
    const payloadStore = (this.ctx as ToolExecutorPayloadContext)
      .contextPayloadStore;
    if (!payloadStore) return null;

    return new ContextPayloadKernelToolOutputStore(payloadStore);
  }

  private settleProviderTurnTool(result: ToolResult): void {
    if (!this.providerTurnReducer) return;

    try {
      if (isPresent(result.error)) {
        this.providerTurnReducer.apply({
          type: "tool-failed",
          toolCallId: result.toolCallId,
          error: result.error,
        });
        return;
      }

      this.providerTurnReducer.apply({
        type: "tool-succeeded",
        toolCallId: result.toolCallId,
        output: result.modelResult ?? result.result,
      });
    } catch (error) {
      log.warn("provider turn tool settlement failed", {
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        error: AppError.getMessage(error),
      });
      this.providerTurnReducer.apply({
        type: "diagnostic",
        code: "tool-settlement-unmatched",
        message: AppError.getMessage(error),
        details: {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        },
      });
    }
  }

  private emitProviderTurnSnapshot(): void {
    if (!this.providerTurnReducer || !this.onProviderTurnSnapshot) return;
    if (this.providerTurnSnapshotEmitted) return;

    try {
      const completion = completeProviderTurnSnapshot(
        this.providerTurnReducer,
        {
          interruptPendingTools: true,
        },
      );
      this.providerTurnSnapshotEmitted = true;
      if (!isEmpty(completion.interruptedToolCallIds)) {
        log.warn("provider turn snapshot interrupted pending tools", {
          toolCallIds: completion.interruptedToolCallIds,
        });
      }
      this.onProviderTurnSnapshot(completion.snapshot);
    } catch (error) {
      log.warn("provider turn snapshot completion failed", {
        error: AppError.getMessage(error),
      });
    }
  }

  private readSessionId(): Nullable<string> {
    const candidate = (this.ctx as { sessionId?: unknown }).sessionId;
    if (!isString(candidate)) return null;

    const trimmed = candidate.trim();
    return trimmed || null;
  }

  private buildToolFailureResult(
    error: string,
    reason: string,
    toolName: string,
    options: ToolFailureBuildOptions = {},
  ): ToolFailureResult {
    return buildStructuredToolFailureResult(error, reason, toolName, options);
  }

  private readProviderToolArgs(
    toolName: string,
    args: unknown,
  ):
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; reason: string; result: ToolFailureResult } {
    if (!isPresent(args)) return { ok: true, args: {} };
    if (isPlainObject(args))
      return { ok: true, args: args as Record<string, unknown> };

    const receivedType = this.describeProviderToolArgsType(args);
    const reason = `Tool arguments for "${toolName}" must be a JSON object; received ${receivedType}.`;
    return {
      ok: false,
      reason,
      result: this.buildToolFailureResult(
        "schema_validation_failed",
        reason,
        toolName,
        {
          code: "VALIDATION",
          details: {
            receivedType,
            schemaIssues: [{ path: "", message: reason }],
          },
          nextActions: [
            "重建 args：读取当前可见工具 schema，只传 schema.properties 声明的字段。",
            "不要把整段 JSON、数组或自然语言字符串作为工具参数；工具参数必须是 object。",
            "如果参数流像是截断或串行化错误，重新发起该工具调用。",
          ],
        },
      ),
    };
  }

  private describeProviderToolArgsType(value: unknown): string {
    if (!isPresent(value)) return "null";
    if (isArray(value)) return "array";
    return typeof value;
  }

  private applyRepeatedFailureBatchGuard(results: ToolResult[]): void {
    const currentResults = results.slice(this.failureBatchResultCursor);
    this.failureBatchResultCursor = results.length;
    if (isEmpty(currentResults)) return;

    const failureBatch = this.toLoopGuardFailureBatch(currentResults);
    const message = this.loopGuard.recordFailureBatch(failureBatch);
    if (!message || isEmpty(currentResults)) return;

    const target = currentResults[0]!;
    const reason = [target.error, `[loop guard] ${message}`]
      .filter(isString)
      .join("\n\n");
    const guardedResult = this.buildToolFailureResult(
      "tool_loop_guard",
      reason,
      target.toolName,
    );
    target.result = guardedResult;
    target.modelResult = guardedResult;
  }

  private toLoopGuardFailureBatch(
    results: readonly ToolResult[],
  ): KernelToolFailureBatchEntry[] {
    if (isEmpty(results)) return [];

    const failures: KernelToolFailureBatchEntry[] = [];
    for (const result of results) {
      if (!result.error || this.isLoopGuardBlockedResult(result)) return [];
      failures.push({
        toolName: result.toolName,
        args: result.args,
        error: result.error,
      });
    }
    return failures;
  }

  private isLoopGuardBlockedResult(result: ToolResult): boolean {
    const record = isPlainObject(result.result) ? result.result : null;
    const error = isString(record?.error) ? record.error : "";
    return [
      "tool_cancelled",
      "tool_blocked",
      "tool_denied",
      "tool_loop_guard",
      "tool_unavailable",
    ].includes(error);
  }
}

export function emitToolProgressEvent(
  events: ToolExecutorEvents,
  toolCallId: string,
  chunk: string,
): void {
  if (!chunk) return;

  events.emitToolProgress?.({
    toolCallId,
    chunk,
    timestamp: Date.now(),
  });
}

export function emitToolMetadataEvent(
  events: ToolExecutorEvents,
  toolCallId: string,
  payload: { title?: string; metadata?: Record<string, unknown> },
): void {
  const title = payload.title?.trim();
  const metadata = payload.metadata;
  if (!title && !metadata) return;

  events.emitToolMetadata?.({
    toolCallId,
    title: toOptional(title),
    metadata,
    timestamp: Date.now(),
  });
}

export type { ToolExecutorEvents };
