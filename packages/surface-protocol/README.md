# @velaros-ai/surface-protocol

provider 自持代理面（Agent Surface）的线格式合同：带版本、不认宿主。包里没有任何 Desktop、Electron、Kernel 运行时、存储或传输的实现，只有「传什么、长什么样、合不合法」。

传输是另一回事：浏览器扩展现在把这些载荷走 External Agent Bridge v2，将来的 Web 与移动客户端换一个带鉴权的网关也不用改工具合同。

工具回执可以携带一小批校验过的 PNG / JPEG 附件，条数与大小按 `ProviderSurfaceLimits` 卡。二进制不进文本输出：provider 适配器走自己的附件通道上传，base64 不会漏进模型上下文。

```ts
import { providerSurfaceWire, ProviderSurfaceProtocol } from '@velaros-ai/surface-protocol'

const checked = providerSurfaceWire.checkToolCall(payload)
if (!checked.ok) {
  // issues 只有 { path, code }，不含载荷值，可以直接记日志
  throw new Error(`工具调用不合法：${checked.issues.map((issue) => issue.path).join('、')}`)
}
console.info(checked.value.toolName, ProviderSurfaceProtocol.version)
```

只要数据不要能力时用 `@velaros-ai/surface-protocol/contracts`：常量表与十种载荷的类型，没有任何 Node 依赖。
模块卡片见 `MODULE.md`，对外承诺见 `spec/invariants.md`。
