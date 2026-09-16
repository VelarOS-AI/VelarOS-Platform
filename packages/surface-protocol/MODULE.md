# @velaros-ai/surface-protocol 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/ProviderSurfaceWire.ts` 类上方的接口（`contract/provides.ts` 登记它），常量表在 `contract/constants.ts`。
> 门禁：`bun run check:module-ownership`。

## 这是什么

provider 自持代理面（Agent Surface）的线格式合同：浏览器扩展、Web 与移动这类瘦客户端和 VelarOS 之间传什么、每一种载荷长什么样、怎么判它合不合法。
它刻意不认宿主：Desktop 与 VelarOS Terminal 是这条边界的两个平级实现，扩展也照同一份判定。
传输是另一回事——扩展现在把这些载荷走 External Agent Bridge v2，将来换别的网关不动工具合同。
本包只看数据：不发请求、不碰存储、不碰 Node 模块，渲染进程与浏览器扩展都能直接加载。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：一件能力的 API 定义在类上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `providerSurfaceWire` | `ProviderSurfaceWireApi` | 五种载荷的严格校验（`checkToolCall` / `checkToolResult` / `checkToolCatalog` / `checkWorkspaceCatalog` / `checkBinding`）与 `createBinding` |
| `ProviderSurfaceProtocol` | 契约常量 | 线协议版本，冻结为 1 |
| `ProviderSurfaceWorkspaceSpaces` | 契约常量 | 代理面能挂的三个空间 |
| `ProviderSurfaceToolResultStatuses` | 契约常量 | 工具回执的三种结局 |
| `ProviderSurfaceArtifactMediaTypes` | 契约常量 | 回执附件允许的图片类型 |
| `ProviderSurfaceLimits` | 契约常量 | 附件条数、base64 长度、文件名长度的公开上限 |

**数据面**是 `types/surface-protocol.ts`（可移植）：十种线格式载荷（`ProviderSurfaceToolCall`、`ProviderSurfaceToolResult`、`ProviderSurfaceToolCatalog`、`ProviderSurfaceToolDescriptor`、`ProviderSurfaceWorkspaceCatalog`、`ProviderSurfaceWorkspaceOption`、`ProviderSurfaceBinding`、`ProviderSurfaceToolContractBinding`、`ProviderSurfaceArtifact`，与常量表派生的 `ProviderSurfaceWorkspaceSpace`、`ProviderSurfaceToolResultStatus`、`ProviderSurfaceArtifactMediaType`），外加校验结果 `ProviderSurfaceCheck` 与 `ProviderSurfaceIssue`。

两个入口对应 `package.json` 的 `exports`，源文件在 `src/exports/`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | 任何进程，含浏览器扩展与渲染进程 | 线格式能力、常量表与可移植数据 |
| `./contracts` | 同上，只要数据不要能力时 | 常量表与可移植数据 |

没有注入面：本包不需要宿主塞任何东西。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 校验入站载荷 | `providerSurfaceWire.check*(value)` → `utils/wire.ts` 里对应的 zod schema `safeParse` → 成功给 `{ ok: true, value }`，失败经 `collectIssues` 收成 `{ path, code }` 列表；抛不抛错由调用方定 |
| 新建绑定 | `providerSurfaceWire.createBinding(provider, space, now?)` → 拼出绑定 → 走一遍 `checkBinding` → 不合法当场抛错（中文，点名哪几个字段），合法则返回定型后的绑定 |

## 依赖什么

- 只依赖 `zod`，没有别的运行时依赖，也不碰 Node 内置模块。
- 不读环境变量、不读写磁盘、不发请求。

## 状态归谁

没有状态：`ProviderSurfaceWire` 只持有一个常量，校验与构造都是纯函数。schema 在模块加载时建好，进程里共用一份。

## 生命周期

没有需要释放的东西。`providerSurfaceWire` 随进程存在。

## 失败语义

- 校验失败不抛错，返回 `{ ok: false, issues }`；`issues` 只有路径与错误码，两端按错误码判断，不按文字。
- 只有 `createBinding` 抛错：入参本来就不该走到桥上，早失败好过在对端才爆。文字是中文，字段名原样夹在里面。
- 认不出的字段一律拒绝（strict）：协议加字段要先升版本，不靠「对端忽略未知字段」兜底。

## 不变量

共 7 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 5 条、门禁 1 条、类型 1 条。未验证 0 条。

## 非目标

- 不管传输：桥、鉴权、重连、重试都在别处；本包换了传输也不用改。
- 不管工具怎么执行：工具名、入参 schema、执行结果由各空间自己定，本包只保证它们在线上的形状。
- 不管附件怎么上传：二进制不进文本输出，适配器走自己的附件通道，本包只卡住上限。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记线格式能力的 API（定义在类上方，这里 re-export），constants.ts 是协议版本、空间、状态、图片类型与四条上限；没有注入面
  types/        只放类型：surface-protocol.ts 是可移植数据，手写十种载荷与校验结果
  impl/         一类一文件：ProviderSurfaceWire（五个 check 与 createBinding 的唯一出口）
  utils/        wire.ts：zod schema 与失败收集，逐个 satisfies 对齐手写类型，不出包
  exports/      两个入口，只有转发
spec/           不变量登记与验收测试
```

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ProviderSurfaceWire.ts` | `ProviderSurfaceWireApi`（同文件，provides 登记） | 五种载荷的严格校验与绑定构造的唯一出口 |
