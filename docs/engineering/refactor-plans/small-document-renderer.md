# `@velaros-ai/document-renderer` 按仓库标准改造方案

> 对象：`packages/document-renderer`（0.1.6，`private: true` 的独立能力包），HEAD `606fba59`（数据采于 `7c39d5c9`；其后本范围内只有 core `utils/RealPath.ts` 的写法微调 `0ac2b5f1`，结论不变），本包工作区干净。
> 标准同其它方案；小包写法照 `shell-command`。路径判定用已落地的公共件：`@velaros-ai/platform` 的 `isPathTextInside`（c9564d45）与 `@velaros-ai/core/utils/RealPath` 的 `resolveRealPath`（7c39d5c9）。
> 基线：`bun test test` 4 pass / 0 fail。缺陷复现脚本在草稿区 `plan-small/probe-dr/`（只在草稿区建文件）。

## 0. 结论先行

- **规模**：`src/` 6 个文件 400 行；入口 `.`（`export *` 四个文件，17 个导出）与 `./cli`（1 个），包内 `bin: velar-document-renderer → dist/cli.js`。
- **没有任何 import 消费方**。真正的用法是命令协议：`products/document-renderer/src/bin.ts` 直接 `import('../../../packages/document-renderer/src/cli')`（源码路径），`scripts/document-renderer/build-product.mjs` 用 `bun build` 打成独立可执行文件，发布构建再跑一次 `describe` 核对产品名与版本。
- **主要问题**：两个自定义错误类当控制流；请求类型从 zod 推导；`DocumentRendererVersion = '0.1.6'` 与 `package.json` 双写；读的环境变量 `VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT` 没登记；用了 `@velaros-ai/core` 却没在 `package.json` 声明依赖；报错全英文；路径判定自己写了一份，而且有两处真 bug（§5）。
- **目标**：`DocumentRenderer`（整件能力：执行一次请求、跑一次命令行、给出自述）+ `RendererPaths`（把三条路径收进 projectRoot）+ `OfficeRenderer`（Office/PDF 渲染）三个类；请求与回执类型手写进可移植文件；错误改用 `AppError` + 常量表里的四个码；入口 `.` 与 `./contracts`，删 `./cli`；产品启动器改从包入口取 `documentRenderer`。
- **要拍板**：包内 `bin` 删不删（产品可执行文件另有启动器，见 §7）。

## 1. 现状

| 文件 | 行 | 内容 | 问题 |
| --- | ---: | --- | --- |
| `index.ts` | 4 | `export *` 四个文件 | 通配转发，导出 `RendererPathDeniedError` 等类 |
| `cli.ts` | 45 | `runDocumentRendererCli(argv, inputText?)` + `import.meta.main` 包装 | 入口文件带副作用；非法 JSON 直接抛，违背「一进程一 JSON 回执」 |
| `service.ts` | 61 | `executeRendererRequest`：zod 校验 → 分派 → 按错误类映射成 4 个错误码 | INVALID_REQUEST 的 message 是 zod 原始 issue JSON（英文、多行） |
| `protocol.ts` | 78 | zod schema、`z.infer` 请求类型、错误码联合、描述与回执类型、版本常量 | 版本双写；上限写死在 schema |
| `path-policy.ts` | 57 | `resolveRendererPaths` + `RendererPathDeniedError` | 见 §5 缺陷 1、2 |
| `renderer.ts` | 155 | `describeRenderer`、`renderOfficeDocument`、`renderPdfPage`、`UnsupportedRendererFormatError`、读环境变量 | 模块级 `MaximumPdfPixels`、`OfficeInputKinds`；`maxItems ?? 80` |

其余：无模块级可变状态；两个错误类都没有接口（错误类本就不写接口，但它们被 `instanceof` 当分支用、并且出包）；测试直接 import `../../office/node_modules/exceljs`、`pdf-lib`（伸进兄弟包的 node_modules）。

## 2. 目标布局

```text
src/
  contract/   provides.ts（登记 DocumentRendererApi）、constants.ts（协议身份、错误码、上限、格式表、环境变量表）
  types/      document-renderer.ts（可移植：三种请求、描述、回执）；options.ts（RendererPaths 的输入输出等内部工作类型）
  impl/       DocumentRenderer.ts、RendererPaths.ts、OfficeRenderer.ts
  utils/      request.ts（zod schema，satisfies 对齐；issue 收成一句中文说明）、tuning.ts
  exports/    index.ts（Node）、contracts.ts
spec/         invariants.md、acceptance.test.ts
```

