# packages/office 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/office`（`@velaros-ai/office` 1.1.11，capabilities 域）。分析基于 HEAD `7c39d5c9`，`packages/office` 工作区干净。
> 标准：`docs/architecture/module-ownership.md`、ADR 0003 / 0004 / 0007 / 0008、样板 `packages/system`（工具文件 `src/impl/SystemTools.ts`）与 `packages/project`（`impl/operations/` 执行类）。流水账已定的事不再论证：挂进内核的可调用操作表已改用 `@velaros-ai/agent/tool-contract` 的 `createToolCallableOperations`（本包 `kernel-module.ts` 已接上）；路径包含判断已进 platform（`relativePathTextInside`，c9564d45），真实路径已进 core（`resolveRealPath`，7c39d5c9）。
> 方法：只读。工具说明与 schema 由 `plan-mid/scripts/office-tools-dump.ts` 从源码 import 后渲染统计；缺陷用 `plan-mid/probes/office-probes.ts` 在草稿区临时目录实测（跑完删掉自建目录）。
> 基线：`packages/office` 下 `bun test test` 22 pass / 0 fail（7 个文件）。

## 0. 结论先行

1. **规模**：`src/` 26 个 `.ts`、7,339 行（另有随包的 PptxGenJS 7,393 行 vendor）；10 个模型面工具定义散在 6 个 `*.tool.ts`，实现在 5 个 1,000 行上下的「函数模块」里（`wordTool.ts` 1,481、`previewTool.ts` 927、`presentationTool.ts` 871、`officeShared.ts` 725、`pdfTools.ts` 690、`spreadsheetTool.ts` 684），161 个顶层函数、只有 3 个类（另 1 个错误类）；6 个入口导出 68 个名字，**产品只用 4 个**（`officeTools`、`OfficeHostApi`、`markItDownBinaryResolver`、`MarkItDownLaunchSpec`），另外 6 个被 `packages/document-renderer` 用；根入口与 `./composition` 零消费。
2. **主要问题**：① 10 个工具的 execute 有 9 个超过门禁 4 条（最多 53 条），工具文件不是「只放定义」；② 路径包含门两处被绕开（第 5 节 O2、O3，实测）：项目里的符号链接能把产物写到根外，只读工具经 `cwd` 参数把「根」换成任意目录；③ `office:convert_document_to_markdown` 长文档返回的是**结尾**、却标 `truncated: false`（O1，实测）；④ Word 追加模式追加的项目符号引用不存在的编号定义（O4，实测）；⑤ 宿主端口带进了产品壳概念（安装建议卡、「用浏览器线上处理」的中英双语草稿、项目自动批准通知）；⑥ 两个模块级单例（资源登记表、MarkItDown 解析器）与 Desktop 自己的插件登记表是两套，Desktop 的安装根与停用开关到不了 office。
3. **目标**：`src/` 收成五个目录；`impl/OfficeTools.ts` 放 10 个工具的全部定义（schema、surfaces、分组、内核挂载），execute 各一行交给 `impl/operations/` 的 6 个执行类；utils 24 个文件按 word / presentation / spreadsheet / pdf / preview 分子目录；**入口从 6 个收成 3 个**：`.`、`./contracts`、`./renderer`（独立发布的 Document Renderer 用，不许把 agent peer 依赖带过去）。
4. **要拍板的**（第 7 节）：删 `cwd` 参数；宿主端口扁平化并去掉安装建议；读取范围（项目内 / 任意位置）；MarkItDown 输出改走临时文件；生成文档默认写「VelarOS」作者与公司；surfaces 文案；内核模块去留；产物里的英文；版本 2.0.0。
5. **步骤一句话**：先修 O1–O5（各带回归测试）→ 工具定义收进一个文件、execute 下沉到执行类（模型面字节不变）→ 函数模块拆进 utils、常量与 tuning、英文改中文 → 合同与入口收口（同提交改 document-renderer、capability 门与 fixtures）→ 登记治理。

## 1. 现状

### 1.1 目录与职责

| 文件 | 行 | 职责 |
| --- | ---: | --- |
| `word.tool.ts` / `wordTool.ts` | 130 / 1,481 | `office:create_word_document`：Markdown/纯文本转 blocks、docx 构建、学术模板（封面、摘要、目录、页脚）、CJK 字体、OOXML 追加 |
| `presentation.tool.ts` / `presentationTool.ts` | 147 / 871 | `office:create_presentation`：内容拆页、四套模板配色与版式、元素（文本、表格、形状、图片、图表） |
| `spreadsheet.tool.ts` / `spreadsheetTool.ts` | 252 / 684 | `office:create_spreadsheet`：CSV/TSV/Markdown/JSON 转表、单元格样式、合并、冻结、数字格式、自动列宽 |
| `pdf.tool.ts` / `pdfTools.ts` | 472 / 690 | 五个 PDF 工具：按页提文本、PDF→Word、Word→PDF（LibreOffice）、LaTeX→PDF、编辑页面/文字戳/元数据；pdfjs 懒加载与 Node 全局补丁 |
| `preview.tool.ts` / `previewTool.ts` | 119 / 927 | `office:preview_document`：docx（mammoth）/pptx/xlsx 解析、HTML 预览与净化、PNG 预览 |
| `markitdown.tool.ts` / `markitdownTool.ts` / `markitdownResolver.ts` | 37 / 283 / 135 | `office:convert_document_to_markdown` 与随包 MarkItDown runtime 的定位 |
| `officeShared.ts` | 725 | 宿主端口类型、`defineOfficeTool`、能力元数据、路径门、输出准备、外部命令（LibreOffice 字体配置、`.doc` 归一）、结果构造器、Markdown 表格原语、依赖的再导出 |
| `OfficeContracts.ts` | 80 | 端口上流动的数据（授权决定、环境检查、安装建议、命令结果） |
| `OfficePlatformCompatibility.ts` | 31 | POSIX 单引号转义、Windows 路径改斜杠、根内相对路径 |
| `OfficeResourceRuntime.ts` | 50 | 可选资源的额外根与停用集 + 兼容单例 |
| `pdfPageRenderer.ts` | 100 | 给 Document Renderer 的 PDF 单页 PNG 渲染 |
| `kernel-module.ts` | 61 | 内核能力 `velaros.office`（工具按名调用） |
| `Collection.ts`、`index.ts`、`composition.ts`、`contracts.ts`、`runtime.ts`、`renderer.ts`、`tools.ts` | — | 工具集合与 6 个入口 |

### 1.2 对外入口：导出了什么、谁在用

