import type { ModelMessage, ToolSet } from 'ai'
import { asSchema } from 'ai'

import { isEmpty, isPlainObject, isString, isTrue, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { CompiledProviderRequest, ContextPinnedEvidenceInput, ProviderToolDefinitionSnapshotInput } from '../../types/context.js'
import type { ContextUsageEmitTarget, ProviderToolNamePlan, ProviderToolTransportContext, ProviderToolTransportPlan, ProviderTurnContextWorkingSetInputs, ProviderTurnPayloadContext, ToolSchemaCharEstimatorRegistry, ToolSchemaHashEstimatorRegistry } from '../../types/loop.js'
import { collectProviderRequestHistoryToolNames } from '../../utils/context/message-scan'
import { buildStreamGovernanceState, resolveActiveContextProvider } from '../../utils/loop/provider-turn-request-helper'
import { compareStableStrings } from '../../utils/residency/determinism'
import { completeToolTransportNameAliases } from '../../utils/tools/tool-identity'
import { ToolPayloadReferencePlanner } from '../context/ToolPayloadReferencePlanner'
import { chatRuntimeEvents } from '../records/ChatRuntimeEvents'

/**
 * 「把一个 turn 组装成 provider 请求」的公共件：工具面、schema 账、payload 引用、发送前的拦截与上报。
 *
 * 谁持有：`StreamTurn` 与 `QueryTurn` 各建一个（只差一个 `label`，用来分辨日志出自哪条链路）。
 * 什么时候调：每轮在请求编译之前按顺序走一遍——先定工具名单与传输身份，再算 schema 字符与哈希、
 * 物化工具定义，编译出请求后由 `assertProviderRequestAllowed` 决定放不放行，放行前后各上报一次用量估算。
 * 它自己不发请求、不碰历史、不持有跨轮状态；除了拦截那一步会抛 `context_length_exceeded`，
 * 其余方法一律不抛：外部依赖（activeContext、序列化）出问题就记一条 warn 并退到保守结果。
 */
export interface ProviderTurnRequestHelperApi {
  /** 估一个值序列化后的字符数；`JSON.stringify` 失败（循环引用等）时退回字符串长度，不抛错。 */
  estimateSerializedChars(value: unknown): number
  /**
   * 本轮真正要给 provider 的工具名单（`resolveProviderToolNamePlan` 的简写）。
   * 传了 allow-list 才有名单；没传表示不限制，返回缺席。
   */
  resolveProviderToolNames(
    history: readonly ModelMessage[],
    allowTools?: readonly string[],
  ): LooseOptional<string[]>
  /**
   * 同时给出「本轮能力面」和「历史里出现过的工具名」两份清单。
   * 历史名只用于把旧 tool-call/result 编译成合法输入名与诊断，**绝不**反向并回能力面——
   * 否则一次越界或幻觉调用会在下一轮自动获得执行能力，绕过工具分页的正式边界。
   */
  resolveProviderToolNamePlan(
    history: readonly ModelMessage[],
    allowTools?: readonly string[],
  ): ProviderToolNamePlan
  /**
   * 在注册表刚生成本轮 tools 之后立刻冻结一份「规范名 ↔ provider 名」双向映射。
   * provider 的响应可能在工具面又翻过一页之后才回来，解码必须认这份请求内的快照，而不是当时的「当前可见工具」。
   */
  captureToolTransportPlan(toolContext: ProviderToolTransportContext): ProviderToolTransportPlan
  /** 把历史里已换出的工具名也补成 provider-safe 输入名（只为让旧消息合法），不扩大响应解码认的工具面。 */
  resolveProviderRequestToolNameAliases(
    transportPlan: ProviderToolTransportPlan,
    historyToolNames: readonly string[],
  ): Readonly<Record<string, string>>
  /**
   * 逐工具的 schema 字符账，键是 provider-safe 名：优先用 run plan 预备好的值，其次问注册表实测，
   * 都没有才逐个序列化兜底。上下文预算与前缀形状哈希都读这本账。
   */
  resolveToolSchemaChars<TContext>(
    toolRegistry: ToolSchemaCharEstimatorRegistry<TContext>,
    toolContext: TContext,
    canonicalToolNames: LooseOptional<readonly string[]>,
    tools: ToolSet,
    transportPlan: ProviderToolTransportPlan,
    preparedToolSchemaChars?: Readonly<Record<string, number>>,
  ): Record<string, number>
  /** 把 canonical 的 schema 哈希账投影到 provider-safe 工具名；注册表不提供哈希能力时返回 undefined。 */
  resolveToolSchemaHashes<TContext>(
    toolRegistry: ToolSchemaHashEstimatorRegistry<TContext>,
    toolContext: TContext,
    canonicalToolNames: LooseOptional<readonly string[]>,
    tools: ToolSet,
    transportPlan: ProviderToolTransportPlan,
  ): Record<string, string> | undefined
  /**
   * 把本次请求的工具定义（含 JSON Schema）就地物化成审计快照，名字按码元序排定。
   * 先抓定义对象再等异步 schema：等待期间宿主注册表更新也不会改写这一份。
   */
  resolveProviderToolDefinitions(
    tools: ToolSet,
    transportPlan: ProviderToolTransportPlan,
    toolSchemaChars: Readonly<Record<string, number>>,
    toolSchemaHashes?: Readonly<Record<string, string>>,
  ): Promise<ProviderToolDefinitionSnapshotInput[]>
  /** 强制工具选择也换成与 tools 键一致的 provider-safe 身份；不是 `{type:'tool'}` 形态就原样返回。 */
  resolveProviderToolChoice<TToolChoice>(
    transportPlan: ProviderToolTransportPlan,
    toolChoice: TToolChoice,
  ): TToolChoice
  /** 为本轮消息里的大块工具产物建 payload 引用（正文换成句柄）；没有会话或没有 store 时返回 undefined。 */
  buildToolPayloadRefs(
    toolContext: ProviderTurnPayloadContext,
    messages: ModelMessage[],
    isOutputInlineToolName?: (toolName: string) => boolean,
  ): Promise<LooseOptional<Record<string, string>>>
  /**
   * 从 activeContext 读出本轮要常驻上下文的工作集：当前目标 + 最近的约束/证据（至多 8 条）。
   * 读不到或读失败都返回空对象并记一条 warn——工作集缺席只是少一点上下文，不该让一轮请求失败。
   */
  resolveContextWorkingSetInputs(toolContext: unknown): Promise<ProviderTurnContextWorkingSetInputs>
  /**
   * 发送前最后一道闸：编译器判定不可发送（压不下去的上下文超限）时抛 `context_length_exceeded`，
   * 由 loop 面的缺页阶梯接住；可发送则什么都不做。
   */
  assertProviderRequestAllowed(
    compiledRequest: CompiledProviderRequest,
    turn: LooseOptional<number>,
  ): void
  /**
   * 把本轮上下文用量估算发给壳侧（来源标记 `provider-request-compiler`），附带治理状态块。
   * 逐轮必须到达：壳侧的转交卡只靠这条消息布防，缺一轮就少一次挽救机会。
   */
  emitContextUsageEstimate(
    compiledRequest: CompiledProviderRequest,
    target: ContextUsageEmitTarget,
  ): void
}

class ProviderTurnRequestHelper implements ProviderTurnRequestHelperApi {
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
   * 在注册表刚生成本轮 tools 之后立刻冻结传输身份。
   *
   * ToolContext 为了 UI 与规划兼容保留着一份可变投影，而 provider 的响应可能在下一份投影建好之后才回来；
   * 因此响应解码必须认这份「请求内快照」，不能事后再去读可变的「当前可见工具」。
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
   * 把已换出工具的历史名字也编译成 provider-safe 输入名，但不扩张响应解码的 advertised 工具面。
   */
  public resolveProviderRequestToolNameAliases(
    transportPlan: ProviderToolTransportPlan,
    historyToolNames: readonly string[],
  ): Readonly<Record<string, string>> {
    return completeToolTransportNameAliases(
      transportPlan.canonicalToProvider,
      historyToolNames,
    );
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

  /** 直接物化本次请求的 schema，避免异步准备期间宿主注册表更新改写审计快照。 */
  public async resolveProviderToolDefinitions(
    tools: ToolSet,
    transportPlan: ProviderToolTransportPlan,
    toolSchemaChars: Readonly<Record<string, number>>,
    toolSchemaHashes?: Readonly<Record<string, string>>,
  ): Promise<ProviderToolDefinitionSnapshotInput[]> {
    // 先捕获定义对象，再等待可能异步的 SDK schema；工具集合更新不能替换本次定义。
    const definitions = Object.keys(tools)
      .sort(compareStableStrings)
      .map((providerToolName) => ({ providerToolName, tool: tools[providerToolName]! }));
    return Promise.all(
      definitions.map(async ({ providerToolName, tool }) => {
        const canonicalName =
          transportPlan.providerToCanonical[providerToolName] ??
          providerToolName;
        const description = isPlainObject(tool) && isString(tool.description)
          ? tool.description
          : "";
        return {
          name: providerToolName,
          canonicalName,
          description,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
          schemaChars: Math.max(0, toolSchemaChars[providerToolName] ?? 0),
          schemaHash: toNullable(toolSchemaHashes?.[providerToolName]),
        };
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

    const refs = await new ToolPayloadReferencePlanner(toolContext.contextPayloadStore).buildRefs({
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
      chatRuntimeEvents.contextUsageEstimate({
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

export { ProviderTurnRequestHelper };
