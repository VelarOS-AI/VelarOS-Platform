/**
 * 评测基础设施的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 除 INV-13（规范 JSON 是包内的纯函数，没有单独的对外入口）外，全部只经根入口，只测对外承诺的行为。
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

import type {
  DetectorContext,
  JobSpec,
  LabDriver,
  Observation,
  RealTaskAssessment,
  RealTaskRecord,
  RunArchive,
  SessionHandle,
  ToolCallRecord,
} from '../src/index.js'
import {
  AgentLabPackageVersion,
  createDetectorRegistry,
  createVerifierRegistry,
  journeyRunner,
  labArchives,
  labCertification,
  labDrivers,
  labReports,
  labStatistics,
  labWire,
  realTaskWorkload,
  UnlimitedBudget,
} from '../src/index.js'
import { canonicalJson } from '../src/utils/canonical-json.js'

import { FullCapabilities, journey, observation, trial } from './support.js'

/** 一个总是收敛的假驱动；时钟按段推进，用来把「本段用时」与「整程用时」分开。 */
function fakeDriver(clock: { value: number }, legMs: number): LabDriver {
  const session: SessionHandle = {
    id: 'session',
    executorId: 'executor-a',
    externalId: 'native',
    metadata: {},
  }
  return {
    id: 'fake',
    capabilities: async () => FullCapabilities,
    identity: async () => ({
      executorId: 'executor-a',
      adapterVersion: '1',
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    }),
    openSession: async () => session,
    prepare: async () => undefined,
    send: async () => undefined,
    waitSettled: async (_session, request) => {
      clock.value += legMs
      const decision = await request.onSample({
        observation: observation('running'),
        usage: { toolCalls: 0, workingMs: legMs, wallClockMs: legMs, tokens: 1, legs: 0 },
      })
      if (decision.kind === 'abort')
        return { kind: 'aborted', detectorId: decision.detectorId, reason: decision.reason }
      return { kind: 'settled' }
    },
    collect: async (_session, phase) => observation(phase),
    abort: async () => undefined,
    closeSession: async () => undefined,
  }
}

/** 一条真实任务记录，带提示词、最终回答与绝对路径，用来核对报告不会把它们嵌进去。 */
function sensitiveRecord(): RealTaskRecord {
  return labWire.parseRealTaskRecord({
    schema: 'agent-lab/real-task@1',
    id: 'task-secret',
    capturedAt: 20,
    task: {
      sessionId: 'session-1',
      runId: 'run-1',
      rootInputId: null,
      source: 'user',
      surface: 'project',
      title: '修一个持久化缺陷',
      prompt: 'SECRET-PROMPT-TOKEN',
      workspaceRoot: '/srv/evaluation/secret-workspace',
      startedAt: 1,
      finishedAt: 5,
      terminalStatus: 'ok',
    },
    executor: { executorId: 'executor-a', provider: null, model: null, reasoningProfile: null },
    privacy: {
      classification: 'local-only',
      containsPrompt: true,
      containsAnswer: true,
      containsPaths: true,
    },
    evidence: {
      spans: [],
      assertions: [
        {
          id: 'file',
          kind: 'file',
          description: '文件写对了',
          outcome: 'pass',
          detail: 'ok',
          evidenceRefs: [],
        },
      ],
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'file',
          path: '/srv/evaluation/secret-workspace/out.txt',
          sha256: null,
          sizeBytes: null,
          provenance: 'agent',
        },
      ],
      finalAnswer: 'SECRET-ANSWER-TOKEN',
      userFeedback: null,
      observationGaps: [],
    },
  })
}

/** 造一次带 n 条工具调用的观测；同一个 id 重复出现时测量口径要去重。 */
function withCalls(calls: readonly ToolCallRecord[]): Observation {
  return {
    ...observation(),
    turns: [{ id: 'turn-1', index: 1, toolCalls: calls, finishReasons: [] }],
  }
}

describe('结果只由独立验证决定', () => {
  test('INV-1 没有验证器判过的判据是 unknown，不被总分掩盖', async () => {
    const verifiers = createVerifierRegistry()
    verifiers.register('complete', () => ({
      kind: 'void',
      cause: 'verifier-unavailable',
      detail: '外部真相取不到',
      evidence: {},
    }))
    const archive = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: journey(),
      driver: fakeDriver({ value: 0 }, 1),
      detectors: createDetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
    })

    expect(archive.legs[0]?.passed).toBeNull()
    expect(archive.legs[0]?.score).toBeNull()
    expect(archive.drops).toHaveLength(1)
    expect(archive.drops[0]?.cause).toBe('verifier-unavailable')
    expect(labStatistics.estimateReliability([archive]).attempts).toBe(0)
  })
})