| 入口 | 导出（值） | 被用 | 消费方 |
| --- | ---: | ---: | --- |
| `.` | 29（7） | 0 | — |
| `./composition` | 5（2） | 0 | — |
| `./contracts` | 14（0） | 1 | `OfficeHostApi`：Desktop `main/agent/context/ToolContext.ts`、`main/tools/ToolContextTypes.ts`；另 `scripts/capabilities/check-packed-consumers.mjs` 的 fixture 用 `OfficeEnvironmentInspection`、`OfficeSystemApi` |
| `./runtime` | 9（4） | 2 | `markItDownBinaryResolver`、`MarkItDownLaunchSpec`：Desktop `main/resources/AppResourcePluginService.ts` |
| `./renderer` | 10（5） | 6 | `packages/document-renderer/src/renderer.ts`：`parseOfficePreview`、`buildOfficePreviewHtml`、`renderOfficePreviewPng`、`renderPdfPagePng`、`OfficePdfPageRenderError`（`instanceof` 判断）、`OfficePreviewKind`；`products/document-renderer/tsconfig.json` 有该入口的 paths |
| `./tools` | 1（1） | 1 | `officeTools`：Desktop `mods/office/main/tools/Office.tool.ts`；`Desktop:scripts/checks/toolDescriptionBudget.mjs` 按字符串引用 |

Termel `serve-host/test/host-renderer-boundary.test.ts` 断言 Termel 不含 `@velaros-ai/office` 与 `velaros.office`（不受入口变化影响）。工具名被别处写死：Desktop `main/agent/unattended/UnattendedTaskToolPolicy.ts:101-123`（8 个 office 工具）、Platform `packages/ui/src/conversation/tool-render/toolTargetSummary.ts`。

### 1.3 与别的包的耦合

- 依赖：`@velaros-ai/core`、`@velaros-ai/kernel/contracts/abi`、peer `@velaros-ai/agent`（`tool-contract` 的 `defineToolRuntimeSpec / renderParameterDescription / structureToolDescriptionsForCategory / createToolCallableOperations`，`protocol` 的 `ToolCapabilitySchema`）、`zod`、`docx`、`exceljs`、`jszip`、`mammoth`、`parse5`、`pdf-lib`、`pdfjs-dist`、`@napi-rs/canvas`。
- 被依赖：`packages/document-renderer`（`./renderer`）。
- 仓库门禁钉住的路径：`scripts/capabilities/capability-owners.mjs`（`entrySubpaths: ['.']`、`schemaExports: ['officeTools']`、缺省 `dist/index.js`）、`scripts/capabilities/check-arch-boundaries.mjs:549-563`（`src/index.ts`、`src/contracts.ts`、`src/OfficeContracts.ts`、`OfficeEnvironmentInspection`）、`scripts/capabilities/check-packed-consumers.mjs:203-218`、根 `tsconfig.json` 的 `@velaros-ai/office` 与 `/*` paths、`scripts/security/checkPatchedDependencies.mjs` 与 `scripts/quality/check-public-readiness.mjs`（vendor 路径，不变）。
- **与 project / system 的镜像**：`OfficeProjectMutationAuthorizationInput` / `OfficeProjectAuthorizationDecision` 与 project 的 `ProjectMutationAuthorizationInput` / `ProjectAuthorizationDecision` 字段逐一相同（连 Desktop 的 `projectAutoApprovalNotice` 都在）；`OfficeSystemCommandResult` 是 system `SystemCommandResult`、project `ProjectCommandResult` 的子集加 `systemToolSuggestion`（system 已按 ADR 0003 删掉这块产品概念）；`getRelativePathInsideOfficeRoot` 是第五份「路径在不在根里」。

### 1.4 写死了别的空间 / 宿主 / 厂商知识的地方

| 位置 | 内容 |
| --- | --- |
| `officeShared.ts:472-523`、`pdf.tool.ts:94-103,314-323`、`previewTool.ts:176-188` | 「用浏览器线上处理」替代方案：`Browser Use` 这个浏览器空间功能名，加中英双语的按钮文字与用户草稿（zh-CN / en-US）——是 Desktop 安装卡的界面文案 |
| `OfficeContracts.ts:16-25,38-57`、`officeShared.ts:74-78,472-499` | `projectAutoApprovalNotice`、`OfficeSystemToolInstallSuggestion`（`triggeredBy.scope: 'project' \| 'system'`）、端口方法 `createSystemToolInstallSuggestion` |
| `officeShared.ts:131-172` | 能力元数据 `project.requiresActiveProject / requiresProjectSwitchForExternalCwd / arbitraryRead / mutation: 'non-transactional'`、`canMutateProject`：全仓与三个产品**没有一处读**这些字段 |
| `markitdownResolver.ts:28-54`、`markitdownTool.ts:119-120` | Electron `process.resourcesPath`、`app.asar.unpacked`、Desktop 构建目录 `out/resources`；模型看得到的「请确认应用构建产物包含 out/resources/markitdown/…」 |
| `markitdown.tool.ts:22` | 工具说明「使用随应用打包的 Microsoft MarkItDown runtime，不要求用户自行安装 CLI」——MarkItDown 已改成插件市场按需安装，这句过时且与模型无关 |
| `word.tool.ts:112`、`wordTool.ts`、`presentation.tool.ts:115-118`、`spreadsheet.tool.ts:141-142`、`pdf.tool.ts:223` | 生成的用户文档默认作者 `VelarOS`、PPT 公司 `VelarOS`、主题 `Generated presentation` |
| `officeShared.ts:268-272` | 注释说「能力范围由 toolSpacePolicy 限制在日常工作区」（宿主策略） |
| `officeShared.ts:604-638` | macOS LibreOffice 字体缓存配置、`/Applications/LibreOffice.app/…` 路径（平台惯例，属 platform） |

### 1.5 模块级可变状态

| 位置 | 状态 |
| --- | --- |
| `OfficeResourceRuntime.ts:49` `officeResourceRuntime` | 进程级登记表（额外根、停用集），`@deprecated` 但 `markItDownBinaryResolver` 缺省就用它 |
| `markitdownResolver.ts:134` `markItDownBinaryResolver` | 进程级解析器，工具的 `isAvailable` 与 execute 直接读这个单例 |
| `pdfTools.ts:145-195` `ensurePdfjsNodeGlobals` | 往 `globalThis` 装 `DOMMatrix / ImageData / Path2D` 替身或 canvas 实现，整个宿主进程生效 |
| `OfficePlatformCompatibility.ts:30`、`officeShared.ts:196`、`markitdownResolver.ts:25`、`previewTool.ts:707-716`、`wordTool.ts:431` | 不可变单例、`createRequire`、净化白名单 Set、学术模板 Set |

Desktop 在 `main/bootstrap/composition/config.ts:77-79` 把共享资源安装根与停用集登记到**它自己的** `appResourceRuntime`，从没碰过 `officeResourceRuntime`（第 5 节 O6）。

### 1.6 一个文件多个类、类不实现接口

