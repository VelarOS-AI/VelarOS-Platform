import { isEmpty, isFiniteNumber,isPlainObject, isPresent, isString } from '@velaros-ai/core'
const ReflectToolCallToolName = 'tool_reflect'
const MaxTimedToolCallTimeoutMs = 10 * 60 * 1_000

const ControlToolNames = new Set([ReflectToolCallToolName])

// tool_reflect 的解析形状（toolName/args/timeoutMs/reason）；call_tool_with_timeout/call_tool_chain
// 已删除，其解析逻辑随之移除，仅保留 reflect 复用的这一份。
interface TimedToolCallInput {
  toolName: string
  args: Record<string, unknown>
  timeoutMs: number
  reason: Nullable<string>
}

type TimedToolCallParseResult =
  | { ok: true; input: TimedToolCallInput }
  | { ok: false; reason: string }

function parseTimedToolCallInput(args: Record<string, unknown>): TimedToolCallParseResult {
  const rawToolName = args.toolName
  if (!isString(rawToolName) || isEmpty(rawToolName.trim())) return { ok: false, reason: 'toolName must be a non-empty string.' }

  const rawArgs = args.args
  if (isPresent(rawArgs) && !isPlainObject(rawArgs)) return { ok: false, reason: 'args must be an object when provided.' }

  const rawTimeoutMs = args.timeoutMs
  if (!isFiniteNumber(rawTimeoutMs) || rawTimeoutMs <= 0) return { ok: false, reason: 'timeoutMs must be a positive number of milliseconds.' }

  const timeoutMs = Math.min(Math.floor(rawTimeoutMs), MaxTimedToolCallTimeoutMs)
  const rawReason = args.reason
  return {
    ok: true,
    input: {
      toolName: rawToolName.trim(),
      args: isPlainObject(rawArgs) ? { ...rawArgs } : {},
      timeoutMs,
      reason: isString(rawReason) && !isEmpty(rawReason.trim()) ? rawReason.trim() : null,
    },
  }
}

function isControlToolName(toolName: string): boolean {
  return ControlToolNames.has(toolName)
}

export {
  isControlToolName,
  MaxTimedToolCallTimeoutMs,
  parseTimedToolCallInput,
  ReflectToolCallToolName,
  type TimedToolCallInput,
}