describe('一个试验失败不影响其它试验', () => {
  test('INV-2 失败后停止派发并等在飞的试验收尾，再把第一个错误抛出来', async () => {
    const job: JobSpec = {
      id: 'job',
      suiteId: 'suite',
      concurrency: 1,
      archiveDirectory: '/archives',
      trials: Array.from({ length: 5 }, (_, index) =>
        trial('executor-a', 'journey-a', 'group-a', index + 1)
      ),
    }
    const started: string[] = []
    await expect(
      journeyRunner.runJob(job, {
        resolveDriver: (candidate) => {
          started.push(candidate.id)
          if (started.length === 2) throw new Error('driver unavailable')
          return fakeDriver({ value: 0 }, 1)
        },
        runTrial: async (candidate) =>
          ({ manifest: { trial: { id: candidate.id } } }) as unknown as RunArchive,
      })
    ).rejects.toThrow('driver unavailable')
    expect(started).toHaveLength(2)
  })
})

describe('归档只读与严格校验', () => {
  test('INV-3 v3 严格校验，历史归档缺的字段保持缺', () => {
    const base = journey()
    expect(() => labWire.parseJourney({ ...base, unexpected: true })).toThrow()

    const v0 = labArchives.readRunArchiveView([{ ok: true }])
    const v1 = labArchives.readRunArchiveView({ sessionId: 's1', rounds: [{ ok: true }] })
    const v2 = labArchives.readRunArchiveView({ manifest: { runId: 'r2' }, rounds: [] })
    expect([v0.shape, v1.shape, v2.shape]).toEqual(['v0-array', 'v1-flat', 'v2-manifest'])
    expect(v0.passed).toBeNull()
    expect(v1.drops).toBeNull()
    expect(v2.findings).toBeNull()
    expect(v2.usage).toBeNull()
  })
})

describe('真实任务报告不外泄内容', () => {
  test('INV-4 报告不嵌入提示词、回答、绝对路径与产物正文', () => {
    const record = sensitiveRecord()
    const assessment: RealTaskAssessment = realTaskWorkload.audit(record, { generatedAt: 1 })
    const html = labReports.renderRealTaskReportHtml(record, assessment)

    expect(html).not.toContain('SECRET-PROMPT-TOKEN')
    expect(html).not.toContain('SECRET-ANSWER-TOKEN')
    expect(html).not.toContain('/srv/evaluation/secret-workspace')
    expect(html).toContain('verified-pass')
  })
})

describe('测量口径', () => {
  test('INV-5 工具调用按 toolCallId 去重，累计快照重复上报不重复计数', async () => {
    const call: ToolCallRecord = {
      id: 'call-1',
      turnId: 'turn-1',
      name: 'read',
      input: { path: '/a' },
      result: null,
      isError: null,
      startedAt: null,
      finishedAt: null,
    }
    const duplicated: Observation = {
      ...observation(),
      turns: [
        { id: 'turn-1', index: 0, toolCalls: [call], finishReasons: [] },
        { id: 'turn-2', index: 1, toolCalls: [{ ...call, turnId: 'turn-2' }], finishReasons: [] },
      ],
    }
    const verifiers = createVerifierRegistry()
    verifiers.register('complete', () => ({ kind: 'pass', credit: 1, evidence: {} }))
    const driver = fakeDriver({ value: 0 }, 1)
    driver.collect = async () => duplicated
    const archive = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: journey(),
      driver,
      detectors: createDetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
    })

    expect(archive.manifest.measurementBasis).toBe('unique-tool-call')
    expect(archive.manifest.usage.toolCalls).toBe(1)
    expect(archive.legs[0]?.observation.turns.flatMap((turn) => turn.toolCalls)).toHaveLength(1)
  })
})

describe('harness 身份', () => {
  test('INV-9 归档里的 harness 版本就是本包版本', async () => {
    const verifiers = createVerifierRegistry()
    verifiers.register('complete', () => ({ kind: 'pass', credit: 1, evidence: {} }))
    const archive = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: journey(),
      driver: fakeDriver({ value: 0 }, 1),
      detectors: createDetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
    })
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      version: string
    }

    expect(manifest.version).toBe(AgentLabPackageVersion)
    expect(archive.manifest.harness.packageVersion).toBe(manifest.version)
  })
})

