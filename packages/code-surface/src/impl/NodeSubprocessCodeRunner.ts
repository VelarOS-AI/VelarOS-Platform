/**
 * 隔离运行器（**开发期专用**）：`node --permission` 起一个子进程跑模型的程序。
 *
 * 它挡得住：读写文件、起子进程、加载原生插件——实测都返回 `ERR_ACCESS_DENIED`。
 * 它**挡不住网络**：Node 的权限模型不覆盖 socket，程序仍能 `net.connect` 把数据发出去。
 * 这条缺口很要命，因为敏感数据是我们自己经能力端口递进去的。所以本实现不许进正式发版，
 * 正式版换 WASM 里的 QuickJS（那里没有任何环境能力，只有显式绑进去的）。见 INV-5。
 */

import { fork } from 'node:child_process'

import { CodeSurfaceErrorCodes } from '../contract/constants.js'
import type { CodeRunnerApi } from '../contract/requires.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'
import { resolveChildPath, resolveNodeExecutable } from '../utils/node-executable.js'
import { serveCapabilityCall } from '../utils/runner-bridge.js'

class NodeSubprocessCodeRunner implements CodeRunnerApi {
  public async run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome> {
    const childPath = resolveChildPath()
    const nodePath = resolveNodeExecutable()
    if (nodePath === null) return {
        ok: false,
        logs: [],
        error: {
          code: CodeSurfaceErrorCodes.runnerCrashed,
          message: '本机找不到 node，隔离起不来，程序没有执行。隔离靠的是 node 的权限模型，换一个不认那套旗标的运行时等于没有隔离。',
        },
      }
    const child = fork(childPath, [], {
      // 必须是真的 node：fork 缺省用 process.execPath，宿主跑在 bun 下时那是 bun，它不认 --permission。
      execPath: nodePath,
      // 只放开读引导脚本自己；程序源码走 IPC，不落盘。
      execArgv: ['--permission', `--allow-fs-read=${childPath}`],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })

    const logs: string[] = []
    return new Promise<CodeRunOutcome>((resolve) => {
      let settled = false
      const stop = (outcome: CodeRunOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.kill('SIGKILL')
        resolve(outcome)
      }
      const fail = (code: string, message: string): void =>
        stop({ ok: false, logs, error: { code, message } })

      const timer = setTimeout(
        () => fail(CodeSurfaceErrorCodes.timeout, `程序超过 ${request.timeoutMs}ms 没跑完，已终止。`),
        request.timeoutMs
      )
      const onAbort = (): void => fail(CodeSurfaceErrorCodes.aborted, '程序被中止。')
      signal?.addEventListener('abort', onAbort, { once: true })

      child.on('message', (raw: unknown) => {
        const message = raw as { type?: string; [key: string]: unknown }
        if (message.type === 'ready') {
          // 隔离**自证**不过就不把程序发进去。宿主跑在 bun 下时 fork 出来的是 bun，
          // 它不认 `--permission`，命令行看着完全正常而隔离一点没生效——只信旗标就会栽在这里。
          if (message.confined !== true) {
            fail(
              CodeSurfaceErrorCodes.runnerCrashed,
              '隔离没有生效：子进程自证时仍能读到不该读的文件，程序没有执行。' +
                '多半是宿主跑在不认 --permission 的运行时下（比如 bun）把 fork 出来的进程也变成了同一个运行时。'
            )
            return
          }
          child.send({
            type: 'program',
            source: request.source,
            blobs: request.blobs,
            operations: request.operations,
          })
          return
        }
        if (message.type === 'log') {
          const line = String(message.line)
          logs.push(line)
          onLog(line)
          return
        }
        if (message.type === 'call') {
          void serveCapabilityCall(child, message, dispatch)
          return
        }
        if (message.type === 'done') {
          const error = message.error as { message?: string; line?: number } | undefined
          stop({
            ok: message.ok === true,
            value: message.value,
            logs,
            error: message.ok === true
              ? undefined
              : {
                  code: CodeSurfaceErrorCodes.programError,
                  message: error?.message ?? '程序失败但没给出原因。',
                  line: error?.line,
                },
          })
        }
      })

      child.on('exit', (code) =>
        fail(CodeSurfaceErrorCodes.runnerCrashed, `隔离进程意外退出，码 ${code}。`)
      )
      child.on('error', (error) => fail(CodeSurfaceErrorCodes.runnerCrashed, error.message))
    })
  }

}

/** 开发期用的那一个隔离运行器；正式发版前必须换掉（见类上方说明与 INV-5）。 */
export const nodeSubprocessCodeRunner: CodeRunnerApi = new NodeSubprocessCodeRunner()

/** 这个运行器是不是可以拿去发版：恒为 false，宿主装配时据此拦下。 */
export const NodeSubprocessRunnerIsReleaseReady: false = false
