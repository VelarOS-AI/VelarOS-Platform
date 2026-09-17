/**
 * 代码面 `sandbox` 命名空间的五个操作：`SandboxOperations` 与整个进程唯一的 `sandboxOperations`。接口 `SandboxOperationsApi` 在本文件的类上方。
 * 这里只做三件事：把模型给的作用域交给宿主端口解析、调端口、把回执整成模型看的样子——一个文件系统调用都不发，
 * 建镜像、跑命令、算差量、落回全在宿主那一侧（本机是 `@velaros-ai/system` 的本地内核）。
 */

import type { SandboxOperationContext } from '../contract/requires.js'
import type {
  SandboxApplyInput,
  SandboxApplyResult,
  SandboxCreateInput,
  SandboxDiff,
  SandboxDiffInput,
  SandboxDiscardInput,
  SandboxDiscardResult,
  SandboxRecord,
  SandboxRunInput,
  SandboxRunResult,
} from '../types/rehearsal-sandbox.js'

import type { RehearsalSandboxRulesApi } from './RehearsalSandboxRules.js'
import { rehearsalSandboxRules } from './RehearsalSandboxRules.js'

/**
 * 代码面第一个跨空间的命名空间：模型在程序里写 `sandbox.create`、`sandbox.run` …，system 与 project 各注入自己的
 * `SandboxSurfacePort`。作用域（source 相对哪个根解析、越界算不算）由那个端口定，不由模型挑，所以模型面只有这一套说明。
 * 实现是 `SandboxOperations`，整个进程只有一份（`sandboxOperations`）。
 */
export interface SandboxOperationsApi {
  /**
   * @AgentView
   * 把一个目录镜像到临时区，脚本先在镜像里跑：落回之前源目录一个字节都没变，镜像随便糟蹋，用完 discard。
   * 回执里的 id 是后面四个操作要的那个；镜像里的命令写不出镜像根，所以脚本里算错的路径在这里只会报错。
   * gitignore 忽略的目录缺省链接到真实目录（能读，写不进），要在镜像里重新构建就把 ignored 传成 copy。
   */
  create(input: SandboxCreateInput, ctx: SandboxOperationContext): Promise<SandboxRecord>
  /**
   * @AgentView
   * 在镜像里跑一条命令，工作目录钉在镜像根。命令自己失败（非零退出、超时）是正常回执、不抛错，照 success 判。
   * 镜像里连不上网，除非建沙箱时把 network 开了。
   */
  run(input: SandboxRunInput, ctx: SandboxOperationContext): Promise<SandboxRunResult>
  /**
   * @AgentView
   * 看镜像相对建的时候变了什么：三列相对路径加有界的文本差量。删除列永远完整，另外两列被 maxFiles 截掉时 truncated 为真。
   */
  diff(input: SandboxDiffInput, ctx: SandboxOperationContext): Promise<SandboxDiff>
  /**
   * @AgentView
   * 把镜像里的变化落回源目录。落回前一定把删除与覆盖摆给用户确认，用户不点头就抛错、一个文件都不落；
   * 确认之后镜像又被改过，宿主整批不落。`.git` 里的变化永远不落，要那部分就在源目录重放那几条 git 命令。
   * 镜像里什么都没变时不问用户，三列都是空的。
   */
  apply(input: SandboxApplyInput, ctx: SandboxOperationContext): Promise<SandboxApplyResult>
  /**
   * @AgentView
   * 删掉镜像，源目录不受影响；沙箱本来就不在时 removed 为 false，不算错。
   */
  discard(input: SandboxDiscardInput, ctx: SandboxOperationContext): Promise<SandboxDiscardResult>
}

export class SandboxOperations implements SandboxOperationsApi {
  constructor(private readonly rules: RehearsalSandboxRulesApi) {}

  public async create(input: SandboxCreateInput, ctx: SandboxOperationContext): Promise<SandboxRecord> {
    ctx.abortSignal.throwIfAborted()
    // 作用域在端口里：system 的实现收任意绝对路径，project 的实现钳在项目内、越界就拒绝。
    const source = await ctx.sandbox.resolveSource(input.source)
    return ctx.sandbox.createSandbox({ source, network: input.network, ignored: input.ignored })
  }

  public async run(input: SandboxRunInput, ctx: SandboxOperationContext): Promise<SandboxRunResult> {
    ctx.abortSignal.throwIfAborted()
    const outcome = await ctx.sandbox.runInSandbox(
      { sandboxId: input.id, command: input.command, timeoutMs: input.timeoutMs, maxOutputChars: input.maxOutputChars },
      ctx.abortSignal
    )
    return { ...outcome, id: input.id, command: input.command }
  }

  public async diff(input: SandboxDiffInput, ctx: SandboxOperationContext): Promise<SandboxDiff> {
    ctx.abortSignal.throwIfAborted()
    return ctx.sandbox.diffSandbox({ sandboxId: input.id, maxFiles: input.maxFiles })
  }

  public async apply(input: SandboxApplyInput, ctx: SandboxOperationContext): Promise<SandboxApplyResult> {
    ctx.abortSignal.throwIfAborted()
    // 「确认的就是要落的」：条数、预览、敏感路径都按不截断的完整差量算，确认之后把同一个指纹交给宿主。
    const changes = await ctx.sandbox.diffSandbox({ sandboxId: input.id, maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })
    const request = this.rules.prepareApply({ ...ctx.sandbox.applyPolicy(changes.source), diff: changes, paths: input.paths })
    if (!request) return { sandboxId: input.id, created: [], modified: [], deleted: [], skippedGit: changes.gitChanged }
    await ctx.approval.awaitConfirmation(request.message, ctx.abortSignal, request.options)
    return ctx.sandbox.applySandbox({ sandboxId: input.id, paths: input.paths, fingerprint: changes.fingerprint })
  }

  public async discard(input: SandboxDiscardInput, ctx: SandboxOperationContext): Promise<SandboxDiscardResult> {
    ctx.abortSignal.throwIfAborted()
    return ctx.sandbox.discardSandbox(input.id)
  }
}

/** 整个进程只有一份的沙箱操作；宿主把它挂在代码面的 `sandbox` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const sandboxOperations: SandboxOperationsApi = new SandboxOperations(rehearsalSandboxRules)
