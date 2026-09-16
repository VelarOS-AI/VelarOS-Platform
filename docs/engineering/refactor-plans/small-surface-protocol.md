# `@velaros-ai/surface-protocol` 按仓库标准改造方案

> 对象：`packages/surface-protocol`（0.1.2），HEAD `606fba59`（数据采于 `7c39d5c9`；其后本范围内只有 core `utils/RealPath.ts` 的写法微调 `0ac2b5f1`，结论不变），本包工作区干净。
> 标准：`docs/architecture/module-ownership.md`、ADR 0007、门禁 `scripts/ownership/check-module-ownership.mjs`；小包写法照 `shell-command`、`rehearsal-sandbox`；zod 类型的处理照 agent 方案 3.5 的裁决（类型手写、schema 用 `satisfies z.ZodType<…>` 对齐，不给门禁开 schema 例外）。
> 消费方扫描：Platform 全仓 + Desktop、Workbench、Termel、Extension、Cloud、Website（AST 解析 import，含 `scripts/release/**`）。基线：`bun test test` 4 pass / 0 fail。

## 0. 结论先行

- **规模**：`src/` 2 个文件 150 行；一个入口 `.` 导出 22 个符号（11 个 `z.infer` 类型、10 个 zod schema、1 个版本常量、1 个工厂函数）。
- **真被用到的只有 11 个**：Termel 8 个文件（`serve-host` 3 个源文件与 3 个只用版本号的测试、`termel-runtime` 2 个源文件），Desktop 2 个文件（`plugins/chatgpt`）。Extension 用纯 JS 手写同一套线格式，不 import 本包。10 个 schema 里只有 `ProviderSurfaceToolCallSchema` 有人用（Desktop 1、Termel 2，都是拿来 `parse`/`safeParse`）。
- **主要问题**：类型全从 zod 推导（types 只放类型、一个值都没有的规矩做不到）；schema 作为值直接出包；版本号是 `1 as const` 数字（常量表只收冻结表与字符串身份）；上限（4 个附件、32 MiB base64、255 字符文件名）写死在 schema 里、不在常量表；README 英文。
- **目标**：`contract/`（常量表：协议版本、工作区空间、结果状态、附件类型与上限）+ `types/surface-protocol.ts`（11 个手写数据类型，可移植）+ `impl/ProviderSurfaceWire.ts`（一个类，`providerSurfaceWire` 实例：五个 `check*` 与 `createBinding`）+ `utils/wire.ts`（zod schema，`satisfies` 对齐，不出包）+ 两个入口 `.`、`./contracts`，都能在渲染进程加载。
- **要拍板**：无产品层决定；只有一处可选：附件 base64 上限 32 MiB × 4 个是否偏大（见 §7）。

## 1. 现状

### 1.1 入口、导出与消费方

| 导出 | 种类 | 谁在用 |
| --- | --- | --- |
| `ProviderSurfaceToolCallSchema` | zod 值 | Desktop `WireContractObserver.ts`（`safeParse`，只取 issue 的 path 与 code）；Termel `tool-gateway.ts`（`.parse`）、`extension-bridge.ts`（`.safeParse`） |
| `createProviderSurfaceBinding` | 函数 | Termel `extension-bridge.ts` |
| `ProviderSurfaceProtocolVersion` | `1 as const` | Termel `tool-gateway.ts`、`kernel-tools.ts`、3 个测试 |
| `ProviderSurfaceBinding` / `ToolCall` / `ToolCatalog` / `ToolDescriptor` / `ToolResult` / `WorkspaceCatalog` / `WorkspaceSpace` / `Artifact` | 类型 | Termel 8 个文件、Desktop `WireContractParity.ts` |
| 其余 9 个 schema（`Artifact`、`Binding`、`ToolCatalog`、`ToolContractBinding`、`ToolDescriptor`、`ToolResult`、`WorkspaceCatalog`、`WorkspaceOption`、`WorkspaceSpace`） | zod 值 | 只有本包测试 |
| `ProviderSurfaceToolContractBinding`、`ProviderSurfaceWorkspaceOption` | 类型 | 无直接引用，但被 `Binding`、`WorkspaceCatalog` 引用（公开签名闭包） |

