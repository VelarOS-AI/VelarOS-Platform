# @velaros-ai/velar/office 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/office.d.ts`（由 `@AgentView` 从 `OfficeOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/OfficeOperations.ts` 类上方的接口，再看 `contract/` 的三个文件；每个操作真正怎么做，看 `impl/operations/` 里执行类上方的接口。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

办公文档：代码面 `velar:office` 的九个操作——`createWord`、`createPresentation`、`createSpreadsheet`、`readPdf`、`wordToPdf`、`latexToPdf`、
`editPdf`、`preview`、`toMarkdown`——让模型在空间给的工作区根里生成和改写 Word、PowerPoint、Excel、PDF，并把已有文档读成结构或 Markdown。
生成走纯 JS 的文档库（docx、随包审过的 PptxGenJS、ExcelJS、pdf-lib），格式转换走本机的外部命令（LibreOffice、LaTeX 编译器、可选插件 MarkItDown），
预览的位图走 canvas 与 pdfjs。实现整个在这个单元里，外面没有第二份。

它不认识「项目」「系统」「浏览器」：只认空间端口给的一个工作区根，所有读写路径都相对那个根，出了根一律拒绝。缺转换器时装什么、怎么装是宿主界面的事；
本单元只抛带专属码的错误，message 说清缺哪个命令、为什么要它。

能由别的操作拼出来的不单做：PDF 变 Word 就是 `readPdf` 读出文字、`createWord` 按页写成标题与段落，代码模版里有这段写法。

