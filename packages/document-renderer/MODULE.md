# @velaros-ai/document-renderer 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/DocumentRenderer.ts` 类上方的接口（`contract/provides.ts` 登记它），常量表在 `contract/constants.ts`。
> 门禁：`bun run check:module-ownership`。

## 这是什么

独立安装的文档渲染能力包：把 Office 文档与 PDF 页渲染成预览页或位图。
它不是 VelarOS Terminal 的模块，不进工具目录，有自己的原生依赖（`@napi-rs/canvas`、`pdfjs-dist`，都在 `@velaros-ai/velar` 的 office 单元那边）与自己的发布节奏。
宿主不 import 它，而是**按命令协议调用它**：`products/document-renderer` 把本包连同 Bun 运行时打成一个可执行文件，一个进程收一条 JSON 请求、回一条 JSON 回执。
本包只负责协议那一面：校验请求、把三条路径关在 projectRoot 里、调 office 的渲染原语、把结果与失败都收成回执。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：一件能力的 API 定义在类上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `documentRenderer` | `DocumentRendererApi` | 执行一次请求（`execute`）、跑一次命令行（`runCli`）、自报身份（`describe`） |
| `DocumentRendererProtocol` | 契约常量 | 协议版本、产品名、传输约定、包版本 |
| `DocumentRendererErrorCodes` | 契约常量 | 四个错误码：`INVALID_REQUEST`、`PATH_DENIED`、`UNSUPPORTED_FORMAT`、`RENDER_FAILED` |
| `DocumentRendererLimits` | 契约常量 | requestId、路径、maxItems、scale 与 PDF 像素的公开上限 |
| `DocumentRendererFormats` | 契约常量 | 两种操作各自认的输入与输出扩展名，describe 与校验共用这一份 |
| `DocumentRendererEnvironmentVariables` | 契约常量 | 本包读的环境变量表（资源根目录） |

**数据面**是 `types/document-renderer.ts`（可移植）：`RendererDescriptor`、`RendererOperationDescriptor`、`DocumentRendererResponse`、`DocumentRendererCliResult`，外加常量表派生的 `DocumentRendererErrorCode`。
请求的形状（`DocumentRendererRequest` 那一族）是包内的工作类型，留在 `types/rendering.ts`：调用方按 JSON 协议拼请求，不 import 类型。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 进程（产品的可执行文件、本仓开发时的直接调用） | 渲染能力 `documentRenderer`、常量表与回执数据 |
| `./contracts` | 只想按协议拼请求、读回执的调用方 | 常量表与可移植数据，整条链不碰 Node |

没有注入面：渲染器不要宿主塞任何东西，唯一的外部输入是登记在常量表里的环境变量。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 执行一次请求 | `documentRenderer.execute(value)` → `utils/request.ts` 的 `checkDocumentRendererRequest`（zod 校验，失败收成一句中文说明）→ 按 `operation` 分派：describe 自己答，两种渲染交给 `OfficeRenderer` → 成功回执带结果，抛出来的 `AppError` 按 `code` 收成四个错误码之一 |
| 渲染一个文档 | `OfficeRenderer.renderOffice/renderPdfPage` → `RendererPaths.resolve` 先判定三条路径、再建输出目录 → `@velaros-ai/velar/office/renderer` 的 `parseOfficePreview` / `renderOfficePreviewPng` / `renderPdfPagePng` → 落盘后回落盘位置、字节数与尺寸 |
| 跑一次命令行 | `documentRenderer.runCli(argv, inputText?)` → `--request-json` 的值 / `describe` 子命令 / 标准输入三选一 → 解析不了 JSON 也回一条 INVALID_REQUEST 回执 → 给出 `{ exitCode, text }`，进程壳只管写 stdout、设退出码 |
| 自报身份 | `documentRenderer.describe()` → 协议版本、产品名、`DocumentRendererProtocol.packageVersion`、`DocumentRendererFormats` 的两条操作 |

## 依赖什么

