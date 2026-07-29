/**
 * 渲染错误边界：捕获子树 render / 生命周期异常，降级为 `fallback` 并写日志，避免白屏整页。
 *
 * variants（封闭枚举）：无外观 variant——通用 React error boundary，外貌全由宿主 `fallback` 决定。
 * 端口：`selfHeal` 注入宿主自愈（陈旧模块硬刷新等）；`onCaughtError` 侧效副作用，
 *       `isRecoverableExternally` 为真时跳过 `resetKeys` 自动重试（避免流式更新造成重试风暴）。
 * `resetKeys` 变化（浅比较）自动清错重渲染；`scope` 仅用于日志排查。
 */
import React from 'react'

/** 边界自愈端口：宿主注入陈旧模块硬刷新等自愈能力，本库不承载具体恢复策略。 */
export interface RenderErrorSelfHealPort {
  /** 捕获错误后触发（host 侧执行自愈副作用，如陈旧模块 chunk 硬刷新）。 */
  onCaughtError?: (error: Error, info: React.ErrorInfo) => void
  /** 该错误是否由外部自愈接管：为真则跳过 resetKeys 自动重试。 */
  isRecoverableExternally?: (error: Error) => boolean
}

export interface RenderErrorBoundaryProps {
  /** 降级渲染；`reset` 供「重试」交互清除错误态后重渲染子树。 */
  fallback: (error: Error, reset: () => void) => React.ReactNode
  /** 任一元素引用变化即清除错误态自动重试（浅比较）。 */
  resetKeys?: readonly unknown[]
  /** 日志与排查用的边界标识（如 app-shell / chat-message）。 */
  scope: string
  /** 宿主自愈端口（陈旧模块硬刷新等）；缺省则纯降级不自愈。 */
  selfHeal?: RenderErrorSelfHealPort
  children: React.ReactNode
}

interface RenderErrorBoundaryState {
  error: Nullable<Error>
}

function areResetKeysEqual(
  left: LooseOptional<readonly unknown[]>,
  right: LooseOptional<readonly unknown[]>
): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false

  return left.every((value, index) => Object.is(value, right[index]))
}

export class RenderErrorBoundary extends React.Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  state: RenderErrorBoundaryState = { error: null }

  public static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { error }
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const runtimeConsole = globalThis.console
    runtimeConsole.error('子树渲染异常，已降级为 fallback', {
      scope: this.props.scope,
      error,
      componentStack: info.componentStack,
    })

    // 自愈交给宿主端口（覆盖所有 scope，包括 fallback 为 null 的边界）。
    this.props.selfHeal?.onCaughtError?.(error, info)
  }

  public componentDidUpdate(prevProps: RenderErrorBoundaryProps): void {
    if (!this.state.error) return
    // 由外部自愈接管的错误（如陈旧模块 chunk）页内重渲染必然再失败：放行 resetKeys 会造成
    // 每次流式更新一次的无效重试风暴。恢复交给宿主自愈端口。
    if (this.props.selfHeal?.isRecoverableExternally?.(this.state.error)) return
    if (areResetKeysEqual(prevProps.resetKeys, this.props.resetKeys)) return

    this.reset()
  }

  private readonly reset = (): void => {
    this.setState({ error: null })
  }

  public render(): React.ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)

    return this.props.children
  }
}
