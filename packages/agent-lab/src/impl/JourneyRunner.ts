/**
 * 旅程运行器：把一条旅程在同一个会话里一段一段走完，落成一份不可变归档。
 * 结果只由验证器决定，看门狗只负责掐断打转，预算按「整程归整程、本段归本段」两本账分开判。
 */
import { randomUUID } from 'node:crypto'

import { AgentLabPackageVersion, MeasurementBasis, RunArchiveSchemaId } from '../contract/constants.js'
import type { JobRuntime } from '../contract/requires.js'
import type {
  Budget,
  DropRecord,
  Finding,
  JobSpec,
  LegResult,
  MatrixJobInput,
  RunArchive,
  SessionHandle,
  SettleOutcome,
  WatchdogAbort,
  WatchdogBaseline,
} from '../types/agent-lab.js'
import type { RunJourneyOptions } from '../types/options.js'
import { resolveBudget } from '../utils/budget.js'
import { sha256Json } from '../utils/digests.js'
import {
  collectArtifacts,
  contextAccount,
  createMatrixJob,
  dropRecords,
  mergeLegUsage,
  scoreCriteria,
  unavailableCapabilities,
  unavailableExecutor,
  verifyLeg,
} from '../utils/journey.js'
import { createUnobservedObservation, normalizeObservation } from '../utils/measure/normalize.js'
import { journeySpecSchema } from '../utils/wire/journey.js'

import { BudgetLedger } from './BudgetLedger.js'

/**
 * 跑评测的三件事：跑一条旅程、跑一个 job 的全部试验、把矩阵展开成一批试验。
 * 它不认任何执行体：驱动、探测器与验证器都由调用方从注入面塞进来。实例归本包，进程里只有一份。
 */
export interface JourneyRunnerApi {
  /**
   * 跑一条旅程，返回一份不可变归档。旅程定义先严格校验；试验声明的旅程身份与定义对不上当场抛错。
   * 驱动报不出能力或身份、开会话或准备工作区失败，都落成丢弃记录而不是异常。
   */
  runJourney: (options: RunJourneyOptions) => Promise<RunArchive>
  /**
   * 跑一个 job 的全部试验，按并发度派发。
   * 一个试验失败就**停止派发**并等在飞的试验收尾，再把第一个错误抛给调用方——
   * 不留「调用方已经拿不到归档、被测执行体还在后台跑」的会话。
   */
  runJob: (job: JobSpec, runtime: JobRuntime) => Promise<readonly RunArchive[]>
  /** 把「旅程 × 执行体 × 实验臂 × 重复次数」展开成一个 job。 */
  createMatrixJob: (input: MatrixJobInput) => JobSpec
}

class JourneyRunner implements JourneyRunnerApi {
  /** 归档里 `exitReason` 的几种固定说法；它是字段值不是给人读的话，保持原样。 */
  private static readonly ExitReasons = {
    completed: 'completed',
    completedWithCloseWarning: 'completed-with-close-warning',
    blockingLegFailed: 'blocking-leg-failed',
    agentUnavailable: 'agent-unavailable',
    environmentSetupFailed: 'environment-setup-failed',
    harnessFailure: 'harness-failure',
  } as const

  /** 运行器自己出的几条判词用这几个探测器 id，与注册的探测器区分开。 */
  private static readonly RunnerDetectorIds = {
    budget: 'budget-exhausted',
    driverExecutionFailed: 'driver-execution-failed',
    sessionCloseFailed: 'session-close-failed',
    identityRefreshFailed: 'executor-identity-refresh-failed',
  } as const

  public createMatrixJob(input: MatrixJobInput): JobSpec {
    return createMatrixJob(input)
  }

  public async runJob(job: JobSpec, runtime: JobRuntime): Promise<readonly RunArchive[]> {
    const pending = [...job.trials]
    const archives: RunArchive[] = []
    let failed = false
    let failure: unknown = null
    const workers = Array.from({ length: Math.min(job.concurrency, pending.length) }, async (): Promise<void> => {
      for (;;) {
        if (failed) return
        const trial = pending.shift()
        if (!trial) return
        try {
          const driver = await runtime.resolveDriver(trial)
          const archive = await runtime.runTrial(trial, driver)
          archives.push(archive)
          await runtime.onArchive?.(archive)
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
          return
        }
      }
    })
    // worker 自己不再抛，所以这里一定等到每个在飞的试验都收了尾，不留后台会话。
    await Promise.all(workers)
    if (failed) throw failure
    return archives.sort((left, right) => left.manifest.trial.id.localeCompare(right.manifest.trial.id))
  }

