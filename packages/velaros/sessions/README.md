# @velaros-ai/velaros/sessions

现有会话之间交付任务与追加引导。模型通过 `velaros:sessions` 的 list、ask、tell 调用宿主目录与投递端口；不创建会话，不按工作区类别限定能力。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import {
  type SessionsOperationContext,
  sessionsOperations,
  type SessionsSpacePort,
} from '@velaros-ai/velaros/sessions'
import { VelarSessionsModule } from '@velaros-ai/velaros/sessions/contracts'

declare const sessions: SessionsSpacePort
const context: SessionsOperationContext = { abortSignal: new AbortController().signal, sessions }
const peers = await sessionsOperations.list(context)
const target = peers.find((peer) => !peer.self)
if (target) {
  const result = await sessionsOperations.ask({
    to: target.id,
    task: '核对分配范围中的接口定义，交回方法、路径与参数表。',
  }, context)
  console.log(result.status, result.answer)
}

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
| `@velaros-ai/velaros/sessions` | 宿主 | 操作实现、宿主端口与调用上下文 |
| `@velaros-ai/velaros/sessions/contracts` | 任何进程 | 输入错误码、可移植入参与结果、模型面 |

## 约定

- list 原样返回宿主目录，self 标识发起会话。目标可用性、账号归属、互相等待和排队由宿主判断，宿主错误原样返回。
- ask 必填 to 与 task，to 取自现有会话目录；对方正在运行时等待该轮结束再投递，并等待对应任务的结果。tell 必填 to 与 message，只向活动运行追加引导，不另开一轮。查询状态不能替代实际投递准入。
- 只接收操作声明的字段；to 去除首尾空白，task 与 message 保持原样。未知字段、缺失身份与空白正文在到达宿主之前失败。
- 取消信号原样交给宿主，触发后立即停止等待；迟到的宿主失败仍被观察。已接纳消息的后续归属由宿主处理。
