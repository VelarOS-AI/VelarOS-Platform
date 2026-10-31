import type { BrowserProtocolChannel } from '../../contract/requires.js'
import type { BrowserViewportOptions } from '../../types/browser.js'
import { buildBrowserViewportDeviceMetrics } from '../../utils/viewport.js'

/** 页面当前真正生效的设备尺寸；截图借用之后在原拥有者上恢复完整参数。 */
export interface BrowserViewportStateApi {
  /** 只登记已经成功的顶层页面命令，不记录 iframe/worker 或失败命令。 */
  record(
    owner: object,
    method: string,
    params: Optional<Record<string, unknown>>,
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>
  ): void
  /** 拥有者断开后不再尝试恢复其仿真。 */
  forget(owner: object): void
  /** 临时改变截图 CSS 视口；返回必须在 finally 调用的还原操作，不调整原生窗口。 */
  temporary(
    options: BrowserViewportOptions,
    open: () => Promise<BrowserProtocolChannel>
  ): Promise<() => Promise<void>>
}

export class BrowserViewportState implements BrowserViewportStateApi {
  private current?: {
    owner: object
    params: Record<string, unknown>
    restore: () => Promise<unknown>
    alive: boolean
  }
  private readonly owners = new WeakMap<object, { alive: boolean }>()

  public record(
    owner: object,
    method: string,
    params: Optional<Record<string, unknown>>,
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>
  ): void {
    if (method === 'Emulation.clearDeviceMetricsOverride' || method === 'Emulation.disable') {
      this.current = undefined
    } else if (method === 'Emulation.setDeviceMetricsOverride' && params) {
      const saved = structuredClone(params)
      const state = {
        owner,
        params: saved,
        restore: async () => {
          // 另一会话清掉的是页面全局状态，原会话仍缓存相同参数；先清自己的记录才能强制重新应用。
          await send('Emulation.clearDeviceMetricsOverride', {})
          return send(method, structuredClone(saved))
        },
        alive: true,
      }
      // 最多保留当前值和截图正在借用的值；同一拥有者重复设置不会累积历史。
      this.owners.set(owner, state)
      this.current = state
    }
  }

  public forget(owner: object): void {
    const state = this.owners.get(owner)
    if (state) state.alive = false
    this.owners.delete(owner)
    if (this.current?.owner === owner) this.current = undefined
  }

  public async temporary(
    options: BrowserViewportOptions,
    open: () => Promise<BrowserProtocolChannel>
  ): Promise<() => Promise<void>> {
    const previous = this.current
    const channel = await open()
    let released = false
    const restore = async (): Promise<void> => {
      if (released) return
      released = true
      // Chromium 的尺寸作用在 WebContents 上：detach 不保证清除，clear 也不会恢复另一会话的旧值。
      try {
        await channel.send('Emulation.clearDeviceMetricsOverride', {})
      } finally {
        try {
          await channel.close()
        } finally {
          if (previous?.alive) {
            await previous.restore()
            this.current = previous
          }
        }
      }
    }
    try {
      await channel.send('Emulation.setDeviceMetricsOverride', {
        ...buildBrowserViewportDeviceMetrics({
          ...options,
          mobile: previous ? previous.params.mobile === true : options.mobile,
        }),
      })
      return restore
    } catch (error) {
      await restore()
      throw error
    }
  }
}
