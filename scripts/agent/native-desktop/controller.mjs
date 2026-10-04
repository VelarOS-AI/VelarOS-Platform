// 用途：运行一组可见 Desktop ScriptAct / 后台 Codex 原生配对，冻结候选并保留完整失败与结算。
import { execFile } from 'node:child_process'
import { open, readFile, writeFile, mkdir, readdir, stat, realpath, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadavg, freemem } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { attemptCredential } from '../harbor/request-identity.mjs'
import { normalizedGenerationPolicy } from '../harbor/budget-proxy.mjs'
import { readTraceArtifact } from '../harbor/trace-artifact.mjs'
import {
  cdpClient,
  configureModel,
  desktopClient,
  dispatch,
  privateJson,
  restoreModel,
  sha256,
  waitForSettlement,
} from './client.mjs'
import { runCodex } from './codex.mjs'
import { codexPolicyAudit, scriptPolicyAudit } from './audit.mjs'
import { nativeContextPolicy, observedInputWindows } from './context-window.mjs'

const execute = promisify(execFile)

/** 派发前原子取得两层租约；本地尝试冲突时撤回本次新建的全局租约。 */
export async function acquireControllerLeases(globalPath, localPath, identity) {
  const globalLease = await open(globalPath, 'wx', 0o600)
  let lease
  try {
    await globalLease.writeFile(JSON.stringify(identity))
    lease = await open(localPath, 'wx', 0o600)
    await lease.writeFile(JSON.stringify(identity))
    return { globalLease, lease }
  } catch (error) {
    for (const [path, handle] of [
      [localPath, lease],
      [globalPath, globalLease],
    ]) {
      if (!handle) continue
      try {
        if ((await stat(path)).ino === (await handle.stat()).ino) await unlink(path)
      } finally {
        await handle.close()
      }
    }
    throw error
  }
}

/** 完成质量与比较资格独立；正常结算、可判分的失败也必须进入质量比较。 */
export function comparisonEligible(state) {
  return (
    state.status === 'completed' &&
    (!state.generationPolicy || state.generationWitness?.status === 'verified') &&
    (!state.contextPolicy ||
      (state.participants.scriptact.inputWindowVerified === true &&
        state.participants.codex.inputWindowTokens === state.contextPolicy.inputWindowTokens)) &&
    ['scriptact', 'codex'].every((who) => {
      const item = state.participants[who]
      return (
        item?.grade?.status === 'graded' &&
        item.policyAudit &&
        !item.policyAudit.confirmedSolutionPatchAccess &&
        !item.policyAudit.requiresReview
      )
    })
  )
}

/** 截图是辅助证据，失败回执保留，不能跳过已付费源任务的官方判分。 */
export async function capturePreview(cdp, path) {
  try {
    await cdp.capture(path)
    return { status: 'captured', path }
  } catch (error) {
    return { status: 'failed', error: error.stack }
  }
}

/** 完整执行证据与真实窗口是比较前提；辅助截图与源模型完成状态分别记录。 */
export function finishStatus(state, health) {
  const scriptact = state.participants.scriptact
  const codex = state.participants.codex
  if ([scriptact, codex].some((item) => item?.grade?.status !== 'graded'))
    return 'grading_infrastructure_failure'
  if (
    !scriptact.metrics?.fullTrace ||
    scriptact.evidenceError ||
    codex.evidence?.status !== 'complete'
  )
    return 'evidence_infrastructure_failure'
  if (health.authenticationBlocker) return 'authentication_failure'
  if (state.generationPolicy && state.generationWitness?.status !== 'verified')
    return 'generation_policy_infrastructure_failure'
  if (
    !scriptact.inputWindowVerified ||
    codex.inputWindowTokens !== state.contextPolicy.inputWindowTokens
  )
    return 'context_policy_infrastructure_failure'
  return 'completed'
}

