import type { ModelMessage, ToolSet } from "ai";

import type {
  ChatRuntimeEvent,
  StreamContextGovernanceState,
} from "@velaros-ai/agent/protocol";
import { ChatRuntimeEvents } from "@velaros-ai/agent/protocol";
import {
  isEmpty,
  isFunction,
  isPlainObject,
  isString,
  isTrue,
  toNullable,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import type { ScopedLog } from "@velaros-ai/core/logger";

import { compareStableStrings } from "./context/residency/determinism";
import {
  buildToolPayloadRefsForProviderMessages,
  collectProviderRequestHistoryToolNames,
  type CompiledProviderRequest,
  type ContextActiveTaskInput,
  type ContextPayloadStore,
  type ContextPinnedEvidenceInput,
} from "./context";

/**
 * Stream 与 Query 两条 turn 链路在"把一个 turn 组装成 provider 请求"上的公共逻辑。
 *
 * 这些方法与流式/非流式无关，过去在 StreamTurn 与 QueryTurn 中逐字/近似重复，
 * 漂移风险已经显现（见 docs/agent-pipeline-review.md §1）。这里统一为单一来源，
 * 仅以 `label` 区分日志文案，其余行为对两条链路严格一致。
 */

interface ProviderTurnPayloadContext {
  sessionId?: string;
  contextPayloadStore?: ContextPayloadStore;
}

interface ProviderTurnActiveContextArtifact {
  id: string;
  kind: "plan" | "decision" | "requirement";
  title?: LooseOptional<string>;
  content: string;
  status?: LooseOptional<string>;
  updatedAt?: LooseOptional<number>;
  metadata?: LooseOptional<Record<string, unknown>>;
}

interface ProviderTurnActiveContextProvider {
  activeContext?: {
    listActiveContextArtifacts(options?: {
      status?: "active" | "completed" | "archived" | "all";
      kinds?: Array<"plan" | "decision" | "requirement">;
    }): Promise<ProviderTurnActiveContextArtifact[]>;
  };
}

interface ProviderTurnContextWorkingSetInputs {
  activeTask?: ContextActiveTaskInput;
  pinnedEvidence?: ContextPinnedEvidenceInput[];
}

type ProviderTurnActiveContext = NonNullable<
  ProviderTurnActiveContextProvider["activeContext"]
>;

function resolveActiveContextProvider(
  value: unknown,
): Nullable<ProviderTurnActiveContextProvider["activeContext"]> {
  if (!isPlainObject(value)) return null;
  const activeContext = value.activeContext;
  if (!isPlainObject(activeContext)) return null;
  const listActiveContextArtifacts = activeContext.listActiveContextArtifacts;
  return isFunction(listActiveContextArtifacts)
    ? {
        listActiveContextArtifacts:
          listActiveContextArtifacts as ProviderTurnActiveContext["listActiveContextArtifacts"],
      }
    : null;
}

interface ToolSchemaCharEstimatorRegistry<TContext> {
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools?: string[],
  ) => Record<string, number>;
}

interface ToolSchemaHashEstimatorRegistry<TContext> {
  estimateToolSchemaHashesByName?: (
    toolContext: TContext,
    allowedTools?: string[],
  ) => Record<string, string>;
}

interface ProviderToolTransportContext {
  /** canonical tool id 到供应方安全的请求内名称。 */
  getCurrentVisibleToolTransportNames?: () => Readonly<Record<string, string>>;
}

interface ContextUsageEmitTarget {
  events?: { emitRuntime?: (event: ChatRuntimeEvent) => void };
  turn: LooseOptional<number>;
  model: string;
}

interface ProviderToolNamePlan {
  providerToolNames?: string[];
  historyToolNames: string[];
}

interface ProviderToolTransportPlan {
  /** canonical tool id -> provider request name for exactly one provider request. */
  canonicalToProvider: Readonly<Record<string, string>>;
  /** provider request name -> canonical tool id for exactly the matching response stream. */
  providerToCanonical: Readonly<Record<string, string>>;
}

class ProviderTurnRequestHelper {
  constructor(
    private readonly log: ScopedLog,
    private readonly label: "stream" | "query",
  ) {}