类只有 `OfficeResourceRuntimeRegistry`（实现了）、`OfficePlatformCompatibility`、`MarkItDownBinaryResolver`（都没实现）与错误类 `OfficePdfPageRenderError`；`pdfTools.ts:79-195` 在函数里造了 `DOMMatrixStub`、`ImageData`、`Path2D` 三个匿名类。真正的问题是反过来：带宿主状态的逻辑（授权、写盘、跑外部命令、清临时目录）全是散在 5 个文件里的顶层函数，把 `ctx` 一路往下传。

### 1.7 用户或模型看得到的英文

| 位置 | 原文 | 谁看得到 |
| --- | --- | --- |
| `pdf.tool.ts:212,215,222` | 标题 `Page N`、`(No extractable text on this page.)`、文档标题 `Converted from …` | PDF→Word 产物 |
| `previewTool.ts:501,515,523,530` 与默认标题 `Word Document / Presentation / Workbook / Slide N` | `Legacy .doc was normalized …`、`· Office Preview`、`… preview`、`No previewable content found.` | 预览 HTML/PNG 与工具结果的 `preview.title` |
| `markitdownTool.ts:95` | `<!-- MarkItDown output truncated by VelarOS -->` | 模型 |
| `pdfPageRenderer.ts:49,54,71,82`、`pdfTools.ts:201` | `PDF page must be a positive integer.` 等 4 句、`pdfjs-dist did not expose getDocument.` | Document Renderer 用户 |
| `officeShared.ts:163,169` | 能力 `reason`：`office document creation or conversion` 等 | 审批与发现界面 |
| `pdf.tool.ts:98,102,318,322`、`previewTool.ts:183,187` | `enDescription` / `enDraft`（双语安装卡） | Desktop 英文界面（本身是界面文案，应随安装卡一起搬回宿主） |

### 1.8 测试怎么组织

7 个文件在 `test/`：`kernel-module.test.ts`（363 行，经内核调用真工具，覆盖 PDF 提取、docx 副标题、预览、PNG）、`preview-sanitization.test.ts`、`spreadsheet-formatting.test.ts`、`word-fonts.test.ts`、`office-shell-quoting.test.ts`、`presentation-vendor.test.ts`、`resource-runtime.test.ts`；多数直接 import 源文件（`../src/officeShared`、`../src/wordTool`、`../src/previewTool`）。没有 `spec/`，没有路径门、追加模式、MarkItDown 截断的测试。

## 2. 目标布局

### 2.1 总体

```text
packages/office/src/
  contract/   provides.ts、requires.ts、constants.ts
  types/      office.ts（可移植）、inputs.ts、word.ts、presentation.ts、spreadsheet.ts、pdf.ts、preview.ts
  impl/
    OfficeTools.ts          10 个工具的全部定义（说明、schema、surfaces、示例、权限、能力声明）、分组、内核挂载
    operations/             OfficeDocumentOperations、OfficePdfOperations、OfficePreviewOperations、OfficeMarkdownOperations、OfficeWorkspace、OfficeConverters
    runtime/                MarkItDownLocator、PdfjsRuntime、OfficeDocumentRenderer
  utils/
    word/                   content.ts、docx.ts、academic.ts、fonts.ts、ooxml-append.ts
    presentation/           content.ts、templates.ts、elements.ts
    spreadsheet/            content.ts、style.ts、sheet.ts
    pdf/                    pages.ts、latex.ts、pdfjs-globals.ts
    preview/                parse.ts、html.ts、sanitize.ts、png.ts
    markdown.ts、paths.ts、results.ts、resources.ts、tool.ts、tuning.ts
  exports/    index.ts、contracts.ts、renderer.ts
```

### 2.2 分层（登记表 `layers`）

1. `OfficeTools.ts`
2. `operations/`：执行类，全部经宿主端口 `ctx.office` 授权、写盘、跑外部命令；`OfficeWorkspace`（路径门、输出准备、授权与跳过结果）与 `OfficeConverters`（LibreOffice、LaTeX、MarkItDown 的发现与执行、`.doc` 归一、临时目录回收）在同层供另外四个用。
3. `runtime/`：`PdfjsRuntime`（一次性装 pdfjs 与 Node 全局补丁，进程一份）、`MarkItDownLocator`（按注入的资源端口找 runtime）、`OfficeDocumentRenderer`（给 `./renderer` 的解析与渲染 API）。

`./renderer` 的值引用链只到 `runtime/OfficeDocumentRenderer.ts` → `utils/preview/*`、`utils/pdf/pdfjs-globals.ts` → 常量表，不经过 `OfficeTools.ts`，所以 Document Renderer 不会被迫装 agent。

### 2.3 `types/`

| 文件 | 内容 | 出包 |
| --- | --- | --- |
| `office.ts`（可移植） | 端口上流动的数据，**按工具真读的字段收窄**：授权请求 `{ operation, targetPath }` 与决定 `{ approved, rootPath, message, rejectionMessage }`；环境检查与命令可用性；原生命令 `{ file, args, env? }`；命令结果 `{ command, cwd, exitCode, signal, stdout, stderr, durationMs, timedOut, aborted, truncated, success }`；MarkItDown 定位结果；产物 `OfficeOutput` | 随 `./contracts` |
| `inputs.ts` | 10 个工具与 6 个 surface 的入参（手写，schema 用 `satisfies z.ZodType<…>` 对齐，与 agent 方案同一裁决） | 公开签名用到的出 |
| `word.ts`、`presentation.ts`、`spreadsheet.ts`、`pdf.ts` | 各域的工作类型（`WordBlock`、`PptElement`、`ExcelCellInput`、`PdfTextStampInput`…） | 被 `inputs.ts` 引到的出 |
| `preview.ts` | `ParsedOfficePreview`、`OfficePreviewKind`、`RenderPdfPagePngInput`、`RenderedPdfPagePng` | `./renderer` 用到的出 |

### 2.4 `impl/` 与 `utils/` 的来源