### 1.2 其余现状

- 耦合：只依赖 zod。无模块级可变状态、无类、无英文报错（zod 自己的报错不经本包文字）。
- 构建脚本用的是 `scripts/kernel/build/fix-esm-extensions.mjs`，其他已治理包用 `scripts/capabilities/build/…` 并跑 `normalize-package-declarations.mjs`；`tsconfig.json` extends 根 `tsconfig.json`，根的 paths 把 `@velaros-ai/surface-protocol` 指到 `src/index.ts`。
- 测试：1 个文件 4 条（版本冻结、严格拒绝多余字段、binding 工厂、附件受限）。

## 2. 目标布局

```text
src/
  contract/   provides.ts（登记 ProviderSurfaceWireApi）、constants.ts（五张表，见 §3.3）
  types/      surface-protocol.ts（可移植：11 个线格式类型 + 校验结果 ProviderSurfaceCheck、ProviderSurfaceIssue）
  impl/       ProviderSurfaceWire.ts（类 + 实例 providerSurfaceWire）
  utils/      wire.ts（zod schema，逐个 `satisfies z.ZodType<T>`；把 ZodError 收成 issue 列表的函数）
  exports/    index.ts、contracts.ts
spec/         invariants.md、acceptance.test.ts
```

| 现有文件 | 去处 |
| --- | --- |
| `src/index.ts` | 删除，改为 `src/exports/index.ts`（转发 `providerSurfaceWire`、`ProviderSurfaceWireApi`，并 `export *` contracts）与 `src/exports/contracts.ts`（常量表 + 可移植类型） |
| `src/provider-surface.ts` 的版本号、空间枚举、状态枚举、媒体类型、三个上限 | `contract/constants.ts` |
| 同文件 11 个 `z.infer` 类型 | `types/surface-protocol.ts` 手写；`protocolVersion` 写成 `(typeof ProviderSurfaceProtocol)['version']`，空间写成 `(typeof ProviderSurfaceWorkspaceSpaces)[number]`（可移植文件只许从常量表 import type） |
| 同文件 10 个 schema 与 `StandardBase64Schema` | `utils/wire.ts`，不出包；上限改引常量表 |
| `createProviderSurfaceBinding` | `ProviderSurfaceWire.createBinding` |
| `test/provider-surface.test.ts` | 4 条改写成 `spec/acceptance.test.ts`（只经根入口），不另留实现测试 |

登记表一行：`directory: 'surface-protocol'`，`portable: 'surface-protocol.ts'`，`browserSafeEntries: ['index.ts', 'contracts.ts']`，`layers: [['ProviderSurfaceWire.ts']]`；无工具、无可调参数、无环境变量。

## 3. 合同草案

### 3.1 provides：`ProviderSurfaceWireApi`（类上方，实例 `providerSurfaceWire`）

| 成员 | 说明 |
| --- | --- |
| `checkToolCall(value: unknown): ProviderSurfaceCheck<ProviderSurfaceToolCall>` | 严格校验一条入站工具调用（多余字段即拒）；失败给出 `{ path, code }` 列表，不含载荷值（Desktop 观察器要的正是这个） |
| `checkToolResult(value)` / `checkToolCatalog(value)` / `checkWorkspaceCatalog(value)` / `checkBinding(value)` | 同上，对应另外四种线格式；协议两端都用得上，保留 |
| `createBinding(provider: string, workspaceSpace: ProviderSurfaceWorkspaceSpace, now?: number): ProviderSurfaceBinding` | 新建一个 provider 自持的绑定（取代 `createProviderSurfaceBinding`） |

`ProviderSurfaceCheck<T> = { ok: true; value: T } | { ok: false; issues: ProviderSurfaceIssue[] }`，`ProviderSurfaceIssue = { path: string; code: string }`：只放路径与错误码，承诺不把载荷值带出来（写进不变量）。
不依赖 core：校验失败以数据返回，调用方自己决定抛什么，保持本包只依赖 zod。

### 3.2 requires：无。

### 3.3 constants

