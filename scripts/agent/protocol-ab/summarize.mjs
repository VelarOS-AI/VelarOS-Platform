#!/usr/bin/env node
// 保留原始成绩，按公开验收政策成对比较；未完成全部预定尝试不选默认值。
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
const policy = JSON.parse(await readFile(join(directory, 'score-policy.json'), 'utf8'))
const ids = new Set()
for (const row of results) {
  const id = `${row.task}:${row.repeat}:${row.transport}`
  assert(!ids.has(id), `Duplicate trial: ${id}`)
  ids.add(id)
}
const expected = manifest.cases.flatMap((task) =>
  Array.from({ length: manifest.repetitions }, (_, index) =>
    ['text', 'tools'].map((transport) => `${task.id}:${index + 1}:${transport}`)
  ).flat()
)
const missing = expected.filter((id) => !ids.has(id))
const selected = results.filter((row) => !policy.excludedTasks.includes(row.task))
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function aggregate(rows) {
  const completeUsage =
    rows.length > 0 && rows.every((row) => row.completeUsage && row.wireCount === row.requestCount)
  const cacheComplete = completeUsage && rows.every((row) => row.cacheComplete)
  return {
    trials: rows.length,
    passed: rows.filter((row) => row.success).length,
    requests: sum(rows, 'requestCount'),
    wireRequests: sum(rows, 'wireCount'),
    repairs: rows.reduce((total, row) => total + (row.repairErrors?.length ?? 0), 0),
    elapsedSeconds: sum(rows, 'elapsedMs') / 1000,
    medianSeconds: rows.length ? median(rows.map((row) => row.elapsedMs)) / 1000 : null,
    inputTokens: sum(rows, 'inputTokens'),
    outputTokens: sum(rows, 'outputTokens'),
    cacheReadTokens: sum(rows, 'cacheReadTokens'),
    completeUsage,
    cacheComplete,
    referenceCachedUsd: cacheComplete ? sum(rows, 'referenceCachedUsd') : null,
    referenceUncachedUsd: completeUsage ? sum(rows, 'referenceUncachedUsd') : null,
  }
}
const groups = Object.fromEntries(
  ['text', 'tools'].map((mode) => [
    mode,
    aggregate(selected.filter((row) => row.transport === mode)),
  ])
)
const rawGroups = Object.fromEntries(
  ['text', 'tools'].map((mode) => [
    mode,
    aggregate(results.filter((row) => row.transport === mode)),
  ])
)
let winner = null,
  decidingMetric = null
if (!missing.length) {
  const costKey =
    groups.text.cacheComplete && groups.tools.cacheComplete
      ? 'referenceCachedUsd'
      : 'referenceUncachedUsd'
  for (const [key, direction] of [
    ['passed', -1],
    [costKey, 1],
    ['requests', 1],
    ['elapsedSeconds', 1],
  ]) {
    if (groups.text[key] == null || groups.tools[key] == null) continue
    const delta = groups.text[key] - groups.tools[key]
    if (Math.abs(delta) < 1e-9) continue
    winner = delta * direction < 0 ? 'text' : 'tools'
    decidingMetric = key
    break
  }
}
const summary = {
  model: manifest.model,
  reasoning: manifest.reasoning,
  suiteHash: manifest.suiteHash,
  snapshotManifestSha256: manifest.snapshotManifestSha256,
  selectedTasks: manifest.cases
    .map((task) => task.id)
    .filter((id) => !policy.excludedTasks.includes(id)),
  policy,
  referencePricing: manifest.referencePricing,
  missing,
  groups,
  rawGroups,
  winner,
  decidingMetric,
  trials: results.map(({ repairErrors, failure, gradeError, ...row }) => ({
    ...row,
    repairs: repairErrors?.length ?? 0,
    failure,
    gradeError,
  })),
}
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ complete: !missing.length, groups, winner, decidingMetric }, null, 2))
