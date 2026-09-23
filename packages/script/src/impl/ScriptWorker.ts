import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  VmFunctionImplementation,
} from 'quickjs-emscripten'
import { getQuickJS } from 'quickjs-emscripten'

import { isEmpty, isObject, isTrue, isUndefined, Log, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ScriptOutputLimits } from '../contract/constants.js'
import type { ScriptWorkerOptions } from '../contract/requires.js'
import type { ScriptOutputCapture } from '../types/output.js'
import type { CodeRunRequest } from '../types/runner.js'
import type { ScriptWorkerCommand, ScriptWorkerEvent } from '../types/worker.js'
import { createWorkerBootstrap } from '../utils/worker-program.js'

/** 受信 worker 内部的初始化入口；每个进程只处理一个程序。 */
export interface ScriptWorkerApi {
  /** 建立独立 QuickJS 堆、通信与隔离自证。 */
  start(): Promise<void>
}

class ScriptWorker implements ScriptWorkerApi {
  private runtime!: QuickJSRuntime
  private vm!: QuickJSContext
  private readonly pending = new Map<number, QuickJSDeferredPromise>()
  private nextId = 0
  private started = false
  private finished = false
  private exiting = false
  private unsubscribe?: () => void
  private readonly logs: string[] = []
  private logChars = 0
  private cpuRemaining = Infinity
  private cpuDeadline = Infinity

  public constructor(private readonly options: ScriptWorkerOptions) {}

  public async start(): Promise<void> {
    try {
      const quickjs = await getQuickJS()
      this.runtime = quickjs.newRuntime()
      this.runtime.setMemoryLimit(128 * 1024 * 1024)
      this.runtime.setMaxStackSize(1024 * 1024)
      this.vm = this.runtime.newContext()
      this.runtime.setInterruptHandler(() => performance.now() >= this.cpuDeadline)
      this.expose('__hostCall', (namespace, operation, input) => {
        const promise = this.vm.newPromise()
        const callId = ++this.nextId
        this.pending.set(callId, promise)
        this.send({
          type: 'call',
          callId,
          namespace: this.vm.getString(namespace),
          operation: this.vm.getString(operation),
          input: JSON.parse(this.vm.getString(input)),
        })
        return promise.handle
      })
      this.expose('__hostOutput', (event) => {
        this.send({ type: 'output', event: JSON.parse(this.vm.getString(event)) })
        return this.vm.undefined
      })
      this.expose('__hostLog', (text) => {
        const line = this.vm.getString(text).slice(0, 2000)
        if (this.logChars + line.length > 8000) return this.vm.undefined
        this.logChars += line.length
        this.logs.push(line)
        this.send({ type: 'log', line })
        return this.vm.undefined
      })
      this.unsubscribe = this.options.onMessage((message) => this.receive(message))
      const probe = this.vm.evalCode(
        '[typeof process, typeof require, typeof fetch, typeof WebSocket].every(x => x === "undefined")'
      )
      const confined = !probe.error && isTrue(this.vm.dump(probe.value))
      if (probe.error) probe.error.dispose()
      else probe.value.dispose()
      this.send({ type: 'ready', confined })
    } catch (error) {
      this.finished = true
      this.unsubscribe?.()
      this.unsubscribe = undefined
      throw error
    }
  }

  private communicationFailed(): void {
    if (this.exiting) return
    this.exiting = true
    this.finished = true
    this.pending.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.options.exit(1)
  }

  private send(message: ScriptWorkerEvent): void {
    try {
      void Promise.resolve(this.options.send(message)).catch(() => this.communicationFailed())
    } catch (error) {
      Log.tag('ActRuntime').debug(`ScriptWorker 消息投递失败：${String(error)}`)
      this.communicationFailed()
    }
  }

  private finish(message: Extract<ScriptWorkerEvent, { type: 'done' }>): void {
    if (this.finished) return
    this.finished = true
    this.pending.clear()
    // 保留接收监听维持 IPC 生命周期；finished 会忽略后续命令。
    // 终态由父进程收到后统一终止，避免同步 MessagePort 的发送与立即退出竞争。
    this.send(message)
  }

  private withCpuBudget<T>(action: () => T): T {
    if (this.cpuRemaining <= 0) throw new AppError('TIMEOUT', '脚本执行超时')
    const started = performance.now()
    const outerDeadline = this.cpuDeadline
    this.cpuDeadline = Math.min(outerDeadline, started + this.cpuRemaining)
    try {
      return action()
    } finally {
      if (outerDeadline === Infinity) this.cpuRemaining -= performance.now() - started
      this.cpuDeadline = outerDeadline
    }
  }

  private readValue(handle: QuickJSHandle): unknown {
    return this.withCpuBudget(() => this.vm.dump(handle))
  }

