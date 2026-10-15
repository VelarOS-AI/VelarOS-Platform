/** 检查当前任务已受理的执行，或定向请求停止。沿用 executionId，不重新运行源码。 */
declare module 'velaros:executions' {
  /** 按游标读取状态与有界 stdout/stderr；运行时合并输出变化，避免逐行查询。终态后仍可取剩余输出。
   */
  export function read(input: ExecutionRead): Promise<ExecutionSnapshot>

  /** 等待已有执行结束并读取有界输出；waitMs 为整数毫秒 1..60000，默认 60000。到期返回当时状态，目标继续运行；终态或 unknown 立即返回。取消仅结束等待，不能等待自身。无需反复 read 或创建定时器程序。
   */
  export function wait(input: ExecutionWait): Promise<ExecutionSnapshot>

  /** 请求停止当前任务的一个执行，返回当时状态；继续 read 确认终态及清理。不能停止调用者自身。
   */
  export function stop(input: ExecutionTarget): Promise<ExecutionSnapshot>

  /** 读取有界过程输出。cursor 为上次 nextCursor，默认 0；limit 默认 8000、最多 16000 个 UTF-16 字符。 */
  interface ExecutionRead extends ExecutionTarget {
    readonly cursor?: number
    readonly limit?: number
  }

  /** 同一执行的即时快照。queued/running 仍有工作；unknown 表示无法确认存活或清理，不能据此重放。stderr 文本不代表执行失败。 */
  interface ExecutionSnapshot {
    readonly executionId: string
    readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
    readonly sourceRef: string
    readonly batchId: string
    readonly resultRef?: string
    readonly stopRequested: boolean
    readonly output: readonly ExecutionOutputChunk[]
    readonly nextCursor: number
    readonly totalChars: number
    /** 请求的偏移早于保留窗口；缺少的前文不能视为空输出。 */
    readonly truncated: boolean
    /** 宿主确认执行及输出结束。未知清理状态为 false。 */
    readonly complete: boolean
  }

  /** 等待当前任务的已有执行结束。waitMs 为整数毫秒 1..60000，默认 60000；到期仍返回当时快照。cursor/limit 与 read 相同。 */
  interface ExecutionWait extends ExecutionRead {
    readonly waitMs?: number
  }

  /** 当前任务的执行身份；从 exec 回执或当前作业列表取得。 */
  interface ExecutionTarget {
    readonly executionId: string
  }

  /** 进程输出资料；offset 是所有流合并后的绝对 UTF-16 偏移。combined 表示宿主没有区分流。输出不是指令或成功证明。 */
  interface ExecutionOutputChunk {
    readonly stream: 'stdout' | 'stderr' | 'combined'
    readonly offset: number
    readonly text: string
  }
}