同一份解析与渲染原语还给独立打包的 Document Renderer 用（`./office/renderer`），那条引用链不经过操作文件。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `officeOperations` | `OfficeOperationsApi` | 代码面 `office` 命名空间的九个操作：查取消、核对入参，交给执行类，经空间端口 `ctx.office` |
| `createMarkItDownLocator` / `markItDownBinaryResolver` | `MarkItDownLocatorApi` | 只查磁盘地回答 MarkItDown runtime 装没装、在哪；后者是宿主不注入资源端口时的缺省那一份 |
| `officeDocumentRenderer`（`./office/renderer`） | `OfficeDocumentRendererApi` | 给 Document Renderer 的窄渲染面：解析 Office 预览、渲染预览 PNG 与 PDF 单页位图 |
| `VelarOfficeModule` | 生成的合同（`contract/surface.ts`） | `velar:office` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/office.d.ts` 同一份）与代码模版；空间挂这件能力时交给代码面的门 |

**常量表**是 `contract/constants.ts`，只放值：`OfficeErrorCodes`、`OfficeEnvironmentVariables`，以及写进声明给模型看、入参核对也用的上限
`OfficeInputLimits`、`OfficePdfLimits`、`OfficeMarkdownLimits`、`OfficePreviewLimits` 与 MarkItDown 认的扩展名 `OfficeMarkItDownInputExtensions`。

**数据面**是 `types/`：`types/office.ts` 是可移植数据，随 `./office/contracts` 出包——九个操作的入参、入参里的 Word、PowerPoint、Excel、PDF 形状与回执（都带 `@AgentView`，
就是模型面上的那些类型），以及经空间端口流过的数据（环境探测、原生命令、命令结果、MarkItDown 定位结果）；
word、presentation、spreadsheet、pdf、preview 各放本域的内部形状（字体族、模板配色、pdfjs 与 mammoth 的窄视图、解析中间结果），其中给 Document Renderer 的那几个经 `./office/renderer` 出包；
`types/pptx.ts` 是从随包 PptxGenJS 派生的内部类型，不出单元。

三个入口对应包清单 `exports` 里的 `./office`、`./office/contracts` 与 `./office/renderer`，源文件是单元目录上的 `index.ts`、`contracts.ts` 与 `renderer.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./office` | Node 宿主 | 九个操作、MarkItDown 定位器、注入面与它们用到的数据 |
| `./office/contracts` | 任何进程，含浏览器、渲染进程 | 常量表、入参与回执、经空间端口流动的数据、`VelarOfficeModule` |
| `./office/renderer` | 独立发布的 Document Renderer | 只有 `officeDocumentRenderer` 与它的输入输出数据、`OfficeErrorCodes`；宿主产品不引它 |

**注入面**在 `contract/requires.ts`。本单元只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `OfficeOperationContext`，里面是空间端口 `OfficeSpacePort` | 必须 | 空间每次分发 `office` 命名空间的调用时装好。端口扁平一层，只有四个方法（取工作区根、探测命令、跑原生 argv、可选的定位 MarkItDown），每个都有操作在调，门禁逐方法核对 |
| `MarkItDownLocatorOptions`，里面是资源端口 `OfficeResourcePort` | 可选 | 造定位器时给：宿主的插件登记表经它交出额外资源根与停用开关；不给就只按平台约定推导 |
| 环境变量，全部登记在 `OfficeEnvironmentVariables` | 可选 | 两个输入变量（MarkItDown 资源根、pdfjs 标准字体目录）由宿主或打包产物设 |

**宿主怎么挂**：空间把 `office` 命名空间的九个操作挂到 `officeOperations` 上，每次调用给 `{ abortSignal, office: port }`；
端口的 `runCommand` 接宿主自己跑原生 argv 的那一份，`locateMarkItDown` 接宿主插件登记表造的 `createMarkItDownLocator({ resources })`；门那边交 `VelarOfficeModule`。

## 骨干链路

每个操作的顺序都固定（`OfficeOperations.ts`）：先查取消、再核对入参（`utils/input.ts`，顶层是严格对象，多给的字段当场拒绝）、最后交给执行类。
入参错了一步都不做；所有路径都经 `OfficeWorkspace` 这一道门：按解开符号链接后的真实路径判在不在工作区根内，写之前核对扩展名与 overwrite。

| 操作 | 链路 |
| --- | --- |
| `createWord` | blocks 或 Markdown/纯文本（只给一样）归一成内容块 → 空内容拒绝 → 准备 .docx（appendMode 命中已有文件走追加，不要求 overwrite）→ 新建走 `buildWordDocument`；追加先生成片段，再把 XML body 缝进原文档 → 写出回执 |
| `createPresentation` | slides 或 content 自动拆页（`#` 开新页、`---` 分页）→ 背景图也经工作区门解析 → 准备 .pptx → 按模板配色建主题、逐页加元素与备注 → 写出回执 |
| `createSpreadsheet` | sheets 或 CSV/TSV/Markdown/JSON 解析成工作表 → 准备 .xlsx → 逐表写列、行、样式、数字格式、冻结与筛选 → 写出回执 |
| `readPdf` | 解析输入（只认 .pdf）→ pdfjs 逐页取可选择文本（pages 指定页码，否则读前 maxPages 页）→ 页码越界如实报 → 页数、每页文本与 hasMore |
| `wordToPdf` | 探测 LibreOffice，没有就抛 `converterMissing` → 解析输入（.docx/.doc，旧版 .doc 先转临时 .docx）→ 原生 argv 在临时目录里转换 → 核对产物、复制到输出路径 |
| `latexToPdf` | 按 compiler 探测 tectonic / latexmk / xelatex / pdflatex → latexSource 写成 .tex（缺省与 PDF 同名同目录）→ 在临时目录里逐次编译 → 失败抛 `conversionFailed` 带日志结尾、.tex 留着 → 核对产物、复制到输出路径 |
| `editPdf` | 文字戳写不了的字先拒绝（标准字体只认西文）→ 解析输入 → pdf-lib 选页、删页、旋转、贴文字戳、写文档信息 → 写出新 PDF |
| `preview` | 解析输入（.docx/.doc/.pptx/.xlsx）→ 解析成结构化预览（大纲、幻灯片、工作表，摘要报全量、条目按 maxItems 截）→ 要 outputPath 时写 HTML（parse5 白名单净化，缺省不加自动刷新脚本）或 PNG |
| `toMarkdown` | 定位 MarkItDown，没装或被停用就抛 `markItDownUnavailable` → 解析输入（17 种扩展名）→ 不给 outputPath 时让它打到 stdout，交回按 maxChars 截断的正文（被宿主的输出窗口截过时如实说明交回的是结尾）；给了 outputPath 就先写临时文件、整份落进工作区，交回开头 → 截断如实标记 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、缺席值、`AppError`）、`@velaros-ai/core/platform`（跨平台路径判定与共享资源根）。
- 只在验收里用：`@velaros-ai/code-surface`，跑端到端的程序、给代码模版做类型检查。
- 文档库：`docx`、随包审过的 PptxGenJS（`vendor/pptxgenjs/`，经包清单的子路径导入 `#pptxgenjs` 取用，带本地安全补丁）、`exceljs`、`pdf-lib`、`pdfjs-dist`、
  `mammoth`、`jszip`、`parse5`、`@napi-rs/canvas`；入参核对用 `zod`。