  /** 序列化体积估算；JSON.stringify 失败时回退到字符串长度。 */
  public estimateSerializedChars(value: unknown): number {
    try {
      return JSON.stringify(value)?.length ?? String(value).length;
    } catch (error) {
      this.log.warn(
        "estimateSerializedChars JSON.stringify failed, using string length fallback",
        {
          error,
        },
      );
      return String(value).length;
    }
  }

  /**
   * 以本轮 allow-list 生成供应方工具面；历史工具名只用于诊断，不会反向扩大当前能力面。
   *
   * 动态工具空间允许历史里保留已 page-out 的 tool-call/result。把历史名重新并入 schema
   * 会让一次越界或幻觉调用在下一轮自动获得执行能力，绕过 tooling:replace 的正式分页边界。
   */
  public resolveProviderToolNames(
    history: readonly ModelMessage[],
    allowTools?: readonly string[],
  ): LooseOptional<string[]> {
    return this.resolveProviderToolNamePlan(history, allowTools)
      .providerToolNames;
  }

  public resolveProviderToolNamePlan(
    history: readonly ModelMessage[],
    allowTools?: readonly string[],
  ): ProviderToolNamePlan {
    const historyToolNames = collectProviderRequestHistoryToolNames(history);
    if (!allowTools) return { historyToolNames };

    return {
      // P7 确定性序列化：工具清单顺序进 prompt 字节，必须与 locale / ICU 数据无关。
      providerToolNames: [...new Set(allowTools)].sort(compareStableStrings),
      historyToolNames,
    };
  }

  /**
   * Freeze the transport identity immediately after the registry builds this request's tools.
   *
   * ToolContext keeps a mutable projection for UI/planning compatibility, but provider responses
   * may arrive after another projection has been built. Response decoding must therefore use this
   * request-local snapshot rather than reading mutable "current visible tools" state later.
   */
  public captureToolTransportPlan(
    toolContext: ProviderToolTransportContext,
  ): ProviderToolTransportPlan {
    const canonicalToProvider = Object.freeze({
      ...(toolContext.getCurrentVisibleToolTransportNames?.() ?? {}),
    });
    const providerToCanonical = Object.freeze(
      Object.fromEntries(
        Object.entries(canonicalToProvider).map(
          ([canonicalToolName, providerToolName]) => [
            providerToolName,
            canonicalToolName,
          ],
        ),
      ),
    );
    return Object.freeze({ canonicalToProvider, providerToCanonical });
  }

  /**
   * 解析每个工具的 schema 字符数：优先用预备值，其次用注册表实测，最后回退到逐工具序列化。
   */
  public resolveToolSchemaChars<TContext>(
    toolRegistry: ToolSchemaCharEstimatorRegistry<TContext>,
    toolContext: TContext,
    canonicalToolNames: LooseOptional<readonly string[]>,
    tools: ToolSet,
    transportPlan: ProviderToolTransportPlan,
    preparedToolSchemaChars?: Readonly<Record<string, number>>,
  ): Record<string, number> {
    const requestedCanonicalNames = canonicalToolNames
      ? [...canonicalToolNames]
      : undefined;
    const measured = toolRegistry.estimateToolSerializedCharsByName?.(
      toolContext,
      requestedCanonicalNames,
    );
    const providerToCanonical = transportPlan.providerToCanonical;

    // `tools` 已经使用 provider-safe 名字，而 run-plan 的预估与注册表仍使用 canonical id。
    // 逐项桥接，避免把 `project__read` 反向交给注册表后得到一张空账。
    return Object.fromEntries(
      Object.entries(tools).map(([providerToolName, tool]) => {
        const canonicalToolName =
          providerToCanonical[providerToolName] ?? providerToolName;
        const prepared = preparedToolSchemaChars?.[canonicalToolName];
        const measuredChars = measured?.[canonicalToolName];
        return [
          providerToolName,
          Math.max(
            0,
            prepared ?? measuredChars ?? this.estimateSerializedChars(tool),
          ),
        ];
      }),
    );
  }

