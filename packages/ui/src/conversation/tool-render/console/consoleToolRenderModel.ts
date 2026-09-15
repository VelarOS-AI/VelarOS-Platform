/**
 * 控制台卡片的模型：从工具结果里认出控制台、把增量输出并起来、算此刻的状态、判断一次按键要做什么，
 * 以及把三件事（读输出、写输入、发中断）交给宿主注入的能力。全是纯函数与薄封装，卡片只管渲染。
 */

import type { ChatToolRenderCapabilities } from '../chatToolRenderCapabilities'

import type {
  SystemConsoleControlResult,
  SystemConsoleOutputChunk,
  SystemConsoleSessionInfo,
  ToolCallBlock,
} from '#contracts'
import { Result } from '#internal/result'
import { isBoolean, isNonBlankString, isString } from '#internal/runtime'
import { isRecord } from '#internal/unknownJsonRecord'

/** 控制台卡片里保留的输出字符数，再多就从头截掉。 */
const ConsoleOutputRenderChars = 60_000

/** 控制台此刻的样子：等用户输入、跑着但插不上嘴、已经结束。 */
export type ConsoleRenderStatus = 'awaiting-input' | 'running' | 'ended'

/** 一次交互式命令在卡片里要展示的东西。 */
export interface ConsoleRenderView {
  session: SystemConsoleSessionInfo
  command: string
  cwd: Nullable<string>
}

/** 把工具结果里的控制台取出来；不是交互式命令就返回 null。 */
export function resolveConsoleSession(result: unknown): Nullable<SystemConsoleSessionInfo> {
  if (!isRecord(result)) return null

  const background = result.backgroundProcess
  if (!isRecord(background)) return null

  const session = background.console
  if (!isRecord(session) || !isString(session.taskId) || !isBoolean(session.acceptsInput)) return null

  return {
    taskId: session.taskId,
    channel: session.channel === 'pty' ? 'pty' : 'pipe',
    acceptsInput: session.acceptsInput,
    note: isString(session.note) ? session.note : '',
  }
}

/** 这条工具调用是不是一次交互式命令；注册层按它决定用控制台卡片还是命令卡片。 */
export function hasConsoleSession(result: unknown): boolean {
  return !!resolveConsoleSession(result)
}

/** 卡片要展示的控制台视图；不是交互式命令就返回 null。 */
export function resolveConsoleView(block: ToolCallBlock): Nullable<ConsoleRenderView> {
  const session = resolveConsoleSession(block.result)
  if (!session) return null

  const result = isRecord(block.result) ? block.result : {}
  const args = isRecord(block.args) ? block.args : {}
  return {
    session,
    command: firstText([result.command, args.command]) ?? '',
    cwd: firstText([result.cwd, args.cwd]),
  }
}

/** 一组候选里第一个非空字符串；都没有就是 null。 */
function firstText(candidates: readonly unknown[]): Nullable<string> {
  for (const candidate of candidates) {
    if (isNonBlankString(candidate)) return candidate
  }
  return null
}

/** 把新读到的一段接到已有输出后面，只留末尾一段；中间被缓冲区挤掉的字符如实插一行说明。 */
export function appendConsoleChunk(
  previous: string,
  chunk: SystemConsoleOutputChunk,
  droppedNotice: (count: number) => string
): string {
  const gap = chunk.droppedChars > 0 ? `\n${droppedNotice(chunk.droppedChars)}\n` : ''
  const merged = previous + gap + chunk.text
  return merged.length > ConsoleOutputRenderChars ? merged.slice(merged.length - ConsoleOutputRenderChars) : merged
}

/** 控制台此刻的状态：不再接受输入就是结束了；还能写、宿主也给了写入通道，才叫在等用户。 */
export function resolveConsoleStatus(acceptsInput: boolean, canWrite: boolean): ConsoleRenderStatus {
  if (!acceptsInput) return 'ended'
  return canWrite ? 'awaiting-input' : 'running'
}

/** 管道背后的进程不会回显用户输入，卡片自己补一行；宿主给的是真终端时由终端回显，不补。 */
export function shouldEchoLocally(session: SystemConsoleSessionInfo): boolean {
  return session.channel === 'pipe'
}

/** 输入框里按下一个键要做什么：回车提交，Ctrl+C 发中断，其余交给输入框自己。 */
export function resolveConsoleKeyAction(event: {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
}): 'submit' | 'interrupt' | 'none' {
  if (event.ctrlKey && event.key.toLowerCase() === 'c') return 'interrupt'
  if (event.key === 'Enter' && !event.shiftKey) return 'submit'
  return 'none'
}

/** 读控制台从 cursor 起的增量输出；宿主没给这个能力就返回 null，卡片降级成只读。 */
export async function readConsoleOutputSince(
  capabilities: ChatToolRenderCapabilities,
  sessionId: Nullable<string>,
  taskId: string,
  cursor: number
): Promise<Nullable<SystemConsoleOutputChunk>> {
  const read = capabilities.readConsoleOutput
  if (!read || !sessionId) return null

  return Result.unwrap(await read(sessionId, taskId, cursor))
}

/** 把用户打的一行写进控制台；宿主没给写入能力就返回 null，卡片不显示输入框。 */
export async function submitConsoleInput(
  capabilities: ChatToolRenderCapabilities,
  sessionId: Nullable<string>,
  taskId: string,
  text: string
): Promise<Nullable<SystemConsoleControlResult>> {
  const write = capabilities.writeConsoleInput
  if (!write || !sessionId) return null

  return Result.unwrap(await write(sessionId, taskId, text))
}

/** 给控制台发中断；宿主没给这个能力就返回 null，卡片不显示中断按钮。 */
export async function interruptConsoleSession(
  capabilities: ChatToolRenderCapabilities,
  sessionId: Nullable<string>,
  taskId: string
): Promise<Nullable<SystemConsoleControlResult>> {
  const interrupt = capabilities.interruptConsole
  if (!interrupt || !sessionId) return null

  return Result.unwrap(await interrupt(sessionId, taskId))
}
