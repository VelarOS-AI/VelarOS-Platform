import type { AgentEvent } from '@velaros-ai/agent/protocol'
import { isEmpty, isNonBlankString, truncate } from '@velaros-ai/core'

/** 单个子 Agent 的进展摘要行数上限；超过后停记并留一条说明，防止撑爆 job 输出。 */
const MaxDigestLines = 200

/** 从工具入参里挑一个最有信息量的短提示（第一个非空字符串值）。 */
function pickArgsHint(args: Record<string, unknown>): Nullable<string> {
  for (const value of Object.values(args)) {
    if (isNonBlankString(value)) return truncate(value.trim(), 60)
  }
  return null
}

/**
 * 子 Agent 运行中进展摘要记录器。
 *
 * 从 worker 事件流提取工具调用轨迹，写入子 Agent 对应的后台 job 输出——
 * 父 Agent 用现有 job:read_output 即可随时窥视运行中子 Agent 的进展，
 * 不需要新工具、不打断子 Agent。sink 绑定前的行先缓冲，绑定时一次性冲刷。
 */
class SubAgentProgressDigestRecorder {
  private readonly startedAt = Date.now()
  private readonly toolNamesByCallId = new Map<string, string>()
  private pendingLines: string[] = []
  private sink: Nullable<(chunk: string) => void> = null
  private lineCount = 0

  /** 绑定输出 sink（后台 job appendOutput），并冲刷此前缓冲的行。 */
  public bindSink(sink: (chunk: string) => void): void {
    this.sink = sink
    if (!isEmpty(this.pendingLines)) {
      const buffered = this.pendingLines
      this.pendingLines = []
      this.emit(buffered.join(''))
    }
  }

  public record(event: AgentEvent): void {
    if (event.type === 'tool-start') {
      this.toolNamesByCallId.set(event.toolCallId, event.toolName)
      const hint = pickArgsHint(event.args)
      this.push(`→ ${event.toolName}${hint ? ` ${hint}` : ''}`)
      return
    }

    if (event.type === 'tool-done' && event.error) {
      const toolName = this.toolNamesByCallId.get(event.toolCallId) ?? 'tool'
      this.push(`✗ ${toolName} 失败：${truncate(event.error.trim(), 120)}`)
    }
  }

  private push(text: string): void {
    if (this.lineCount >= MaxDigestLines) return
    this.lineCount += 1
    const elapsedSeconds = Math.round((Date.now() - this.startedAt) / 1_000)
    const line = `[+${elapsedSeconds}s] ${text}\n`
    const suffix =
      this.lineCount === MaxDigestLines
        ? `[+${elapsedSeconds}s] （进展轨迹已达 ${MaxDigestLines} 行上限，后续省略；最终结果以子 Agent 返回为准）\n`
        : ''
    if (this.sink) {
      this.emit(`${line}${suffix}`)
    } else {
      this.pendingLines.push(`${line}${suffix}`)
    }
  }

  private emit(chunk: string): void {
    try {
      this.sink?.(chunk)
    } catch {
      // arch-guard:silent-catch-ok job 可能已被清理（父执行结束早于子 Agent 收尾）；进展摘要是
      // 尽力而为的旁路，写不进去就永久摘掉 sink，绝不冒泡进子 Agent 主流程。
      this.sink = null
    }
  }
}

export { SubAgentProgressDigestRecorder }
