// 用途：运行同期本机 Codex，逐字保留 JSONL 和诊断，按独占进程组处理截止与取消。
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

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
  const stdout = createWriteStream(join(directory, 'codex.jsonl'), { flags: 'wx', mode: 0o600 })
  const stderr = createWriteStream(join(directory, 'codex.stderr'), { flags: 'wx', mode: 0o600 })
  const child = spawn(executable, args, {
    cwd: workspace,
    detached: true,
    env: { ...process.env, CODEX_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  let timedOut = false
  let cancelled = false
  let stopping = false
  let inputError = null
  let escalation
  child.stdin.on('error', (error) => {
    inputError = error.code ?? 'STDIN_ERROR'
  })
  const killGroup = (signal) => {
    if (!Number.isInteger(child.pid) || child.pid < 1) return
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
  const timer = setTimeout(() => stop('deadline'), timeoutMs)
  cancellationSignal?.addEventListener('abort', onCancel, { once: true })
  if (cancellationSignal?.aborted) onCancel()
  const startedAt = Date.now()
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => {
        onSpawn({ pid: child.pid, startedAt, args })
        child.stdin.end(prompt)
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    }).then((outcome) => {
      child.outcome = outcome
    })
    await Promise.all([finished(stdout), finished(stderr)])
    const lines = (await readFile(join(directory, 'codex.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
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
      child.outcome.code === 0 &&
      !timedOut &&
      !cancelled &&
      !inputError &&
      events.some((event) => event.type === 'turn.completed') &&
      !events.some((event) => event.type === 'turn.failed')
    return {
      ...child.outcome,
      startedAt,
      finishedAt: Date.now(),
      timedOut,
      cancelled,
      inputError,
      threadId: thread ?? null,
      terminalComplete: success,
      diagnosticLines: diagnostics.length,
      eventCount: events.length,
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
    cancellationSignal?.removeEventListener('abort', onCancel)
    // 进程组只包含本次 CLI 及其后代；收尾不能把遗留任务带到下一题。
    killGroup('SIGKILL')
    if (!stdout.writableEnded) stdout.end()
    if (!stderr.writableEnded) stderr.end()
  }
}
