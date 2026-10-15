#!/usr/bin/env node
// 汇总各层的原始证据；未知用量与参考报价不转换成完整账单。
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readCapabilityUsage } from './capability-usage.mjs'
import { nodeRegressionReport, nodeTestSummary } from './node-task.mjs'
import { workspaceChanges } from './workspace-changes.mjs'

// 自动评分、运行终态与完整交付是不同证据；字段缺失保持未知，不能由退出或空闲推断成功。
export function completionSummary(participant, solve, grade, { taskMode = 'request' } = {}) {
  let terminalComplete = null
  let basis = 'No authoritative successful terminal was recorded'
  if (participant === 'codex') {
    if (
      solve.terminalComplete === false ||
      (Number.isInteger(solve.code) && solve.code !== 0) ||
      solve.signal ||
      solve.timedOut === true ||
      solve.cancelled === true ||
      solve.inputError
    ) {
      terminalComplete = false
      basis = 'Codex recorded a failed, interrupted or unsuccessful process/turn outcome'
    } else if (solve.terminalComplete === true && solve.code === 0) {
      terminalComplete = true
      basis = 'Codex recorded terminalComplete=true and a clean exit'
    }
  } else if (['failed', 'waiting', 'cancelled'].includes(solve.status)) {
    terminalComplete = false
    basis = `Runtime stopped with status ${solve.status}`
  } else if (solve.host === 'desktop') {
    basis = 'Desktop settlement and trace coverage do not expose a successful task terminal'
  } else if (solve.status === 'completed') {
    if (taskMode !== 'goal') {
      terminalComplete = true
      basis = 'Runtime recorded a completed request'
    } else if (solve.goalSnapshotError) {
      basis = 'Runtime ended but its goal snapshot could not be read'
    } else if (solve.goal?.status === 'complete') {
      terminalComplete = true
      basis = 'Runtime completed and its persisted goal is complete'
    } else if (typeof solve.goal?.status === 'string') {
      terminalComplete = false
      basis = `Runtime ended but its persisted goal remains ${solve.goal.status}`
    } else basis = 'Runtime ended without a readable persisted goal completion'
  }
  const automaticChecksPassed = typeof grade.passed === 'boolean' ? grade.passed : null
  const completedWithPassingChecks =
    terminalComplete === false || automaticChecksPassed === false
      ? false
      : terminalComplete === true && automaticChecksPassed === true
        ? true
        : null
  return {
    terminalComplete,
    terminalBasis: basis,
    automaticChecksPassed,
    completedWithPassingChecks,
    fullDeliveryVerified: null,
    fullDeliveryBasis:
      'Retained requested artifacts, validation coverage and task-specific obligations require a separate delivery audit',
  }
}

export function requestOwner(request) {
  const material = request.materials[0]
  const frame = JSON.parse(material.text)
  if (material.origin === 'context-narration' && frame.kind === 'context-narration')
    return typeof frame.sessionId === 'string' ? frame.sessionId : 'unknown'
  return frame.partitions?.task?.goals?.[0]?.record?.ref?.sessionId ?? 'unknown'
}

// 汇总需要计数与最后一个主请求的提示保留状态，不保留所有历史请求正文。
export async function readRuntimeRequestSummary(directory, manifest) {
  const names = (await readdir(directory)).filter((name) => /^\d+\.json$/u.test(name)).sort()
  if (!names.length) throw new Error('Missing Runtime request inventory')
  const originalPrompt = JSON.stringify(
    manifest.executionEnvironments?.scriptact?.prompt ?? manifest.prompt
  ).slice(1, -1)
  const result = {
    mainRequests: 0,
    branchRequests: 0,
    completionReviewRequests: 0,
    requestOwners: {},
    contextSegments: -Infinity,
    nativeRequests: 0,
    textProtocolRequests: 0,
    structuredNarrationRequests: 0,
    originalPromptInFinalRequest: false,
  }
  let rootKey
  for (const [index, name] of names.entries()) {
    const { request } = JSON.parse(await readFile(join(directory, name), 'utf8'))
    if (index === 0) rootKey = request.cacheKey
    if (request.cacheKey === rootKey) {
      result.mainRequests++
      result.contextSegments = Math.max(
        result.contextSegments,
        request.contextStatus?.segment?.index ?? 1
      )
      result.originalPromptInFinalRequest = JSON.stringify(request.history).includes(originalPrompt)
    } else result.branchRequests++
    const owner = requestOwner(request)
    result.requestOwners[owner] = (result.requestOwners[owner] ?? 0) + 1
    if (request.materials.some((material) => material.origin.startsWith('completion-')))
      result.completionReviewRequests++
    if (request.response.type === 'tools') result.nativeRequests++
    if (request.response.type === 'text') result.textProtocolRequests++
    if (request.materials[0]?.origin === 'context-narration') result.structuredNarrationRequests++
  }
  return result
}