/** 运行期间直接核对封存文件；修复必须等当前候选收尾。 */
export async function verifyFrozen(candidate) {
  for (const item of candidate.files) {
    if (sha256(await readFile(item.path)) !== item.sha256)
      throw new Error('Frozen artifact changed: ' + item.path)
  }
  if (candidate.roots) {
    const current = await snapshotFiles(candidate.roots)
    if (current.fingerprint !== candidate.fingerprint)
      throw new Error('Frozen artifact inventory changed')
  }
}

export async function snapshotFiles(roots) {
  const files = []
  const seen = new Set()
  const visit = async (path) => {
    path = await realpath(path)
    if (seen.has(path)) return
    seen.add(path)
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
    } else if (info.isFile())
      files.push({ path, sha256: sha256(await readFile(path)), bytes: info.size })
  }
  const resolvedRoots = [...new Set(await Promise.all(roots.map((root) => realpath(root))))].sort()
  for (const root of resolvedRoots) await visit(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { fingerprint: sha256(JSON.stringify(files)), roots: resolvedRoots, files }
}

export function assessLedger(rows, identities) {
  const ids = new Set()
  const expected = new Map(identities.map((item) => [item.attemptId, item]))
  const summary = {}
  for (const identity of identities)
    summary[identity.participantId] = {
      requests: 0,
      knownReferenceUsd: 0,
      unknownUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requestIds: [],
    }
  for (const row of rows) {
    if (!expected.has(row.identity?.attemptId)) continue
    if (!row.id || ids.has(row.id)) throw new Error('Duplicate or missing request ID')
    ids.add(row.id)
    const identity = expected.get(row.identity.attemptId)
    if (JSON.stringify(row.identity) !== JSON.stringify(identity))
      throw new Error('Request accounting owner changed')
    if (!row.finishedAt || row.status === 'reserved')
      throw new Error('Physical upstream request remains unsettled')
    const item = summary[identity.participantId]
    item.requests++
    item.requestIds.push(row.id)
    item.knownReferenceUsd += row.estimatedUsd ?? 0
    if (row.estimatedUsd === null || row.estimatedUsd === undefined) item.unknownUsage++
    if (row.usage) {
      item.inputTokens += row.usage.input_tokens ?? row.usage.prompt_tokens ?? 0
      item.outputTokens += row.usage.output_tokens ?? row.usage.completion_tokens ?? 0
      const details = row.usage.input_tokens_details ?? row.usage.prompt_tokens_details ?? {}
      item.cacheReadTokens += details.cached_tokens ?? 0
      item.cacheWriteTokens += details.cache_write_tokens ?? 0
      item.reasoningTokens +=
        row.usage.output_tokens_details?.reasoning_tokens ??
        row.usage.completion_tokens_details?.reasoning_tokens ??
        0
    }
  }
  for (const item of Object.values(summary))
    item.referenceCostComplete = item.unknownUsage === 0 && item.requests > 0
  return summary
}

/** 核对网关实际出线，不能只凭 CLI 或模板中写过参数就认定双方资源一致。 */
export function generationPolicyWitness(rows, policy) {
  policy = normalizedGenerationPolicy(policy)
  if (!policy) return null
  const participants = { scriptact: 0, codex: 0 }
  const mismatches = []
  for (const row of rows) {
    const who = row.identity?.participantId
    if (!Object.hasOwn(participants, who)) continue
    participants[who]++
    const options = row.metadata?.wireOptions
    const expected = {
      reasoningContext: policy.reasoningContext,
      reasoningSummary: policy.reasoningSummary,
      textVerbosity: policy.textVerbosity,
    }
    const fields = Object.keys(expected).filter(
      (key) => options?.[key]?.state !== 'value' || options[key].value !== expected[key]
    )
    if (row.metadata?.outputLimit !== policy.maxOutputTokens) fields.push('outputLimit')
    if (row.metadata?.endpoint !== '/v1/responses') fields.push('endpoint')
    if (fields.length) mismatches.push({ requestId: row.id, participant: who, fields })
  }
  return {
    status:
      !mismatches.length && Object.values(participants).every((n) => n > 0)
        ? 'verified'
        : 'mismatch',
    policy,
    participants,
    mismatches,
  }
}

