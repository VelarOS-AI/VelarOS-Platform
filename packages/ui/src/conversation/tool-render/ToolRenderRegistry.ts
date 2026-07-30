import type React from 'react'

import type { ToolCallBlock } from '#contracts'

/**
 * ToolRenderRegistry — 工具渲染注册中心（渲染层）
 *
 * 设计来源：Claude Code "colocated tool render" 模式
 * 每个工具可以注册自己的展示组件，而不是共用一个通用 JSON 转储。
 * 未注册的工具回退到默认的 ToolCallBlock 组件。
 *
 * 使用方式：
 *   // 在 tool-render registration 文件中声明并默认导出（没有 define* 包装器，就是一份字面量）
 *   const registration: ToolRenderRegistration = {
 *     toolNames: CommandToolNames,
 *     component: LazyCommandToolRender,
 *   }
 *   export default registration
 *
 *   // 在 MessageBubble 中消费
 *   const Component = ToolRenderRegistry.get(block.toolName)
 *   return <Component block={block} />
 */

export type ToolRenderComponent = React.ComponentType<{
  block: ToolCallBlock
  compact?: boolean
  sessionId?: string
  planUpdateIndex?: number
  formatPathForDisplay?: (path: string) => string
}>

export interface ToolRenderRegistration {
  toolNames: readonly string[]
  component: ToolRenderComponent
}

/**
 * Isolated registry for tool renderers.
 *
 * Create one registry per application or composition root when registrations must not leak across
 * tenants, tests, or embedded conversation surfaces.
 */
export class ToolRendererRegistry {
  private readonly registry = new Map<string, ToolRenderComponent>()
  private fallback: Nullable<ToolRenderComponent> = null

  public constructor(registrations: readonly ToolRenderRegistration[] = []) {
    this.registerAll(registrations)
  }

  /** 注册工具对应的渲染组件 */
  public register(toolName: string, component: ToolRenderComponent): this {
    const normalizedName = toolName.trim()
    if (!normalizedName) throw new TypeError('Tool renderer name must not be empty')
    this.registry.set(normalizedName, component)
    return this
  }

  /** 注册一组工具渲染声明，供自动发现的 registration modules 使用。 */
  public registerRegistration(registration: ToolRenderRegistration): this {
    for (const toolName of registration.toolNames) {
      this.register(toolName, registration.component)
    }
    return this
  }

  /** 批量注册，保留声明顺序；后注册的同名工具覆盖先注册项。 */
  public registerAll(registrations: readonly ToolRenderRegistration[]): this {
    for (const registration of registrations) {
      this.registerRegistration(registration)
    }
    return this
  }

  /** 注册未匹配时的默认组件（由 ToolCallBlock 调用） */
  public setFallback(component: ToolRenderComponent): this {
    this.fallback = component
    return this
  }

  /** 获取工具对应的渲染组件，未注册时返回 fallback */
  public get(toolName: string): Nullable<ToolRenderComponent> {
    return this.registry.get(toolName) ?? this.fallback
  }

  public has(toolName: string): boolean {
    return this.registry.has(toolName)
  }

  /**
   * Remove one renderer without disturbing unrelated registrations.
   *
   * When `component` is supplied, ownership must still match. This makes hot-disable safe for
   * bundled capabilities: a stale cleanup cannot remove a renderer installed later by another
   * composition root.
   */
  public unregister(toolName: string, component?: ToolRenderComponent): boolean {
    const normalizedName = toolName.trim()
    if (!normalizedName) return false
    if (component && this.registry.get(normalizedName) !== component) return false
    return this.registry.delete(normalizedName)
  }

  /** 清除应用级扩展并保留可选的 fallback，便于测试和热重载安全重建。 */
  public clear(options: { keepFallback?: boolean } = {}): void {
    this.registry.clear()
    if (!options.keepFallback) this.fallback = null
  }
}

/**
 * Backward-compatible shared registry used by the bundled `ToolCallBlock`.
 *
 * Third-party applications that need isolation should instantiate {@link ToolRendererRegistry}
 * and pass it through `ToolCallBlockProps.registry`.
 */
export const ToolRenderRegistry = new ToolRendererRegistry()
