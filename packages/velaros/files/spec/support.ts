/**
 * 验收测试与实现测试共用的假对象：一个落在真磁盘上的空间端口、接成系统空间那样的本机文件端口（`./local` 入口）、跑一段模型程序的会话。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取，不再各抄一份。
 */

import { readFileSync } from 'node:fs'
import { mkdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { textFileIo } from '@velaros-ai/core/text-files'
import type { ExpectedBytes } from '@velaros-ai/core/text-files/contracts'
import { TextFileErrorCodes } from '@velaros-ai/core/text-files/contracts'
import type { CodeProgramResult, CodeSurfaceOutcome } from '@velaros-ai/script'
import { codeProgramChecker, createCapabilityPort, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/script'

import type { FileOperationContext, FileSpacePort, FileWrite } from '../index'
import { fileOperations } from '../index'
import { createLocalFilePort } from '../local'

/** 单元目录（packages/velaros/files）。 */
export const UnitRoot = resolve(import.meta.dir, '..')

/** 生成的模型面：`velaros:files` 的声明，模型看到的全部。 */
export const Declarations = readFileSync(resolve(UnitRoot, '../../../baselines/script/files.d.ts'), 'utf8')

/** 解开符号链接后的真实路径；文件还不存在时解开它的上级目录。 */
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return join(await realTarget(dirname(path)).catch(() => dirname(path)), basename(path))
  }
}

/** 撤回新建时删掉文件：给了 expected 先核对磁盘上还是它，再删；已经不在了算删完。 */
async function removeFile(target: string, expected: ExpectedBytes | undefined): Promise<void> {
  try {
    if (expected) await textFileIo.assertUnchanged(target, expected)
    await unlink(target)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return
    throw error
  }
}

/** 原子替换写进去：给了 expected 就交给公共件在写前、改名前各核对一次。 */
async function writeFileBytes(write: FileWrite & { bytes: Buffer }): Promise<void> {
  await mkdir(dirname(write.target), { recursive: true })
  const options: { expected?: ExpectedBytes } = {}
  if (write.expected) options.expected = write.expected
  await textFileIo.writeBytes(write.target, write.bytes, options)
}

/**
 * 一个落在真磁盘上的空间：相对路径相对 root；`clamp` 为真时解开符号链接之后越出 root 就拒绝（回执里用相对 root 的写法）。
 * 定位过的路径记在 `located`（操作方法交来的写法），落盘一个一个来：bytes 是字节就原子替换，是 null 就核对后删掉，核对不上报 `VALIDATION`；
 * `failOn` 命中的那一项模拟磁盘出错（`PLATFORM`），前面写进去的在错误的 `context.applied` 里点名。
 */
export function diskSpace(options: {
  root: string
  clamp?: boolean
  failOn?: (target: string) => boolean
}) {
  const commits: FileWrite[][] = []
  const located: string[] = []
  const port: FileSpacePort = {
    locate: async (path) => {
      located.push(path)
      const absolute = isAbsolute(path) ? resolve(path) : resolve(options.root, path)
      const target = await realTarget(absolute)
      if (options.clamp) {
        const inside = relative(await realpath(options.root), target)
        if (inside.startsWith('..') || isAbsolute(inside)) throw new AppError('PERMISSION', `${path} 在这个空间之外`)
      }
      return { path: options.clamp ? relative(options.root, absolute) : absolute, target, linked: target !== absolute }
    },
    commit: async (writes) => {
      commits.push([...writes])
      const applied: string[] = []
      for (const write of writes) {
        try {
          if (options.failOn?.(write.target)) throw new AppError('PLATFORM', '磁盘满了')
          if (write.bytes === null) await removeFile(write.target, write.expected)
          else await writeFileBytes({ ...write, bytes: write.bytes })
          applied.push(write.target)
        } catch (error) {
          const failure = AppError.from(error)
          const code = failure.code === TextFileErrorCodes.externalEdit ? 'VALIDATION' : failure.code
          throw new AppError(code, `写 ${write.target} 失败：${failure.message}`, error, { applied })
        }
      }
    },
  }
  const context: FileOperationContext = { abortSignal: new AbortController().signal, files: port }
  return { port, context, commits, located }
}

/**
 * 本机文件端口（`./local` 入口）接成系统空间那样的上下文：`~` 展开到 `home`（缺省就是 cwd），相对路径相对 `cwd`，绝对路径原样。
 * `onResolve` 在端口每次解析模型给的路径时先被叫到（同步），测试借它在「定改法」与「落盘」之间插一手。
 */
export function localFileSpace(options: { cwd: string; home?: string; onResolve?: (path: string) => void }) {
  const home = options.home ?? options.cwd
  const port = createLocalFilePort({
    resolvePath: (path) => {
      options.onResolve?.(path)
      if (path === '~') return home
      if (path.startsWith('~/')) return join(home, path.slice(2))
      return resolve(options.cwd, path)
    },
  })
  const context: FileOperationContext = { abortSignal: new AbortController().signal, files: port }
  return { port, context }
}

/** 等一个调用失败，交出它的码、说明与上下文。 */
export async function failureOf(call: Promise<unknown>): Promise<{ code: string; message: string; context: Record<string, unknown> }> {
  try {
    await call
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message, context: failure.context }
  }
  throw new Error('应当失败，却成功了')
}

/** 把一段模型程序交给代码面会话：先照生成的声明 typecheck，过了才在隔离里跑，能力调用经操作表转到这个空间。 */
export async function submitModelProgram(space: ReturnType<typeof diskSpace>, source: string, timeoutMs = 20_000): Promise<CodeSurfaceOutcome> {
  // 和系统空间一样的接法：一张操作表，每次调用把这个空间的上下文塞进去。
  const capabilities = createCapabilityPort({
    files: {
      read: (input) => fileOperations.read(input, space.context),
      edit: (input) => fileOperations.edit(input, space.context),
      undo: (input) => fileOperations.undo(input, space.context),
    },
  })
  const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities })
  return session.submit({ program: { source }, granted: [{ namespace: 'files', declarations: Declarations }], timeoutMs })
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完，交出整个结果；没过检查直接抛。 */
export async function runModelProgram(space: ReturnType<typeof diskSpace>, source: string, timeoutMs = 20_000): Promise<CodeProgramResult> {
  const outcome = await submitModelProgram(space, source, timeoutMs)
  if (!outcome.checked) {
    const why = 'needsModules' in outcome ? `要先补模块 ${outcome.needsModules.join(', ')}` : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}
