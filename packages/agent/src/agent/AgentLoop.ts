// 域：Agent 回合循环的**唯一引擎**（198 行；主会话与子 agent 两个面共用它）。
//
// **为什么只有一个引擎**：历史上主会话（SoloLoop）与子 agent（QueryLoop）各自带一份流消费
// 复制体，四处分叉长期不同步（同一个中止/护栏 bug 要修两遍且常只修一遍）。B5 批把两者
// 收成「一个引擎 + 两层薄壳」：引擎持有回合推进与护栏，壳只提供各自的 surface 实现
// （见 `LoopSurface`）。**加新的循环面时写壳，不复制引擎**。
//
// ## 关键不变量（改这些会破什么）
//  - **四护栏单源**：wind-down 判定、溢出处理、中止落在轮首、span 审计各只有一份实现。
//    在壳里重写任何一条 = 两个面行为漂移，而漂移只会在真机长跑里暴露。
//  - **中止只在轮首生效**：轮内中止会留下半成品工具结果 → 历史结构出现孤儿片段 →
//    下一轮 provider 校验拒收整条会话（曾导致会话永久锁死，见 history-orphan 自愈判决）。
//  - **surface 不得持有回合状态**：状态归引擎，壳只做 IO 与投影；壳存状态 = 两份真相。
import { toNullable } from '@velaros-ai/core'
import type { ScopedLog } from '@velaros-ai/core/logger'
import type { PromptSegmentTrace, SkippedPromptSegmentTrace } from '@velaros-ai/core/types'

import type { ModelSpanHandle, RunSpanScope, TurnSpanScope } from '../kernel'

import type { ContextDegradeAction } from './ContextDegradeLadder'
import type { AgentLoopSurface } from './LoopSurface'
import { isContextOverflowError, isContextOverflowReplayUnsafe } from './retry'

/**
 * AgentLoop —— 全内核唯一的 agent 循环引擎（B5 单引擎双面）。
 *
 * 引擎只有一份骨架：轮次推进 → 中止门（护栏 3）→ 开场注入 → 轮次上限 tick（护栏 1）→
 * 单轮执行与裁决。上下文溢出恢复（护栏 2）与 turn span 收敛（护栏 4）作为共享机制由面在
 * runTurn 内装配——因为两面的异常收敛策略是真装配差异（主面把错误收敛为状态 + UI 事件，
 * 子面把错误冒泡给派发器），try/catch 的疆界必须归面，机制必须归引擎。
 *
 * 与 S1（流消费单脑 StreamConsumer）同构：SoloStreamLoop / QueryLoop 保留为两个装配面薄壳，
 * 公开构造签名与调用点零扰动。
 */

// ─── 引擎骨架 ────────────────────────────────────────────────────────────────

/** 运行装配面直至某轮给出 finish 裁决；面内抛出的异常原样冒泡（子面的收敛策略）。 */
async function runAgentLoop<TFinish>(surface: AgentLoopSurface<TFinish>): Promise<TFinish> {
  for (let turn = 1; ; turn += 1) {
    if (surface.isAborted()) return surface.onAborted(turn)

    await surface.beforeTurn(turn)

    const windDownReason = surface.windDown.guard.tickTurnStart(turn)
    if (windDownReason) surface.windDown.onTriggered(windDownReason, turn)

    const verdict = await surface.runTurn(turn)
    if (verdict.kind === 'finish') return verdict.value
  }
}

// ─── 护栏 2：上下文溢出降级恢复（单源机制，双面装配） ─────────────────────────

interface ExecuteLoopTurnWithContextOverflowRecoveryInput<TTurnResult> {
  turn: number
  abortSignal: AbortSignal
  /** 发起一次单轮模型调用；溢出恢复后会用同一轮重试。 */
  executeTurn(): Promise<TTurnResult>
  /** 第 attempt 次缺页（从 0 起）应采取的降级动作（面提供阶梯：solo=RecoveryRunPlan，query=chain 表）。 */
  resolveAction(attempt: number): ContextDegradeAction
  /** 执行一级降级动作；true = 状态真变（可重试），false = 走下一级。 */
  applyAction(action: ContextDegradeAction): Promise<boolean>
  /** 每次真正重试前的面装配点（主面在此重建 ToolExecutor 保证干净重放）。 */
  onBeforeRetry?(): void
  /** 阶梯耗尽日志（面各自措辞；载荷统一 turn/attempts）。 */
  surrenderLogMessage: string
  log: Pick<ScopedLog, 'error'>
}

/**
 * 用降级阶梯包住一次单轮调用：溢出（缺页）→ 沿阶梯逐级释放压力 → 同一轮重试；
 * 已中止 / 非溢出 / 重放不安全（本轮已有可见输出或工具副作用）一律原样上抛，
 * 阶梯耗尽记日志后优雅上抛。
 */
