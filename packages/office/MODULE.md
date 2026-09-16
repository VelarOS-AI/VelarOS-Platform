# @velaros-ai/office 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 十个工具都在 `src/impl/OfficeTools.ts` 一个文件里，是最先看的地方；其次是 `src/contract/` 的三个文件（产品面登记、注入面、常量表）和各实现文件类上方的接口。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`。

## 这是什么

办公文档的能力包：让 agent 在用户的工作区里生成和改写 Word、PowerPoint、Excel、PDF，并把已有文档读成模型能看的结构或 Markdown。生成走纯 JS 的文档库（docx / PptxGenJS / ExcelJS / pdf-lib），格式转换走宿主本机的外部命令（LibreOffice、LaTeX 编译器、可选插件 MarkItDown），预览的位图走随包的 canvas 与 pdfjs。

它不知道「项目」「系统」「浏览器」是什么，工具说明里也不提别的空间；它只认宿主给的一个工作区根，所有读写路径都相对那个根。缺转换器时装什么、怎么装、要不要改用浏览器在线处理，全是宿主界面的事：本包只把错误码与缺了哪个命令交出去。

同一份解析与渲染原语还给独立打包的 Document Renderer 用，那条路径不经过工具文件，也就不需要 agent。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/` 的公开数据文件，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对，没写进这一节的值导不出去。

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `officeTools` | `OfficeToolCollection`，元素是 `VelaTool` | 十个模型面工具 |
| `createOfficeKernelModule` | 上游的 `KernelModuleDefinition` | 挂进内核的模块 |
| `OfficeCapability` | 能力令牌，服务是 `OfficeCapabilityService` | 在内核里按名调用 office 工具 |
| `createMarkItDownLocator` / `markItDownBinaryResolver` | `MarkItDownLocatorApi` | 找本机装没装 MarkItDown runtime；后者是不注入端口时的缺省那一份 |
| `officeDocumentRenderer`（`./renderer`） | `OfficeDocumentRendererApi` | 解析 Office 预览、渲染预览 PNG 与 PDF 单页位图 |

**注入面**，写在 `contract/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `OfficeToolContext`，里面是宿主端口 `OfficeHostApi` | 必须 | 宿主每次调工具时给。端口扁平一层、只有五个方法（取工作区根、申请写入授权、探测命令、跑原生 argv、定位 MarkItDown），每个都有工具在调，门禁逐方法核对 |
| `OfficeToolContextResolver`，放在 `CreateOfficeKernelModuleOptions` 里 | 挂进内核且要按名调用时必须 | 创建内核模块时给 |
| `OfficeResourcePort`，放在 `MarkItDownLocatorOptions` 里 | 可选 | 宿主的插件登记表经它交出额外资源根与停用开关；不给就只按平台约定推导 |
| 环境变量，全部登记在 `OfficeEnvironmentVariables` | 可选 | 两个输入变量由宿主设 |
| `OfficeSystemCommandResult.systemToolSuggestion` | 可选 | 缺转换器时宿主往命令结果上挂自己的安装建议卡；本包原样透传，不构造也不读 |

**数据面**是 `types/`，只放类型；**常量表**是 `contract/constants.ts`，只放值：`OfficeToolNames`、`OfficeToolCategoryId`、`OfficeModId`、`OfficeKernelModuleVersion`、`OfficeErrorCodes`、`OfficeEnvironmentVariables`，以及被工具说明与 schema 直接引用的上限 `OfficeInputLimits`、`OfficePdfLimits`、`OfficeMarkdownLimits`、`OfficePreviewLimits` 和输入扩展名表 `OfficeMarkItDownInputExtensions`。类型里对外的是 `OfficeToolPermission`、`OfficeToolName`、`OfficeErrorCode`、`OfficeMarkItDownInputExtension` 与经宿主端口流动的数据（授权请求与裁决、环境探测、命令结果、原生命令、MarkItDown 定位结果、归一化后的 Word 输入）。