  private pump(): void {
    if (this.finished) return
    const result = this.withCpuBudget(() => this.runtime.executePendingJobs())
    if (result.error) {
      const error = this.readValue(result.error)
      result.error.dispose()
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    const detail = isObject(error)
      ? (error as { message?: unknown; stack?: unknown; code?: unknown })
      : undefined
    let message = String(detail?.message ?? error)
    const library = /(?:at .*?\()?((?:lib\/)[A-Za-z0-9_./-]+\.js):(\d+)/u.exec(
      String(detail?.stack)
    )
    if (library)
      message += `（出在库里的 ${library[1]} 第 ${Math.max(1, Number(library[2]) - 1)} 行）`
    const matched = /program\.js:(\d+)/u.exec(String(detail?.stack))
    const line = matched ? Number(matched[1]) - 1 : undefined
    this.finish({
      type: 'done',
      ok: false,
      logs: this.logs,
      error: {
        code: message.includes('out of memory')
          ? 'TOO_LARGE'
          : message.includes('interrupted')
            ? 'TIMEOUT'
            : String(detail?.code ?? 'PROGRAM_ERROR'),
        message,
        line: optionalWhen(!isUndefined(line) && line > 0, line),
      },
    })
  }

  private expose(name: string, callback: VmFunctionImplementation<QuickJSHandle>): void {
    const handle = this.vm.newFunction(name, callback)
    this.vm.setProp(this.vm.global, name, handle)
    handle.dispose()
  }

  private run(message: CodeRunRequest): void {
    if (this.started) throw new AppError('CONFLICT', '一个隔离进程只能执行一次程序。')
    this.started = true
    if (!Number.isFinite(message.timeoutMs) || message.timeoutMs <= 0)
      throw new AppError('VALIDATION', '缺少有限的执行预算')
    this.cpuRemaining = message.timeoutMs
    const setup = this.withCpuBudget(() =>
      this.vm.evalCode(createWorkerBootstrap(message), 'bootstrap.js')
    )
    if (setup.error) {
      const error = this.readValue(setup.error)
      setup.error.dispose()
      this.fail(error)
      return
    }
    setup.value.dispose()
    for (const [path, source] of Object.entries(message.modules)) {
      const compiled = this.vm.evalCode(
        `globalThis.__libraryFactories[${JSON.stringify(path)}] = async () => {\n${source}\n}`,
        path
      )
      if (compiled.error) {
        const error = this.readValue(compiled.error)
        compiled.error.dispose()
        this.fail(error)
        return
      }
      compiled.value.dispose()
    }
    const evaluated = this.withCpuBudget(() =>
      this.vm.evalCode(`(async () => {\n${message.source}\n})()`, 'program.js')
    )
    if (evaluated.error) {
      const error = this.readValue(evaluated.error)
      evaluated.error.dispose()
      this.fail(error)
      return
    }
    const program = evaluated.value
    void this.withCpuBudget(() => this.vm.resolvePromise(program))
      .then((result) => {
        if (this.finished) {
          if (result.error) result.error.dispose()
          else result.value.dispose()
          return
        }
        if (result.error) {
          const error = this.readValue(result.error)
          result.error.dispose()
          this.fail(error)
          return
        }
        let value = this.readValue(result.value)
        result.value.dispose()
        program.dispose()
        const explicit = this.withCpuBudget(() => this.vm.evalCode('__readOutputs()'))
        if (explicit.error) {
          const error = this.readValue(explicit.error)
          explicit.error.dispose()
          this.fail(error)
          return
        }
        const capture = this.readValue(explicit.value) as ScriptOutputCapture
        const outputs = capture.blocks.map((block) => block.value)
        explicit.value.dispose()
        if (!isEmpty(outputs)) value = { default: outputs.length === 1 ? outputs[0] : outputs }
        const rawText = JSON.stringify(value)
        if (rawText && rawText.length > ScriptOutputLimits.rawChars)
          this.finish({
            type: 'done',
            ok: false,
            logs: this.logs,
            error: { code: 'TOO_LARGE', message: '程序返回值超过归档上限；未保存完整返回值' },
          })
        else this.finish({ type: 'done', ok: true, value, logs: this.logs })
      })
      .catch((error: unknown) => this.fail(error))
    this.pump()
  }

  private receive(message: ScriptWorkerCommand): void {
    if (this.finished) return
    try {
      if (message.type === 'program') {
        this.run(message)
        return
      }
      if (message.type !== 'result') return
      const waiter = this.pending.get(message.callId)
      if (!waiter) return
      this.pending.delete(message.callId)
      const text = this.vm.newString(
        JSON.stringify({ ok: message.ok, value: message.value, error: message.error })
      )
      waiter.resolve(text)
      text.dispose()
      waiter.dispose()
      this.pump()
    } catch (error) {
      Log.tag('ActRuntime').debug('ScriptWorker 读取宿主回执已进入异常处理分支')
      this.fail(error)
    }
  }
}

/** 在宿主已隔离的受信进程中启动单次 QuickJS worker。 */
export function startScriptWorker(options: ScriptWorkerOptions): Promise<void> {
  return new ScriptWorker(options).start()
}