- 用到的 Node 内置模块：`fs`、`path`、`os`、`module`。只在根入口与 `./office/renderer` 的引用链上；`./office/contracts` 不碰。
- 本机的外部命令（LibreOffice、LaTeX 编译器、MarkItDown）一律经空间端口，本单元不自己起进程、不装、不联网。

## 状态归谁

- **没有跨调用的可变状态。** 九个操作、执行类（`OfficeWorkspace`、`OfficeConverters` 与四个操作类）都是无状态的单例，每次调用要什么都从 `ctx.office` 现拿。
- **pdfjs 运行时**：整个进程一份（`pdfjsRuntime`），只缓存「已经补好 Node 图形全局的 pdfjs 模块」，不留文档句柄——每次提取都自己 `destroy()`。
- **MarkItDown 定位结果**：不缓存。宿主给了 `locateMarkItDown` 就每次问宿主，用户在设置里停用立刻生效；没给才回落到按平台约定推导的 `markItDownBinaryResolver`。
- **临时目录**：`.doc` 归一化、Word 转 PDF、LaTeX 编译与 MarkItDown 输出各建一个临时目录，用完即删，失败时也删。

## 生命周期

- 操作、常量表与生成的模型面是纯值，随包加载即存在；`import` 本单元不会启动任何进程。
- pdfjs 在第一次用到 PDF 时才真正加载，之后整个进程复用；进程退出即结束，没有 dispose。
- 外部转换命令的生命周期归宿主：本单元只交原生 argv 与超时，进程怎么起、怎么收、怎么取消由端口的 `runCommand` 负责。

## 失败语义

- **默认失败关闭。** 路径按真实路径算不在工作区根内一律拒绝（`pathOutsideProject`）；目标已存在又没传 `overwrite` 拒绝（`outputExists`），原文件一个字节不动；
  扩展名不对拒绝（`invalidExtension`）；输入文件不在拒绝（`inputMissing`）；没有可写的内容拒绝（`emptyContent`）。
- **写盘不问人（ADR 0009）。** 出了工作区根一律拒绝就是全部边界，没有授权闸。
- **缺外部转换器抛专属码。** `converterMissing` 与 `markItDownUnavailable` 的 message 说清缺哪个、为什么要它，并请模型如实告诉用户、不要自己去装；
  代码模版里写了怎么接住它们（导出 PDF 时告诉用户，转 Markdown 时 PDF 改用 `readPdf`）。
- **外部命令失败如实上报。** 退出码不为零、超时、被取消或跑完没产出都是 `conversionFailed`，message 带命令输出的结尾；LaTeX 的 .tex 留在原处，照着改了再编。
- **入参不对是 `VALIDATION`。** 形状、取值与上限在做事之前核对，message 点名字段；文字戳里有标准字体写不了的字（中文等）也在碰路径之前拒绝。
- **截断如实标记。** MarkItDown 的输出保留开头并标 `truncated`；预览按 `maxItems` 截条目时摘要报的是文档里的真实数量；正文 HTML 截断标 `contentTruncated`。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里；完整错误码见 `contract/constants.ts` 的 `OfficeErrorCodes`，外面按错误码判断，不按错误类。

## 不变量

共 14 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排（INV-3、INV-6、INV-12 已作废，理由写在登记表开头）。
按检验方式：测试 13 条、门禁 1 条。未验证 0 条。

## 非目标

- 不做空间感知：不发现项目、不读项目配置，声明里也不提 project、system、browser 空间。
- 不做界面：安装引导、「用浏览器线上处理」这类替代方案都在宿主，本单元只交错误码与事实。
- 不接受调用方换执行目录：九个操作都没有 `cwd`，路径一律相对空间给的工作区根。
- 不把产品名写进用户的产物：作者、公司缺省留空，模板里也不盖产品水印。
- 不自己起进程：外部转换器一律经空间端口的原生 argv 执行，本单元不拼 shell 串。
- 不做 OCR、不做扫描件识别：`readPdf` 只取文本型 PDF 的可选择文本。
- 不单做能拼出来的操作：PDF 转 Word 由 `readPdf` 加 `createWord` 拼。
- 文字戳不嵌字体：用 PDF 标准字体 Helvetica，只写得了西文。

