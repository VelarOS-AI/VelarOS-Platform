# @velaros-ai/velaros/sessions

同一个对话里的会话之间交活、传话：代码面 `velaros:sessions` 的 `list`（这个对话里有哪些会话）、`ask`（交一件事给一个会话，等它这一轮跑完，交回它说的话）与 `tell`（传一句话，不等）。会话的一切都在宿主那里——这个对话里有谁、开新会话、排队、谁在等谁；本单元是模型面加入参核对，核对、规范过的入参经端口交给宿主，结果与错误原样交回。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import { AppError } from '@velaros-ai/core/error'
import {
  type SessionsOperationContext,
  sessionsOperations,
  type SessionsSpacePort,
} from '@velaros-ai/velaros/sessions'
import { SessionsErrorCodes, VelarSessionsModule } from '@velaros-ai/velaros/sessions/contracts'

// 宿主给：已经绑在发问会话上的端口（成员校验、互相等待、对方正忙都在宿主那里判断）
declare const sessions: SessionsSpacePort

// 宿主自己调用（界面、测试）
const context: SessionsOperationContext = { abortSignal: new AbortController().signal, sessions }
const inputCodes: readonly string[] = Object.values(SessionsErrorCodes)
const peers = await sessionsOperations.list(context)
const browser = peers.find((peer) => peer.workspace === 'browser' && !peer.self)
try {
  const reply = browser
    ? await sessionsOperations.ask({ to: browser.id, task: '在京东上买一包 A4 纸，付款前停下来问我' }, context)
    : await sessionsOperations.ask({ workspace: 'browser', site: 'https://www.jd.com', task: '在京东上买一包 A4 纸，付款前停下来问我' }, context)
  if (reply.status === 'waiting') console.log(reply.session, '在问：', reply.answer)
} catch (error) {
  if (!(error instanceof AppError)) throw error
  // 入参不对是 SessionsErrorCodes 里的码；别的码来自宿主（对方不在这个对话里、两个会话互相等待……）
  console.warn(inputCodes.includes(error.code) ? '入参不对' : '宿主拒绝了', error.message)
}

// 挂成模型程序里可以 import 的 velaros:sessions；ask、tell 只能在 execute 里调，list 哪儿都能调
export const sessionsModule = createCapabilityModule({
  surface: VelarSessionsModule,
  implementation: sessionsOperations,
  instanceId: 'sessions',
  context: (call) => ({ abortSignal: call.signal, sessions }),
})
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/sessions` | 宿主 | `sessionsOperations`、宿主要给的 `SessionsSpacePort`、调用上下文 `SessionsOperationContext` |
| `@velaros-ai/velaros/sessions/contracts` | 任何进程 | 错误码 `SessionsErrorCodes`、三种工作区 `SessionWorkspaces`、入参与结果、模型面 `VelarSessionsModule` |

## 约定

- 端口已经绑在发问的会话上：list 交回这个对话里的会话（发问的那个 self 为真）；ask 等对方这一轮跑完才交回，对方正在跑就排在这一轮之后；tell 不等，闲着的马上收到并为它跑一轮，正在跑的这一轮跑完再收到。
- 交给宿主之前核对入参，不对抛 `SessionsErrorCodes` 里的码，宿主一次都不调：to 与 workspace 恰好一个；workspace 是 `SessionWorkspaces` 之一；project 必须带绝对路径的 root（`/` 开头、`C:\` 这样带盘符、`\\服务器\共享`，宿主跑在哪个平台都认）；site 只跟 browser、要是 http(s) 网址；task、message 不能是空白。
- 交给宿主的入参是规范过的：to、workspace、root、site 去掉首尾空白（空白的当作没给），site 换成网址的规范写法，没给的字段不在对象上；task、message 原样。
- 成员校验、两个会话互相等待、对方正忙都由宿主判断；宿主拒绝时抛的错误（带宿主自己的码）原样交给模型，这里不重复判断。
- 取消信号原样交给宿主；宿主还没回时一取消，本单元就以取消原因失败，不陪宿主等。结果（`SessionAnswer`、`SessionTold`）照宿主交回的原样。
