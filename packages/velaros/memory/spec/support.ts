/**
 * 验收测试与实现测试共用的东西：系统临时目录下的记忆库根目录（清理只删自己建的）、像代码面宿主那样装调用上下文的会话、
 * 跑一段模型程序的代码面会话，以及取失败码的小工具。放在 spec 下，因为验收测试依赖它们；实现测试也从这里取，不再各抄一份。
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CapabilityOperationContext } from '@velaros-ai/script'
import { codeProgramChecker, createCapabilityPort, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/script'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryIdInput, MemoryOperationContext, MemorySaveInput, MemoryScopePort } from '../index'
import { memoryOperations } from '../index'

// ── 临时目录 ────────────────────────────────────────────────────

/** 本套测试建的临时目录都带这个前缀；清理只认它。 */
const ScratchPrefix = 'velaros-memory-'

/** 在系统临时目录下建一个本套测试专用的空目录，交回解开符号链接之后的路径。 */
export async function makeScratch(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), ScratchPrefix)))
}

/** 删掉 makeScratch 建的目录：不是系统临时目录下、带本套前缀的那一级目录就拒绝，绝不递归删别处。 */
export async function removeScratch(directory: string): Promise<void> {
  const base = await realpath(tmpdir())
  if (dirname(directory) !== base || !basename(directory).startsWith(ScratchPrefix)) {
    throw new Error(`拒绝删除 ${directory}：不是本套测试在系统临时目录下建的目录`)
  }
  await rm(directory, { recursive: true, force: true })
}

// ── 会话 ────────────────────────────────────────────────────────

/**
 * 像代码面宿主那样接一个会话：同一个作用域端口，每次调用装一份调用上下文，取消信号跟着这次调用。
 * `call` 像模型的程序那样调一次：入参与返回值都过一遍 JSON，失败抛带 code 的错误（程序看得到的就这两样）。
 */
export function memorySpace(memory: MemoryScopePort, abortSignal: AbortSignal = new AbortController().signal) {
  const context: MemoryOperationContext = { abortSignal, memory }
  const hostContext = (call: CapabilityOperationContext): MemoryOperationContext => ({ abortSignal: call.signal ?? abortSignal, memory })
  const capabilities = createCapabilityPort({
    memory: {
      list: (_input, call) => memoryOperations.list(hostContext(call)),
      save: (input, call) => memoryOperations.save(input as MemorySaveInput, hostContext(call)),
      remove: (input, call) => memoryOperations.remove(input as MemoryIdInput, hostContext(call)),
    },
  })
  const call = async (operation: string, input?: unknown): Promise<any> => {
    const outcome = await capabilities.invoke({ namespace: 'memory', operation, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) })
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value))
  }
  return { context, capabilities, call }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return { code: failure.code ?? AppError.from(error).code, message: failure.message ?? String(error) }
  }
  throw new Error('应当失败，却成功了')
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velaros:memory` 声明：就是提交进仓的那份生成物，程序照着它过 typecheck。 */
export const MemoryDeclarations = readFileSync(fileURLToPath(new URL('../../../../baselines/script/memory.d.ts', import.meta.url)), 'utf8')

/** 这一轮授给程序的模块：只有 `memory` 一个命名空间。 */
const Granted = [{ namespace: 'memory', declarations: MemoryDeclarations }]

/** 只照生成的声明做 typecheck、不执行：交回诊断，过了就是空的。 */
export function checkModelProgram(source: string) {
  const checked = codeProgramChecker.check({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完：交出程序的结果。 */
export async function runModelProgram(space: ReturnType<typeof memorySpace>, source: string, timeoutMs = 20_000) {
  const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities: space.capabilities })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why = 'needsModules' in outcome ? `要先补模块 ${outcome.needsModules.join(', ')}` : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}