三个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个面的全部 |
| `./contracts` | 任何进程，含浏览器、渲染进程 | 常量表与可移植数据 |
| `./renderer` | 不装 agent 的 Document Renderer | 只有 `officeDocumentRenderer` 与它的输入输出数据、`OfficeErrorCodes` |

模型面的十个工具是本模块的主产品。它们都在 `src/impl/OfficeTools.ts`，每个工具的定义就是模型看到的全部信息面：摘要、适用与禁用场景、用法、示例、参数说明、权限、能力声明。execute 只放一两步，交给 `operations/` 的执行类。

## 骨干链路

十个工具都在 `OfficeTools.ts`，每个工具定义上方是它的说明。写盘的工具一律先向宿主申请授权，被拒时一个字节都不写；所有路径按解开符号链接后的真实路径判是否还在工作区根内。

| 工具 | 链路 |
| --- | --- |
| `office:create_word_document` | blocks 或 Markdown/纯文本归一成内容块 → 空内容直接拒绝 → `prepareMutation` 授权 → 准备 .docx 输出路径（appendMode 命中已有文件走追加、不要求 overwrite）→ 新建走 `buildWordDocument`，追加先生成 fragment 再把 XML body 缝进原文档 → 落盘回执 |
| `office:create_presentation` | slides 或 content 自动拆页 → 授权 → 准备 .pptx → 按模板配色建主题、逐页加元素与备注 → 落盘回执 |
| `office:create_spreadsheet` | sheets 或 CSV/TSV/Markdown/JSON 解析成工作表 → 授权 → 准备 .xlsx → 逐表写列定义、行、样式、冻结与筛选 → 落盘回执 |
| `office:extract_pdf_text` | 解析输入路径（只认 .pdf，真实路径必须在根内）→ pdfjs 逐页取可选择文本 → 按 pages / maxPages 选页，页码越界如实报 → 返回页数与每页文本 |
| `office:convert_pdf_to_word` | 提取 PDF 文本 → 每页一节标题加正文 → 授权 → 复用 Word 生成链路写 .docx |
| `office:convert_word_to_pdf` | 解析输入（.docx/.doc）→ 授权 → 探测 LibreOffice，没有就带 `converterMissing` 结构化返回 → 原生 argv 跑转换 → 核对产物并挪到输出路径 |
| `office:create_latex_pdf` | 授权 → latexSource 写成 .tex（sourcePath 缺省与 PDF 同名同目录）→ 按 compiler 探测 tectonic / latexmk / xelatex / pdflatex → 逐次编译，失败保留 .tex 并交回 commandResults → 核对 PDF 产物 |
| `office:edit_pdf_document` | 解析输入 → 授权 → pdf-lib 选页、删页、旋转、盖文字戳、写元数据 → 写出新 PDF |
| `office:preview_document` | 解析输入（.docx/.doc/.pptx/.xlsx）→ 解析成结构化预览（大纲、幻灯片、工作表）→ 要 outputPath 时授权后写 HTML（parse5 白名单净化，缺省不加自动刷新脚本）或 PNG → 返回摘要与预览 |
| `office:convert_document_to_markdown` | 定位 MarkItDown，没装或被停用就带 `markItDownUnavailable` 返回 → 解析输入（17 种扩展名）→ 让 MarkItDown 写临时文件 → 读文件开头、按 maxChars 截断并如实标记 → 要 outputPath 时授权后落盘 |