async function executeLoopTurnWithContextOverflowRecovery<TTurnResult>(
  input: ExecuteLoopTurnWithContextOverflowRecoveryInput<TTurnResult>
): Promise<TTurnResult> {
  let overflowAttempt = 0

  for (;;) {
    try {
      return await input.executeTurn()
    } catch (error) {
      if (
        input.abortSignal.aborted ||
        !isContextOverflowError(error) ||
        isContextOverflowReplayUnsafe(error)
      ) {
        throw error
      }

      let stateChanged = false
      while (!stateChanged) {
        const action = input.resolveAction(overflowAttempt)
        overflowAttempt += 1
        if (action.kind === 'surrender') {
          input.log.error(input.surrenderLogMessage, {
            turn: input.turn,
            attempts: overflowAttempt,
          })
          throw error
        }
        stateChanged = await input.applyAction(action)
      }

      input.onBeforeRetry?.()
    }
  }
}

// ─── 护栏 4：turn/model span 生命周期收敛（单源机制，双面装配） ────────────────

interface LoopTurnSpans {
  turnScope: Nullable<TurnSpanScope>
  modelSpan: Nullable<ModelSpanHandle>
}

/**
 * 开本轮观测 span：turn span（run 的子）+ model span（turn 的子，usage 收敛在此——
 * D5 确定 turn，无 null turn）。turn scope 兼作 tool span 开启器注入本轮 ToolExecutor
 * （缺省端口时全链 no-op）。
 */
function beginLoopTurnSpans(
  runScope: Nullable<RunSpanScope>,
  input: { turn: number; roleId: string; model: string; provider: string }
): LoopTurnSpans {
  const turnScope: Nullable<TurnSpanScope> =
    runScope?.beginTurn({ turn: input.turn, roleId: input.roleId, model: input.model }) ?? null
  const modelSpan: Nullable<ModelSpanHandle> =
    turnScope?.beginModelSpan({
      provider: input.provider,
      model: input.model,
      requestFingerprint: null,
    }) ?? null
  return { turnScope, modelSpan }
}

/** 双面 turn 结果的观测富化子面（StreamTurnResult / QueryTurnResult 结构上都满足）。 */
interface LoopTurnSpanUsage {
  inputTokens?: LooseOptional<number>
  outputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  finishReason?: LooseOptional<string>
  requestFingerprint?: LooseOptional<string>
}

interface LoopTurnPromptAudit {
  systemPrompt: string
  promptSegments: readonly PromptSegmentTrace[]
  skippedPromptSegments: readonly SkippedPromptSegmentTrace[]
}

/**
 * 供应方回合成功收敛：usage 四字段挂本确定 turn 的 model span；重内容（系统提示词全文 /
 * promptSegments）落 prompt 审计侧信道，靠 requestFingerprint 关联（缺省无 sidecar 时 no-op；
 * 绝不进会话账本）。capabilityContextAudit 恒空占位：能力包拥有的回合上下文走注入的 turn-context
 * source，从不经此路径。
 */
function endLoopTurnSpansOk(
  spans: LoopTurnSpans,
  result: LoopTurnSpanUsage,
  audit: LoopTurnPromptAudit
): void {
  spans.modelSpan?.end({
    status: 'ok',
    finishReason: toNullable(result.finishReason),
    tokensIn: toNullable(result.inputTokens),
    tokensOut: toNullable(result.outputTokens),
    costUsd: toNullable(result.costUsd),
    requestFingerprint: toNullable(result.requestFingerprint),
  })
  spans.turnScope?.recordPromptAudit({
    requestFingerprint: toNullable(result.requestFingerprint),
    systemPrompt: audit.systemPrompt,
    promptSegments: audit.promptSegments,
    skippedPromptSegments: audit.skippedPromptSegments,
    capabilityContextAudit: [],
  })
  spans.turnScope?.end({ status: 'ok' })
}

/**
 * 供应方回合出错收敛（幂等——成功路径已 ok 收敛则后续调用被 scope 吞掉）。
 * 出错路径无 turnResult 富化，指标一律 null（§12.6 缺席值单一）。
 */
function endLoopTurnSpansError(spans: LoopTurnSpans): void {
  spans.modelSpan?.end({
    status: 'error',
    finishReason: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    requestFingerprint: null,
  })
  spans.turnScope?.end({ status: 'error' })
}

export {
  beginLoopTurnSpans,
  endLoopTurnSpansError,
  endLoopTurnSpansOk,
  executeLoopTurnWithContextOverflowRecovery,
  runAgentLoop,
}
export type {
  ExecuteLoopTurnWithContextOverflowRecoveryInput,
  LoopTurnPromptAudit,
  LoopTurnSpans,
  LoopTurnSpanUsage,
}
