# 外部网页模型桥

本地产品通过一个固定网页通道驱动标准 Runtime；网页只完成一次模型请求。

## 用法

```ts
import { createExternalModelDriver } from '@velaros-ai/velaros/act/bridge'

const model = createExternalModelDriver({
  id: 'chatgpt-web',
  limits: { contextTokens: 128000, inputTokens: 112000, outputTokens: 16000 },
  createId: () => crypto.randomUUID(),
  send: async (request) => { console.log(request.requestId) },
  cancel: async () => {},
})
model.close()
```

## 入口

- `@velaros-ai/velaros/act/bridge`
- `@velaros-ai/velaros/act/bridge/contracts`

## 约定

宿主固定设备与会话身份，并核验响应来源和租约。完整供应商终止之后才调用 deliver；连接 EOF 和 UI 预览保持在传输展示侧。