  /** 把 canonical schema hash 账投影到 provider-safe 工具名。 */
  public resolveToolSchemaHashes<TContext>(
    toolRegistry: ToolSchemaHashEstimatorRegistry<TContext>,
    toolContext: TContext,
    canonicalToolNames: LooseOptional<readonly string[]>,
    tools: ToolSet,
    transportPlan: ProviderToolTransportPlan,
  ): Record<string, string> | undefined {
    if (!toolRegistry.estimateToolSchemaHashesByName) return undefined;
    const hashes = toolRegistry.estimateToolSchemaHashesByName(
      toolContext,
      canonicalToolNames ? [...canonicalToolNames] : undefined,
    );
    const providerToCanonical = transportPlan.providerToCanonical;
    return Object.fromEntries(
      Object.keys(tools).flatMap((providerToolName) => {
        const canonicalToolName =
          providerToCanonical[providerToolName] ?? providerToolName;
        const hash = hashes[canonicalToolName];
        return hash ? [[providerToolName, hash] as const] : [];
      }),
    );
  }

  /** 强制工具选择也必须使用与 tools key 相同的 provider-safe 身份。 */
  public resolveProviderToolChoice<TToolChoice>(
    transportPlan: ProviderToolTransportPlan,
    toolChoice: TToolChoice,
  ): TToolChoice {
    if (
      !isPlainObject(toolChoice) ||
      toolChoice.type !== "tool" ||
      !isString(toolChoice.toolName)
    )
      return toolChoice;
    const providerToolName =
      transportPlan.canonicalToProvider[toolChoice.toolName] ??
      toolChoice.toolName;
    return { ...toolChoice, toolName: providerToolName } as TToolChoice;
  }

  /** 为本轮 provider 消息构建工具 payload 引用；无 session/store 或无引用时返回 undefined。 */
  public async buildToolPayloadRefs(
    toolContext: ProviderTurnPayloadContext,
    messages: ModelMessage[],
    isOutputInlineToolName?: (toolName: string) => boolean,
  ): Promise<LooseOptional<Record<string, string>>> {
    if (!toolContext.sessionId || !toolContext.contextPayloadStore)
      return undefined;

    const refs = await buildToolPayloadRefsForProviderMessages({
      sessionId: toolContext.sessionId,
      messages,
      store: toolContext.contextPayloadStore,
      isOutputInlineToolName,
    });

    return isEmpty(Object.keys(refs)) ? undefined : refs;
  }