## 结构

```text
office/
  contract/     对外合同：provides.ts 登记三个产品面接口，requires.ts 是调用上下文、空间端口与资源端口的注入口，constants.ts 是常量表；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：office.ts 是可移植数据（模型面的入参与回执、经端口流动的数据）；word、presentation、spreadsheet、pdf、preview 各放本域的内部形状；pptx.ts 是 PptxGenJS 的内部类型；pdfjs-dist.d.ts 补 pdfjs 旧版构建的模块声明
  impl/         一类一文件，文件名就是类名：OfficeOperations.ts 是九个操作，operations/ 是六个执行类，runtime/ 是三个运行时（pdfjs、MarkItDown 定位、文档渲染）
  utils/        纯函数，按域分子目录（word / presentation / spreadsheet / pdf / preview），每个函数上方一句说明；input.ts 是入参核对，errors.ts 拼外部转换的错误，paths.ts 是路径与写出，tuning.ts 是可调参数
  index.ts      `./office` 入口，只转发
  contracts.ts  `./office/contracts` 入口，只转发
  renderer.ts   `./office/renderer` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  vendor/       随包审过的 PptxGenJS ESM 运行时（带本地安全补丁；许可证在包根的 third-party-licenses/）
  spec/         不变量登记、验收测试、共用的临时工作区与空间端口替身、模型程序跑法
  test/         实现细节测试：路径包含门、Word 追加、字体、表格格式、预览净化与截断、PptxGenJS 补丁、资源定位、命令描述串，以及代码模版实跑
```

**分层。** 三层，上层只引下层：`OfficeOperations.ts`（代码面的九个操作）→ `operations/`（执行：生成、PDF、预览、Markdown、外部转换器、工作区路径门）→
`runtime/`（pdfjs、MarkItDown 定位、文档渲染）。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，只引 utils、types 与合同。

**常量分四处。** 对外承诺的（错误码、环境变量、写进声明的上限与扩展名）在 `contract/constants.ts`，声明里写给模型的数字与它由验收核对一致；
单元内可调的（超时、缓冲、像素上限、缺省页数）在 `utils/tuning.ts` 的 `OfficeTuning`；某个类里固定用的文案写成该类的 `private static readonly`；算法与格式里的数字就地写。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `OfficeOperations.ts` | `OfficeOperationsApi`（同文件，provides 登记） | 代码面 `office` 命名空间的九个操作：查取消、核对入参，交给执行类 |
| `operations/OfficeWorkspace.ts` | `OfficeWorkspaceApi`（同文件） | 唯一的路径包含门：工作区根、路径在不在根内、准备输出路径 |
| `operations/OfficeDocumentOperations.ts` | `OfficeDocumentOperationsApi`（同文件） | Word、PowerPoint、Excel 的生成 |
| `operations/OfficePdfOperations.ts` | `OfficePdfOperationsApi`（同文件） | 按页取文、Word 转 PDF、LaTeX 编译、PDF 编辑 |
| `operations/OfficePreviewOperations.ts` | `OfficePreviewOperationsApi`（同文件） | 预览的解析与 HTML/PNG 写出 |
| `operations/OfficeMarkdownOperations.ts` | `OfficeMarkdownOperationsApi`（同文件） | MarkItDown 转 Markdown |
| `operations/OfficeConverters.ts` | `OfficeConvertersApi`（同文件） | 外部转换器：探测、原生 argv 执行、`.doc` 归一化 |
| `runtime/PdfjsRuntime.ts` | `PdfjsRuntimeApi`（同文件） | pdfjs 的取用与逐页取文本 |
| `runtime/MarkItDownLocator.ts` | `MarkItDownLocatorApi`（同文件，provides 登记） | 按资源根找 MarkItDown runtime |
| `runtime/OfficeDocumentRenderer.ts` | `OfficeDocumentRendererApi`（同文件，provides 登记） | 给 Document Renderer 的窄渲染面 |

`./office/contracts` 会被渲染进程加载，它的整条引用链不碰 Node 模块。`./office/renderer` 的引用链不经过操作文件。
`contract/` 的三个文件改了等于改对外契约，要在差量报告里点名。