| 目标 | 来源 |
| --- | --- |
| `impl/OfficeTools.ts` | 6 个 `*.tool.ts` 的定义、`wordTool/presentationTool/spreadsheetTool/pdfTools/previewTool/markitdownTool` 里的 zod schema 与 surface normalize、`officeShared.ts` 的能力元数据与 `outputPathSchema`、`Collection.ts`、`kernel-module.ts` |
| `operations/OfficeDocumentOperations.ts` | word/presentation/spreadsheet 三个 execute（16 / 28 / 53 条语句）与 `prepareWordDocumentOutputPath`、`applyNumberFormats` 的写盘部分 |
| `operations/OfficePdfOperations.ts` | 五个 PDF execute（5–28 条）、`runLatexCompileCommands` |
| `operations/OfficePreviewOperations.ts` | preview execute（17 条）、`normalizePreviewInput`、`writeOfficePreview` |
| `operations/OfficeMarkdownOperations.ts` | `markitdownTool.ts` 的 `executeConvertDocumentToMarkdown / runMarkItDownToFile / runMarkItDownToStdout` |
| `operations/OfficeWorkspace.ts` | `officeShared.ts` 的 `toolRequiresProject / runWithDirectory / normalizeExtensionPath / assertOfficePathInsideProject / prepareOfficeOutputPath / resolveOfficeInputPath* / getFileStats / writeOfficeBuffer / copyOfficeOutput / buildProjectMutationSkippedResult`；包含判断改用 `currentPlatform.relativePathTextInside` + `resolveRealPath` |
| `operations/OfficeConverters.ts` | `findAvailableCommand / runOfficeSystemCommand / runLibreOfficeSystemCommand / resolveLibreOfficeCommand / normalizeWordInputToDocx / cleanupNormalizedWordInput / resolveLatexCompiler` |
| `runtime/MarkItDownLocator.ts` | `markitdownResolver.ts`（类实现 `MarkItDownLocatorApi`，工厂 `createMarkItDownLocator`，删单例） |
| `runtime/PdfjsRuntime.ts` | `pdfTools.ts:145-205` `ensurePdfjsNodeGlobals / loadPdfjs / getPdfjsStandardFontDataUrl` |
| `runtime/OfficeDocumentRenderer.ts` | `pdfPageRenderer.ts` + 预览解析/HTML/PNG 的对外那一面（实现 `OfficeDocumentRendererApi`，实例 `officeDocumentRenderer`） |
| `utils/word/*` | `wordTool.ts`：`parseWordContentToBlocks…parseMarkdownTableAt`→`content.ts`；`buildTextRun…buildWordChildren`、`buildStandardWordStyles`→`docx.ts`；`buildAcademic*`、`WordAcademicProfiles`→`academic.ts`；`resolveWordFontFamilies`、`buildMacLibreOfficeFontConfig`→`fonts.ts`；`extractWordBodyChildrenXml…createEmptyWordDocumentRelsXml`→`ooxml-append.ts` |
| `utils/presentation/*` | `presentationTool.ts`：拆页→`content.ts`，`PresentationTemplatePalettes`、`buildTemplatePresentationSlide`、`buildPresentationCardGrid`、`buildPresentationTheme`→`templates.ts`，`addSlideElements`→`elements.ts` |
| `utils/spreadsheet/*` | `spreadsheetTool.ts`：CSV/TSV/Markdown/JSON 解析→`content.ts`，`applyExcel*`、`buildExcelCellStyle`、`toArgbColor`→`style.ts`，`buildExcelCellValue`、`applyAutoWidths`、`normalizeSheetName`、`excelColumnNumber`→`sheet.ts` |
| `utils/pdf/*` | `parsePdfColor / resolvePdfPageNumbers / applyPdfMetadata / applyPdfTextStamp / extractPdfTextPages(纯部分)`→`pages.ts`；`getDefaultLatexSourcePath / resolveLatexCompilerCandidates / buildLatexCompileCommands`→`latex.ts`；`makeDOMMatrixStub` 等→`pdfjs-globals.ts` |
| `utils/preview/*` | `previewTool.ts`：`parseDocx/Pptx/XlsxPreview`→`parse.ts`，`buildOfficePreviewHtml / buildPreviewCss / build*Html`→`html.ts`，`sanitizePreviewHtml` 与白名单、`htmlToText`、`decodeHtmlText`→`sanitize.ts`，`renderOfficePreviewPng` 与行渲染→`png.ts` |
| `utils/markdown.ts` | `parseMarkdownTableRow / isMarkdownTableSeparator`、MarkItDown 命令构造与截断 |
| `utils/results.ts` | `createCommandFailureResult`、缺依赖结果（去掉安装建议后） |
| `utils/resources.ts` | MarkItDown 资源根的推导（环境变量根、注入的额外根、平台共享资源根） |
| `utils/tool.ts` | `defineOfficeTool`（同 system 的 `utils/tool.ts`） |

### 2.5 常量与 `tuning.ts`

对外承诺（进 `contract/constants.ts`，工具说明与 schema 引它们）：

- `OfficeInputLimits`：路径 1200、标题 200、作者/短字段 120、关键词 30 个×80 字、正文与 LaTeX 源码 1,000,000；Word：blocks 500、标题块 500 字、段落 20,000 字、列表 200 项×1,000 字、层级 0–8、表格 500 行×30 列、宽度 10–100%；Excel：工作表 100 张、表名 31（Excel 格式上限，可就地写）、每表 100,000 行×1,000 列、数字格式串 120 字、数字格式范围 100,000 格。
- `OfficePdfLimits`：按页读最多 100 页、缺省读前 20 页（说明文字里的「20 页」引它）、PDF→Word 最多 500 页、页码列表 1000、文字戳 500 条×2000 字、字号 4–96、LaTeX 编译最多 3 轮。
- `OfficeMarkdownLimits`：返回最多 200,000 字、最少 1,000 字。
- `OfficePreviewLimits`：`maxItems` 最多 200。

包内可调（进 `utils/tuning.ts` 的 `OfficeTuning`）：外部命令超时（LibreOffice 180 s、通用 120 s、LaTeX 每轮 180 s、MarkItDown 180 s）、外部命令输出窗口 20,000 字、MarkItDown 缺省返回 60,000 字、预览缺省 80 项与 `contentHtml` 16,000 字、PDF→Word 缺省 20 页、PDF 渲染缺省 1.5 倍与 4000 万像素上限、预览图片 data URL 8 MB、PPT 每页正文 2,800 字、Word 纯文本段落 12,000 字、文字戳缺省（14 号、48/48、0.9）、LaTeX 缺省 2 轮。

格式里的数字就地写：docx 字号（半磅值）、PPT 版式英寸、预览 PNG 画布尺寸、Excel 列宽算法。

### 2.6 `exports/`：三个入口

| 入口 | 给谁 | 内容 | 理由 |
| --- | --- | --- | --- |
| `.` | Node 宿主 | `export * from './contracts.js'`；`officeTools`、`createOfficeKernelModule`、`OfficeCapability`、`createMarkItDownLocator`；注入面；公开签名用到的 `types/inputs.ts` 等 | — |
| `./contracts` | 任何进程 | 常量表 + `types/office.ts` | 标准入口；`check-packed-consumers` 的浏览器打包 fixture 用它 |
| `./renderer` | `packages/document-renderer`（独立发布的命令能力包） | `officeDocumentRenderer` 与 `types/preview.ts` | Document Renderer 不装 agent（本包对 agent 是 peer 依赖），根入口一 import 就要 agent；这是「确有独立消费方」的那种多开 |

`./composition`、`./runtime`、`./tools` 删除，内容并进 `.`。

