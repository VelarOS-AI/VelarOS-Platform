/**
 * 代码面 `sandbox` 命名空间的五个操作：`SandboxOperations` 与整个进程唯一的 `sandboxOperations`。接口 `SandboxOperationsApi` 在本文件的类上方。
 * 这里只做几件事：把模型给的作用域交给宿主端口解析、要问人的先问（落回、镜像里的危险命令）、调端口、把回执整成模型看的样子——一个文件系统调用都不发，
 * 建镜像、跑命令、算差量、落回全在宿主那一侧（本机实现是 `./local` 入口的本机演练沙箱）。
 */

import { isArray, isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { ShellLimits } from '@velaros-ai/velaros/shell/contracts'

import type { SandboxOperationContext } from '../contract/requires.js'
import type {
  SandboxApplyInput,
  SandboxApplyResult,
  SandboxCreateInput,
  SandboxDiff,
  SandboxDiffInput,
  SandboxDiffOptions,
  SandboxDiscardInput,
  SandboxDiscardResult,
  SandboxRecord,
  SandboxRunInput,
  SandboxRunResult,
} from '../types/rehearsal-sandbox.js'
import { sandboxIdOf, sandboxTimeoutOf } from '../utils/input.js'

import type { RehearsalSandboxRulesApi } from './RehearsalSandboxRules.js'
import { rehearsalSandboxRules } from './RehearsalSandboxRules.js'

/**
 * 代码面跨空间的命名空间之一：模型在程序里写 `create(...)`、`run(...)` …，每个空间注入自己的
 * `SandboxSurfacePort`。作用域（source 相对哪个根解析、越界算不算）由那个端口定，不由模型挑，所以模型面只有这一套说明。
 * 实现是 `SandboxOperations`，整个进程只有一份（`sandboxOperations`）。
 *
 * @AgentView
 * 演练沙箱：把一个目录镜像出来，命令在镜像里跑、写不到外面；看过差量、用户点头之后才落回源目录。
 */
export interface SandboxOperationsApi {
  /**
   * @AgentView
   * 把一个目录镜像到临时区，脚本先在镜像里跑：落回之前源目录一个字节都没变，镜像随便糟蹋，用完 discard。
   * 回执里的 id 是后面四个操作要的那个；镜像里的命令写不出镜像根，所以脚本里算错的路径在这里只会报错。
   * gitignore 忽略的目录缺省链接到真实目录（能读，写不进），要在镜像里重新构建就把 ignored 传成 copy。
   * @OperationEffect write
   */
  create(input: SandboxCreateInput, ctx: SandboxOperationContext): Promise<SandboxRecord>
  /**
   * @AgentView
   * 在镜像里跑一条命令，工作目录钉在镜像根。命令自己失败（非零退出、超时）是正常回执、不抛错，照 success 判。
   * 危险命令（递归删除、丢未提交改动的 git 这类）照常先问用户，用户不点头就抛错、命令不跑。
   * 镜像里连不上网，除非建沙箱时把 network 开了。
   * @OperationEffect write
   */
  run(input: SandboxRunInput, ctx: SandboxOperationContext): Promise<SandboxRunResult>
  /**
   * @AgentView
   * 看镜像相对建的时候变了什么：三列相对路径（永远完整），加上新增与修改的文本文件的统一差量；只想看其中几个就传 paths。
   * @OperationEffect none
   */
  diff(input: SandboxDiffInput, ctx: SandboxOperationContext): Promise<SandboxDiff>
  /**
   * @AgentView
   * 把镜像里的变化落回源目录，回执是真落下去的三列。源目录里要落的文件自建沙箱以来被别人改过，整批不落；
   * `.git` 里的变化永远不落，要那部分就在源目录重放那几条 git 命令。镜像里什么都没变时三列都是空的。
   * @OperationEffect write
   */
  apply(input: SandboxApplyInput, ctx: SandboxOperationContext): Promise<SandboxApplyResult>
  /**
   * @AgentView
   * 删掉镜像，源目录不受影响；沙箱本来就不在时 removed 为 false，不算错。
   * @OperationEffect write
   */
  discard(input: SandboxDiscardInput, ctx: SandboxOperationContext): Promise<SandboxDiscardResult>
}

export class SandboxOperations implements SandboxOperationsApi {
  constructor(private readonly rules: RehearsalSandboxRulesApi) {}

  public async create(
    input: SandboxCreateInput,
    ctx: SandboxOperationContext
  ): Promise<SandboxRecord> {
    ctx.abortSignal.throwIfAborted()
    // 作用域在端口里：系统空间的实现收任意路径，项目空间的实现钳在项目内、越界就拒绝。
    const source = await ctx.sandbox.resolveSource(input.source)
    return ctx.sandbox.createSandbox({ source, network: input.network, ignored: input.ignored })
  }

  public async run(
    input: SandboxRunInput,
    ctx: SandboxOperationContext
  ): Promise<SandboxRunResult> {
    ctx.abortSignal.throwIfAborted()
    const id = sandboxIdOf(input?.id)
    if (!isString(input.command) || isEmpty(input.command.trim()))
      throw new AppError('VALIDATION', 'run 要一条命令（command）')
    // 危险命令在镜像里照常先问（ADR 0006）：写不出镜像，但用户要看得到脚本在做什么；被拒就抛错，宿主一个进程都不起。
    const request = this.rules.prepareRun(id, input.command)
    if (request)
      await ctx.approval.awaitConfirmation(request.message, ctx.abortSignal, request.options)
    // 输出不折叠：跟 velaros:shell 同一个只守内存的上限。
    const outcome = await ctx.sandbox.runInSandbox(
      {
        sandboxId: id,
        command: input.command,
        timeoutMs: sandboxTimeoutOf(input.timeoutMs),
        maxOutputChars: ShellLimits.outputChars,
      },
      ctx.abortSignal
    )
    return { ...outcome, id, command: input.command }
  }

  public async diff(input: SandboxDiffInput, ctx: SandboxOperationContext): Promise<SandboxDiff> {
    ctx.abortSignal.throwIfAborted()
    const options: SandboxDiffOptions = { sandboxId: sandboxIdOf(input?.id) }
    if (isArray(input.paths)) options.paths = input.paths
    return ctx.sandbox.diffSandbox(options)
  }

  public async apply(
    input: SandboxApplyInput,
    ctx: SandboxOperationContext
  ): Promise<SandboxApplyResult> {
    ctx.abortSignal.throwIfAborted()
    sandboxIdOf(input?.id)
    // 「核对过的就是要落的」：点名的路径按完整的三列核，再把同一个指纹交给宿主，镜像在这之后又变过就整批不落。
    const changes = await ctx.sandbox.diffSandbox({ sandboxId: input.id, textDiffs: false })
    if (!this.rules.prepareApply({ diff: changes, paths: input.paths }))
      return {
        sandboxId: input.id,
        created: [],
        modified: [],
        deleted: [],
        skippedGit: changes.gitChanged,
      }
    return ctx.sandbox.applySandbox({
      sandboxId: input.id,
      paths: input.paths,
      fingerprint: changes.fingerprint,
    })
  }

  public async discard(
    input: SandboxDiscardInput,
    ctx: SandboxOperationContext
  ): Promise<SandboxDiscardResult> {
    ctx.abortSignal.throwIfAborted()
    return ctx.sandbox.discardSandbox(sandboxIdOf(input?.id))
  }
}

/** 整个进程只有一份的沙箱操作；宿主把它挂在代码面的 `sandbox` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const sandboxOperations: SandboxOperationsApi = new SandboxOperations(rehearsalSandboxRules)
