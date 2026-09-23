/**
 * 验收测试与实现测试共用的东西：本机有没有进程约束后端、只删自己建的临时目录的清理、带假 `.git` 的源目录、收尾与取错误的小工具，
 * 以及把本机演练沙箱（`./local` 入口）接成系统空间那样的端口、像模型的程序那样调 `velaros:sandbox` 的会话。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取，不再各抄一份。
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import type { ApprovalPort } from '@velaros-ai/kernel'
import { createCapabilityPort } from '@velaros-ai/script'

import type { LocalSandboxHostApi, SandboxOperationContext, SandboxSurfacePort } from '../index'
import { sandboxOperations } from '../index'

/** 本机有没有进程约束后端：macOS 的 sandbox-exec 或 Linux 的 bubblewrap；没有就建不出沙箱，要真建沙箱的用例跳过。 */
export const canConfine =
  (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
  (process.platform === 'linux' &&
    ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

// ── 临时目录 ────────────────────────────────────────────────────

/** 本套测试建的临时目录都带这个前缀；清理只认它。 */
const ScratchPrefix = 'velaros-sandbox-test-'

/** 在系统临时目录下建一个本套测试专用的空目录（源目录、沙箱基目录、源目录外的受害目录都用它），交回解开符号链接之后的路径。 */
export async function makeScratch(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `${ScratchPrefix}${label}-`)))
}

/** 删掉 makeScratch 建的目录：不是系统临时目录下、带本套前缀的那一级目录就拒绝，绝不递归删别处。 */
export async function removeScratch(directory: string): Promise<void> {
  const base = await realpath(tmpdir())
  if (dirname(directory) !== base || !basename(directory).startsWith(ScratchPrefix)) {
    throw new Error(`拒绝删除 ${directory}：不是本套测试在系统临时目录下建的目录`)
  }
  await rm(directory, { recursive: true, force: true })
}

/** 一个带假 `.git` 的源目录：`.git/config` 里有一个远端，根下一个 `a.txt`。 */
export async function makeSource(): Promise<string> {
  const source = await makeScratch('source')
  await mkdir(join(source, '.git'))
  await writeFile(
    join(source, '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:example/demo.git\n'
  )
  await writeFile(join(source, 'a.txt'), 'alpha\n')
  return source
}

// ── 宿主 ────────────────────────────────────────────────────────

/** 用例收尾：丢掉宿主登记着的全部沙箱（镜像里被改成只读的也删得掉），再停掉宿主。 */
export async function discardAll(host: LocalSandboxHostApi): Promise<void> {
  for (const record of host.listSandboxes()) await host.discardSandbox(record.id)
  await host.dispose()
}

/** 等一个调用失败，交出它的码、说明与上下文（宿主的拒绝把冲突清单、落没落写在上下文里）。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string; context: Record<string, unknown> }> {
  try {
    await call
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message, context: failure.context }
  }
  throw new Error('应当失败，却成功了')
}

// ── 空间 ────────────────────────────────────────────────────────

/** 程序看得到的一次失败：错误码与说明。 */
export interface ProgramFailure extends Error {
  code: string
}

/**
 * 把本机演练沙箱接成系统空间那样的 `SandboxSurfacePort`：宿主的五件原样接上，源目录可以是本机任意位置——
 * 相对路径相对 `cwd`，不给就是 `cwd`。审批端口把每次确认的文案记进 `asked`，`approve` 为 false 时拒绝（缺省放行）。
 * `call` 像模型的程序那样经代码面的能力端口调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。
 */
export function systemSandboxSpace(
  host: LocalSandboxHostApi,
  options: { cwd: string; approve?: boolean }
) {
  const asked: string[] = []
  const port: SandboxSurfacePort = {
    createSandbox: (create) => host.createSandbox(create),
    diffSandbox: (diff) => host.diffSandbox(diff),
    applySandbox: (apply) => host.applySandbox(apply),
    discardSandbox: (sandboxId) => host.discardSandbox(sandboxId),
    runInSandbox: (run, abortSignal) => host.runInSandbox(run, abortSignal),
    resolveSource: async (source) => resolve(options.cwd, source ?? '.'),
  }
  const approval: ApprovalPort = {
    awaitConfirmation: async (message) => {
      asked.push(message)
      if (options.approve === false) throw new AppError('PERMISSION', '用户拒绝了这次操作。')
    },
    awaitConfirmationDecision: async (message) => {
      asked.push(message)
      return { approved: options.approve !== false, message: null, autoApproved: false }
    },
  }
  const context: SandboxOperationContext = {
    abortSignal: new AbortController().signal,
    sandbox: port,
    approval,
  }
  const capabilities = createCapabilityPort({
    sandbox: {
      create: (input) => sandboxOperations.create(input, context),
      run: (input) => sandboxOperations.run(input, context),
      diff: (input) => sandboxOperations.diff(input, context),
      apply: (input) => sandboxOperations.apply(input, context),
      discard: (input) => sandboxOperations.discard(input, context),
    },
  })
  const call = async <T = Record<string, unknown>>(
    operation: string,
    input: Record<string, unknown> = {}
  ): Promise<T> => {
    const outcome = await capabilities.invoke({ namespace: 'sandbox', operation, input })
    if (outcome.error)
      throw Object.assign(new Error(outcome.error.message), {
        code: outcome.error.code,
      }) as ProgramFailure
    return outcome.value as T
  }
  return { port, context, asked, call }
}
