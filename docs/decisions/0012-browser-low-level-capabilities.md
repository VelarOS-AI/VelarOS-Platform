# 0012: 浏览器给模型底层能力：页面脚本、真实输入原子与模型自己的 CDP 会话

- Status: accepted
- Date: 2026-09-18
- Owners: `@velaros-ai/velar`（browser 单元）

## Context

ADR 0011 把 32 个工具换成了 `velar:browser`（48 个操作）与 `velar:devtools`（22 个），但操作的切法还是工具时代的：
一个意图一个操作，替模型把链路想好。用户的判断：「浏览器包里面定义的那一堆操作很多都可以干掉，只需要一个执行 js 的方法就能干掉一堆，
和执行命令是一个道理，也更灵活」；随后又定下「必须给模型提供一些更加底层的能力」。

逐个核对实现之后：

- **一半操作就是预先写好的页面脚本。** `query`、`media`、`table`、`list`、`paginate`、`content`、`select`、`check`、`focus`、`clear`、
  `selectText`、`scrollIntoView`、`scroll`、`waitForSelector`、`waitForText`、`waitForUrl` 在页面里跑一段我们写好的 JavaScript；
  `evaluate` 做的是同一件事，只是脚本由模型写。
- **`evaluate` 当不了万能入口。** 返回值被压扁（数组只留前 100 项、对象只留 100 个键、8 层以下截断），结果超过 20 万字符只回截断标记；
  没有参数，值只能拼进源码；失败不抛错，回一个 `ok: false` 的信封。`table`、`list`、`content` 自己先 `JSON.stringify` 再取回，就是为了绕开它。
- **页面 JS 不是浏览器的完整入口。** shell 能替掉一堆文件工具，是因为 shell 就是操作系统的完整入口；页面脚本只是页面自己的沙箱：
  `el.click()` 派出的事件 `isTrusted` 为假、只有一个 click；合成的 Enter 不提交表单、Tab 不换焦点；`:hover` 触发不了；
  文档一跳转脚本就没了；截图的像素、PDF、给 file input 塞文件、alert、权限、标签页都不在页面里。浏览器真正对应 shell 的那一层是 CDP。
- **两个真缺陷。** `fill` 在页面里直接 `el.value = x` 再派 input 事件：React 盯着 value 的写入，判定「没变」，onChange 不触发，
  页面上看着填进去了、提交还是空的；富文本编辑器被直接改 textContent 也进不了编辑器的状态。`waitForUrl`、`waitForText`、`waitForFunction`
  往页面里注入一段自己轮询的脚本，页面一真跳转（登录回调正是这种场景）脚本就跟着旧文档没了。

ADR 0011 否决过「再开裸 CDP」：模型绕过运行时改仿真会让坐标对不上，关掉 Network 域会把诊断弄断。这两条是在护着运行时，不是做不到。
用仓库里的 Electron 41 实测：

- 内嵌页面可以给模型单开一条 CDP 会话（`Target.attachToTarget` 连页面自己，flatten）。域的开关、事件、Fetch 拦截只算在这条会话上，宿主那条不受影响。
- 这条会话派的鼠标事件 `isTrusted` 为真。
- 会话一断开，它设的仿真撤掉；被它拦着的请求直接失败，不会把页面卡死。
- `WebFrameMain.executeJavaScript` 能在跨源 iframe 里跑脚本。

外部浏览器（CDP 驱动）里同一个页面可以连多个客户端，再开一条 WebSocket 就是一条独立会话。
跨源 iframe 在 Chrome 里是另一个进程的 target，驱动那条连接的 `Page.getFrameTree` 看不到它；在驱动连接上开 `Target.setAutoAttach`（flatten）
挂出 iframe 子会话，框架树与求值都够得着，嵌套的一层层挂。

## Decision

### 四层，模型可以从任何一层下手

| 层 | 给模型什么 | 宿主只负责 |
| --- | --- | --- |
| 协议（新模块 `velar:cdp`） | `send` 任意 CDP 命令，`events` 读事件，`waitForEvent` 等事件，`reset` 撤掉自己做过的一切 | 开和收这条会话、缓存事件、兜住没人放行的拦截 |
| 输入原子（`velar:browser`） | `mouseMove`、`mouseDown`、`mouseUp`、`wheel`、`keyDown`、`keyUp`、`insertText` | 键位表（key、code、keyCode、text）、按住的修饰键与鼠标键、虚拟指针；坐标和截图同一套视口 CSS 像素 |
| 页面脚本（`velar:browser`） | `evaluate`（表达式或用 `args` 调的函数，整份 JSON 取回，出错就抛），`frames` 列出含跨源 iframe 的框架树 | 序列化、守内存的上限、在指定框架的主世界里跑（内嵌与外部浏览器同一口径） |
| 常用组合（`velar:browser`、`velar:devtools`） | `open`、`inspect`、`screenshot`、`click`、`fill`、`press`、`drag`、`goto`、`waitFor…`、诊断、trace…… | 就是现在这些；下面三层随时能绕过去 |