### 2.7 逐个现有文件的去处

| 现有文件 | 去处 | 理由 |
| --- | --- | --- |
| `word.tool.ts`、`presentation.tool.ts`、`spreadsheet.tool.ts`、`pdf.tool.ts`、`preview.tool.ts`、`markitdown.tool.ts` | 定义 → `impl/OfficeTools.ts`；execute 主体 → `operations/*` | 全部工具定义在一个文件；execute ≤ 4 条 |
| `wordTool.ts`、`presentationTool.ts`、`spreadsheetTool.ts`、`pdfTools.ts`、`previewTool.ts`、`markitdownTool.ts` | schema → `OfficeTools.ts`；类型 → `types/*`；纯函数 → `utils/<域>/*`；带 `ctx` 的 → `operations/*` | 函数模块拆开 |
| `officeShared.ts` | 端口类型 → `contract/requires.ts`；数据 → `types/office.ts`；`defineOfficeTool` → `utils/tool.ts`；路径与写盘 → `operations/OfficeWorkspace.ts`；外部命令 → `operations/OfficeConverters.ts`；结果构造 → `utils/results.ts`；Markdown 表格 → `utils/markdown.ts`；对 `node:fs`、`zod`、`path` 的再导出删掉；`OfficeToolPermission`（13 个值，多数与 office 无关）改用 agent 的 `ToolPermission`；`ToolContext` 别名删 | 725 行杂物文件 |
| `OfficeContracts.ts` | `types/office.ts`（收窄）；`OfficeSystemToolInstallAlternative / Suggestion` 删 | 产品壳概念（ADR 0003 同理） |
| `OfficePlatformCompatibility.ts` | 删；包含判断用 platform + core；`quoteShellArg / quoteShellPath` 只剩一个死分支在用 | 所有调用都走原生 argv，字符串命令分支从不触发 |
| `OfficeResourceRuntime.ts` | 删；资源来源改由注入面 `OfficeResourcePort` 给 | 修 O6 |
| `markitdownResolver.ts` | `impl/runtime/MarkItDownLocator.ts` + `utils/resources.ts` | 删单例 |
| `pdfPageRenderer.ts` | `impl/runtime/OfficeDocumentRenderer.ts`；错误类改 `AppError` + `OfficeErrorCodes.pdfPage*` | 错误类不出包，Document Renderer 按码判断 |
| `kernel-module.ts`、`Collection.ts` | `impl/OfficeTools.ts` 末尾 | 同 system |
| `index.ts`、`contracts.ts`、`renderer.ts` | `exports/` | — |
| `composition.ts`、`runtime.ts`、`tools.ts` | 删 | 并进 `.` |
| `pdfjs-dist.d.ts`、`velaros-globals.d.ts` | 留在 `src/` 根 | 声明文件 |

## 3. 合同草案

### 3.1 `contract/provides.ts`

```ts
/** 一个 office 工具的运行时规格；上下文固定是 OfficeToolContext。 */
type VelaTool<TInput> = ToolContractRuntimeSpec<TInput, OfficeToolContext, unknown, ToolPermission>
/** 10 个模型面工具，按工具名索引，实例 officeTools。 */
type OfficeToolCollection = Readonly<Record<OfficeToolName, VelaTool<any>>>
/** 内核能力服务：按工具名调用 office 工具（入参先严格解析、再解析上下文）。 */
interface OfficeCapabilityService extends KernelCallableCapabilityService { readonly tools: OfficeToolCollection }
// 类上方接口，登记：
interface OfficeDocumentRendererApi {            // document-renderer 用的 4 个操作
  parsePreview(inputPath, kind, maxItems): Promise<ParsedOfficePreview>
  buildPreviewHtml(input): string
  renderPreviewPng(parsed): Promise<{ buffer; width; height }>
  renderPdfPagePng(input): Promise<RenderedPdfPagePng>   // 失败抛 AppError，码见 OfficeErrorCodes
}
interface MarkItDownLocatorApi { resolve(): Nullable<MarkItDownLaunchSpec>; resolveIgnoringDisabled(): Nullable<MarkItDownLaunchSpec> }
```

对外的值：`officeTools`、`createOfficeKernelModule`、`OfficeCapability`、`createMarkItDownLocator`（宿主拿它实现端口的 `locateMarkItDown`，Desktop 插件目录也用它）、`officeDocumentRenderer`（只从 `./renderer`）。

### 3.2 `contract/requires.ts`

```ts
interface OfficeToolContext { abortSignal: AbortSignal; office: OfficeHostApi }
/** 宿主端口（登记 hostPort: 'OfficeHostApi'，hostPortField: 'office'）。扁平一层，只放工具真会调的方法。 */
interface OfficeHostApi {
  getRootPath(): string                                            // 项目根；没有可用根时抛错（工具据此判不可用）
  prepareMutation(input: OfficeMutationRequest): Promise<OfficeMutationDecision>
  inspectEnvironment(commands?: string[]): Promise<OfficeEnvironmentInspection>
  runCommand(command: OfficeNativeCommand, options: OfficeCommandOptions): Promise<OfficeCommandResult>  // 只收原生 argv
  locateMarkItDown(): Nullable<MarkItDownLaunchSpec>              // 取代模块级单例；宿主按自己的插件状态回答
}
type OfficeToolContextResolver = (scope, signal) => OfficeToolContext | Promise<OfficeToolContext>
interface CreateOfficeKernelModuleOptions { resolveContext?: OfficeToolContextResolver }
interface OfficeResourcePort { extraResourceRoots(): string[]; isDisabled(id: 'markitdown'): boolean }
interface MarkItDownLocatorOptions { resourceRoots?: string[]; resources?: OfficeResourcePort; platform?; arch? }
```

与现在相比删掉的端口成员：`hasProjectRoot`（只用来给安装建议选 scope）、`project.runInDirectory`（只服务 `cwd`，见 D2）、`system.createSystemToolInstallSuggestion`（见 D3）；`project` / `system` 两层嵌套压平，门禁的「端口每个方法都有工具在调」就能逐方法核对（现在嵌套一层只能核到 `project`、`system` 两个名字），Desktop `ToolContextProjection.ts:78-117` 的按权限授予成员也能精确到方法（现在 `fs:write` 顺带拿到了 `system.runCommand`）。

### 3.3 `contract/constants.ts`

- 身份：`OfficeToolNames`（10 个）、`OfficeToolCategoryId = 'office'`、`OfficeModId = 'velaros.office'`、`OfficeKernelModuleVersion`。
- `OfficeErrorCodes`：`pathOutsideProject`、`outputExists`、`invalidExtension`、`inputMissing`、`emptyContent`、`converterMissing`、`conversionFailed`、`markItDownUnavailable`、`appendTargetInvalid`、`pdfPageInvalid`、`pdfPageOutOfRange`、`pdfRenderScaleInvalid`、`pdfRenderPixelLimit`。
- `OfficeEnvironmentVariables`：`VELAROS_MARKITDOWN_RESOURCE_ROOT`、`VELAROS_PDFJS_STANDARD_FONTS_ROOT`（input）。
- 上限表见 2.5；`OfficeMarkItDownInputExtensions`（17 个扩展名，说明文字引它）。

