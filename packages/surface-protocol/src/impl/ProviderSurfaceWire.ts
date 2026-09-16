/**
 * 线格式的唯一出口：五种载荷的严格校验，加上新建一个 provider 自持绑定。
 * 实例是 `providerSurfaceWire`，协议两端（Desktop、VelarOS Terminal、浏览器扩展）共用同一份判定。
 */
import type { ProviderSurfaceWorkspaceSpace } from '../contract/constants.js'
import type {
  ProviderSurfaceBinding,
  ProviderSurfaceCheck,
  ProviderSurfaceToolCall,
  ProviderSurfaceToolCatalog,
  ProviderSurfaceToolResult,
  ProviderSurfaceWorkspaceCatalog,
} from '../types/surface-protocol.js'
import {
  bindingSchema,
  collectIssues,
  toolCallSchema,
  toolCatalogSchema,
  toolResultSchema,
  workspaceCatalogSchema,
} from '../utils/wire.js'

/**
 * provider 自持代理面的线格式能力：校验桥上传来的每一种载荷，构造本端自己的绑定。
 * 只看数据，不发请求、不碰存储；校验失败以数据返回，抛不抛错由调用方决定。实例归本包，进程里只有一份。
 */
export interface ProviderSurfaceWireApi {
  /** 严格校验一条入站的工具调用：多余字段一律拒。失败时给出 `{ path, code }` 列表，不含载荷值。 */
  checkToolCall: (value: unknown) => ProviderSurfaceCheck<ProviderSurfaceToolCall>
  /** 严格校验一条工具回执，规则同上；附件的条数、类型、编码与文件名长度按常量表卡。 */
  checkToolResult: (value: unknown) => ProviderSurfaceCheck<ProviderSurfaceToolResult>
  /** 严格校验一份工具目录，规则同上。 */
  checkToolCatalog: (value: unknown) => ProviderSurfaceCheck<ProviderSurfaceToolCatalog>
  /** 严格校验一份工作区目录，规则同上。 */
  checkWorkspaceCatalog: (value: unknown) => ProviderSurfaceCheck<ProviderSurfaceWorkspaceCatalog>
  /** 严格校验一个 provider 自持的绑定，规则同上。 */
  checkBinding: (value: unknown) => ProviderSurfaceCheck<ProviderSurfaceBinding>
  /**
   * 新建一个 provider 自持的绑定；`now` 缺省取当下。
   * 造出来的绑定一定过得了 `checkBinding`：provider 为空串、时间戳不是非负整数毫秒时当场抛错，
   * 不把「本端说合法、对端说不合法」的绑定放上桥。
   */
  createBinding: (
    provider: string,
    workspaceSpace: ProviderSurfaceWorkspaceSpace,
    now?: number,
  ) => ProviderSurfaceBinding
}

class ProviderSurfaceWire implements ProviderSurfaceWireApi {
  /** 代理面归谁：本包只造 provider 自持的绑定。 */
  private static readonly SurfaceOwner = 'provider' as const

  public checkToolCall(value: unknown): ProviderSurfaceCheck<ProviderSurfaceToolCall> {
    const parsed = toolCallSchema.safeParse(value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: collectIssues(parsed.error) }
  }

  public checkToolResult(value: unknown): ProviderSurfaceCheck<ProviderSurfaceToolResult> {
    const parsed = toolResultSchema.safeParse(value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: collectIssues(parsed.error) }
  }

  public checkToolCatalog(value: unknown): ProviderSurfaceCheck<ProviderSurfaceToolCatalog> {
    const parsed = toolCatalogSchema.safeParse(value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: collectIssues(parsed.error) }
  }

  public checkWorkspaceCatalog(value: unknown): ProviderSurfaceCheck<ProviderSurfaceWorkspaceCatalog> {
    const parsed = workspaceCatalogSchema.safeParse(value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: collectIssues(parsed.error) }
  }

  public checkBinding(value: unknown): ProviderSurfaceCheck<ProviderSurfaceBinding> {
    const parsed = bindingSchema.safeParse(value)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: collectIssues(parsed.error) }
  }

  public createBinding(
    provider: string,
    workspaceSpace: ProviderSurfaceWorkspaceSpace,
    now = Date.now(),
  ): ProviderSurfaceBinding {
    const checked = this.checkBinding({
      provider,
      surfaceOwner: ProviderSurfaceWire.SurfaceOwner,
      workspaceSpace,
      providerConversationId: null,
      providerParentMessageId: null,
      selectedModelId: null,
      selectedReasoningEffort: null,
      capabilityValues: {},
      adapterRevision: null,
      toolContract: null,
      createdAt: now,
      updatedAt: now,
    })
    if (!checked.ok) {
      const fields = checked.issues.map((issue) => issue.path).join('、')
      throw new Error(`绑定参数不合法：${fields}。provider 不能为空，时间戳必须是非负整数毫秒。`)
    }

    return checked.value
  }
}

/** 进程里的那一份线格式能力。 */
export const providerSurfaceWire: ProviderSurfaceWireApi = new ProviderSurfaceWire()