十个工具的分组、内置类别与内核挂载也在 `OfficeTools.ts` 末尾；挂进内核后每次调用先解析入参，再向宿主解析一次上下文。

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`。
- `@velaros-ai/kernel`：内核模块定义与模块 SDK；`@velaros-ai/kernel/contracts` 出能力令牌与作用域等可移植数据。
- `@velaros-ai/tool-contract`：工具运行时规格、工具定义辅助、入参描述辅助。
- `@velaros-ai/agent/contracts`：`ToolPermission` 权限轴。
- `@velaros-ai/platform`：跨平台路径判定与共享资源目录。
- `docx`、随包 vendor 的 `pptxgenjs`、`exceljs`、`pdf-lib`、`pdfjs-dist`、`mammoth`、`jszip`、`parse5`、`@napi-rs/canvas`：文档读写与渲染。
- `zod`：wire 面入参校验。

运行时要宿主给的东西全部列在上一节的注入面里。本包不依赖 `@velaros-ai/project`、`@velaros-ai/system`、`@velaros-ai/browser`，工具说明里也不提这些空间。

## 状态归谁

- **没有跨调用的可变状态。** 工具集合、常量表都是纯值；执行类 `OfficeWorkspace`、`OfficeConverters` 与四个操作类是无状态的单例，每次调用要什么都从 `ctx.office` 现拿。
- **pdfjs 运行时**：整个进程一份（`pdfjsRuntime`），只缓存「已经补好 Node 图形全局的 pdfjs 模块」，不留文档句柄——每次提取都自己 `destroy()`。
- **MarkItDown 定位结果**：不缓存。宿主注入了 `OfficeHostApi.locateMarkItDown` 就每次问宿主，用户在设置里停用立刻生效；没注入才回落到按平台约定推导的 `markItDownBinaryResolver`。
- **临时目录**：`.doc` 归一化与 MarkItDown 输出各建一个临时目录，用完即删。
- **授权记忆**：不归本模块。本模块只发起 `prepareMutation`，记不记、记多久由宿主决定。

## 生命周期

- 工具集合与常量表是纯值，随包加载即存在，没有启动顺序。
- 内核模块 `createOfficeKernelModule` 在 `activate` 时注册能力服务；每次调用先解析入参，再向宿主解析一次上下文。
- `office:convert_document_to_markdown` 在 MarkItDown 不可用时对模型隐身（`hideWhenUnavailable`），装上或停用都在下一次列工具时生效。
- pdfjs 在第一次用到 PDF 时才真正取到模块，之后整个进程复用；进程退出即结束，没有 dispose。
- 外部转换命令的生命周期归宿主：本包只交原生 argv 与超时，进程怎么起、怎么收由 `OfficeHostApi.runCommand` 负责。

## 失败语义

- **默认失败关闭。** 路径按真实路径算不在工作区根内一律拒绝（`pathOutsideProject`）；目标已存在又没传 `overwrite` 拒绝（`outputExists`）；扩展名不对拒绝（`invalidExtension`）；内容为空拒绝（`emptyContent`）。
- **缺外部转换器不是异常，是结构化结果。** 返回带 `converterMissing` / `markItDownUnavailable` 的回执，说清缺哪个命令、为什么要它；装什么、怎么装、能不能改走浏览器在线处理由宿主的界面回答。
- **授权被拒不是失败。** 返回跳过回执，把宿主给的拒绝说明原样带上，一个字节都不写。
- **外部命令自身失败如实上报**：退出码、stderr、超时都进 `commandResults`，不把它翻译成本包的错误。
- **截断如实标记。** MarkItDown 的输出保留文档开头并标 `truncated`；预览按 `maxItems` 截条目时摘要报的是文档里的真实数量。
- 完整错误码语义见 `src/contract/constants.ts` 的 `OfficeErrorCodes`；外面按错误码判断，不按错误类。

## 不变量

共 12 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 10 条、门禁 2 条。未验证 0 条。

## 非目标

- 不做空间感知：不发现项目、不读项目配置，工具说明里不提 project、system、browser 空间。
- 不做界面：安装建议卡、「用浏览器线上处理」这类替代方案、授权提示的文案与按钮都在宿主，本包只交错误码与事实。
- 不接受调用方换执行目录：十个工具都没有 `cwd`，路径一律相对宿主给的工作区根（2.0.0 删除）。
- 不把产品名写进用户的产物：作者、公司缺省留空，模板里也不盖产品水印。
- 不自己起进程：外部转换器一律经宿主端口的原生 argv 执行，本包不拼 shell 串。
- 不做 OCR、不做扫描件识别：`office:extract_pdf_text` 只取文本型 PDF 的可选择文本。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记产品面（类实现的 API 定义在类上方，这里 re-export；没有类的公开接口声明在这里），requires.ts 注入面，constants.ts 约定的常量表
  types/        只放类型，按域分文件：office.ts 是可移植数据文件，inputs.ts 是十个工具的入参形状，word/presentation/spreadsheet/pdf/preview/workspace/tool 各管一域
  impl/         OfficeTools.ts 放十个工具；operations/ 是六个执行类，runtime/ 是三个运行时（pdfjs、MarkItDown 定位、文档渲染），一个类一个文件
  utils/        纯工具函数，按域分子目录（word / presentation / spreadsheet / pdf / preview）；每个函数上方一句中文说明；tuning.ts 是全包的可调参数表
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
  renderer.ts   `./renderer` 入口，只转发
```