### 3.4 要删的现有导出与替代

| 现有 | 替代 |
| --- | --- |
| `@velaros-ai/office/tools` 的 `officeTools` | `@velaros-ai/office` 的 `officeTools` |
| `@velaros-ai/office/runtime` 的 `markItDownBinaryResolver`、`MarkItDownBinaryResolver`、`officeResourceRuntime`、`OfficeResourceRuntimeRegistry` | `createMarkItDownLocator({ resources })`，Desktop 传入包装 `appResourceRuntime` 的端口 |
| `OfficeHostApi / OfficeProjectApi / OfficeSystemApi`（嵌套） | 扁平 `OfficeHostApi` |
| `OfficeSystemToolInstallSuggestion / Alternative`、`OfficeProjectAuthorizationDecision` 全字段 | 删 / 收窄为 `OfficeMutationDecision` |
| `./renderer` 的 5 个函数与 `OfficePdfPageRenderError` | `officeDocumentRenderer.*`，按 `OfficeErrorCodes` 判断 |
| `./composition`、根入口的 29 个名字 | 按 3.1 |

## 4. 工具面

### 4.1 全部模型面工具（说明与 schema 字符数由源码渲染统计）

| # | 工具 | 做什么 | 顶层字段（**粗体**必填） | 说明 / schema 字符 | execute 语句 | surfaces |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | `office:create_word_document` | 生成 .docx；blocks 或 Markdown content；学术模板、目录、追加 | cwd、**outputPath**、title、author、profile、language、metadata、abstract、keywords、includeTableOfContents、blocks、content、overwrite、appendMode | 563 / 5,037 | 16 | preset（4 字段，242/423）、guided（13 字段，287/1,510） |
| 2 | `office:create_presentation` | 生成 .pptx；slides+elements 或 content 自动拆页；四套模板 | cwd、**outputPath**、title、author、layout、rtlMode、template、theme、slides、content、overwrite | 558 / 3,632 | 28 | preset（5，256/617）、guided（9，256/974） |
| 3 | `office:create_spreadsheet` | 生成 .xlsx；sheets 或 CSV/TSV/Markdown/JSON content | cwd、**outputPath**、title、author、sheets、content、overwrite | 491 / 4,170 | 53 | preset（4，250/432）、guided（6，268/530） |
| 4 | `office:extract_pdf_text` | 按页提取文本型 PDF | cwd、**inputPath**、pages、maxPages | 361 / 532 | 5 | — |
| 5 | `office:convert_pdf_to_word` | PDF 文本按页写成 .docx | cwd、**inputPath**、**outputPath**、title、author、maxPages、overwrite | 246 / 551 | 12 | — |
| 6 | `office:convert_word_to_pdf` | .docx/.doc → PDF（LibreOffice） | cwd、**inputPath**、**outputPath**、overwrite | 270 / 400 | 28 | — |
| 7 | `office:create_latex_pdf` | 写 .tex 并编译 PDF（tectonic/latexmk/xelatex/pdflatex） | cwd、**outputPath**、sourcePath、**latexSource**、compiler、runs、overwrite | 343 / 898 | 24 | — |
| 8 | `office:edit_pdf_document` | 选页、删页、旋转、文字戳、元数据，输出新 PDF | cwd、**inputPath**、**outputPath**、overwrite、pageSelection、removePages、rotatePages、textStamps、metadata | 310 / 1,694 | 26 | — |
| 9 | `office:preview_document` | 解析 docx/doc/pptx/xlsx 结构，可写 HTML/PNG 预览 | cwd、**inputPath**、outputPath、overwrite、maxItems、autoRefresh | 362 / 567 | 17 | — |
| 10 | `office:convert_document_to_markdown` | MarkItDown 转 Markdown（插件没装时隐藏） | cwd、**inputPath**、outputPath、overwrite、maxChars | 395 / 610 | 引用外部函数（42 行） | — |

- 10 个工具同一类别 `office`；定义分散在 6 个文件，`defineOfficeTool` 在 6 处调用；schema 全部是非严格 `z.object`（模型路径上多余字段被静默丢掉，内核路径由 `parseToolWireInput` 只对顶层加 `.strict()`），system 与 project 都是 `z.strictObject`。
- **没写说明的参数**：10 个工具的 `cwd` 与 `overwrite` 全部没有说明；Word 的 `title / author / metadata / abstract / keywords / includeTableOfContents / appendMode`，PPT 的 `title / author / rtlMode / theme`，PDF 编辑的 `pageSelection / removePages / rotatePages / textStamps / metadata`，预览的 `maxItems` 也没有。模型只能从字段名猜 `appendMode`、`cwd` 做什么。
- README 列 9 个工具（漏 `extract_pdf_text`），写的上下文形状（`hasProjectRoot / project / system` 平铺在 ctx 上）也和代码不符。

### 4.2 简化候选（判据：别的工具替代得了、只剩仪式感才删；没人用过但有独特能力的不删）

| 候选 | 判定 | 理由 |
| --- | --- | --- |
| 10 个工具的 `cwd` 参数 | **删** | 没有说明；在 Desktop 里它会把「项目根」整个换成任意目录（`WorkspaceBindingService.runWithRootOverride` 不校验），只读工具因此能读根外文件（O3）；写工具的相对路径本来就相对项目根，产物只能落在根内，`cwd` 只剩「换根」这一个作用 |
| `office:convert_pdf_to_word` | 保留 | 能用 extract + create 两步替代，但要把整本 PDF 的文字过一遍模型上下文（最多 500 页）；独有价值是不经模型搬运 |
| `office:extract_pdf_text` 与 `office:convert_document_to_markdown` | 都保留，写清分工 | 后者能读 PDF 但是可选插件、没有页级选择；前者内置、按页 |
| `office:preview_document` 与 `office:convert_document_to_markdown` | 都保留，写清分工 | 读正文用后者；看结构、生成给人看的 HTML/PNG 用前者 |
| 三个创建工具的 preset / guided surfaces | 保留（agent 机制），改文案 | compact 档看 guided；Desktop 的「manifest-first」规则在 base 超过 6000 字符时换 preset（`Desktop:main/tools/ToolSurfaceCatalog.ts:454-466`），实测 base 在 4.2–5.6 千字符，balanced 档现在看的是 base |
| 其余 | 保留 | 各有唯一能力 |

### 4.3 提示词问题（引原文，给改后原文）

