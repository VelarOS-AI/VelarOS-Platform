// 用途：运行同期本机 Codex，逐字保留 JSONL 和诊断，按独占进程组处理截止与取消。
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runCodex({
  executable,
  workspace,
  directory,
  baseURL,
  apiKey,
  model,
  prompt,
  timeoutMs,
  contextTokens = 128000,
  inputWindowTokens = contextTokens - 12000 - 4096,
  onSpawn = () => {},
  processGuard,
  signal: cancellationSignal,
}) {
  cancellationSignal?.throwIfAborted()
  if (
    !Number.isSafeInteger(contextTokens) ||
    !Number.isSafeInteger(inputWindowTokens) ||
    inputWindowTokens < 1024 ||
    inputWindowTokens > contextTokens - 12000 - 4096
  )
    throw new Error('Invalid native Codex input window')
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--disable',
    'plugins',
    '--disable',
    'hooks',
    '--json',
    '--color',
    'never',
    '--sandbox',
    'danger-full-access',
    '-C',
    workspace,
    '-m',
    model,
    '-c',
    'approval_policy="never"',
    '-c',
    'model_provider="native_evaluation"',
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'model_context_window=' + contextTokens,
    '-c',
    'model_auto_compact_token_limit=' + inputWindowTokens,
    '-c',
    'model_providers.native_evaluation={name="Native paired evaluation",base_url=' +
      JSON.stringify(baseURL) +
      ',env_key="CODEX_API_KEY",wire_api="responses",requires_openai_auth=false}',
    '-o',
    join(directory, 'final-message.txt'),
    '-',
  ]
  const descriptors = []
  let child
  let timedOut = false
  let cancelled = false
  let stopping = false
  let inputError = null
  let captureError = null
  let exitedAt = null
  let groupCleaned = false
  let timer
  let escalation
  let ownedProcessCleanup
  let ownedCleanup
  const cleanupOwned = () => {
    ownedCleanup ??= Promise.resolve().then(async () => {
      ownedProcessCleanup = await processGuard?.stop()
    })
    return ownedCleanup
  }
  const killGroup = (signal) => {
    if (!Number.isInteger(child?.pid) || child.pid < 1) return
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const stop = (reason) => {
    if (reason === 'deadline') timedOut = true
    else cancelled = true
    if (stopping) return
    stopping = true
    killGroup('SIGTERM')
    escalation = setTimeout(() => killGroup('SIGKILL'), 5000)
  }
  const onCancel = () => stop('cancelled')
  const startedAt = Date.now()
  try {
    // 子进程直接写独占文件；父进程没有待排空的 WriteStream 或日志管道。
    for (const name of ['codex.jsonl', 'codex.stderr'])
      descriptors.push(openSync(join(directory, name), 'wx', 0o600))
    child = spawn(executable, args, {
      cwd: workspace,
      detached: true,
      env: { ...process.env, CODEX_API_KEY: apiKey },
      stdio: ['pipe', ...descriptors],
    })
    child.stdin.on('error', (error) => {
      inputError = error.code ?? 'STDIN_ERROR'
    })
    timer = setTimeout(() => stop('deadline'), timeoutMs)
    cancellationSignal?.addEventListener('abort', onCancel, { once: true })
    if (cancellationSignal?.aborted) onCancel()
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => {
        try {
          onSpawn({ pid: child.pid, startedAt, args })
          child.stdin.end(prompt)
        } catch (error) {
          reject(error)
        }
      })
      child.once('exit', (code, signal) => {
        exitedAt = Date.now()
        // 退出事实先独立落盘；后续宿主检查或评分失效时仍能恢复真实终态。
        try {
          writeFileSync(
            join(directory, 'codex-exit.json'),
            JSON.stringify(
              {
                pid: child.pid,
                startedAt,
                exitedAt,
                code,
                signal,
                timedOut,
                cancelled,
                inputError,
              },
              null,
              2
            ) + '\n',
            { flag: 'wx', mode: 0o600 }
          )
        } catch (error) {
          captureError = error.code ?? 'EXIT_CHECKPOINT_ERROR'
        }
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    clearTimeout(escalation)
    cancellationSignal?.removeEventListener('abort', onCancel)
    killGroup('SIGKILL')
    groupCleaned = true
    await cleanupOwned()
    const lines = readFileSync(join(directory, 'codex.jsonl'), 'utf8').split('\n').filter(Boolean)
    const events = []
    const diagnostics = []
    for (const [index, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line))
      } catch {
        diagnostics.push({ line: index + 1, text: line })
      }
    }
    const thread = events.find((event) => event.type === 'thread.started')?.thread_id
    const success =
      outcome.code === 0 &&
      !timedOut &&
      !cancelled &&
      !inputError &&
      !captureError &&
      (!processGuard || ownedProcessCleanup?.scopeEmpty === true) &&
      events.some((event) => event.type === 'turn.completed') &&
      !events.some((event) => event.type === 'turn.failed')
    return {
      ...outcome,
      startedAt,
      exitedAt,
      finishedAt: Date.now(),
      timedOut,
      cancelled,
      inputError,
      captureError,
      threadId: thread ?? null,
      terminalComplete: success,
      diagnosticLines: diagnostics.length,
      eventCount: events.length,
      ...(processGuard ? { ownedProcessCleanup } : {}),
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
    cancellationSignal?.removeEventListener('abort', onCancel)
    // 进程组只包含本次 CLI 及其后代；收尾不能把遗留任务带到下一题。
    try {
      if (!groupCleaned) killGroup('SIGKILL')
      await cleanupOwned()
    } finally {
      for (const descriptor of descriptors) closeSync(descriptor)
    }
  }
}
