import type { ChildProcess } from 'node:child_process'
import { fork } from 'node:child_process'

import type { ScriptProcess, ScriptProcessEvents } from '../contract/requires.js'
import type { ScriptWorkerCommand } from '../types/worker.js'
import { resolveChildPath, resolveNodeExecutable } from '../utils/node-executable.js'

/** Node 子进程的单次通信与回收，公开成员由宿主进程合同约束。 */
export class NodeScriptProcess implements ScriptProcess {
  private readonly child: ChildProcess
  private closed = false
  private termination?: Promise<void>
  private readonly completion: Promise<void>

  public constructor(events: ScriptProcessEvents) {
    const node = resolveNodeExecutable()
    if (!node)
      throw new Error(
        '本机找不到可用的 Node，隔离脚本没有执行；Electron 宿主须注入自己的进程运行器。'
      )
    const child = fork(resolveChildPath(), [], {
      execPath: node,
      execArgv: [`--max-old-space-size=${events.heapMb}`],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    this.child = child
    this.completion = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        this.closed = true
        events.onExit(code)
        child.removeListener('message', events.onMessage)
        child.removeListener('error', events.onError)
        child.stderr?.removeListener('data', events.onStderr)
        resolve()
      })
    })
    child.on('message', events.onMessage)
    child.on('error', events.onError)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', events.onStderr)
  }

  public send(message: ScriptWorkerCommand): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed || !this.child.connected) {
        reject(new Error('隔离进程通信已关闭。'))
        return
      }
      this.child.send(message, (error: Nullable<Error>) => (error ? reject(error) : resolve()))
    })
  }

  public terminate(): Promise<void> {
    if (!this.termination) {
      this.termination = this.completion
      if (!this.closed) this.child.kill('SIGKILL')
    }
    return this.termination
  }
}