/** 模型、脚本、Kernel 和原生命令分层统计，语义非零退出与操作异常分别计数。 */
export function scriptMetrics(pages) {
  const seenTurns = new Set()
  const scripts = new Map()
  const counts = {
    modelTurns: 0,
    scripts: 0,
    failedScripts: 0,
    kernelOperations: {},
    nativeCommands: 0,
    nonzeroCommands: 0,
    unfinishedCommands: 0,
    modelMs: 0,
    scriptMs: 0,
    fullTrace: true,
  }
  for (const page of pages) {
    if (page.omitted) counts.fullTrace = false
    for (const turn of page.turns) {
      if (seenTurns.has(turn.turnId)) continue
      seenTurns.add(turn.turnId)
      counts.modelTurns++
      counts.modelMs += turn.timing?.modelMs ?? 0
      if (
        turn.gaps?.length ||
        Object.entries(turn.detail ?? {}).some(([key, value]) => key.endsWith('Truncated') && value)
      )
        counts.fullTrace = false
      for (const script of turn.executions) {
        const prior = scripts.get(script.executionId)
        if (!prior || script.calls.length > prior.calls.length)
          scripts.set(script.executionId, script)
      }
    }
  }
  for (const script of scripts.values()) {
    counts.scripts++
    counts.scriptMs += script.durationMs ?? 0
    if (script.failure || !['succeeded', 'completed'].includes(script.status))
      counts.failedScripts++
    if (script.sourceTruncated) counts.fullTrace = false
    for (const call of script.calls) {
      const key = call.module + '.' + call.operation
      const value = (counts.kernelOperations[key] ??= { calls: 0, failures: 0, unknown: 0 })
      value.calls++
      if (call.status === 'failed') value.failures++
      else if (call.status !== 'succeeded') value.unknown++
      if (call.truncated) counts.fullTrace = false
      if (
        call.module === 'velaros:project' &&
        call.operation === 'patch' &&
        call.status === 'succeeded'
      ) {
        try {
          const result = JSON.parse(call.output)
          if (result.status === 'blocked' && result.executionOutcome === 'not-applied') {
            value.failures++
            value.blocked = (value.blocked ?? 0) + 1
          }
        } catch {
          counts.fullTrace = false
        }
      }
      if (call.module === 'velaros:shell' && call.operation === 'run') {
        counts.nativeCommands++
        try {
          const result = JSON.parse(call.output)
          if (result.exitCode !== null && result.exitCode !== 0) counts.nonzeroCommands++
          if (result.exitCode === null || result.aborted || result.timedOut)
            counts.unfinishedCommands++
        } catch {
          counts.fullTrace = false
        }
      }
    }
  }
  return counts
}

export function codexMetrics(text) {
  const counts = {
    outerTools: {},
    nativeCommands: 0,
    nonzeroCommands: 0,
    fileChanges: 0,
    diagnosticLines: 0,
    threadId: null,
    terminalComplete: false,
  }
  for (const line of text.split('\n').filter(Boolean)) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      counts.diagnosticLines++
      continue
    }
    if (event.type === 'thread.started') {
      if (counts.threadId && counts.threadId !== event.thread_id)
        throw new Error('Codex thread identity changed')
      counts.threadId = event.thread_id
    }
    if (event.type === 'turn.completed') counts.terminalComplete = true
    if (event.type === 'turn.failed') counts.terminalComplete = false
    if (event.type !== 'item.completed' || !event.item) continue
    const item = event.item
    if (
      [
        'command_execution',
        'file_change',
        'mcp_tool_call',
        'web_search',
        'collab_tool_call',
      ].includes(item.type)
    ) {
      const value = (counts.outerTools[item.type] ??= { calls: 0, failures: 0, unknown: 0 })
      value.calls++
      if (item.status === 'failed' || item.is_error) value.failures++
      else if (!['completed', 'succeeded'].includes(item.status)) value.unknown++
    }
    if (item.type === 'command_execution') {
      counts.nativeCommands++
      if (item.exit_code !== null && item.exit_code !== 0) counts.nonzeroCommands++
    }
    if (item.type === 'file_change') counts.fileChanges += item.changes?.length ?? 0
  }
  return counts
}

