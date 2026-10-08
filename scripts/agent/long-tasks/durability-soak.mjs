// 真实进程退出、SQLite 重开与副作用恢复压力测试；模型替身只控制故障点，不用于能力评分。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireTaskResources,
  archiveTaskResources,
  checkTaskResourceBudget,
  monitorTaskResources,
  registerTaskResources,
} from './resource-lifecycle.mjs'

const phases = ['partial-response', 'committed', 'receipt-lost']
const activeWorkers = new Set()

// SIGKILL 会遗留 socket 目录项；确认没有监听者且 inode 未变后才移除，并保留回收依据。
export async function reclaimDurabilitySockets(root) {
  const retired = []
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await scan(path)
        continue
      }
      if (!entry.isSocket()) continue
      const before = await lstat(path)
      const result = await new Promise((resolve, reject) => {
        const socket = createConnection(path)
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error(`Socket probe timed out: ${path}`))
        }, 1000)
        socket.once('connect', () => {
          clearTimeout(timer)
          socket.destroy()
          reject(new Error(`Socket still has a listener: ${path}`))
        })
        socket.once('error', (error) => {
          clearTimeout(timer)
          socket.destroy()
          if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(error.code)
          else reject(error)
        })
      })
      if (result !== 'ENOENT') {
        const current = await lstat(path)
        assert(current.isSocket() && current.dev === before.dev && current.ino === before.ino)
        await unlink(path)
      }
      retired.push({ path, dev: before.dev, ino: before.ino, probe: result })
    }
  }
  await scan(root)
  await writeFile(join(root, 'retired-sockets.json'), JSON.stringify(retired, null, 2))
  return retired
}

// 只管理本控制器启动的独占进程组；正常取消也要排空输出后才能回收目录。
function launchWorker(root, phase, mode, signal) {
  signal?.throwIfAborted()
  const child = spawn(process.execPath, [import.meta.filename, '--worker', root, phase, mode], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TMPDIR: join(root, 'tmp'),
      TMP: join(root, 'tmp'),
      TEMP: join(root, 'tmp'),
    },
  })
  let stdout = '',
    stderr = '',
    failure
  const kill = () => {
    if (!child.pid) return
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  activeWorkers.add(kill)
  const abort = () => {
    failure = signal.reason
    kill()
  }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    failure = new Error('Durability worker exceeded 30 seconds')
    kill()
  }, 30_000)
  child.stdout.on('data', (data) => {
    stdout += data
    if (stdout.length > 2_000_000) {
      stdout = stdout.slice(-2_000_000)
      failure = new Error('Durability worker output exceeded budget')
      kill()
    }
  })
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-12_000)
  })
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal, stdout, stderr }))
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    kill()
    activeWorkers.delete(kill)
  })
  void exit.catch(() => {})
  return {
    child,
    exit,
    kill,
    output: () => ({ stdout, stderr }),
    async result() {
      const result = await exit
      if (failure) throw failure
      assert.equal(result.code, 0, JSON.stringify(result))
      return JSON.parse(result.stdout.trim().split('\n').at(-1))
    },
  }
}

