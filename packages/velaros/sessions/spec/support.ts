/**
 * 验收测试与实现测试共用的假对象：一个假宿主（这个对话里的会话表、ask 与 tell 交回什么都能按用例换，收到的入参与取消信号都记下来），
 * 以及跑一段模型程序的代码面会话。放在 spec 下，因为验收测试依赖它们；实现测试从这里取，不再各抄一份。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros-ai/core/error'
import type { CapabilityOperationContext } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'

import type {
  SessionAnswer,
  SessionAskInput,
  SessionPeer,
  SessionsOperationContext,
  SessionsSpacePort,
  SessionTellInput,
  SessionTold,
} from '../index'
import { sessionsOperations } from '../index'

// ── 假宿主 ──────────────────────────────────────────────────────

/** 缺省的会话表：自己是一个项目会话，另有一个浏览器会话（正在跑）和一个系统会话。 */
export const DefaultPeers: SessionPeer[] = [
  {
    id: 'project-1',
    workspace: 'project',
    title: '商城前端',
    root: '/home/me/shop-web',
    site: null,
    running: true,
    self: true,
  },
  {
    id: 'browser-1',
    workspace: 'browser',
    title: '京东',
    root: null,
    site: 'https://www.jd.com/',
    running: true,
    self: false,
  },
  {
    id: 'system-1',
    workspace: 'system',
    title: null,
    root: null,
    site: null,
    running: false,
    self: false,
  },
]

/** 假宿主收到的东西：list 被调了几次，ask、tell 各收到什么入参、带着哪个取消信号。 */
export interface FakeHostRecord {
  lists: number
  asks: Array<{ input: SessionAskInput; signal: AbortSignal }>
  tells: Array<{ input: SessionTellInput; signal: AbortSignal }>
}

/** 缺省的回答：交给谁就是谁（开新会话的叫「工作区-new」），做完了，把 task 复述一遍。 */
function doneAnswer(input: SessionAskInput): SessionAnswer {
  return {
    session: input.to ?? `${input.workspace ?? 'unknown'}-new`,
    status: 'completed',
    answer: `做完了：${input.task}`,
    reason: null,
  }
}

/**
 * 一个假宿主：会话表、ask 与 tell 怎么回都能按用例换（缺省是做完了、马上收到）。
 * 交回端口、调用上下文、代码面宿主装上下文的写法，以及它收到的东西。
 */
export function sessionsSpace(
  options: {
    peers?: SessionPeer[]
    answer?: (input: SessionAskInput, signal: AbortSignal) => Promise<SessionAnswer>
    told?: (input: SessionTellInput, signal: AbortSignal) => Promise<SessionTold>
    abortSignal?: AbortSignal
  } = {}
) {
  const record: FakeHostRecord = { lists: 0, asks: [], tells: [] }
  const port: SessionsSpacePort = {
    list: async () => {
      record.lists += 1
      return options.peers ?? DefaultPeers
    },
    ask: async (input, signal) => {
      record.asks.push({ input, signal })
      return options.answer ? options.answer(input, signal) : doneAnswer(input)
    },
    tell: async (input, signal) => {
      record.tells.push({ input, signal })
      return options.told ? options.told(input, signal) : { session: input.to, status: 'delivered' }
    },
  }
  const context: SessionsOperationContext = {
    abortSignal: options.abortSignal ?? new AbortController().signal,
    sessions: port,
  }
  /** 代码面宿主给每次调用装的上下文：同一个端口，取消信号用这次调用的。 */
  const hostContext = (call: CapabilityOperationContext): SessionsOperationContext => ({
    abortSignal: call.signal ?? new AbortController().signal,
    sessions: port,
  })
  return { port, context, hostContext, record }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message }
  }
  throw new AppError('ASSERTION', '应当失败，却成功了')
}

/** 一个一直不回的宿主调用：只有取消信号能让它失败（宿主守约时），给了 honor 为假就连取消都不理。 */
export function pendingUntilAborted<T>(signal: AbortSignal, honor = true): Promise<T> {
  return new Promise<T>((_, reject) => {
    if (honor) signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velaros:sessions` 声明：就是提交进仓的那份生成物；程序照它核对 import，代码模版照它过类型检查。 */
export const SessionsDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/sessions.d.ts', import.meta.url)),
  'utf8'
)

/** 这一轮授给程序的模块：只有 `sessions` 一个命名空间。 */
const Granted = [{ namespace: 'sessions', declarations: SessionsDeclarations }]

/** 代码模版照生成的声明做完整类型检查、不执行：交回诊断，过了就是空的。模型交的程序只查语法，不走这里。 */
export function typecheckTemplate(source: string) {
  const checked = codeProgramChecker.typecheck({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/**
 * 让一段真程序过语法检查，再在隔离里跑完。能力端口由一张只有 `sessions.list`、`sessions.ask`、`sessions.tell` 的操作表接出来，
 * 每次调用经 `hostContext` 装一份 `SessionsOperationContext`；交出程序的结果。
 */
export async function runModelProgram(
  space: ReturnType<typeof sessionsSpace>,
  source: string,
  timeoutMs = 30_000
) {
  const capabilities = createCapabilityPort({
    sessions: {
      list: async (_input, context) => sessionsOperations.list(space.hostContext(context)),
      ask: async (input, context) => sessionsOperations.ask(input, space.hostContext(context)),
      tell: async (input, context) => sessionsOperations.tell(input, space.hostContext(context)),
    },
  })
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities,
  })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new AppError('ASSERTION', `程序没过检查：${why}`)
  }
  return outcome.result
}