async function capturePatch(workspace, base, path) {
  const { stdout } = await execute('git', ['diff', '--binary', base], {
    cwd: workspace,
    maxBuffer: 32 * 1024 * 1024,
  })
  const { stdout: others } = await execute(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: workspace, maxBuffer: 32 * 1024 * 1024 }
  )
  let patch = stdout
  for (const name of others.split('\0').filter(Boolean)) {
    try {
      await execute('git', ['diff', '--no-index', '--binary', '--', '/dev/null', name], {
        cwd: workspace,
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (error) {
      if (error.code !== 1) throw error
      patch += error.stdout
    }
  }
  await writeFile(path, patch, { mode: 0o600, flag: 'wx' })
  return sha256(patch)
}

async function captureTrace(cdp, sessionId, directory) {
  const pages = []
  const queue = [undefined]
  const seen = new Set()
  while (queue.length) {
    const branch = queue.shift()
    const id = branch ?? sessionId
    if (seen.has(id)) continue
    seen.add(id)
    const page = await cdp.trace(sessionId, branch)
    const path = join(directory, 'trace-' + pages.length + '.json')
    await privateJson(path, page)
    // 读取器维护完整/编码轨迹合同；观测字段不能被当成另一种编码。
    pages.push(await readTraceArtifact(path))
    for (const child of page.branches)
      if (child.sessionId !== sessionId) queue.push(child.sessionId)
  }
  return pages
}

async function waitForGateway(config) {
  const secret = (await readFile(config.tokenFile, 'utf8')).trim()
  const deadline = Date.now() + 16 * 60 * 1000
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/health', config.baseURL), {
      headers: { authorization: 'Bearer ' + secret },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('Gateway health unavailable')
    const value = await response.json()
    if (
      !value.activeUpstreamRequests &&
      !value.activeModelDiscoveryRequests &&
      !value.scheduler.active &&
      !value.scheduler.queued
    )
      return value
    await sleep(1000)
  }
  throw new Error('Gateway physical settlement remains unknown')
}

async function main(manifestPath) {
  if (!manifestPath) throw new Error('Usage: node controller.mjs <frozen-manifest.json>')
  const bytes = await readFile(manifestPath)
  const manifest = JSON.parse(bytes)
  const campaignId = sha256(bytes)
  if (
    manifest.protocol !== 'macos-desktop-native-v1' ||
    manifest.model !== 'gpt-5.6-sol' ||
    manifest.reasoningEffort !== 'high'
  )
    throw new Error('Unsupported native evaluation identity')
  const directory = resolve(manifest.directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const globalLeasePath = join(manifest.campaignRoot, 'active-controller.lock')
  const { globalLease, lease } = await acquireControllerLeases(
    globalLeasePath,
    join(directory, 'controller.lock'),
    { pid: process.pid, campaignId, manifest: resolve(manifestPath), startedAt: Date.now() }
  )
  const stop = new AbortController()
  const onStop = () => stop.abort()
  process.once('SIGTERM', onStop)
  process.once('SIGINT', onStop)
  const state = {
    schema: 1,
    protocol: manifest.protocol,
    campaignId,
    controllerPid: process.pid,
    model: manifest.model,
    reasoningEffort: manifest.reasoningEffort,
    contextPolicy: manifest.contextPolicy,
    generationPolicy: normalizedGenerationPolicy(manifest.generationPolicy),
    status: 'preparing',
    participants: {},
    startedAt: Date.now(),
    paidSourcesDispatched: 0,
  }
  const stateFile = join(directory, 'state.json')
  let cdp,
    hook,
    sampler,
    priorConfigs,
    temporaryKey,
    settlementProved = false
  let stateWrites = Promise.resolve()
  const writeState = () => (stateWrites = stateWrites.then(() => privateJson(stateFile, state)))
  try {
    await verifyFrozen(manifest.candidate)
    if (manifest.evaluation) await verifyFrozen(manifest.evaluation)
    const actualPolicy = await nativeContextPolicy(manifest.candidate, manifest.contextTokens)
    if (JSON.stringify(actualPolicy) !== JSON.stringify(manifest.contextPolicy))
      throw new Error('Native paired context policy is missing or stale; freeze again')
    for (const item of ['baseline', 'oracle']) {
      const result = JSON.parse(await readFile(manifest.task[item + 'Result'], 'utf8'))
      if (result.status !== item + '_verified' || result.taskId !== manifest.task.id)
        throw new Error('Missing task environment acceptance: ' + item)
    }
    const health = await waitForGateway(manifest.gateway)
    if (
      JSON.stringify(normalizedGenerationPolicy(health.generationPolicy)) !==
      JSON.stringify(state.generationPolicy)
    )
      throw new Error('Gateway generation policy differs from the frozen manifest')
    if (
      health.authenticationBlocker ||
      health.model !== manifest.model ||
      health.reasoningEffort !== manifest.reasoningEffort
    )
      throw new Error('Gateway identity/authentication mismatch')
    hook = await desktopClient(manifest.desktop.endpointFile)
    cdp = await cdpClient(manifest.desktop.cdp)
    if (!(await hook({ kind: 'bridge_ping', timeoutMs: 2000 })).alive)
      throw new Error('Desktop renderer bridge unavailable')
    for (const who of ['scriptact', 'codex']) {
      const path = manifest.task.workspaces[who]
      const { stdout: head } = await execute('git', ['rev-parse', 'HEAD'], { cwd: path })
      const { stdout: dirty } = await execute('git', ['status', '--porcelain'], { cwd: path })
      if (head.trim() !== manifest.task.baseCommit || dirty)
        throw new Error('Source workspace is not at the frozen initial state')
    }
    const secret = (await readFile(manifest.gateway.tokenFile, 'utf8')).trim()
    const identities = ['scriptact', 'codex'].map((participantId) => ({
      campaignId,
      candidateId: manifest.candidate.fingerprint,
      participantId,
      taskId: manifest.task.id,
      attemptId: manifest.attemptId + '-' + participantId,
      jobId: manifest.attemptId,
      phase: 'source',
    }))
    const credentials = identities.map((item) => attemptCredential(item, secret))
    priorConfigs =
      JSON.parse(await readFile(manifest.desktop.settingsFile, 'utf8')).system
        .providerRuntimeConfigs ?? []
    temporaryKey = credentials[0]
    await privateJson(join(directory, 'identities.json'), identities)
    for (const who of ['scriptact', 'codex']) await mkdir(join(directory, who), { mode: 0o700 })
    await configureModel(hook, manifest.desktop.settingsFile, {
      baseURL: manifest.gateway.baseURL,
      apiKey: credentials[0],
      model: manifest.model,
    })
    const source = await open(join(directory, 'source-started.json'), 'wx', 0o600)
    await source.writeFile(JSON.stringify({ campaignId, at: Date.now(), identities }))
    await source.close()
    state.status = 'running'
    state.paidSourcesDispatched = 2
    await writeState()
    const resources = await open(join(directory, 'resources.jsonl'), 'wx', 0o600)
    const sample = async () => {
      const value = {
        at: Date.now(),
        loadavg: loadavg(),
        freeMemoryBytes: freemem(),
      }
      await resources.writeFile(JSON.stringify(value) + '\n')
      await privateJson(join(directory, 'resource-current.json'), value)
    }
    stop.signal.addEventListener('abort', () => clearInterval(sampler), { once: true })
    await sample()
    sampler = setInterval(() => void sample().catch(() => {}), 10_000)
    const sessionId = 'native-' + manifest.attemptId
    state.desktopSessionId = sessionId
    const startScript = async () => {
      const item = (state.participants.scriptact = {
        startedAt: Date.now(),
        status: 'dispatching',
        sessionId,
      })
      await writeState()
      try {
        const receipt = await dispatch(hook, {
          sessionId,
          workspace: manifest.task.workspaces.scriptact,
          model: manifest.model,
          activate: false,
          commandId: manifest.attemptId + '-source',
          problem: manifest.task.prompts.scriptact,
        })
        item.admission = receipt
        item.status = 'running'
        await writeState()
        await waitForSettlement(hook, sessionId, manifest.sourceTimeoutMs, async (status) => {
          item.runtime = status
          await writeState()
        })
        item.solveFinishedAt = Date.now()
        try {
          const pages = await captureTrace(cdp, sessionId, join(directory, 'scriptact'))
          item.metrics = scriptMetrics(pages)
          item.observedInputWindows = observedInputWindows(pages)
          item.inputWindowVerified =
            item.observedInputWindows.length === 1 &&
            item.observedInputWindows[0] === manifest.contextPolicy.inputWindowTokens
          item.policyAudit = scriptPolicyAudit(pages)
          item.terminalComplete =
            pages[0]?.turns.at(-1)?.done === true && !pages[0]?.turns.at(-1)?.error
          item.status = item.terminalComplete ? 'completed' : 'source_failed'
          await privateJson(
            join(directory, 'scriptact', 'transcript.json'),
            await hook({ kind: 'get_transcript', sessionId })
          )
        } catch (error) {
          item.status = 'evidence_failed'
          item.evidenceError = error.stack
        }
      } catch (error) {
        item.status = 'source_failed'
        item.error = error.stack
        await hook({
          kind: 'abort_session',
          sessionId,
          reason: 'native controller source failure cleanup',
        })
        await waitForSettlement(hook, sessionId, 30_000)
      } finally {
        item.finishedAt = Date.now()
        item.solveSeconds = ((item.solveFinishedAt ?? item.finishedAt) - item.startedAt) / 1000
        await writeState()
      }
      return item
    }
    const startCodex = async () => {
      const item = (state.participants.codex = { status: 'dispatching', startedAt: Date.now() })
      await writeState()
      const result = await runCodex({
        executable: manifest.codex.executable,
        workspace: manifest.task.workspaces.codex,
        directory: join(directory, 'codex'),
        baseURL: manifest.gateway.baseURL,
        apiKey: credentials[1],
        model: manifest.model,
        contextTokens: manifest.contextTokens,
        inputWindowTokens: manifest.contextPolicy.inputWindowTokens,
        prompt: manifest.task.prompts.codex,
        timeoutMs: manifest.sourceTimeoutMs,
        signal: stop.signal,
        onSpawn: ({ pid, args }) => {
          item.pid = pid
          const thresholds = args.filter((arg) => arg.startsWith('model_auto_compact_token_limit='))
          item.inputWindowTokens =
            thresholds.length === 1 ? Number(thresholds[0].split('=')[1]) : null
          item.status = 'running'
        },
      })
      Object.assign(item, result, {
        status: result.terminalComplete ? 'completed' : 'source_failed',
        solveSeconds: (result.finishedAt - result.startedAt) / 1000,
      })
      const cliText = await readFile(join(directory, 'codex', 'codex.jsonl'), 'utf8')
      item.metrics = codexMetrics(cliText)
      item.policyAudit = codexPolicyAudit(cliText)
      if (result.threadId) {
        try {
          await execute(
            manifest.grader.python,
            [
              manifest.codex.evidenceScript,
              '--directory',
              join(directory, 'codex'),
              '--thread',
              result.threadId,
              '--identity',
              join(directory, 'identities.json'),
            ],
            { timeout: 60_000, maxBuffer: 1024 * 1024 }
          )
        } catch (error) {
          if (error.code !== 1) throw error
        }
        item.evidence = JSON.parse(
          await readFile(join(directory, 'codex', 'evidence-index.json'), 'utf8')
        )
      }
      await writeState()
      return item
    }
    stop.signal.addEventListener(
      'abort',
      () =>
        void hook({ kind: 'abort_session', sessionId, reason: 'native controller stop requested' }),
      { once: true }
    )
    const sources = await Promise.allSettled([startScript(), startCodex()])
    clearInterval(sampler)
    await resources.close()
    if (sources.some((item) => item.status === 'rejected'))
      throw new Error(
        'A source ended with unknown cleanup: ' +
          sources
            .filter((item) => item.status === 'rejected')
            .map((item) => item.reason)
            .join('; ')
      )
    state.status = 'settling'
    await writeState()
    const settled = await waitForGateway(manifest.gateway)
    settlementProved = true
    await privateJson(join(directory, 'gateway-settled.json'), settled)
    const ledger = JSON.parse(await readFile(manifest.gateway.ledgerFile, 'utf8'))
    state.accounting = assessLedger(ledger.requests, identities)
    state.generationWitness = generationPolicyWitness(
      ledger.requests.filter((item) => item.identity?.campaignId === campaignId),
      state.generationPolicy
    )
    await privateJson(
      join(directory, 'request-rows.json'),
      ledger.requests.filter((item) => item.identity?.campaignId === campaignId)
    )
    await verifyFrozen(manifest.candidate)
    if (manifest.evaluation) await verifyFrozen(manifest.evaluation)
    for (const who of ['scriptact', 'codex']) {
      state.participants[who].patchSha256 = await capturePatch(
        manifest.task.workspaces[who],
        manifest.task.baseCommit,
        join(directory, who, 'source.patch')
      )
    }
    state.screenshot = await capturePreview(cdp, join(directory, 'desktop.png'))
    state.status = 'grading'
    await writeState()
    for (const who of ['scriptact', 'codex']) {
      const gradeDir = join(directory, who, 'grading')
      try {
        await execute(
          manifest.grader.python,
          [
            manifest.grader.script,
            '--task',
            manifest.task.directory,
            '--directory',
            gradeDir,
            '--kind',
            'source',
            '--source-patch',
            join(directory, who, 'source.patch'),
          ],
          { timeout: 7 * 60 * 1000, maxBuffer: 1024 * 1024 }
        )
      } catch (error) {
        if (error.code !== 1) throw error
      }
      state.participants[who].grade = JSON.parse(
        await readFile(join(gradeDir, 'result.json'), 'utf8')
      )
    }
    state.status = finishStatus(state, settled)
    state.comparisonEligible = comparisonEligible(state)
  } catch (error) {
    state.status = 'stopped_infrastructure_failure'
    state.error = error.stack
    stop.abort()
    if (hook && state.desktopSessionId)
      await hook({
        kind: 'abort_session',
        sessionId: state.desktopSessionId,
        reason: 'native controller failure cleanup',
      }).catch((failure) => {
        state.cancellationError = failure.message
      })
  } finally {
    clearInterval(sampler)
    if (hook && temporaryKey && priorConfigs) {
      try {
        state.configurationRestore = await restoreModel(
          hook,
          manifest.desktop.settingsFile,
          priorConfigs,
          temporaryKey
        )
      } catch (error) {
        state.configurationRestoreError = error.message
        state.status = 'configuration_restore_failure'
      }
    }
    cdp?.close()
    state.finishedAt = Date.now()
    state.totalSeconds = (state.finishedAt - state.startedAt) / 1000
    await writeState()
    await privateJson(join(directory, 'result.json'), state)
    await lease.close()
    if (settlementProved && (await stat(globalLeasePath)).ino === (await globalLease.stat()).ino)
      await unlink(globalLeasePath)
    await globalLease.close()
    process.removeListener('SIGTERM', onStop)
    process.removeListener('SIGINT', onStop)
  }
  console.log(
    JSON.stringify({
      status: state.status,
      task: manifest.task.id,
      participants: Object.fromEntries(
        Object.entries(state.participants).map(([who, item]) => [
          who,
          {
            status: item.status,
            solveSeconds: item.solveSeconds,
            resolved: item.grade?.resolved,
            caseCount: item.grade?.caseCount,
            metrics: item.metrics,
            evidence: item.evidence?.status,
          },
        ])
      ),
      accounting: state.accounting,
    })
  )
  if (state.status !== 'completed') process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void main(process.argv[2]).catch((error) => {
    console.error(error.stack)
    process.exitCode = 1
  })