  public async runJourney(options: RunJourneyOptions): Promise<RunArchive> {
    const journey = journeySpecSchema.parse(options.journey)
    if (options.trial.journeyId !== journey.id || options.trial.journeyVersion !== journey.version) {
      throw new Error('试验声明的旅程身份与旅程定义对不上')
    }
    for (const detectorId of journey.gatingDetectorIds) {
      if (!options.detectors.get(detectorId)) throw new Error(`旅程引用了没注册的探测器: ${detectorId}`)
    }
    for (const leg of journey.legs) {
      for (const criterion of leg.criteria) {
        if (!options.verifiers.get(criterion.verifierId)) {
          throw new Error(`旅程引用了没注册的验证器: ${criterion.verifierId}`)
        }
      }
    }

    const now = options.now ?? Date.now
    const runId = (options.createRunId ?? randomUUID)()
    const startedAt = now()
    let preflightFailure: string | null = null
    const capabilities = await options.driver.capabilities().catch((error: unknown) => {
      preflightFailure = error instanceof Error ? error.message : String(error)
      return unavailableCapabilities()
    })
    const executor = await options.driver.identity().catch((error: unknown) => {
      preflightFailure ??= error instanceof Error ? error.message : String(error)
      return unavailableExecutor(options.trial.executorId)
    })
    const taskDigest = sha256Json(journey)
    const detectorDigest = sha256Json(options.detectors.list().map((item) => item.definition))
    const policyDigest = sha256Json({ budget: journey.budget, gatingDetectorIds: journey.gatingDetectorIds })
    const ledger = new BudgetLedger(now, startedAt)
    const legResults: LegResult[] = []
    const findings: Finding[] = []
    const drops: DropRecord[] = []
    let exitReason: string = JourneyRunner.ExitReasons.completed
    let session: SessionHandle | null = null
    let environmentReady = false

    if (preflightFailure) {
      drops.push({
        trialId: options.trial.id,
        legId: null,
        cause: 'agent-unavailable',
        detail: preflightFailure,
      })
      exitReason = JourneyRunner.ExitReasons.agentUnavailable
    } else {
      try {
        session = await options.driver.openSession({
          trial: options.trial,
          journey,
          workspaceRoot: options.workspaceRoot,
        })
        await options.driver.prepare(session, journey.setup)
        environmentReady = true
      } catch (error) {
        drops.push({
          trialId: options.trial.id,
          legId: null,
          cause: 'environment-setup-failed',
          detail: error instanceof Error ? error.message : String(error),
        })
        exitReason = JourneyRunner.ExitReasons.environmentSetupFailed
      }
    }

    if (session && environmentReady) {
      const openSession = session
      try {
        for (const leg of journey.legs) {
          try {
            const legStartedAt = now()
            const legBudget: Budget = resolveBudget(journey.budget, leg.budget)
            // 段预算按本段计（与驱动等待的计时口径一致），整程预算仍按整程累计比。
            const legLedger = ledger.beginLeg()
            let watchdogBaseline: WatchdogBaseline | null = null
            // 用一个容器装：中止是在 onSample 回调里定的，闭包外面要读得到它。
            const watchdog: { current: WatchdogAbort | null } = { current: null }
            const activeWatchdogDetectorIds = new Set(journey.gatingDetectorIds)

            await options.driver.send(openSession, leg)
            let settleOutcome = await options.driver.waitSettled(openSession, {
              budget: legBudget,
              signal: new AbortController().signal,
              onSample: async (sample) => {
                const observation = normalizeObservation(sample.observation)
                ledger.observe(observation)
                ledger.observeDriverUsage(sample.usage)
                legLedger.observe(observation)
                legLedger.observeDriverUsage(sample.usage)
                const sampleFindings = options.detectors.detect(observation, {
                  trial: options.trial,
                  journey,
                  leg,
                })
                const budgetLimit = legLedger.exceeded(legBudget) ?? ledger.exceeded(journey.budget)
                if (budgetLimit) {
                  const abort: WatchdogAbort = {
                    detectorId: JourneyRunner.RunnerDetectorIds.budget,
                    reason: `预算耗尽: ${budgetLimit}`,
                  }
                  watchdog.current = abort
                  if (capabilities.canAbortMidRun) await options.driver.abort(openSession, abort.reason)
                  return { kind: 'abort', ...abort }
                }
                if (!watchdogBaseline) {
                  watchdogBaseline = options.detectors.watchdogBaseline(
                    observation,
                    sampleFindings,
                    activeWatchdogDetectorIds,
                  )
                  return { kind: 'continue' }
                }
                const candidate = options.detectors.watchdogAbort(
                  observation,
                  sampleFindings,
                  watchdogBaseline,
                  activeWatchdogDetectorIds,
                )
                if (!candidate) return { kind: 'continue' }
                watchdog.current = candidate
                if (capabilities.canAbortMidRun) await options.driver.abort(openSession, candidate.reason)
                return { kind: 'abort', ...candidate }
              },
            })

            const abortRequest = watchdog.current
            if (abortRequest && settleOutcome.kind === 'settled') {
              settleOutcome = { kind: 'aborted', detectorId: abortRequest.detectorId, reason: abortRequest.reason }
            }
            const observation = normalizeObservation(await options.driver.collect(openSession, 'idle'))
            ledger.observe(observation)
            const legFindings = options.detectors.detect(observation, { trial: options.trial, journey, leg })
            const gatingFinding = legFindings.some(
              (item) => item.severity === 'fail' && journey.gatingDetectorIds.includes(item.detectorId),
            )
            const criteria = await verifyLeg({
              verifiers: options.verifiers,
              trial: options.trial,
              journey,
              leg,
              session: openSession,
              observation,
              settleOutcome,
              workspaceRoot: options.workspaceRoot,
              now,
            })
            const score = scoreCriteria(leg, criteria)
            ledger.finishLeg()
            legResults.push({
              legId: leg.id,
              startedAt: legStartedAt,
              finishedAt: now(),
              settleOutcome,
              criteria,
              observation,
              findings: legFindings,
              score: score.score,
              passed: gatingFinding ? false : score.passed,
            })
            findings.push(...legFindings)
            drops.push(...dropRecords(options.trial.id, leg.id, criteria))

            const blockingFailure = leg.blocking && (score.passed === false || gatingFinding)
            const expectedNativeOutcome =
              settleOutcome.kind !== 'settled' && leg.continueOn.includes(settleOutcome.kind)
            if (blockingFailure || (settleOutcome.kind !== 'settled' && !expectedNativeOutcome)) {
              exitReason =
                settleOutcome.kind === 'settled' ? JourneyRunner.ExitReasons.blockingLegFailed : settleOutcome.kind
              break
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            const legStartedAt = now()
            const observation = createUnobservedObservation('idle')
            const settleOutcome: SettleOutcome = { kind: 'unavailable', cause: 'harness-failure', detail }
            const criteria = await verifyLeg({
              verifiers: options.verifiers,
              trial: options.trial,
              journey,
              leg,
              session: openSession,
              observation,
              settleOutcome,
              workspaceRoot: options.workspaceRoot,
              now,
            })
            ledger.finishLeg()
            legResults.push({
              legId: leg.id,
              startedAt: legStartedAt,
              finishedAt: now(),
              settleOutcome,
              criteria,
              observation,
              findings: [],
              score: null,
              passed: null,
            })
            drops.push(...dropRecords(options.trial.id, leg.id, criteria))
            findings.push({
              detectorId: JourneyRunner.RunnerDetectorIds.driverExecutionFailed,
              severity: 'warn',
              failureClass: 'infrastructure',
              summary: detail,
              references: [],
              evidence: {},
            })
            exitReason = JourneyRunner.ExitReasons.harnessFailure
            break
          }
        }
      } finally {
        try {
          await options.driver.closeSession(openSession)
        } catch (error) {
          findings.push({
            detectorId: JourneyRunner.RunnerDetectorIds.sessionCloseFailed,
            severity: 'warn',
            failureClass: 'infrastructure',
            summary: error instanceof Error ? error.message : String(error),
            references: [],
            evidence: {},
          })
          if (exitReason === JourneyRunner.ExitReasons.completed) {
            exitReason = JourneyRunner.ExitReasons.completedWithCloseWarning
          }
        }
      }
    } else if (session) {
      try {
        await options.driver.closeSession(session)
      } catch (error) {
        findings.push({
          detectorId: JourneyRunner.RunnerDetectorIds.sessionCloseFailed,
          severity: 'warn',
          failureClass: 'infrastructure',
          summary: error instanceof Error ? error.message : String(error),
          references: [],
          evidence: {},
        })
      }
    }

    const finalExecutor = await options.driver.identity().catch((error: unknown) => {
      findings.push({
        detectorId: JourneyRunner.RunnerDetectorIds.identityRefreshFailed,
        severity: 'warn',
        failureClass: 'infrastructure',
        summary: error instanceof Error ? error.message : String(error),
        references: [],
        evidence: {},
      })
      return executor
    })
    return {
      manifest: {
        schema: RunArchiveSchemaId,
        runId,
        jobId: options.jobId,
        suiteId: options.suiteId,
        trial: options.trial,
        harness: {
          packageVersion: options.packageVersion ?? AgentLabPackageVersion,
          sourceCommit: options.sourceCommit,
          consumerCommit: options.consumerCommit,
          taskDigest,
          detectorDigest,
          policyDigest,
        },
        executor: finalExecutor,
        capabilities,
        startedAt,
        finishedAt: now(),
        exitReason,
        budget: journey.budget,
        usage: ledger.snapshot(),
        measurementBasis: MeasurementBasis,
      },
      journey,
      legs: legResults,
      findings,
      drops,
      usage: mergeLegUsage(legResults),
      context: contextAccount(legResults),
      artifacts: collectArtifacts(legResults),
      extensions: {},
    }
  }
}

/** 进程里共用的那一份旅程运行器。 */
export const journeyRunner: JourneyRunnerApi = new JourneyRunner()