| # | 位置 | 原文 | 问题 | 改后 |
| --- | --- | --- | --- | --- |
| P1 | 三个工具的 guided 注意、`content` 参数（guided） | 「复杂内容块保留给 direct/expert。」「需要富文本 runs 或表格单元格样式时切到 direct/expert。」 | 模型切不了档位；`direct/expert` 是 agent 内部名 | 删；或写「这个版本只收纯文本或 Markdown，富文本和单元格样式做不到时如实说明」 |
| P2 | PPT base 注意 | 「direct/expert 可用 elements 控制 text、table、shape、image、chart。」 | 看到这句的就是 base，本身就能用 | 「slides[].elements 可放 text、table、shape、image、chart；坐标单位英寸。」 |
| P3 | 表格 guided 适合 | 「需要设置 cwd、title、author 或覆盖策略。」 | 模型看到哪个 surface 由档位决定，不由「需要」决定；还提了没说明的 cwd | 「用 content 生成单张表，可设 title、author、overwrite。」 |
| P4 | `convert_document_to_markdown` 注意 | 「使用随应用打包的 Microsoft MarkItDown runtime，不要求用户自行安装 CLI。」 | 已改插件市场安装，过时；与模型决策无关 | 删 |
| P5 | `convert_document_to_markdown` 禁止 | 「不要用它读取工作区外路径或远程 URL。」 | 规则靠模型自觉，代码经 `cwd` 放行（O3） | 保留，并删 `cwd`、按真实路径校验 |
| P6 | `create_latex_pdf` 强制流程 | 「先写入 .tex 源码；编译失败时读取命令输出后修正源码再重试。」 | 「先写入」读起来像要模型先用别的工具写文件，其实工具自己写 | 「latexSource 会先写成 .tex（sourcePath，缺省与 PDF 同名同目录）再编译；失败时 .tex 保留，按 commandResults 的 stderr 改 latexSource 后整段重传。」 |
| P7 | `extract_pdf_text` 强制流程与 `maxPages` 说明 | 「省略 pages 和 maxPages 时只读取前 20 页…」两处 | 重复；裸数字 | 只留参数说明一处，数字引 `OfficePdfLimits.defaultReadPages` |
| P8 | `edit_pdf_document` 禁止 | 「不要用它直接覆盖原文件，除非明确传 overwrite=true 且输出路径可覆盖。」 | 写成「禁止」却给了允许条件 | 移到用法：「输出路径与输入相同时要传 overwrite=true。」 |
| P9 | Word 用法 + blocks/content 参数说明 | 「传 outputPath，并提供 blocks 或 content；复杂样式用结构化 blocks。」与两个参数说明各说一遍 | 三处重复 | 用法一句，参数说明只写各自格式 |
| P10 | 预览与 Markdown 的适合 | 「需要检查生成后的 Word、PowerPoint 或 Excel 文档结构和摘要。」/「需要把 PDF、Office…转换成模型可读 Markdown。」 | 读 docx 正文两边都像 | 预览加一句「读正文用 office:convert_document_to_markdown（可用时）」 |
| P11 | 预览 `autoRefresh`（缺省 true） | 「生成 HTML 预览时是否加入自动刷新脚本。」 | 缺省往用户文件里塞每 5 秒 reload 的脚本 | 缺省改 false（拍板 D8） |
| P12 | 所有工具的 `overwrite`、`cwd` | （无说明） | 模型不知道覆盖语义 | `overwrite` 共用一条：「目标已存在时必须为 true 才覆盖；Word 的 appendMode 追加时不需要」；`cwd` 删 |

模型看得到的英文：说明与 schema 里没有；结果里有 `Page N`、`(No extractable text on this page.)`、`Converted from …`、`<!-- MarkItDown output truncated by VelarOS -->`、预览标题兜底 `Word Document / Presentation / Workbook / Slide N`（见 1.7）。

## 5. 实现层缺陷（O1–O5 实测，探针 `plan-mid/probes/office-probes.ts`）

| # | 位置 | 现象 | 复现 |
| --- | --- | --- | --- |
| O1 | `markitdownTool.ts:125-167` | 不写 outputPath 时把 `commandResult.stdout` 当 Markdown：宿主的输出窗口**保留末尾**（system 与 Desktop `host/commands/CommandHelper.ts:95-121` 都是）且上限 50,000，于是长文档返回的是结尾；`truncated` 只看截到 `maxChars` 的那一步，报 `false`；schema 允许 `maxChars` 到 200,000 也兑现不了 | 按宿主语义的假端口、9.3 万字的输出：返回 50,000 字，开头是「ne 1387 …」，`truncated=false`，`commandResult.truncated=true`。修法：一律让 MarkItDown 写临时文件、自己读头部截断 |
| O2 | `officeShared.ts:294-363`（`normalizeExtensionPath` → `assertOfficePathInsideProject` → `prepareOfficeOutputPath`） | 「唯一的路径包含门」按字面路径算，项目里指向根外的符号链接能把产物写出去；已存在的链接文件带 `overwrite` 时 `writeFile` 顺着链接覆盖根外文件 | 根里建 `link → ../outside`，`create_spreadsheet({ outputPath: 'link/escaped.xlsx' })` 成功，文件落在根外。修法：`resolveRealPath` 后用 `relativePathTextInside` |
| O3 | `officeShared.ts:283-290`（`runWithDirectory`）与三个只读工具 | `extract_pdf_text`、不写 outputPath 的 `preview_document` 与 `convert_document_to_markdown` 不过授权就 `runInDirectory(cwd)`；Desktop 的实现把 cwd 当成新根（`WorkspaceBindingService.ts:272-283`、`resolveRootOverridePath` 不校验），包含门随之失效 | 按 Desktop 语义的假端口：`extract_pdf_text({ cwd: <根外目录>, inputPath: 'secret.pdf' })` 读出 `SECRET-OUTSIDE`，授权调用 0 次 |
| O4 | `wordTool.ts:1293-1330`（追加模式） | 只合并 relationships，不合并 `numbering.xml` 与 `styles.xml`；追加的项目符号引用 `numId=1`，目标文档没有这条编号定义时退化成普通段落，有同号定义时串用别人的列表样式；标题同理依赖目标文档里的 `Heading1` 样式 | 手工构造一个没有 numbering/styles 部件的 docx，追加 bullets：`<w:numId w:val="1"/>` ×2，`numbering part exists=false` |
| O5 | `previewTool.ts:273-310` | pptx 先按 `maxItems` 截幻灯片再统计，`summary.slides` 报的是截后数量（xlsx 同时报总数与预览数） | 5 页 PPT、`maxItems=2` → `summary={"slides":2,…}` |
| O6 | `markitdownResolver.ts:65,90`、`OfficeResourceRuntime.ts:49` 与 Desktop `bootstrap/composition/config.ts:77-79`、`resources/AppResourcePluginService.ts:195,229` | Desktop 把共享资源安装根、停用集登记在自己的 `appResourceRuntime`，office 单例一个都看不到：插件市场装到共享资源根的 MarkItDown 按 office 的解析找不到；用户在设置里停用后，office 的 `isAvailable` 仍按单例判定 | 代码走读 + computer 同构探针（`plan-mid/probes/computer-probes.ts` C3）；需真机确认 Desktop 插件目录显示 |
| O7 | `officeShared.ts:641-702`（第 687 行抛错） | `.doc` 归一后找不到 docx 时直接抛，临时目录 `velaros-office-docx-normalize-*` 不回收 | 代码走读 |
| O8 | `pdf.tool.ts:329-336` | LaTeX 的 `.tex` 写到 `sourcePath`，而授权只针对 `outputPath`；`sourcePath` 可以在项目里别的目录 | 代码走读（仍在项目根内） |