describe('预算的两本账', () => {
  test('INV-10 段预算按本段计，整程预算按整程累计', async () => {
    const definition = journey('journey-a', 2)
    const [first, second] = definition.legs
    const verifiers = createVerifierRegistry()
    verifiers.register('complete', () => ({ kind: 'pass', credit: 1, evidence: {} }))
    const clock = { value: 0 }
    const archive = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: {
        ...definition,
        budget: { ...UnlimitedBudget, legs: 2 },
        legs: [first!, { ...second!, budget: { ...UnlimitedBudget, wallClockMs: 8_000 } }],
      },
      driver: fakeDriver(clock, 5_000),
      detectors: createDetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })

    expect(archive.legs).toHaveLength(2)
    expect(archive.legs[1]?.settleOutcome.kind).toBe('settled')
    expect(archive.manifest.usage.wallClockMs).toBe(10_000)
  })
})

describe('本包不认宿主', () => {
  test('INV-11 工具名单与宿主驱动都从注入面进来，核心里一个产品工具名都没有', async () => {
    const context: DetectorContext = { trial: trial(), journey: journey(), leg: null }
    const catalogReads = withCalls(
      Array.from({ length: 4 }, (_, index) => ({
        id: `call-${index}`,
        turnId: 'turn-1',
        name: 'tooling:map',
        input: { op: 'read', ids: ['tool:write'] },
        result: null,
        isError: null,
        startedAt: null,
        finishedAt: null,
      }))
    )

    const withoutNames = createDetectorRegistry()
    withoutNames.registerBuiltins()
    expect(
      withoutNames
        .detect(catalogReads, context)
        .some((finding) => finding.detectorId === 'toolmap-read-loop')
    ).toBe(false)

    const withNames = createDetectorRegistry()
    withNames.registerBuiltins({ catalogToolNames: ['tooling:map'] })
    expect(
      withNames
        .detect(catalogReads, context)
        .some((finding) => finding.detectorId === 'toolmap-read-loop')
    ).toBe(true)

    const hostDriver = fakeDriver({ value: 0 }, 1)
    labDrivers.register({ id: 'acceptance-host-driver', create: () => hostDriver })
    expect(labDrivers.ids()).toContain('acceptance-host-driver')
    expect(await labDrivers.create('acceptance-host-driver')).toBe(hostDriver)
    await expect(labDrivers.create('velar-hooks')).rejects.toThrow('没有登记过这个驱动')
  })
})

describe('报告自包含', () => {
  test('INV-12 报告不拉任何外部资源，未知显示破折号而不是 0', () => {
    const view = labArchives.readRunArchiveView({ sessionId: 'legacy', rounds: [] })
    const html = labReports.renderHistoricalReportHtml([view], { generatedAt: 1 })

    expect(html).toContain('data-value="null">—</span>')
    expect(/<link\b|<script\b[^>]*\bsrc=|@import\b/i.test(html)).toBe(false)
    expect(/https?:\/\//i.test(html)).toBe(false)
  })
})

describe('规范 JSON', () => {
  test('INV-13 键按码点排序、undefined 写成 null，摘要跨机器一致', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    // 码点序：大写字母在小写字母之前；localeCompare 在多数区域设置下会给出相反的顺序。
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}')
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('认证只认看得到的证据', () => {
  test('INV-14 任一项检查判不了，整份认证报告就是 inconclusive', () => {
    const report = labCertification.certify({
      subject: { kind: 'agent', id: 'agent-a', version: '1.0.0', digest: 'a'.repeat(64) },
      policy: labWire.parseCertificationPolicy({
        id: 'policy-a',
        version: 1,
        requiredJourneyIds: ['journey-a'],
        minimumReplicatesPerJourney: 2,
        minimumReliability: 0.9,
        maximumAttritionRate: 0,
        requiredObservationCoverage: {},
        requireSeparateVerifier: true,
        requireNativeExecution: true,
        requireBaseline: false,
        maximumBaselineRegression: 0,
      }),
      archives: [],
      subjectExecutorId: 'executor-a',
      now: () => 1,
    })

    expect(report.status).toBe('inconclusive')
    expect(report.digest).toHaveLength(64)
  })
})