| 现有 | 去处 |
| --- | --- |
| `service.ts` | `impl/DocumentRenderer.ts` 的 `execute(request)`；错误映射按 `AppError.code`，不再 `instanceof` |
| `cli.ts` 的 `runDocumentRendererCli` | `DocumentRenderer.runCli(argv, inputText?)`；`import.meta.main` 那段删掉（进程包装在产品启动器里本来就有一份） |
| `renderer.ts` 的 `describeRenderer` | `DocumentRenderer.describe()`，版本改读常量表 |
| `renderer.ts` 的两种渲染 | `impl/OfficeRenderer.ts`（类上方接口 `OfficeRendererApi`，由 `DocumentRenderer` 构造时持有） |
| `path-policy.ts` | `impl/RendererPaths.ts`：`resolveRealPath` + `currentPlatform.isPathTextInside(…, { caseSensitive: true })`，先判定后建目录 |
| `protocol.ts` | 常量进 `contract/constants.ts`，类型手写进 `types/document-renderer.ts`，schema 进 `utils/request.ts` |
| 两个错误类 | 删除，改抛 `AppError(DocumentRendererErrorCodes.pathDenied / unsupportedFormat, 中文说明)` |
| `test/renderer.test.ts` | 协议与路径两组进 `spec/acceptance.test.ts`；渲染两条留 `test/`，改用 `@velaros-ai/office` 的测试夹具或本包 devDependencies，不再伸进 office 的 node_modules |

登记表：`portable: 'document-renderer.ts'`，`tuning: 'tuning.ts'`，`browserSafeEntries: ['contracts.ts']`，`environmentTable: 'DocumentRendererEnvironmentVariables'`，`layers: [['DocumentRenderer.ts'], ['OfficeRenderer.ts', 'RendererPaths.ts']]`。

## 3. 合同草案

**provides：`DocumentRendererApi`**（类上方，实例 `documentRenderer`）

| 成员 | 说明 |
| --- | --- |
| `execute(request: unknown): Promise<DocumentRendererResponse>` | 执行一次请求；任何失败都收成带错误码的回执，不抛 |
| `runCli(argv: readonly string[], inputText?: string): Promise<DocumentRendererCliResult>` | 命令行语义：`--request-json`、`describe`、标准输入；**非法 JSON 也回一条 INVALID_REQUEST 回执**，退出码 1 |
| `describe(): RendererDescriptor` | 协议、产品名、版本、支持的格式 |

**requires**：无（环境变量登记在常量表）。

**constants**

| 表 | 内容 |
| --- | --- |
| `DocumentRendererProtocol` | `version: 1`、`product: 'velar-document-renderer'`、`transport: 'one-json-request-per-process'`、`packageVersion`（与 `package.json` 由验收用例核对，替代 `DocumentRendererVersion`） |
| `DocumentRendererErrorCodes` | `INVALID_REQUEST`、`PATH_DENIED`、`UNSUPPORTED_FORMAT`、`RENDER_FAILED` |
| `DocumentRendererLimits` | requestId ≤ 200、路径 ≤ 4096、`maxItems` 1–200、`scale` 0.25–4、PDF 最多 4000 万像素 |
| `DocumentRendererFormats` | `render-office` 输入 `.docx/.pptx/.xlsx`、输出 `.html/.png`；`render-pdf-page` 输入 `.pdf`、输出 `.png`（`describe` 与校验共用这一份） |
| `DocumentRendererEnvironmentVariables` | `VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT`（产品启动器设，渲染器读 PDF 标准字体） |

可调参数 `DocumentRendererTuning.office.defaultMaxItems = 80`。

**要删的导出**：`./cli` 入口、`runDocumentRendererCli`、`executeRendererRequest`、`resolveRendererPaths`、`describeRenderer`、`renderOfficeDocument`、`renderPdfPage`、两个错误类、全部 zod schema、`DocumentRendererVersion`、`DocumentRendererProtocolVersion`（进常量表）。仓内外没有 import 消费方，唯一要跟着改的是 `products/document-renderer/src/bin.ts`：`import('…/src/cli')` 改成静态 `import { documentRenderer } from '../../../packages/document-renderer/src/exports/index.js'`，再 `documentRenderer.runCli(argv)`。

## 4. 用户面与模型面文字

