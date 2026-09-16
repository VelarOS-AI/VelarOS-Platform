

import type { AbortSignalScope,RunSoloBackgroundCompletionGateInput, SoloAwaitPendingBackgroundJobs, SoloBackgroundCompletionGateResult } from '../../types/loop.js'
import { createAgentRuntimeInputInterruptScope } from '../runner/runtime-input-port'

/**
 * 主 Agent 真正提交收尾前的后台任务门。
 *
 * 时序刻意是「先 drain → wait-any → 再 drain」：
 * - 第一次 drain 拦住模型生成/收尾检查期间已到达的终态通知；
 * - wait-any 只等下一个任务，一个完成就把决策权还给主模型；
 * - 第二次 drain 封住「先 drain、任务完成、wait 看到无 running」的竞态窗口。
 *
 * waitSignal 也包含 runtime input：用户在停泊期间 steer 会立即唤醒主循环，而不会被
 * `takeOrSeal()` 提前封口。
 */
async function runSoloBackgroundCompletionGate(
  input: RunSoloBackgroundCompletionGateInput
): Promise<SoloBackgroundCompletionGateResult> {
  // 先注册 input listener 再 drain：onInputAccepted 会对已排队输入同步回放，
  // 从而封住「有输入但还没开始 wait」的 lost wake-up。
  const runtimeInputInterrupt = createAgentRuntimeInputInterruptScope(input.runtimeInput)
  const waitInterrupt = combineAbortSignals([
    input.executionAbortSignal,
    runtimeInputInterrupt.signal,
  ])
  const waitSignal = waitInterrupt.signal
  try {
    if (injectTurnContextNote(input, 'before-wait'))
      return { status: 'continue', reason: 'late-context' }
    if (waitSignal.aborted) return { status: 'interrupted' }

    const waitOutcome = input.awaitPendingBackgroundJobs
      ? await awaitPendingBackgroundJobsOrInterrupt(
          input.awaitPendingBackgroundJobs,
          waitSignal,
          input.emitWaitingPhase,
        )
      : { status: 'settled' as const, observedTerminal: false }

    if (waitOutcome.status === 'interrupted' || waitSignal.aborted)
      return { status: 'interrupted' }

    const injectedAfterWait = injectTurnContextNote(input, 'after-wait')
    if (injectedAfterWait) return { status: 'continue', reason: 'late-context' }
    if (waitOutcome.observedTerminal)
      return { status: 'continue', reason: 'background-terminal' }
    return { status: 'ready' }
  } finally {
    waitInterrupt.dispose()
    runtimeInputInterrupt.dispose()
  }
}

/** Node >=20.0 可用的本地合并实现，不依赖 20.3 才加入的 AbortSignal.any。 */
function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignalScope {
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    signal.addEventListener('abort', listener, { once: true })
    cleanups.push(() => signal.removeEventListener('abort', listener))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup()
    },
  }
}

/**
 * 等下一个后台任务进入终态，同时随时可被打断。返回 `settled` 并带上「这次等待里是否真的观察到终态」，
 * 或在 abort / 新运行时输入到达时返回 `interrupted`；`wait` 自己抛的错原样抛出
 * （迟到的 rejection 由 guardedWait 消化，不会变成 unhandled）。
 *
 * `wait` 必须同步调用（见函数体内注释）：推到 microtask 会让已排队的完成先跑掉，wait-any 只盯住还在跑的那个，
 * 主 Agent 就会平白多等一个任务。
 */
async function awaitPendingBackgroundJobsOrInterrupt(
  wait: SoloAwaitPendingBackgroundJobs,
  signal: AbortSignal,
  onWaiting: () => void,
): Promise<
  | { status: 'settled'; observedTerminal: boolean }
  | { status: 'interrupted' }
> {
  if (signal.aborted) return { status: 'interrupted' }

  // wait 必须同步调用，让 manager 在 pre-drain 后立即选中当前 running jobs。
  // 若用 Promise.resolve().then 推迟到 microtask，已排队的 A 完成会先跑，wait-any 只选中
  // 仍在跑的 B，主 Agent 就会错过 A 而多等一个任务。
  const pendingWait = Promise.resolve(wait({ signal, onWaiting }))
  // 即使 abort race 先胜，guardedWait 也会消化后到 rejection，不会 unhandled。
  const guardedWait = pendingWait.then(
    (observedTerminal) => ({ status: 'settled' as const, observedTerminal }),
    (error) => ({ status: 'failed' as const, error }),
  )
  let removeAbortListener: () => void = () => undefined
  const interrupted = new Promise<{ status: 'interrupted' }>((resolve) => {
    const listener = () => resolve({ status: 'interrupted' })
    signal.addEventListener('abort', listener, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', listener)
    if (signal.aborted) listener()
  })

  const outcome = await Promise.race([guardedWait, interrupted])
  removeAbortListener()
  if (outcome.status === 'failed') throw outcome.error
  return outcome
}

/**
 * 取一条待投递的回合上下文便签（若有），以 user 消息压进 history，并记一条日志标明是在等待前还是等待后注入的。
 * 返回值即「有没有真的注入」：为真表示上下文已经变了，停泊门据此让主循环再跑一轮去消化它，而不是就地收尾；
 * 没有便签时返回 false 且一个字都不碰 history。
 */
function injectTurnContextNote(
  input: Pick<
    RunSoloBackgroundCompletionGateInput,
    'consumeTurnContextNote' | 'history' | 'log' | 'turn'
  >,
  phase: 'before-wait' | 'after-wait'
): boolean {
  const note = input.consumeTurnContextNote?.()
  if (!note) return false

  input.history.push({ role: 'user', content: note })
  input.log.info('turn context note injected at final boundary', {
    turn: input.turn,
    phase,
  })
  return true
}

export { runSoloBackgroundCompletionGate }