### `velar:browser`：48 → 34

删掉 20 个：

| 删掉的 | 换成 |
| --- | --- |
| `query`、`media`、`table`、`list`、`content` | `evaluate` 里 `querySelectorAll(…).map(…)` |
| `paginate` | 程序里一个循环：evaluate 取、click 下一页、waitForFunction 等内容变 |
| `select`、`check`、`focus`、`clear`、`selectText`、`scrollIntoView`、`scroll` | `evaluate`（下拉框设 value 再派 change；勾选直接 click） |
| `waitForSelector`、`waitForText`、`waitForUrl` | `waitForFunction` 一个判定式 |
| `wait` | 程序里 `setTimeout` |
| `clickAt` | `click` 给 x、y |
| `tabs`、`events` | `state` 里的 `tabs`、`pending` |

改了的：

- **`evaluate`**：`script` 是一个表达式；求出来是函数就用 `args`（JSON 值的数组）调它，是 Promise 就等它；`frame` 是 `frames()` 给的 id。
  直接交回值（类型 `any`，和 `JSON.parse` 一样）。结果整份按 JSON 取回：DOM 元素换成它的描述，环引用写成 `"[Circular]"`，有 `toJSON` 的（日期）照它来。
  超过守内存的上限抛 `BROWSER_RESULT_TOO_LARGE`；页面里抛错抛 `BROWSER_SCRIPT_FAILED`，message 带页面的错误名、说明与脚本里的行列。`mode` 删掉：多条语句写成箭头函数。
- **`fill`** 改成真实输入：页面脚本聚焦、全选，宿主像输入法一样插入 value（空字符串就按退格删掉选中的），React、Vue 与富文本编辑器都认；
  勾选框、下拉框、日期这类不是文本的控件如实回 `matched: false`。
- **`click`** 收元素或 x、y 两者之一，都带 `button`、`clickCount`（元素也能双击、右键）。
- **`type` 改名 `insertText`**：它本来就不发按键事件，叫 type 会让熟悉 Playwright 的模型误会。
- **`press`** 与新的 `keyDown`、`keyUp` 走同一张键位表：Enter 带上 `\r`、Tab 换焦点、Shift 按住时字母大写；macOS 上 Meta 加 a、c、x、v、z 带编辑命令。
- **等待一个口径**：`waitForFunction` 由宿主每隔 `intervalMs` 在当前页面跑一次判定，跳转途中的那一拍算「还没到」，新页面上接着判；
  到了交回判定式的值。`waitForLoad` 交回页面状态，`waitForEvent` 交回那个事件。三个都是等不到抛 `TIMEOUT`，message 说等了什么、最后看到什么——
  原来回 `matched: false`，程序忘了查就带着没到位的页面往下走。
- **`state`** 进了站点时带上标签页（`tabs`）与挂着的弹窗、下载、权限（`pending`）。

新增：`frames`、`mouseDown`、`mouseUp`、`wheel`、`keyDown`、`keyUp`（`mouseMove` 留下，拖出任意路径靠它）。按住的修饰键与鼠标键记在会话上，
带到之后的每个输入事件里：`keyDown Shift` 之后的 `click` 就是 Shift 点击，`mouseDown` 之后的 `mouseMove` 就是拖。

### `velar:devtools`：22 → 18

只转发一两条命令的删掉：`emulate`、`setViewport`（`Emulation.*` 一条命令）、`storage`（localStorage 与 sessionStorage 用 evaluate，
cookie 含 HttpOnly 用 `Network.getCookies`）、`runUserScript`（「立刻跑一次」就是 evaluate）。留下的都是协议之外还要宿主干活的：
诊断（程序开始之前就在录）、请求详情（宿主会话里的响应体）、`network` 规则（mock 要一个常驻的应答者）、`zoom`（Electron 的缩放不在 CDP 里）、
trace 与 insight（DevTools 分析引擎）、堆快照、录屏（GIF 编码）、用户脚本（跨会话持久）。

### `velar:cdp`：模型自己的一条 CDP 会话

- `send({ method, params?, session? })`：在模型的会话上发一条命令，交回结果；协议报错抛 `BROWSER_PROTOCOL_FAILED`，message 是协议的原话。
  跨源 iframe、worker 先发 `Target.setAutoAttach`（flatten），`Target.attachedToTarget` 给的 sessionId 填进 `session`；只认这条会话自己挂出来的子会话。
- `events({ method?, after? })`：这条会话收到的事件，按序号从早到晚；`method` 是完整方法名，或以点结尾的域前缀（`Network.`）。
  缓冲只为守住内存有上限，挤掉的条数记在 `dropped`。
- `waitForEvent({ method, after?, timeoutMs? })`：等 `after` 之后第一条这个方法的事件（不给 `after` 就从现在起），等不到抛 `TIMEOUT`。
- `reset()`：断开这条会话。开过的域、设过的仿真与拦截、事件缓冲一并清掉；下一次 `send` 重新连一条。

会话第一次用到时才建，跨程序保留（上一个程序设的深色模式，下一个程序里还在），`reset`、会话关闭、外部浏览器切标签页时断开。