async function worker(root, phase, mode) {
  const resume = mode === '--resume'
  const contender = mode === '--contender'
  const { createRuntime } = await import('../../../packages/velaros/dist/act/runtime/index.js')
  const { nodeSubprocessCodeRunner } = await import('@velaros-ai/script')
  const { turn, done } =
    await import('../../../packages/velaros/act/runtime/test/support/model-turn.mjs')
  const marker = join(root, 'effects.jsonl')
  const hold = setInterval(() => {}, 1000)
  const ready = () => process.stdout.write('FAULT_READY\n')
  const count = async () =>
    (
      await readFile(marker, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
    )
      .trim()
      .split('\n')
      .filter(Boolean).length
  let modelCalls = 0
  const runtime = await createRuntime({
    dataDir: join(root, 'state'),
    runner: nodeSubprocessCodeRunner,
    agents: false,
    search: false,
    memory: false,
    context: {
      maintenance: false,
      completion: {
        requirements: (view) => [
          {
            id: 'effect-count',
            label: 'the original operation is completed exactly once',
            artifacts: ['external-effect-snapshot'],
            sourceRefs: [view.goals[0].record.ref],
          },
        ],
        verify: async (_view, _signal, checks) => {
          const check = await checks.check(
            {
              id: 'effect-count',
              scope: `effect-count/${phase}`,
              verifierId: 'durability-fixture',
              verifierVersion: '2',
              probe: async () => {
                const content = await readFile(marker, 'utf8').catch((error) => {
                  if (error.code === 'ENOENT') return null
                  throw error
                })
                const hash = createHash('sha256').update(JSON.stringify({ content })).digest('hex')
                return {
                  status: 'versioned',
                  providerId: 'local-filesystem',
                  token: hash,
                  authorization: root,
                  artifacts: [{ identity: 'external-effect-snapshot', contentHash: hash }],
                  cost: { coverage: 'complete', charges: [] },
                }
              },
            },
            async () => ({
              label: 'effect count',
              status: (await count()) === 1 ? 'passed' : 'failed',
              complete: true,
              cost: { coverage: 'complete', charges: [] },
            })
          )
          const passed = (await count()) === 1
          return {
            verified: passed,
            reason: 'independent external state check',
            report: {
              scope: 'durable-effect-count',
              checkedAt: new Date().toISOString(),
              checks: [check],
            },
          }
        },
      },
    },
    modules: [
      {
        binding: {
          moduleId: 'test:durable-effect',
          instanceId: 'external',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'Durable fixture effects',
        operations: {
          commit: {
            summary: 'write external receipt',
            input: { type: 'null' },
            output: { type: 'null' },
            effects: 'write',
            run: async () => {
              const handle = await open(marker, 'a', 0o600)
              try {
                await handle.writeFile(JSON.stringify({ id: randomUUID() }) + '\n')
                await handle.sync()
              } finally {
                await handle.close()
              }
              if (phase === 'receipt-lost') {
                ready()
                await new Promise(() => {})
              }
              return null
            },
          },
        },
      },
    ],
    model: {
      id: 'deterministic-fault-fixture',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request) {
        modelCalls++
        assert(!contender, 'a competing process entered model execution')
        if (resume) {
          assert(
            JSON.stringify(request).includes('original-delivery-contract'),
            'original requirement disappeared on recovery'
          )
          if (phase === 'partial-response' && modelCalls === 1) {
            assert.equal(await count(), 0, 'an incomplete response must not produce effects')
            yield turn(request, {
              execute: { source: "import {commit} from 'test:durable-effect';await commit(null);" },
            })
            yield { type: 'finish', reason: 'stop' }
            return
          }
          assert.equal(await count(), 1, 'recovery must fulfill the original operation')
          yield* done(request, 'External state was reconciled before continuing.')
          return
        }
        if (modelCalls > 1) {
          ready()
          await new Promise(() => {})
          return
        }
        const response = turn(request, {
          execute: { source: "import {commit} from 'test:durable-effect';await commit(null);" },
        })
        if (phase === 'partial-response') {
          yield { type: 'text', text: response.text.slice(0, -3) }
          ready()
          await new Promise(() => {})
          return
        }
        yield response
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  try {
    const session = await runtime.openSession('durable')
    const events = []
    try {
      for await (const event of session.submit(
        resume || contender
          ? 'Continue after checking external effects.'
          : 'original-delivery-contract: apply the operation once and preserve its receipt.'
      ))
        events.push(event)
    } catch (error) {
      if (!contender || error.code !== 'TASK_BUSY') throw error
    }
    if (contender) {
      assert.equal(modelCalls, 0)
      assert(
        events.length === 0 ||
          events.some(
            (event) =>
              event.type === 'error' && /持有任务租约|活动任务不能从外部恢复/.test(event.message)
          )
      )
      process.stdout.write(JSON.stringify({ phase, activeOwnerProtected: true }) + '\n')
      return
    }
    await writeFile(join(root, 'resume-events.json'), JSON.stringify(events, null, 2))
    assert.equal(events.at(-1)?.status, 'completed')
    assert.equal(await count(), 1, 'the original operation must finish exactly once')
    assert.equal(
      modelCalls,
      phase === 'partial-response' ? 2 : 1,
      'recovery may finish the missing operation, but must not dispatch an old accepted request'
    )
    process.stdout.write(
      JSON.stringify({ phase, effects: await count(), status: 'completed', modelCalls }) + '\n'
    )
  } finally {
    await runtime.close()
    clearInterval(hold)
  }
}

export async function durabilityCycle(
  phase,
  { signal, temporaryDirectory = tmpdir(), evidenceDirectory } = {}
) {
  assert(phases.includes(phase))
  signal?.throwIfAborted()
  const root = await mkdtemp(join(temporaryDirectory, 'vlr-durability-'))
  await mkdir(join(root, 'tmp'))
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })
  const resources = evidenceDirectory ? await registerTaskResources(root, evidenceDirectory) : null
  const workers = []
  const start = (mode) => {
    const value = launchWorker(root, phase, mode, signal)
    workers.push(value)
    return value
  }
  let passed = false
  try {
    if (resources) await checkTaskResourceBudget(resources)
    const holder = start('--initial')
    const { child, exit } = holder
    await new Promise((resolve, reject) => {
      child.stdout.on('data', () => {
        if (holder.output().stdout.includes('FAULT_READY')) resolve()
      })
      void exit.then(
        (result) => reject(new Error(`Fixture exited before fault: ${JSON.stringify(result)}`)),
        reject
      )
    })
    const competing = await start('--contender').result()
    assert(competing.activeOwnerProtected)
    holder.kill()
    await exit
    const result = await start('--resume').result()
    const receipt = {
      ...result,
      activeOwnerProtected: true,
      faultSignal: 'SIGKILL',
      effectSha256: createHash('sha256')
        .update(await readFile(join(root, 'effects.jsonl')))
        .digest('hex'),
      eventsSha256: createHash('sha256')
        .update(await readFile(join(root, 'resume-events.json')))
        .digest('hex'),
    }
    await writeFile(join(root, 'result.json'), JSON.stringify(receipt, null, 2))
    passed = true
    return receipt
  } catch (error) {
    await writeFile(
      join(root, 'failure.txt'),
      String(error) + '\n' + JSON.stringify(workers.map((worker) => worker.output()))
    )
    throw new Error(`Durability evidence retained at ${evidenceDirectory ?? root}`, {
      cause: error,
    })
  } finally {
    for (const value of workers) value.kill()
    await Promise.all(workers.map((value) => value.exit))
    await reclaimDurabilitySockets(root)
    await writeFile(
      join(root, 'processes.json'),
      JSON.stringify(
        workers.map((value) => ({ pid: value.child.pid, ...value.output() })),
        null,
        2
      )
    )
    // 有证据目录时，失败与取消也在验证归档后回收；直接 API 保留失败现场。
    if (resources) await archiveTaskResources(resources)
    else if (passed) await rm(root, { recursive: true })
  }
}

async function main() {
  if (process.argv[2] === '--worker')
    return worker(process.argv[3], process.argv[4], process.argv[5])
  const durationMs = Number(process.argv[2] ?? 0)
  assert(Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= 24 * 60 * 60 * 1000)
  const output = resolve(process.argv[3] ?? '.velaros-workspace/durability-soak')
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  // macOS 的 Unix socket 路径有长度上限，嵌套 TMPDIR 使用独占短根。
  const root = await mkdtemp(
    join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'vlr-durability-run-')
  )
  const resources = await registerTaskResources(root, output)
  const release = await acquireTaskResources(resources)
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Durability controller interrupted'))
  const emergency = () => {
    for (const kill of activeWorkers) kill()
  }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  process.on('SIGHUP', cancel)
  process.once('exit', emergency)
  const stopMonitor = monitorTaskResources(resources, (error) => controller.abort(error))
  const startedAt = Date.now()
  const totals = Object.fromEntries(phases.map((phase) => [phase, 0]))
  let round = 0
  let status = 'running',
    failure
  const summary = () => ({
    model: 'deterministic fixture; no paid provider calls',
    requestedDurationMs: durationMs,
    elapsedMs: Date.now() - startedAt,
    rounds: round,
    totals,
    status,
    ...(failure ? { failure } : {}),
  })
  try {
    await checkTaskResourceBudget(resources)
    do {
      for (const phase of phases) {
        const result = await durabilityCycle(phase, {
          signal: controller.signal,
          temporaryDirectory: root,
          evidenceDirectory: join(output, 'cycles', `${round + 1}-${phase}`),
        })
        totals[phase]++
        await appendFile(
          join(output, 'cycles.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n'
        )
      }
      round++
      await writeFile(join(output, 'summary.json'), JSON.stringify(summary(), null, 2))
      if (round === 1 || round % 10 === 0) console.log(JSON.stringify(summary()))
    } while (Date.now() - startedAt < durationMs)
    status = 'completed'
  } catch (error) {
    status = controller.signal.aborted ? 'cancelled' : 'failed'
    failure = String(error) + (error.cause ? ': ' + String(error.cause) : '')
    process.exitCode = 1
  } finally {
    await stopMonitor()
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary(), null, 2))
    await release()
    await archiveTaskResources(resources)
    process.off('SIGTERM', cancel)
    process.off('SIGINT', cancel)
    process.off('SIGHUP', cancel)
    process.off('exit', emergency)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main()