回执里的 `error.message` 会被调用方（宿主或经命令调用的模型）看到，现在 7 处全英文，加上 INVALID_REQUEST 直接塞 zod 的 issue JSON。改成中文一句话（字段路径与期望原样夹在里面），例如「inputPath 在 projectRoot 之外」「render-office 只接受 .docx、.pptx、.xlsx，收到 .txt」「请求不合法：operation 应为 describe、render-office 或 render-pdf-page」。错误码不变。README 与 `products/document-renderer/README.md` 的发布说明是英文，本次只改包 README（产品 README 被 kernel/agent 两个架构门钉了英文标记句，不动）。

## 5. 实现层缺陷（均已在草稿区复现）

1. **先建目录、后判越界，能在 projectRoot 之外建目录**（`path-policy.ts` 第 38–41 行）。`outputPath` 经项目内的符号链接指向外面时，词法判定通过，`mkdir(dirname, { recursive: true })` 先在外面把目录建出来，然后 `realpath` 判定才拒绝。复现：`root/link → ../outside`，请求 `outputPath: 'link/newdir/deeper/x.png'`，回执 PATH_DENIED，但 `outside/newdir/deeper` 已被创建。README 承诺「所有输入输出路径都约束在 projectRoot，包括符号链接逃逸」。修法：先对「最近的已存在祖先」求真实路径并判定，通过后再建目录。
2. **项目里名叫 `..xxx` 的目录被当成越界**（`isInside` 用 `path.startsWith('..')`）。复现：`inputPath: '..cache/a.pdf'` → PATH_DENIED。与 project 的 `resolveSourceInsideProject` 同一个错，改用 `isPathTextInside` 即消失。
3. **非法 JSON 没有 JSON 回执**：`--request-json '{bad'`、`--request-json` 后面没参数、标准输入不是 JSON 时，`runDocumentRendererCli` 直接抛，进程只在 stderr 打一行英文、stdout 为空，违背「一进程恰好一条 JSON 回执」。
4. **INVALID_REQUEST 的 message 是 zod 原始 issue 数组的 JSON 文本**（英文、多行、几百字符）。
5. **`package.json` 没声明 `@velaros-ai/core`**，`service.ts`、`path-policy.ts` 却 import 它；靠工作区提升才能跑，产品打包时恰好被 bun 打进去。补上依赖。
6. **版本双写**：`DocumentRendererVersion = '0.1.6'` 与 `package.json` 各写一份，只在发布构建的 `assertRendererDescription` 才会发现漂移；单测虽然比对了 package.json，但升版时仍要手改两处。
7. 路径判定与写入之间有换链接的窗口（TOCTOU），单用户本机场景风险低，写进卡片「非目标」而不是本次修。

## 6. 步骤、检查与共享文件

1. 常量、类型、schema 就位；三个类；`AppError` 替换两个错误类；修 §5 的 1–6。
2. `spec/invariants.md`（建议：INV-1 一进程恰好一条 JSON 回执，任何输入都有错误码；INV-2 三条路径真实路径都在 projectRoot 内，越界时磁盘上一个目录都不建；INV-3 输出路径不许是符号链接；INV-4 `describe` 的版本等于 package.json；INV-5 `./contracts` 不碰 Node（门禁））与验收；`MODULE.md`；README 中文。
3. `package.json`：exports 指 `dist/exports/*`，删 `./cli`，补 `@velaros-ai/core`、`@velaros-ai/platform` 依赖（注意 `check:public-readiness` 只禁止复制 office 的 `@napi-rs/canvas`、`pdfjs-dist`，不影响）。
4. 产品启动器与构建脚本跟着改（见下），升 0.2.0。

检查：`bun scripts/ownership/check-module-ownership.mjs --only document-renderer`、`bun run --cwd packages/document-renderer test`、`bun run check:document-renderer-release`（发布脚本自测）、`node scripts/document-renderer/build-product.mjs --adhoc`（本机打一次，核对 describe；属于重操作，放在最后一步由人决定是否跑）、`bun run check:public-readiness`、`bun run check:package-catalog`。

共享文件：`scripts/ownership/governed-modules.mjs`、`products/document-renderer/src/bin.ts` 与 `products/document-renderer/tsconfig.json`（include 路径不变，paths 若改用包名要补）、`scripts/document-renderer/build-product.mjs`（入口仍是 products 的 bin.ts，一般不用改，核对 `assertRendererDescription`）、`docs/generated/package-catalog.json`、`bun.lock`。

## 7. 需要拍板

- **包内 `bin` 删不删**：包是 private，不发 npm；真正的可执行文件由 `products/document-renderer` 构建。建议删掉 `bin` 与 `./cli`，本仓开发时用 `bun products/document-renderer/src/bin.ts describe`。保留的话要在包根放一个 `bin/` 启动脚本（`src` 下的文件不许有副作用）。
