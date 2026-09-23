/**
 * 项目资源门：`ProjectExecutionGate` 与整个进程唯一的 `projectExecutionGate`。接口 `ProjectExecutionGateApi` 在本文件的类上方。
 * 同一进程里多个 Agent 共用一个项目时，读取之间可以同时进行；前台构建、修改与读取互斥，写者之间排队。
 */

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { Gate, Waiter } from '../../types/agent.js'

/**
 * 按项目根排队的读写门。读取（inspect 类工具、只读命令）之间共享；修改（事务写入、撤销、会改项目的前台命令）独占。
 * 排队中的任务可以被各自的取消信号撤出队列；一扇门没人用、也没人排队时就回收。
 */
export interface ProjectExecutionGateApi {
  /**
   * 在 root 的门里执行 task：write 为真时独占，否则与其他读取共享。取消信号在排队期间触发就撤出队列并以取消原因失败；
   * 开始执行前再核一次取消。task 的结果或错误原样交回。
   */
  run<T>(root: string, write: boolean, signal: AbortSignal, task: () => Promise<T> | T): Promise<T>
}

export class ProjectExecutionGate implements ProjectExecutionGateApi {
  private readonly gates = new Map<string, Gate>()

  public run<T>(
    root: string,
    write: boolean,
    signal: AbortSignal,
    task: () => Promise<T> | T
  ): Promise<T> {
    signal.throwIfAborted()
    let gate = this.gates.get(root)
    if (!gate) {
      gate = { readers: 0, writing: false, queue: [] }
      this.gates.set(root, gate)
    }
    const current = gate
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        write,
        start: () => {
          signal.removeEventListener('abort', waiter.cancel)
          if (write) current.writing = true
          else current.readers++
          Promise.resolve()
            .then(() => {
              signal.throwIfAborted()
              return task()
            })
            .then(resolve, reject)
            .finally(() => {
              if (write) current.writing = false
              else current.readers--
              this.drain(root, current)
            })
        },
        cancel: () => {
          const index = current.queue.indexOf(waiter)
          if (index < 0) return
          current.queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.cancel)
          reject(signal.reason ?? new AppError('CANCELLED', '等待项目资源门时操作被取消'))
          this.drain(root, current)
        },
      }
      signal.addEventListener('abort', waiter.cancel, { once: true })
      current.queue.push(waiter)
      if (signal.aborted) waiter.cancel()
      else this.drain(root, current)
    })
  }

  /** 放行队首能开始的任务：写者要等读者清空，读者可以连着放行；门空了就回收。 */
  private drain(root: string, gate: Gate): void {
    while (!gate.writing && !isEmpty(gate.queue)) {
      const first = gate.queue[0]!
      if (first.write && gate.readers) return
      gate.queue.shift()
      first.start()
      if (first.write) return
    }
    if (!gate.readers && !gate.writing && isEmpty(gate.queue)) this.gates.delete(root)
  }
}

/** 整个进程唯一的项目资源门；项目的两件工具与项目空间里的前台命令共用它，保证同一进程里的读写互斥。 */
export const projectExecutionGate: ProjectExecutionGateApi = new ProjectExecutionGate()