## 6. 步骤与风险

每步的全绿口径：`cd packages/office && bun test test`（22 条只许挪位不许减）、`bun run --cwd packages/office typecheck`、`bun run --cwd packages/office build`、仓根 `bun run typecheck`、`bun run check:capabilities-schemas`（工具 schema 可生成）、`bun run check:capabilities-arch`、`bun run check:code-style`、`bun run --cwd packages/document-renderer test`、`bun run test:capabilities`；工具面不变的步骤另跑一个说明与 schema 的逐字节快照（第 1 步先落 `test/tool-surface-snapshot.test.ts`，把 10 个工具 × 3 个 surface 的渲染结果冻住）。

| 步 | 做什么 | 保持全绿 | 规模 |
| --- | --- | --- | --- |
| 0 | 落工具面快照测试 | — | 1 个测试文件 |
| 1 修缺陷 | O1、O2、O4、O5、O7 各一个提交带回归测试（O3 随 D2 删 `cwd` 一起修） | 快照不变（O1 只改结果） | 约 300 行 |
| 2 工具文件 | 10 个定义与 schema 收进 `impl/OfficeTools.ts`，execute 下沉到 `operations/` 六个执行类，每个一行 | 快照逐字节不变 | 工具文件约 1,200 行 |
| 3 拆函数模块与达标 | `move-declarations.mjs` 把类型进 `types/`、纯函数进 `utils/<域>/`；常量表与 `OfficeTuning`；英文改中文；删 `OfficePlatformCompatibility`、两个单例 | 快照中数字改引常量须字节不变 | 约 5,000 行搬动 |
| 4 合同与入口收口（破坏性） | 写 `contract/` 三文件；入口收成 3 个；端口扁平化（D2、D3）；同提交改 `packages/document-renderer/src/renderer.ts`、`products/document-renderer/tsconfig.json`、`scripts/capabilities/{capability-owners,check-arch-boundaries,check-packed-consumers}.mjs`、根 `tsconfig.json` paths、`docs/generated/package-catalog.json`；`package.json` 加 `@velaros-ai/platform` 依赖（`bun.lock`）；版本 2.0.0 | `check:lockfile-consistency`、`check:package-catalog` | Desktop 迁移 4 个文件 + 端口实现 |
| 5 工具面改动（单独一个提交，拍板后） | 删 `cwd`、改 P1–P12 文案、schema 改严格、补参数说明 | 快照按差量报告更新 | — |
| 6 登记治理 | `governed-modules.mjs` 条目（`toolsFile: 'src/impl/OfficeTools.ts'`、`toolDefiner: 'defineOfficeTool'`、`hostPort: 'OfficeHostApi'`、`hostPortField: 'office'`、`browserSafeEntries: ['contracts.ts']`、`environmentTable: 'OfficeEnvironmentVariables'`、三层）；`MODULE.md`；`spec/invariants.md` 与验收 | `check:module-ownership` 零条 | — |

不变量候选：① 写入与读取目标按真实路径都在项目根内（测试）；② 已有文件不带 `overwrite` 不覆盖，Word 追加模式例外（测试）；③ 每次写盘前拿到 `prepareMutation` 批准，被拒返回跳过结果、什么都不写（测试）；④ 外部转换器只经原生 argv（测试）；⑤ 缺转换器返回带 `OfficeErrorCodes.converterMissing` 的结构化结果，不抛通用执行错误（测试）；⑥ 预览 HTML 经 parse5 白名单净化（测试，沿用现有用例）；⑦ MarkItDown 返回的是文档开头，截断如实标记（测试）；⑧ `./renderer` 与 `./contracts` 的值引用链不经过工具文件与 agent（门禁）。

**风险与共享文件**：`scripts/ownership/governed-modules.mjs`（多路同时改，串行）、根 `tsconfig.json`（另一实例正在改）、`bun.lock`、`scripts/capabilities/*`（computer 方案也改 `capability-owners.mjs`，两包合并成一次改）、`docs/generated/package-catalog.json`。端口扁平化与安装建议上移要 Desktop 同步改 `main/agent/context/ToolContext.ts:447-462` 与 `main/tools/ToolContextProjection.ts` 的授予表；Desktop 升级前继续用 1.x。

## 7. 需要拍板的项

- **D1 入口**：6 → 3（`.`、`./contracts`、`./renderer`），2.0.0；Document Renderer 改按错误码判断。
- **D2 删 `cwd` 参数**（10 个工具，模型面变化）并据此删端口的 `runInDirectory`。
- **D3 缺依赖的安装建议与「用浏览器线上处理」替代方案搬回宿主**：office 只返回 `converterMissing` 码与缺哪个命令、为什么要它；Desktop 在自己的结果中间件里挂安装卡和双语草稿。删端口 `createSystemToolInstallSuggestion` 与 `hasProjectRoot`。
- **D4 读取范围**：只读工具是否允许读项目根外（`readScopes` 现在声明 `project` 与 `system`，说明却禁止；按「只读项目内」修，还是放开并改说明）。
- **D5 MarkItDown 输出改走临时文件**（修 O1），`maxChars` 上限 200,000 保持。
- **D6 生成文档的默认作者 / 公司 / 主题**：现在写「VelarOS」「Generated presentation」进用户文档元数据；改为留空或由宿主注入。
- **D7 Word 追加模式**：合并编号与样式定义，还是目标缺定义时拒绝追加列表/标题（修 O4）。
- **D8 预览 `autoRefresh` 缺省改 false**；surfaces 与参数说明按 4.3 改；schema 改严格。
- **D9 内核模块**：`createOfficeKernelModule` 零产品消费，保留（与 system、project 同构，Termel 以后可按名调用）还是删。
- **D10 产物里的英文**（`Page N`、无文本提示、预览 HTML 标签、兜底标题）改中文或跟随文档 `language`。