**模型直接动协议，靠结构防止把宿主弄坏，不设闸（和 shell 一个待遇，ADR 0009）：**

- **会话分开**：模型关掉 Network 域、改 Fetch 拦截，只影响它自己那条；宿主的诊断、录屏、mock 照常。宿主自己的事件监听只收宿主会话的事件，
  不会把模型会话里的网络事件记两遍。
- **没人放行的拦截由宿主兜住**：程序跑完就没人应答 `Fetch.requestPaused` 了。被模型拦下的请求 30 秒没人放行，宿主替它放行，并在事件里记一条
  `Velar.requestAutoContinued`。
- **坐标现读**：宿主换算坐标一律现读页面的实时尺寸（截图读布局指标，点击的点来自页面里的 `getBoundingClientRect`），模型用协议改了视口也不会点偏。

### 错误码

新增四个：`BROWSER_SCRIPT_FAILED`（页面脚本抛错）、`BROWSER_RESULT_TOO_LARGE`（结果超过守内存的上限）、`BROWSER_PROTOCOL_FAILED`（CDP 命令被协议拒绝）、
`BROWSER_FRAME_NOT_FOUND`（frame 不在当前的框架树里，跳转后旧 id 作废）。

## Alternatives

- **真的只留 evaluate**：点击全成了 `el.click()`——靠 pointerdown 打开的下拉框不开，风控看 isTrusted，`:hover` 菜单出不来，Enter 提交不了表单。否决。
- **裸 CDP 只挂在宿主那条会话上**：模型关一个域就断了宿主的诊断，改 Fetch 拦截会覆盖 mock 的规则。否决，给模型单开一条。
- **evaluate 直接收函数**（`evaluate(() => document.title)`）：检查器本来就带 DOM 声明，函数体能在跑之前查类型；但闭包变量带不进页面是最常见的坑，
  还要改门的参数序列化。这一轮不做。
- **三个挂起事件的处理合成一个 `respond`**：dialog、download、permission 各有自己的字段，合起来只是换个形状。不做。
- **拦截的兜底绑在程序结束上**：能力那一侧不知道程序什么时候结束，要在代码面加收尾钩子；按时间兜底只多一个常量。

## Security and privacy

不加任何确认或名单：模型手里本来就有 shell，读浏览器资料目录、起一个自己的 Chrome 都拦不住，确认只是摩擦（ADR 0009）。
隔离靠的是会话分开：模型的会话动不了宿主会话上的域、监听与拦截规则。

## Compatibility and migration

`velar:browser`、`velar:devtools` 的模型面按上表变；空间端口 `BrowserSpacePort` 删掉 `scrollPage`、`queryElements`、`waitForSelector`、`listMediaSources`、
`readPageStorage`、`configureEmulation`、`setViewport`，改了 `evaluateScript` 的入参与回执，加了 `listFrames`、`keyDown`、`keyUp`、`mouseDown`、`mouseUp`、
`mouseWheel` 与三个协议会话的方法；`moveMouse` 多了 `steps`，`performTargetAction` 的点击多了 `button`、`clickCount`。
运行时 `ElectronBrowserRuntimeApi` 加上对应的方法；只为被删操作存在的运行时方法与页面脚本随后删掉。产品还没接代码面，不留过渡。

## Validation

- 单元验收：模型面、声明里的数字与常量表一致、没进站点不碰端口、入参先核对、evaluate 的整份取回与三种失败、fill 走真实输入、
  等待跨跳转与超时抛错、state 带标签页与挂起事件、`velar:cdp` 的会话隔离与事件游标与拦截兜底。
- 三份代码模版照真实声明过类型检查，并经真的代码面会话逐个函数跑通。
- 真机探针（`packages/velar/browser/test/probes/electron-low-level.probe.mjs`，不进 bun test）：用仓库里的 Electron 跑真的运行时，
  内嵌页面与外部 Chrome（产品自带的启动器，临时配置目录、无头）各一轮、每轮 22 项：evaluate 取回上万项的数组、报错行列换算，
  三层框架（跨源 iframe、同源子框架、跨源里再套回主站的）都列得出、都在框架主世界里求值，模型经 CDP 子会话进跨源 iframe，
  fill 让 React 式受控输入认到改动、可编辑区替换、空值清空，Enter 提交表单、Shift 按住输入大写，鼠标原子拖出的是真事件、滚轮落在指针下、
  clickCount 2 是一次真双击，模型会话的 Network 事件不让宿主诊断记两遍、模型关掉 Network 域宿主照常，reset 撤掉仿真，
  拦截 30 秒没人放行由宿主放行并记事件，waitForFunction 跨过真跳转。44 项全过。

## Consequences

- 模型读页面要自己写 querySelector；代码模版改成以 evaluate 为主的日常写法。
- 用户在旁边看时，evaluate 改的东西没有虚拟指针和高亮框；要让用户看见的动作走 click、fill 这些。
- 声明变小：删掉的操作带走了它们的入参与回执类型。