**看代码的顺序**：`OfficeTools.ts` → `contract/` 的三个文件 → 需要时看 utils 里函数上方的一句说明。

**合同、类型、常量分开。** `contract/` 是对外合同；`types/` 只放类型，一个值都没有；出不出包不看文件，看合同的签名有没有用到。

**常量分四处。** 对外承诺的（工具名、错误码、环境变量、写进工具说明与 schema 的上限）在 `contract/constants.ts`，工具说明里的数字用模板字符串引它；包内可调的（超时、缓冲、像素上限、缺省页数）在 `utils/tuning.ts` 的 `OfficeTuning`；某个类里固定用的文案写成该类的 `private static readonly`；算法与格式里的数字就地写。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `OfficeTools.ts` | 没有类 | 十个工具的定义、分组、内核挂载 |
| `operations/OfficeWorkspace.ts` | `OfficeWorkspaceApi`（同文件） | 唯一的路径包含门：有没有根、路径在不在根内、写入授权、准备输出路径 |
| `operations/OfficeDocumentOperations.ts` | `OfficeDocumentOperationsApi`（同文件） | 三个创建工具的执行 |
| `operations/OfficePdfOperations.ts` | `OfficePdfOperationsApi`（同文件） | 四个 PDF 工具的执行 |
| `operations/OfficePreviewOperations.ts` | `OfficePreviewOperationsApi`（同文件） | 预览的解析、HTML/PNG 写出 |
| `operations/OfficeMarkdownOperations.ts` | `OfficeMarkdownOperationsApi`（同文件） | MarkItDown 转 Markdown |
| `operations/OfficeConverters.ts` | `OfficeConvertersApi`（同文件） | 外部转换器：探测、原生 argv 执行、`.doc` 归一化 |
| `runtime/PdfjsRuntime.ts` | `PdfjsRuntimeApi`（同文件） | pdfjs 的取用与逐页取文本 |
| `runtime/MarkItDownLocator.ts` | `MarkItDownLocatorApi`（同文件，provides 登记） | 按资源根找 MarkItDown runtime |
| `runtime/OfficeDocumentRenderer.ts` | `OfficeDocumentRendererApi`（同文件，provides 登记） | 给 Document Renderer 的窄渲染面 |

实现分三层，上层可以调下层，下层不调上层：工具（`OfficeTools.ts`）→ 执行（`operations/`）→ 运行时（`runtime/`）。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，只引 utils、types 与合同。

`./contracts` 入口会被渲染进程加载，它的整条引用链不碰 Node 模块。`./renderer` 的引用链不经过工具文件，因此不带 agent。

`OfficeTools.ts` 改了要在差量报告里点名，人复核；`contract/` 的三个文件改了等于改对外契约，也要点名。
