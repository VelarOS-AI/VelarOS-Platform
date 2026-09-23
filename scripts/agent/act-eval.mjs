import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile, appendFile, rename } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'

import {
  createDetectorRegistry,
  createVerifierRegistry,
  journeyRunner,
  labArchives,
  labDrivers,
  ObservationFaces,
  UnlimitedBudget,
} from '@velaros-ai/agent-lab'
import { evaluationScenario } from './act-scenarios.mjs'
import { createEvidenceCheckpoints } from './evidence-checkpoints.mjs'
import { createRuntime } from '@velaros-ai/velaros'

const prompt =
  '工作区 state.txt 当前第一行是 one。请用 observe 持续读取它（注释说明观察目的），先等待下一轮观察确实返回 one，再用后续 execute 将第一行改为 two，只修改一次；安装 observe 的同一份响应不要改写；在之后一轮的观察结果中确认 two 再完成。保留 protected.txt 原样。通过 velaros:project 的真实契约完成读写。'
const coverage = Object.fromEntries(
  ObservationFaces.map((face) => [
    face,
    ['runtime', 'transcript', 'turns', 'usage', 'context-residency', 'artifacts'].includes(face)
      ? 'partial'
      : 'full',
  ])
)
const capabilities = {
  observes: coverage,
  settleSignal: 'custom',
  canApproveInline: false,
  canAbortMidRun: true,
  verifierIsolation: 'separate',
  preservesNativeExecution: true,
}

// 证据快照以同目录原子替换发布，观察进程不会读到半份 JSON。
async function writeSnapshot(path, value) {
  const temporary = `${path}.writing`
  await writeFile(temporary, JSON.stringify(value, null, 2))
  await rename(temporary, path)
}

// 正文截断时保留未知，不把局部 JSON 当成完整事实。
function body(record) {
  return record && !record.truncated && record.body !== null ? JSON.parse(record.body) : null
}

// 将同一 Kernel 调用去重映射给 Lab；ScriptAct 外层协议不伪装成工具调用。
function observedCalls(traces) {
  const seen = new Set()
  return traces.map((trace) => ({
    id: trace.turnId,
    index: trace.turn,
    finishReasons: [body(trace.decision)?.finish?.reason ?? 'unknown'],
    toolCalls: trace.invocations.flatMap((item) => {
      if (seen.has(item.id)) return []
      const record = body(item)
      if (!record) return []
      seen.add(item.id)
      return [
        {
          id: item.id,
          turnId: trace.turnId,
          name: `${record.prepared.binding.moduleId}.${record.prepared.operation}`,
          input: record.prepared.input ?? null,
          result: record.receipt?.value ?? record.receipt?.error ?? null,
          isError: record.receipt ? record.receipt.outcome !== 'succeeded' : null,
          startedAt: null,
          finishedAt: null,
        },
      ]
    }),
  }))
}

// 只有每次模型调用都报告用量，才给出完整 token 总数。
function measuredUsage(traces) {
  const usage = traces.map((trace) => body(trace.decision)?.usage)
  const complete =
    usage.length > 0 &&
    usage.every(
      (value) => value && Number.isFinite(value.inputTokens) && Number.isFinite(value.outputTokens)
    )
  const inputTokens = complete ? usage.reduce((n, item) => n + item.inputTokens, 0) : null
  const outputTokens = complete ? usage.reduce((n, item) => n + item.outputTokens, 0) : null
  return {
    inputTokens,
    outputTokens,
    totalTokens: complete ? inputTokens + outputTokens : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
  }
}

