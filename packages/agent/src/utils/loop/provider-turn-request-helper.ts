// ProviderTurnRequestHelper 用到的纯函数（不碰实例状态）。
import { isFunction, isPlainObject, isTrue, toNullable } from '@velaros-ai/core'

import type { StreamContextGovernanceState } from '../../types/agent.js'
import type { CompiledProviderRequest } from '../../types/context.js'
import type { ProviderTurnActiveContext, ProviderTurnActiveContextProvider } from '../../types/loop.js'

/**
 * Stream 与 Query 两条 turn 链路在"把一个 turn 组装成 provider 请求"上的公共逻辑。
 *
 * 这些方法与流式/非流式无关，过去在 StreamTurn 与 QueryTurn 中逐字/近似重复，
 * 漂移风险已经显现（见 docs/agent-pipeline-review.md §1）。这里统一为单一来源，
 * 仅以 `label` 区分日志文案，其余行为对两条链路严格一致。
 */

export function resolveActiveContextProvider(
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

/**
 * 编译结果 → 流事件里的治理状态块。
 *
 * 编译器没持有治理会话（一次性编译 / 旧调用面）时返回 undefined：宁可让壳侧"这轮没有治理状态"，
 * 也不要伪造一个 `handoffArmed:false` 的默认块——布防看门分不清"没信号"和"信号说别布防"。
 */
export function buildStreamGovernanceState(
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