  public async resolveContextWorkingSetInputs(
    toolContext: unknown,
  ): Promise<ProviderTurnContextWorkingSetInputs> {
    const activeContext = resolveActiveContextProvider(toolContext);
    if (!activeContext) return {};

    try {
      const artifacts = await activeContext.listActiveContextArtifacts({
        status: "active",
        kinds: ["requirement", "decision"],
      });
      if (isEmpty(artifacts)) return {};

      const sorted = [...artifacts].sort(
        (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
      );
      const activeGoal = sorted.find(
        (artifact) =>
          artifact.kind === "requirement" &&
          isTrue(artifact.metadata?.goal) &&
          artifact.metadata?.goalStatus !== "complete" &&
          artifact.metadata?.goalStatus !== "blocked",
      );
      const activeTask = activeGoal
        ? {
            id: activeGoal.id,
            title: activeGoal.title ?? "Active goal",
            summary: activeGoal.content,
            state: isString(activeGoal.metadata?.goalStatus)
              ? activeGoal.metadata.goalStatus
              : activeGoal.status,
            metadata: activeGoal.metadata,
          }
        : undefined;
      const pinnedEvidence = sorted
        .filter((artifact) => artifact.id !== activeGoal?.id)
        .slice(0, 8)
        .map((artifact): ContextPinnedEvidenceInput => ({
          id: artifact.id,
          kind:
            artifact.kind === "requirement" ? "user-constraint" : "evidence",
          summary: artifact.title,
          content: artifact.content,
          source: `active-context:${artifact.kind}`,
          recoverable: false,
        }));

      return {
        activeTask,
        pinnedEvidence: isEmpty(pinnedEvidence) ? undefined : pinnedEvidence,
      };
    } catch (error) {
      this.log.warn("resolve active-context inputs failed", {
        error: String(error),
      });
      return {};
    }
  }

  /** 编译结果判定为不可发送时抛上下文超限错误，否则放行。 */
  public assertProviderRequestAllowed(
    compiledRequest: CompiledProviderRequest,
    turn: LooseOptional<number>,
  ): void {
    if (compiledRequest.decision.okToSend) return;

    this.log.warn(
      `compiled ${this.label} request blocked before provider send`,
      {
        turn: toNullable(turn),
        percent: compiledRequest.estimate.percent,
        tokenPercent: compiledRequest.estimate.tokenPercent,
        payloadPercent: compiledRequest.estimate.payloadPercent,
        pressureKind: compiledRequest.decision.pressureKind,
        ledgerEntries: compiledRequest.ledger.length,
      },
    );
    throw new AppError(
      "context_length_exceeded",
      compiledRequest.decision.reason,
      undefined,
      {
        source: "provider-request-compiler",
        turn: toNullable(turn),
        percent: compiledRequest.estimate.percent,
        pressureKind: compiledRequest.decision.pressureKind,
        requestFingerprint: compiledRequest.requestFingerprint,
      },
    );
  }

  /** 上报本轮上下文用量估算（来源标记为 provider-request-compiler）。 */
  public emitContextUsageEstimate(
    compiledRequest: CompiledProviderRequest,
    target: ContextUsageEmitTarget,
  ): void {
    target.events?.emitRuntime?.(
      ChatRuntimeEvents.contextUsageEstimate({
        ...compiledRequest.estimate,
        turn: toNullable(target.turn),
        model: target.model,
        source: "provider-request-compiler",
        pressureKind: compiledRequest.decision.pressureKind,
        ledger: compiledRequest.ledger,
        zoneDiagnostics: compiledRequest.decision.zoneDiagnostics,
        requestFingerprint: compiledRequest.requestFingerprint,
        // 治理状态是 main 侧治理器的**只读**投影：renderer 靠它布防转交卡，不再自行采样水位。
        // B1 起送核门失去回收阶梯的二次挽救，转交是压力的唯一出路，所以这条必须逐轮到达壳侧。
        governance: buildStreamGovernanceState(compiledRequest),
      }),
    );
  }
}

/**
 * 编译结果 → 流事件里的治理状态块。
 *
 * 编译器没持有治理会话（一次性编译 / 旧调用面）时返回 undefined：宁可让壳侧"这轮没有治理状态"，
 * 也不要伪造一个 `handoffArmed:false` 的默认块——布防看门分不清"没信号"和"信号说别布防"。
 */
function buildStreamGovernanceState(
  compiledRequest: CompiledProviderRequest,
): LooseOptional<StreamContextGovernanceState> {
  const handoff = compiledRequest.governanceHandoff;
  if (!handoff) return undefined;

  const report = compiledRequest.governanceEpoch;
  const distill = report?.distill;
  return {
    epoch: compiledRequest.governanceEpochSeq ?? 0,
    occupancyPercent: toNullable(compiledRequest.governanceOccupancyPercent),
    epochApplied: isTrue(report?.applied),
    epochSavingPercent: report ? report.savingPercent : null,
    handoffArmed: handoff.armed,
    recentSavingPercents: [...handoff.recentSavingPercents],
    lastEpochAfterPercent: handoff.lastEpochAfterPercent,
    handoffReason: handoff.reason,
    // 没跑 epoch 的轮次也给一份零值块（而不是缺席）：与 governance 块整体缺席不同，这里
    // "本轮没有 epoch" 是确定的事实，零值就是它的忠实表示，消费方不必区分两种 undefined。
    distill: {
      mode: distill?.mode ?? "off",
      appliedProducts: distill?.appliedProducts ?? 0,
      appliedByInstrument: {
        ...(distill?.appliedByInstrument ?? { distill: 0, skeleton: 0 }),
      },
      planned: isTrue(distill?.planned),
      skipReason: toNullable(distill?.skipReason),
      totals: {
        ...(distill?.totals ?? {
          requested: 0,
          accepted: 0,
          rejected: 0,
          timedOut: 0,
          failed: 0,
          staleDropped: 0,
        }),
      },
    },
  };
}

export { ProviderTurnRequestHelper };
export type {
  ProviderToolNamePlan,
  ProviderToolTransportPlan,
  ProviderTurnPayloadContext,
};