// 验收对象是正式 Runtime，Lab 只负责驱动、外部核验和证据归档。
export async function runActEvaluation({
  model,
  output,
  provider = null,
  configuration = {},
  sourceCommit = null,
  consumerCommit = null,
  scenario = 'read-edit-observe',
  turns = scenario === 'read-edit-observe' ? 12 : 64,
  timeoutMs = scenario === 'read-edit-observe' ? 120000 : 1800000,
}) {
  if (
    !Number.isSafeInteger(turns) ||
    turns < 3 ||
    turns > 128 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 3600000
  )
    throw new Error('验收需要有限的回合和时间预算')
  const workload = evaluationScenario(scenario),
    taskPrompt = workload?.prompt ?? prompt
  await mkdir(resolve(output), { recursive: true })
  const directory = await mkdtemp(join(resolve(output), 'act-')),
    root = join(directory, 'project'),
    tracePath = join(directory, 'traces.json'),
    eventsPath = join(directory, 'events.json')
  await mkdir(root)
  await writeFile(join(root, 'state.txt'), 'one\n')
  await writeFile(join(root, 'protected.txt'), 'keep this\n')
  for (const [name, body] of Object.entries(workload?.files ?? {})) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), body)
  }
  const metrics = new Map()
  const onMetric = (metric) => {
    const key = `${metric.phase}:${metric.operation}`
    const item = metrics.get(key) ?? {
      phase: metric.phase,
      operation: metric.operation,
      count: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
    }
    item.count++
    item.failures += metric.succeeded ? 0 : 1
    item.totalMs += metric.durationMs
    item.maxMs = Math.max(item.maxMs, metric.durationMs)
    metrics.set(key, item)
  }
  const runtime = await createRuntime({
    onMetric,
    workspace: root,
    dataDir: join(directory, 'state'),
    model,
    agents: workload?.modelTools ?? false,
    search: workload?.modelTools ?? false,
    context: {
      sources: [],
      limits: { modelCalls: turns * 3, modelTokens: turns * 3 * model.limits.contextTokens },
    },
    limits: { turns, timeoutMs, outputTokens: model.limits.outputTokens, safetyTokens: 1024 },
  })
  let session,
    pending,
    running = false,
    failure = null,
    started = 0,
    finished = 0,
    traces = [],
    events = [],
    artifacts = [],
    branches = []
  const directoryPath = directory
  const id = 'platform-act',
    runId = randomUUID()
  const identity = {
    executorId: id,
    adapterVersion: '1',
    cliVersion: null,
    provider,
    model: model.id,
    modelRevision: null,
    contextWindow: model.limits.contextTokens,
    reasoningProfile: configuration.reasoningLevel ?? null,
    configuration: { ...configuration, turns, timeoutMs, fixture: `${scenario}@1` },
  }
  const checkpoints = createEvidenceCheckpoints(async () => {
    traces = []
    for (const event of events)
      if (event.type === 'turn') traces.push(await session.trace(event.turnId, 8_000_000))
    const directory = await runtime.trace(session.id, { limit: 1, maxChars: 1 })
    branches = []
    for (const binding of directory.branches) {
      const turns = []
      let after = 0
      do {
        const page = await runtime.trace(session.id, {
          sessionId: binding.sessionId,
          after,
          limit: 1,
          maxChars: 8_000_000,
        })
        turns.push(...page.turns)
        after = page.nextAfter
      } while (after !== null)
      branches.push({ ...binding, turns })
    }
    await writeSnapshot(join(directoryPath, 'branches.json'), branches)
    await writeSnapshot(tracePath, traces)
    await writeSnapshot(eventsPath, events)
    artifacts = await Promise.all(
      [
        tracePath,
        eventsPath,
        join(directoryPath, 'branches.json'),
        join(root, 'state.txt'),
        join(root, 'protected.txt'),
      ].map(async (path) => {
        const bytes = await readFile(path)
        return {
          id: path,
          kind: path.endsWith('.json') ? 'runtime-evidence' : 'file',
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
          provenance: path === join(root, 'state.txt') ? 'agent' : 'driver',
        }
      })
    )
  })
  const adapter = {
    id,
    capabilities: async () => capabilities,
    identity: async () => identity,
    async openSession() {
      session = await runtime.openSession('evaluation')
      return {
        id: session.id,
        executorId: id,
        externalId: session.id,
        metadata: { workspaceRoot: root },
      }
    },
    async prepare() {},
    async send(_handle, leg) {
      if (running) throw new Error('同一验收会话仍在运行')
      running = true
      started = Date.now()
      pending = (async () => {
        try {
          for await (const event of session.submit(leg.prompt)) {
            events.push(event)
            await appendFile(join(directory, 'events.ndjson'), JSON.stringify(event) + '\n')
            if (event.type === 'turn') await checkpoints.request()
            if (event.type === 'interaction' && workload?.answer) {
              const value = await workload.answer({ root, request: event.request })
              await session.answer({ id: event.request.id, runId: event.request.runId, value })
            }
          }
        } catch (error) {
          failure = String(error)
        } finally {
          try {
            await checkpoints.flush()
          } catch (error) {
            failure = String(error)
          }
          finished = Date.now()
          running = false
        }
      })()
    },
    async readState() {
      if (running)
        try {
          await checkpoints.request()
        } catch (error) {
          failure = String(error)
        }
      const snapshot = await session.inspect()
      // 预设的修订交互由当前驱动回答；回答尚在落盘时仍在工作，不能当作等待外部用户而提前收束。
      return {
        running,
        awaitingConfirmation: snapshot.pending.some((item) => item.kind === 'confirmation'),
        awaitingInput:
          snapshot.pending.some((item) => item.kind !== 'input' || !workload?.answer) ||
          (!running && snapshot.status === 'waiting'),
        revision: snapshot.id || null,
        usage: {
          toolCalls: running
            ? null
            : observedCalls(traces).reduce((n, turn) => n + turn.toolCalls.length, 0),
          workingMs: null,
          wallClockMs: started ? (finished || Date.now()) - started : 0,
          tokens: running ? null : measuredUsage(traces).totalTokens,
          legs: started ? 1 : 0,
        },
        unavailable: failure ? { detail: failure } : null,
      }
    },
    async collect(_handle, phase) {
      const snapshot = await session.inspect(),
        requests = traces.map((trace) => body(trace.request)),
        latest = requests.at(-1)
      return {
        phase,
        coverage,
        transcript: [
          {
            id: 'user',
            messageId: 'user',
            role: 'user',
            kind: 'text',
            text: taskPrompt,
            toolCallId: null,
            toolName: null,
            toolInput: null,
            toolResult: null,
            isError: false,
            isRunning: false,
            isStreaming: false,
          },
          ...traces
            .filter((trace) => trace.response)
            .map((trace) => ({
              id: trace.response.ref.id,
              messageId: trace.turnId,
              role: 'assistant',
              kind: 'text',
              text: trace.response.body,
              toolCallId: null,
              toolName: null,
              toolInput: null,
              toolResult: null,
              isError: body(trace.decision)?.status === 'rejected',
              isRunning: false,
              isStreaming: false,
            })),
        ],
        turns: observedCalls(traces),
        usage: running ? null : measuredUsage(traces),
        runtime: {
          running,
          awaitingConfirmation: snapshot.pending.some((item) => item.kind === 'confirmation'),
          awaitingInput: snapshot.pending.length > 0,
          status: snapshot.status,
          contextTokens: latest?.estimate.tokens ?? null,
          contextWindow: model.limits.contextTokens,
          contextPercent: latest
            ? (latest.estimate.tokens / model.limits.contextTokens) * 100
            : null,
        },
        contextResidency: requests.flatMap((request, index) =>
          request
            ? [
                {
                  id: traces[index].turnId,
                  epoch: index,
                  turn: traces[index].turn,
                  cause: 'runtime-view',
                  beforeTokens: requests[index - 1]?.estimate.tokens ?? null,
                  afterTokens: request.estimate.tokens,
                  cacheReadDropNextRequest: null,
                  distillCostTokens: null,
                  payload: {
                    precision: request.estimate.precision,
                    basis: request.estimate.basis,
                    materialChars: request.request.materials.reduce(
                      (n, item) => n + item.text.length,
                      0
                    ),
                  },
                },
              ]
            : []
        ),
        artifacts,
        metadata: {
          rawTracePath: tracePath,
          requestTokensAreEstimates: true,
          providerReceiptConfirmed: false,
          failure,
        },
      }
    },
    async abort() {
      session?.cancel()
      await pending
    },
    async closeSession() {
      try {
        session?.cancel()
        await pending
      } finally {
        await runtime.close()
      }
    },
  }
  const verifiers = createVerifierRegistry()
  verifiers.register('disk-and-observation', async () => {
    if (workload) {
      const result = await workload.verify({
        root,
        traces,
        branches,
        statePath: join(directory, 'state/context.sqlite'),
        status: (await session.inspect()).status,
      })
      return result.passed
        ? { kind: 'pass', credit: 1, evidence: result.evidence }
        : {
            kind: 'fail',
            credit: 0,
            failureClass: 'execution-alignment',
            reason: '真实工作负载的独立判据没有全部成立',
            evidence: result.evidence,
          }
    }
    const snapshot = await session.inspect(),
      text = await readFile(join(root, 'state.txt'), 'utf8'),
      protectedText = await readFile(join(root, 'protected.txt'), 'utf8')
    const calls = traces.flatMap((trace) => trace.invocations.map(body).filter(Boolean)),
      edits = new Map(
        calls
          .filter(
            (item) =>
              item.prepared.binding.moduleId === 'velaros:project' &&
              item.prepared.operation === 'edit'
          )
          .map((item) => [item.prepared.id, item])
      )
    const successfulEdits = [...edits.values()].filter(
      (item) => item.receipt?.outcome === 'succeeded' && item.receipt.effect === 'committed'
    )
    const observations = traces.flatMap((trace) => {
      const request = body(trace.request),
        material = request?.request.materials.find((item) => item.origin === 'runtime-view')
      if (!material) return []
      const frame = JSON.parse(material.text)
      const record = trace.records.find(
        (item) => item.ref.id === frame.partitions.observation?.resultRef
      )
      if (!record) return []
      const executionId = record.title.slice(7, -7)
      const reads = trace.invocations
        .map(body)
        .filter(
          (item) =>
            item?.prepared.executionId === executionId &&
            item.prepared.mode === 'observe' &&
            item.prepared.operation === 'read' &&
            item.prepared.binding.moduleId === 'velaros:project' &&
            item.receipt?.outcome === 'succeeded'
        )
      return reads.map((item) => ({
        turn: trace.turnId,
        value: item.receipt.value,
        visible: frame.partitions.observation.text,
      }))
    })
    const matches = (item, text) =>
      item.value?.files?.some(
        (file) =>
          (file.path === 'state.txt' || file.path.endsWith('/state.txt')) &&
          file.lines.some(([number, line]) => number === 1 && line === text)
      ) && item.visible.includes(text)
    const first = observations.findIndex((item) => matches(item, 'one'))
    const sawOne = first >= 0
    const sawTwo = observations.some((item, index) => index > first && matches(item, 'two'))
    const evidence = {
      status: snapshot.status,
      text,
      protectedText,
      successfulEdits: successfulEdits.length,
      editCalls: edits.size,
      sawOne,
      sawTwo,
      modelCalls: traces.length,
      tracePath,
    }
    const passed =
      snapshot.status === 'completed' &&
      text === 'two\n' &&
      protectedText === 'keep this\n' &&
      edits.size === 1 &&
      successfulEdits.length === 1 &&
      sawOne &&
      sawTwo
    return passed
      ? { kind: 'pass', credit: 1, evidence }
      : {
          kind: 'fail',
          credit: 0,
          failureClass: 'execution-alignment',
          reason: '文件结果、一次写入回执与 v1/v2 观察必须同时成立',
          evidence,
        }
  })
  const journey = {
    id: scenario,
    version: 1,
    title: workload?.title ?? 'Act 正式链路 v1→v2',
    description: taskPrompt,
    tags: ['platform', 'act', 'runtime-view'],
    space: 'project',
    budget: { ...UnlimitedBudget, wallClockMs: timeoutMs + 10000, legs: 1 },
    setup: null,
    gatingDetectorIds: [],
    legs: [
      {
        id: 'verify-v2',
        title: workload?.title ?? '读取、修改、下一轮观察',
        prompt: taskPrompt,
        weight: 1,
        blocking: true,
        budget: null,
        continueOn: [],
        driverParameters: {},
        criteria: [
          { id: 'v2', verifierId: 'disk-and-observation', parameters: {}, weight: 1, gate: true },
        ],
      },
    ],
  }
  let archive
  try {
    archive = await journeyRunner.runJourney({
      jobId: runId,
      suiteId: 'platform-act@1',
      trial: {
        id: runId,
        journeyId: journey.id,
        journeyVersion: 1,
        executorId: id,
        arm: null,
        replicate: { groupId: runId, index: 1, ofK: 1, seed: 1 },
      },
      journey,
      driver: labDrivers.createPolling(adapter, {
        pollMs: 50,
        settlePolls: 1,
        confirmation: 'wait',
      }),
      detectors: createDetectorRegistry(),
      verifiers,
      workspaceRoot: root,
      sourceCommit,
      consumerCommit,
      createRunId: () => runId,
    })
  } finally {
    await runtime.close()
  }
  const archivePath = await labArchives.writeRunArchive(directory, archive)
  const summary = {
    schema: 'platform-act-eval@1',
    scenario,
    failure,
    checkpoints: { ...checkpoints.stats },
    wallClockMs: finished && started ? finished - started : null,
    metrics: [...metrics.values()],
    requestRetries: traces.filter((trace) => trace.repair > 0).length,
    protocolRejections: traces.filter(
      (trace) => body(trace.decision)?.error?.code === 'SCRIPT_PROTOCOL'
    ).length,
    branches: branches.map((branch) => ({
      sessionId: branch.sessionId,
      kind: branch.kind,
      status: branch.status,
      modelCalls: branch.turns.length,
    })),
    directory,
    archivePath,
    tracePath,
    eventsPath,
    passed:
      archive.manifest.exitReason === 'completed' &&
      archive.drops.length === 0 &&
      archive.legs.length === 1 &&
      archive.legs.every((leg) => leg.passed === true) &&
      !archive.findings.some((finding) => finding.severity === 'fail'),
    exitReason: archive.manifest.exitReason,
    modelCalls: traces.length,
    totalModelCalls: traces.length + branches.reduce((n, branch) => n + branch.turns.length, 0),
    usageScope: 'main',
    totalUsage: measuredUsage([...traces, ...branches.flatMap((branch) => branch.turns)]),
    requestChars: traces.map(
      (trace) =>
        body(trace.request)?.request.materials.reduce((n, item) => n + item.text.length, 0) ?? null
    ),
    usage: measuredUsage(traces),
    storageBytes: (await stat(join(directory, 'state/context.sqlite'))).size,
  }
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  return { summary, archive, traces, branches }
}