| 表 | 内容 |
| --- | --- |
| `ProviderSurfaceProtocol` | `{ version: 1 }`——协议版本冻结为 1（替代 `ProviderSurfaceProtocolVersion`，常量表不收裸数字身份） |
| `ProviderSurfaceWorkspaceSpaces` | `['system', 'project', 'browser']` |
| `ProviderSurfaceToolResultStatuses` | `['success', 'error', 'denied']` |
| `ProviderSurfaceArtifactMediaTypes` | `['image/png', 'image/jpeg']` |
| `ProviderSurfaceLimits` | `artifactsPerResult: 4`、`artifactBase64Chars: 32 * 1024 * 1024`、`artifactNameChars: 255`，每项一句中文说明 |

### 3.4 要删的现有导出与替代（破坏性，升 0.2.0）

| 现在 | 以后 |
| --- | --- |
| `ProviderSurfaceToolCallSchema.safeParse(x)` / `.parse(x)` | `providerSurfaceWire.checkToolCall(x)`；Termel 的 `.parse` 改成「check 失败就抛自己的错」 |
| 其余 9 个 `*Schema` | 删除（无外部使用），校验走对应的 `check*` |
| `createProviderSurfaceBinding(p, s, now)` | `providerSurfaceWire.createBinding(p, s, now)` |
| `ProviderSurfaceProtocolVersion` | `ProviderSurfaceProtocol.version` |
| 11 个数据类型 | 名字不变，改从手写类型导出（`/contracts` 也能取） |

产品侧要改：Termel `serve-host/src/tool-gateway.ts`、`extension-bridge.ts`、`termel-runtime/src/kernel-tools.ts` 与 3 个测试（其余只 import 类型的文件不用动）；Desktop `WireContractObserver.ts`（`observe(shape, schema, value)` 改成收一个 check 函数）。

## 4. 模型面与用户面文字

没有模型面文字。README 是英文，改中文（保留 External Agent Bridge v2 与附件不进文本输出两点说明）。

## 5. 实现层缺陷

1. **工厂造出的绑定过不了自己的 schema**：`createProviderSurfaceBinding('')` 返回的绑定过不了自己的 `ProviderSurfaceBindingSchema`（provider `min(1)`）。改成 `createBinding` 时对空 provider 直接拒绝。复现：`ProviderSurfaceBindingSchema.safeParse(createProviderSurfaceBinding('', 'project')).success === false`。
2. **附件上限偏大**：单个附件 base64 可到 32 MiB、一条结果最多 4 个，即单条工具结果最多约 128 MiB 文本在桥上传；README 写的是 "small, bounded list"。不是 bug，列入 §7。

## 6. 步骤、检查与共享文件

1. 写 `contract/`、`types/`、`utils/wire.ts`（schema `satisfies`）、`impl/ProviderSurfaceWire.ts`、`exports/`；删 `src/index.ts`、`src/provider-surface.ts`。
2. `spec/invariants.md`（建议 5 条：INV-1 线格式严格、未声明字段一律拒绝；INV-2 附件有界（条数、媒体类型、标准 base64、文件名长度按常量表）；INV-3 目录用 `revision`、调用回显 `catalogRevision`；INV-4 协议版本冻结为 1；INV-5 两个入口不碰 Node（门禁））与 `spec/acceptance.test.ts`；`MODULE.md` 十节；README 改中文；`package.json` 的 `exports`、`main/types` 指向 `dist/exports/*`，`test` 脚本改成 `bun run build && bun test spec/acceptance.test.ts`，build 脚本对齐其它治理包。
3. 登记表加一行，跑到绿；升 0.2.0。

检查：`bun scripts/ownership/check-module-ownership.mjs --only surface-protocol`、`bun run --cwd packages/surface-protocol test`、`bun run --cwd packages/surface-protocol typecheck`、`bun run check:package-catalog`（重新生成）、`bun run check:lockfile-consistency`、`bun run check:code-style`。

会碰到的共享文件：`scripts/ownership/governed-modules.mjs`、根 `tsconfig.json`（paths 改指 `src/exports/index.ts`、`src/exports/*`）、`docs/generated/package-catalog.json`、`bun.lock`（工作区版本号手改）。

## 7. 需要拍板

- （可选）附件上限要不要收紧，例如单个 8 MiB：会改变 Termel/扩展的截图行为，属于产品取舍；不收紧也不影响本次改造。
