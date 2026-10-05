#!/usr/bin/env node
// 汇总各层的原始证据；未知用量与参考报价不转换成完整账单。
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { mochaReport, nodeTestSummary } from './node-task.mjs'
import { workspaceChanges } from './workspace-changes.mjs'

export function requestOwner(request) {
  const material = request.materials[0]
  const frame = JSON.parse(material.text)
  if (material.origin === 'context-narration' && frame.kind === 'context-narration')
    return typeof frame.sessionId === 'string' ? frame.sessionId : 'unknown'
  return frame.partitions?.task?.goals?.[0]?.record?.ref?.sessionId ?? 'unknown'
}

export function summarizeRequests(requests) {
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
  return {
    requests: requests.length,
    requestStatuses: requests.reduce(
      (counts, request) => ({ ...counts, [request.status]: (counts[request.status] ?? 0) + 1 }),
      {}
    ),
    measuredRequests: measured.length,
    missingUsageRequests: requests.length - measured.length,
    tokenCoverage: measured.length === requests.length ? 'complete' : 'partial',
    knownInputTokens: inputTokens,
    knownOutputTokens: sum('output_tokens'),
    knownCachedInputTokens: cachedTokens,
    knownCacheRatio:
      cached.length === measured.length && inputTokens > 0 ? cachedTokens / inputTokens : null,
    pricedRequests: priced.length,
    knownReferenceUsd: priced.reduce((total, request) => total + request.estimatedUsd, 0),
    totalReferenceUsd:
      priced.length === requests.length
        ? priced.reduce((total, request) => total + request.estimatedUsd, 0)
        : null,
    costBasis: 'frozen-reference-pricing; not a provider invoice',
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
  if (runner === 'mocha-json') {
    try {
      return {
        ...(result.summary ?? mochaReport(result, '').summary),
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
      accounting: summarizeRequests(
        budget.requests.filter((request) => request.identity.participantId === participant)
      ),
      acceptance: (manifest.environment?.runtime === 'node' ? nodeTestSummary : pytestSummary)(
        await json(join(output, 'acceptance.json'))
      ),
      regression: regressionSummary(
        await json(join(output, 'regression.json')),
        manifest.environment?.regressionRunner
      ),
      passed: grade.passed,
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
  const requests = []
  for (const name of (await readdir(join(directory, 'scriptact/requests')))
    .filter((name) => /^\d+\.json$/u.test(name))
    .sort())
    requests.push(await json(join(directory, 'scriptact/requests', name)))
  const rootKey = requests[0].request.cacheKey
  const mainRequests = requests.filter((request) => request.request.cacheKey === rootKey)
  const owners = {}
  for (const request of requests) {
    const session = requestOwner(request.request)
    owners[session] = (owners[session] ?? 0) + 1
  }
  results.scriptact.execution = {
    mainRequests: mainRequests.length,
    branchRequests: requests.length - mainRequests.length,
    requestOwners: owners,
    contextSegments: Math.max(
      ...mainRequests.map((request) => request.request.contextStatus?.segment?.index ?? 1)
    ),
    nativeRequests: requests.filter((request) => request.request.response.type === 'tools').length,
    textProtocolRequests: requests.filter((request) => request.request.response.type === 'text')
      .length,
    structuredNarrationRequests: requests.filter(
      (request) => request.request.materials[0]?.origin === 'context-narration'
    ).length,
    originalPromptInFinalRequest: JSON.stringify(mainRequests.at(-1).request.history).includes(
      JSON.stringify(manifest.executionEnvironments?.scriptact?.prompt ?? manifest.prompt).slice(
        1,
        -1
      )
    ),
  }
  if (results.codex) {
    const events = (await readFile(join(directory, 'codex/codex.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    const threadId = events.find((event) => event.type === 'thread.started').thread_id
    const sessions = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
    const source = await findCodexRollout(
      sessions,
      threadId,
      results.codex.solve.startedAt,
      results.codex.solve.finishedAt
    )
    if (source) {
      const destination = join(directory, 'codex/root-rollout.jsonl')
      await cp(source, destination)
      const records = (await readFile(destination, 'utf8')).trim().split('\n').map(JSON.parse)
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
    split: manifest.task.split,
    model: manifest.model,
    contextTokens: manifest.contextTokens,
    inputWindowTokens: manifest.inputWindowTokens,
    evaluatorRecovery: await json(join(directory, 'recovery.json')).catch(() => null),
    baselineRegression: manifest.baselineRegression?.verdict ?? null,
    results,
  }
  await writeFile(join(directory, 'metrics.json'), JSON.stringify(value, null, 2))
  console.log(JSON.stringify(value, null, 2))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main()
