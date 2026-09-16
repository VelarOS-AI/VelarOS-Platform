import type { z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserToolContext } from '../../contract/requires'
import type { BrowserSiteContext, BrowserWorkspaceManifest } from '../../types/browser'
import { buildBrowserArtifactAccess } from '../../utils/artifacts.js'
import type { browserUserScriptsSchema } from '../../utils/schemas/user-scripts'
import { getActiveBrowserContext, requireActiveBrowserSite } from '../../utils/tool.js'
import { BrowserWorkspaceArtifactManager } from '../workspace/BrowserWorkspaceArtifactManager.js'

/**
 * 站点会话本身的操作：进站点、读站点工作区清单、管理这个站点的用户脚本。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文。用户脚本的九个动作在这里只做
 * 「入参形状 → 宿主端口入参」的映射，真正的存储、校验与注入都在宿主那一侧。
 */
export interface BrowserSiteOperationsApi {
  /** 打开网址并把当前会话绑到该站点，同时准备好站点工作区清单。 */
  enterSite(url: string): Promise<{
    active: true
    browserContext: BrowserSiteContext
    workspaceManifest: BrowserWorkspaceManifest
    message: string
  }>
  /** 读当前站点工作区清单；不存在或不是本站点的才补写一份。 */
  readWorkspaceManifest(): Promise<BrowserWorkspaceManifest>
  /** 按收敛好的入参分派到用户脚本的九个动作。 */
  manageUserScripts(input: z.output<typeof browserUserScriptsSchema>): Promise<unknown>
}

export class BrowserSiteOperations implements BrowserSiteOperationsApi {
  constructor(private readonly ctx: BrowserToolContext) {}

  public async enterSite(url: string) {
    this.ctx.abortSignal.throwIfAborted()

    // enterSite 会打开页面、绑定当前 session，并准备站点级 context。
    const browserContext = await this.ctx.browser.enterSite(url)
    // 进入站点：整份写一次清单（刷新 lastActivatedAt），后续产物工具才能按标准目录写入。
    const workspaceManifest = await this.artifacts().activateManifest(browserContext)

    return {
      active: true as const,
      browserContext,
      workspaceManifest,
      message: '已打开并进入当前网站的浏览器会话；如果之前已绑定其他网站，则已同步切换。',
    }
  }

  public async readWorkspaceManifest(): Promise<BrowserWorkspaceManifest> {
    this.ctx.abortSignal.throwIfAborted()

    // 读操作：清单已经是当前站点的就原样返回，只有缺失、损坏或不是本站点的才补写。
    return this.artifacts().getManifest(getActiveBrowserContext(this.ctx))
  }

  public async manageUserScripts(input: z.output<typeof browserUserScriptsSchema>): Promise<unknown> {
    this.ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(this.ctx)

    switch (input.action) {
      case 'list':
      case 'read':
      case 'set_enabled':
      case 'set_global_enabled':
      case 'move':
      case 'delete':
      case 'run_now':
        return this.ctx.browser.manageUserScripts(input)
      case 'create': {
        const { action: _action, ...script } = input
        return this.ctx.browser.manageUserScripts({ action: 'create', script })
      }
      case 'update': {
        const { action: _action, id, ...patch } = input
        if (isEmpty(Object.keys(patch)))
          throw new AppError('VALIDATION', 'update 至少需要一个要修改的字段。')
        return this.ctx.browser.manageUserScripts({ action: 'update', id, patch })
      }
      default:
        input satisfies never
        throw new AppError('VALIDATION', 'browser:user_scripts 不认识这个 action。')
    }
  }

  /** 当前站点的产物管理器：只经工具上下文的文件 API 读写，出不了站点目录。 */
  private artifacts(): BrowserWorkspaceArtifactManager {
    return new BrowserWorkspaceArtifactManager(buildBrowserArtifactAccess(this.ctx))
  }
}