export function summarizeRequests(requests, rejected = []) {
  const measured = requests.filter((request) =>
    ['input_tokens', 'output_tokens'].every(
      (key) => Number.isFinite(request.usage?.[key]) && request.usage[key] >= 0
    )
  )
  const priced = requests.filter((request) => Number.isFinite(request.estimatedUsd))
  const sum = (key) => measured.reduce((total, request) => total + request.usage[key], 0)
  const cached = measured.filter((request) =>
    Number.isFinite(request.usage.input_tokens_details?.cached_tokens)
  )
  const cachedTokens = cached.reduce(
    (total, request) => total + request.usage.input_tokens_details.cached_tokens,
    0
  )
  const inputTokens = sum('input_tokens')
  const durations = requests
    .map((request) => request.durationMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right)
  return {
    requests: requests.length,
    rejectedBeforeDispatch: rejected.length,
    rejectionCodes: rejected.reduce(
      (counts, request) => ({ ...counts, [request.code]: (counts[request.code] ?? 0) + 1 }),
      {}
    ),
    requestStatuses: requests.reduce(
      (counts, request) => ({ ...counts, [request.status]: (counts[request.status] ?? 0) + 1 }),
      {}
    ),
    measuredRequests: measured.length,
    missingUsageRequests: requests.length - measured.length,
    tokenCoverage:
      requests.length === 0
        ? 'unknown'
        : measured.length === requests.length
          ? 'complete'
          : 'partial',
    knownInputTokens: inputTokens,
    knownOutputTokens: sum('output_tokens'),
    knownCachedInputTokens: cachedTokens,
    knownCacheRatio:
      cached.length === measured.length && inputTokens > 0 ? cachedTokens / inputTokens : null,
    pricedRequests: priced.length,
    knownReferenceUsd: priced.reduce((total, request) => total + request.estimatedUsd, 0),
    totalReferenceUsd:
      requests.length > 0 && priced.length === requests.length
        ? priced.reduce((total, request) => total + request.estimatedUsd, 0)
        : null,
    unknownUsageReservationUsd: requests
      .filter((request) => request.estimatedUsd === null)
      .reduce((total, request) => total + (request.budgetUsd ?? 0), 0),
    providerDurations: {
      measuredRequests: durations.length,
      summedMs: durations.reduce((total, value) => total + value, 0),
      p50Ms: durations.length ? durations[Math.ceil(durations.length * 0.5) - 1] : null,
      p95Ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
      meaning:
        'Physical upstream duration per request; overlapping requests are not task wall time',
    },
    costBasis: 'frozen-reference-pricing; not a provider invoice',
  }
}

// 支线按产品保存的类型计数；摘要响应获接纳不等于已证明父会话成功发布了整理补丁。
export function desktopBranchEvidence(pages, rootSessionId) {
  const bindings = new Map(
    pages.flatMap((page) => page.branches ?? []).map((branch) => [branch.sessionId, branch])
  )
  const counts = {}
  let acceptedMaintenanceResponses = 0
  let rejectedMaintenanceResponses = 0
  for (const page of pages) {
    const kind =
      page.sessionId === rootSessionId ? 'main' : (bindings.get(page.sessionId)?.kind ?? 'unknown')
    counts[kind] = (counts[kind] ?? 0) + page.turns.length
    if (kind === 'context') {
      acceptedMaintenanceResponses += page.turns.filter(
        (turn) => turn.response === 'accepted'
      ).length
      rejectedMaintenanceResponses += page.turns.filter(
        (turn) => turn.response === 'rejected'
      ).length
    }
  }
  return {
    modelTurnsByKind: counts,
    maintenanceBranches: [...bindings.values()].filter((branch) => branch.kind === 'context')
      .length,
    acceptedMaintenanceResponses,
    rejectedMaintenanceResponses,
    appliedMaintenanceOutcomes: null,
  }
}

