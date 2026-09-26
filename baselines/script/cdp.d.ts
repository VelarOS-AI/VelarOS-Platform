declare module 'velaros:cdp' {
  /**
   * 直接用 Chrome DevTools Protocol（CDP）操作当前页面：发任意命令、读事件。命令在你自己的一条会话上跑，和宿主那条互不影响：
   * 你开关的域、设的仿真与 Fetch 拦截只算在这条会话上，reset 或 leave 时一并撤掉；会话跨程序保留（上个程序设的深色模式，下个程序里还在）。
   * 事件从会话建起来之后开始记，要收哪个域的事件先 send 它的 enable（Network.enable、Page.enable）。
   * 跨源 iframe 与 worker：先 send Target.setAutoAttach（autoAttach、flatten 为真，waitForDebuggerOnStart 为假），Target.attachedToTarget 事件里的 sessionId 填进 session。
   * 被你用 Fetch 拦下的请求 30000 毫秒没人放行，宿主替你放行，并记一条 Velar.requestAutoContinued 事件。
   * 一条命令的结果按 JSON 超过 10000000 个字符抛 BROWSER_RESULT_TOO_LARGE。都作用在 velaros:browser 当前打开的站点上，没进站点时抛 BROWSER_SITE_NOT_OPEN。
   */

  /** 发一条 CDP 命令，交回协议原样的结果；协议报错抛 BROWSER_PROTOCOL_FAILED，message 是协议给的原话。
   */
  export function send(input: CdpSendInput): Promise<any>

  /** 读这条会话收到的事件（最早的在前）。
   */
  export function events(input: CdpEventsInput): Promise<BrowserProtocolEvents>

  /** 等一条事件到来，交回它（先记下 events 的 last，再触发动作，再从 last 之后等，不会错过）。
   */
  export function waitForEvent(input: CdpWaitForEventInput): Promise<BrowserProtocolEvent>

  /** 断开你的会话：开过的域、设过的仿真与拦截、缓冲的事件一并清掉；下一次 send 重新连一条。
   */
  export function reset(): Promise<void>

  /**
   * 一条 CDP 命令：method 是完整方法名（如 DOM.getDocument，最多 200 个字符），params 是它的参数（按 JSON 算最多 10000000 个字符）。
   * session 是子会话 id（最多 200 个字符）：跨源 iframe、worker 先发 Target.setAutoAttach（autoAttach、flatten 为真），从 Target.attachedToTarget 事件里取；不给就是页面本身。
   */
  interface CdpSendInput {
    method: string
    params?: Record<string, unknown>
    session?: string
  }

  /** 读事件：method 是完整方法名，或以点结尾的域（如 Network.），不给就是全部；after 是上一次拿到的 last，只要它之后的。 */
  interface CdpEventsInput {
    method?: string
    after?: number
  }

  /** 缓冲里的事件：events 按收到的先后排，last 交给下一次的 after；dropped 是缓冲满了挤掉的条数（最多留 5000 条）。 */
  interface BrowserProtocolEvents {
    events: BrowserProtocolEvent[]
    last: number
    dropped: number
  }

  /** 等一条事件：method 写法同 events；after 不给就从现在起等新来的，给了就从那之后找（已经到了的也算）。timeoutMs 最多 60000、缺省 30000，等不到抛 TIMEOUT。 */
  interface CdpWaitForEventInput {
    method: string
    after?: number
    timeoutMs?: number
  }

  /** 一条 CDP 事件：seq 是序号（只增不减），session 是它来自哪个子会话（页面本身是 null），params 是协议原样的参数。 */
  interface BrowserProtocolEvent {
    seq: number
    method: string
    params: any
    session: string | null
  }
}