- `@velaros-ai/velar/office/renderer`：Office 预览解析与 PNG、PDF 单页渲染的原语（原生依赖都在那边）。
- `@velaros-ai/core`：`AppError`（错误码即控制流）、`resolveRealPath`、几个类型守卫与 `truncate`。
- `@velaros-ai/core/platform`：`isPathTextInside`，路径包含判断的公共件。
- `zod`：请求 schema。
- 环境变量 `VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT`：产品启动器设的资源根，渲染 PDF 时从这里取标准字体；没设就交给 pdfjs 自己找。

## 状态归谁

没有状态：三个类都不持有会变的东西。`RendererPaths` 每次重新解析路径，`OfficeRenderer` 只持有一份扩展名表（`private static readonly`），`DocumentRenderer` 只持有渲染器。
进程里每个类各有一份实例，随进程存在。

## 生命周期

没有需要释放的东西：一个进程执行一次请求就退出。写文件是同步落盘后才回执，不留后台任务，也不缓存解析结果。

## 失败语义

- 三个方法都不抛错：任何失败都收成回执。调用方按 `error.code` 判断，不按文字。
- 四个错误码：请求不合法 `INVALID_REQUEST`、路径被拒 `PATH_DENIED`、格式不支持 `UNSUPPORTED_FORMAT`、其余 `RENDER_FAILED`。
- 包内不自定义错误类：实现抛 `AppError(错误码, 中文说明)`，`utils/command.ts` 把它收成回执，认不出的码一律 `RENDER_FAILED`。
- `message` 是一句中文，字段路径、扩展名、`--request-json` 这类原文夹在里面；zod 的原始 issue 不出现在回执里。
- 命令协议的底线：stdout 上恰好一条 JSON。参数缺失、JSON 语法错、读标准输入失败，都还是一条回执。

## 不变量

共 8 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 6 条、门禁 1 条、类型 1 条。未验证 0 条。

## 非目标

- 不做宿主模块：不注册工具、不进工具目录、不被 Host 进程 import；宿主只经命令协议用它。
- 不管怎么被拉起：进程壳、资源目录、签名与公证在 `products/document-renderer` 与 `scripts/document-renderer/`，本包不写进程代码。
- 不管并发与排队：一个进程一条请求，批量与调度是调用方的事。
- 不堵 TOCTOU：路径判定与落盘之间仍有换符号链接的极小窗口，单用户本机场景不为此加锁。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记渲染能力的 API（定义在类上方，这里 re-export），constants.ts 是协议、错误码、上限、格式表与环境变量表；没有注入面
  types/        只放类型：document-renderer.ts 是可移植数据（describe 与回执），rendering.ts 是包内工作类型（三种请求、路径判定的入参出参）
  impl/         一类一文件：DocumentRenderer（协议出口）、OfficeRenderer（两种渲染）、RendererPaths（路径准入）
  utils/        request.ts（schema 与中文校验说明）、paths.ts（包含判断、符号链接、资源目录）、command.ts（读标准输入、错误码归一、拼回执）、tuning.ts（可调参数）
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现测试：真的渲染出图落盘
```

**分层。** 上层可以引下层与同层，下层不许引上层：`DocumentRenderer.ts` → `OfficeRenderer.ts`、`RendererPaths.ts`。utils 在所有层下面，谁都可以用。

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出；公开的那个在 `contract/provides.ts` 登记。类的公开方法只能是接口里的方法，整个进程只需要一份的，在文件末尾给出那一份。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `DocumentRenderer.ts` | `DocumentRendererApi`（同文件，provides 登记） | 命令协议的唯一出口：校验、分派、回执、命令行 |
| `OfficeRenderer.ts` | `OfficeRendererApi`（同文件，不出包） | 两种渲染的执行：扩展名判定、调 office 原语、落盘 |
| `RendererPaths.ts` | `RendererPathsApi`（同文件，不出包） | 三条路径的准入：先判定、后建目录 |