export function pytestSummary(result) {
  const text = result.stdout ?? ''
  const summary =
    text
      .split('\n')
      .findLast((line) => /\d+ (?:passed|failed|skipped|errors?)(?:,| in|=|$)/u.test(line)) ?? ''
  const counts = Object.fromEntries(
    [...summary.matchAll(/(\d+) (passed|failed|skipped|errors?)/gu)].map((match) => [
      match[2],
      Number(match[1]),
    ])
  )
  return {
    exitCode: result.exitCode,
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    skipped: counts.skipped ?? 0,
    errors: counts.errors ?? counts.error ?? 0,
    summary,
    failures: text.split('\n').filter((line) => line.startsWith('FAILED ')),
  }
}

export function regressionSummary(result, runner) {
  if (
    ['mocha-json', 'jest-json', 'ava-tap', 'vitest-json', 'tap-json', 'node-json'].includes(runner)
  ) {
    try {
      return {
        ...(result.summary ?? nodeRegressionReport(result, '', runner).summary),
        ...(result.verdict ? { verdict: result.verdict } : {}),
      }
    } catch (error) {
      return {
        exitCode: result.exitCode,
        passed: 0,
        failed: 0,
        skipped: 0,
        errors: 1,
        summary: String(error),
        failures: [],
        ...(result.verdict ? { verdict: result.verdict } : {}),
      }
    }
  }
  if (runner !== 'unittest')
    return {
      ...pytestSummary(result),
      ...(result.verdict ? { verdict: result.verdict } : {}),
    }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const ran = Number(text.match(/Ran (\d+) tests? in /u)?.[1] ?? 0)
  const summary = text.split('\n').findLast((line) => /^(?:OK|FAILED)(?: \(|$)/u.test(line)) ?? ''
  const count = (name) => Number(summary.match(new RegExp(`${name}=(\\d+)`, 'u'))?.[1] ?? 0)
  const failed = count('failures'),
    errors = count('errors'),
    skipped = count('skipped')
  return {
    exitCode: result.exitCode,
    passed: Math.max(0, ran - failed - errors - skipped),
    failed,
    skipped,
    errors,
    summary,
    failures: text.split('\n').filter((line) => /^(?:FAIL|ERROR): /u.test(line)),
  }
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

// Codex 目录按宿主日期保存；运行与冻结时间可能跨午夜，也可能与 UTC 日期不同。
export async function findCodexRollout(sessions, threadId, startedAt, finishedAt) {
  const dayMs = 86400000
  for (
    let day = Math.floor(startedAt / dayMs) - 1;
    day <= Math.floor(finishedAt / dayMs) + 1;
    day++
  ) {
    const directory = join(sessions, ...new Date(day * dayMs).toISOString().slice(0, 10).split('-'))
    const files = await readdir(directory).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const name = files.find((file) => file.endsWith(`-${threadId}.jsonl`))
    if (name) return join(directory, name)
  }
  return null
}

async function main() {
  const directory = resolve(process.argv[2])
  const metricsName = process.argv[3] ?? 'metrics.json'
  if (!/^metrics(?:-[a-z0-9-]+)?\.json$/u.test(metricsName))
    throw new Error('Expected a metrics JSON filename inside the attempt directory')
  const manifest = await json(join(directory, 'freeze.json'))
  const budget = await json(join(directory, 'gateway/budget.json'))
  const results = {}
  for (const participant of manifest.participants ?? ['scriptact', 'codex']) {
    const output = join(directory, participant)
    const solve = await json(join(output, 'solve.json'))
    const grade = await json(join(output, 'grade.json'))
    const baseline = await json(join(output, 'workspace-baseline.json')).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    // 老控制器只统计未暂存 diff；原始评分文件保持原样，单独附上起点核对结果。
    const changes = grade.changeAccounting
      ? grade
      : await workspaceChanges(
          join(
            manifest.taskRoot,
            participant,
            manifest.environment?.project ?? basename(manifest.source)
          ),
          baseline?.commit
        ).catch((error) => ({
          ...grade,
          changeAccounting: {
            source: 'legacy-grade-only',
            includesCommittedChanges: false,
            error: String(error),
          },
        }))
    results[participant] = {
      solve,
      ...(grade.build ? { build: grade.build } : {}),
      accounting: summarizeRequests(
        budget.requests.filter((request) => request.identity.participantId === participant),
        (budget.rejectedRequests ?? []).filter(
          (request) => request.identity?.participantId === participant
        )
      ),
      acceptance: (manifest.environment?.runtime === 'node' ? nodeTestSummary : pytestSummary)(
        await json(join(output, 'acceptance.json'))
      ),
      regression: regressionSummary(
        await json(join(output, 'regression.json')),
        manifest.environment?.regressionRunner
      ),
      passed: grade.passed,
      completion: completionSummary(participant, solve, grade, {
        taskMode: manifest.scriptactTaskMode ?? 'request',
      }),
      featureCompleteWithoutNewRegressions:
        grade.featureCompleteWithoutNewRegressions ?? grade.passed,
      changedFiles:
        changes.changeAccounting.changedFiles ??
        (changes.changed.trim() ? changes.changed.trim().split('\n').length : 0),
      createdFiles:
        changes.changeAccounting.createdFiles ??
        (changes.created.trim() ? changes.created.trim().split('\n').length : 0),
      changeSummary: changes.changed,
      created: changes.created,
      changeAccounting: changes.changeAccounting,
    }
  }
  if (manifest.desktop) {
    const pages = []
    for (const name of (await readdir(join(directory, 'scriptact')))
      .filter((name) => /^trace-\d+\.json$/u.test(name))
      .sort()) {
      pages.push(await json(join(directory, 'scriptact', name)))
    }
    const metrics = await json(join(directory, 'scriptact/desktop-trace-summary.json'))
    const main = pages.find((page) => page.sessionId === manifest.scriptactSessionId)
    results.scriptact.execution = {
      host: 'desktop',
      ...metrics,
      ...desktopBranchEvidence(pages, manifest.scriptactSessionId),
      mainModelTurns: main?.turns.length ?? 0,
      branchModelTurns: pages
        .filter((page) => page !== main)
        .reduce((sum, page) => sum + page.turns.length, 0),
      contextSegments: null,
      contextEvidence:
        'Full product requests and responses are preserved in trace pages; segment count is not exposed by this IPC.',
    }
    results.scriptact.capabilityUsage = {
      available: pages.length > 0,
      complete: results.scriptact.solve.evidenceComplete,
      operations: metrics.kernelOperations,
    }
  } else {
    results.scriptact.execution = await readRuntimeRequestSummary(
      join(directory, 'scriptact/requests'),
      manifest
    )
    results.scriptact.capabilityUsage = await readCapabilityUsage(
      join(directory, 'scriptact/traces.json')
    )
  }
  if (results.codex) {
    const events = (await readFile(join(directory, 'codex/codex.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    const threadId = events.find((event) => event.type === 'thread.started')?.thread_id ?? null
    const sessions = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
    const destination = join(directory, 'codex/root-rollout.jsonl')
    let archived = await readFile(destination, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const source =
      archived !== null
        ? destination
        : threadId &&
          (await findCodexRollout(
            sessions,
            threadId,
            results.codex.solve.startedAt,
            results.codex.solve.finishedAt
          ))
    if (source) {
      if (archived === null) {
        await cp(source, destination)
        archived = await readFile(destination, 'utf8')
      }
      const records = archived.trim().split('\n').map(JSON.parse)
      results.codex.execution = {
        rootThreadId: threadId,
        compactions: records.filter((record) => record.type === 'compacted').length,
        childAgentDispatches: records.filter(
          (record) => record.type === 'response_item' && record.payload?.name === 'spawn_agent'
        ).length,
        source,
      }
    } else
      results.codex.execution = {
        rootThreadId: threadId,
        compactions: null,
        childAgentDispatches: null,
      }
  }
  const value = {
    schema: 1,
    at: new Date().toISOString(),
    taskId: manifest.task.id,
    scriptactSessionId: manifest.scriptactSessionId ?? 'development',
    candidateId: manifest.candidateId,
    candidateSourceCommit: manifest.candidateSourceCommit,
    candidateSourceDirty: manifest.candidateSourceDirty ?? null,
    scriptactCapabilities: manifest.scriptactCapabilities ?? 'on-demand',
    scriptactTaskMode: manifest.scriptactTaskMode ?? 'request',
    scriptactEditingStrategy: manifest.scriptactEditingStrategy ?? 'adaptive',
    completionReview: {
      configured: Boolean(manifest.desktop || manifest.runtimeCompletion),
      artifactAdapter: manifest.runtimeCompletion ?? null,
    },
    split: manifest.task.split,
    model: manifest.model,
    contextTokens: manifest.contextTokens,
    inputWindowTokens: manifest.inputWindowTokens,
    evaluatorRecovery: await json(join(directory, 'recovery.json')).catch(() => null),
    baselineRegression: manifest.baselineRegression?.verdict ?? null,
    results,
  }
  await writeFile(join(directory, metricsName), JSON.stringify(value, null, 2))
  console.log(JSON.stringify(value, null, 2))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main()
