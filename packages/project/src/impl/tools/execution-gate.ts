import { isEmpty } from '@velaros-ai/core'

interface Waiter {
  write: boolean
  start(): void
  cancel(): void
}
interface Gate {
  readers: number
  writing: boolean
  queue: Waiter[]
}
const gates = new Map<string, Gate>()

/** 同进程多个 Agent 共用项目资源门；前台构建/修改与读取互斥，读取之间共享。 */
export function runWithProjectExecutionGate<T>(
  root: string,
  write: boolean,
  signal: AbortSignal,
  run: () => Promise<T> | T
): Promise<T> {
  signal.throwIfAborted()
  let gate = gates.get(root)
  if (!gate) {
    gate = { readers: 0, writing: false, queue: [] }
    gates.set(root, gate)
  }
  const current = gate
  const drain = () => {
    while (!current.writing && !isEmpty(current.queue)) {
      const first = current.queue[0]!
      if (first.write && current.readers) return
      current.queue.shift()
      first.start()
      if (first.write) return
    }
    if (!current.readers && !current.writing && isEmpty(current.queue)) gates.delete(root)
  }
  return new Promise<T>((resolve, reject) => {
    const waiter: Waiter = {
      write,
      start() {
        signal.removeEventListener('abort', waiter.cancel)
        if (write) current.writing = true
        else current.readers++
        Promise.resolve()
          .then(() => {
            signal.throwIfAborted()
            return run()
          })
          .then(resolve, reject)
          .finally(() => {
            if (write) current.writing = false
            else current.readers--
            drain()
          })
      },
      cancel() {
        const index = current.queue.indexOf(waiter)
        if (index < 0) return
        current.queue.splice(index, 1)
        signal.removeEventListener('abort', waiter.cancel)
        reject(signal.reason ?? new Error('Project operation cancelled while waiting'))
        drain()
      },
    }
    signal.addEventListener('abort', waiter.cancel, { once: true })
    current.queue.push(waiter)
    if (signal.aborted) waiter.cancel()
    else drain()
  })
}
