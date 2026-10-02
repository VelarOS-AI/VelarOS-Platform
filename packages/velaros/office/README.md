# @velaros-ai/velaros/office

办公文档能力：代码面 `velaros:office` 的九个操作，生成 Word、PowerPoint、Excel，读 PDF 的文字、编辑 PDF，Word 与 LaTeX 转 PDF，预览 Office 文档，把文档转成 Markdown。宿主挂在要写文档的空间上；独立发布的 Document Renderer 只用 `./office/renderer` 的解析与渲染原语。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import { AppError } from '@velaros-ai/core/error'
import {
  createMarkItDownLocator,
  officeOperations,
  type OfficeOperationContext,
  type OfficeResourcePort,
  type OfficeSpacePort,
} from '@velaros-ai/velaros/office'
import { OfficeErrorCodes, VelarOfficeModule } from '@velaros-ai/velaros/office/contracts'

// 宿主给：工作区根，与探测命令、按原生 argv 跑命令的那一份（LibreOffice、LaTeX、MarkItDown 都经它起进程）
declare const workspaceRoot: string
declare const commands: Pick<OfficeSpacePort, 'inspectEnvironment' | 'runCommand'>
// 插件登记表：额外的资源根与用户在设置里的停用开关
declare const plugins: OfficeResourcePort

const markItDown = createMarkItDownLocator({ resources: plugins })
const office: OfficeSpacePort = {
  getRootPath: () => workspaceRoot,
  inspectEnvironment: (names) => commands.inspectEnvironment(names),
  runCommand: (command, options) => commands.runCommand(command, options),
  locateMarkItDown: () => markItDown.resolve(),
}

// 宿主自己调用（界面、测试）：路径相对工作区根
const context: OfficeOperationContext = { abortSignal: new AbortController().signal, office }
const word = await officeOperations.createWord(
  { outputPath: 'reports/weekly.docx', title: '周报', content: '# 本周进展\n\n- 完成登录改版', overwrite: true },
  context
)
try {
  await officeOperations.wordToPdf({ inputPath: word.path, outputPath: 'reports/weekly.pdf', overwrite: true }, context)
} catch (error) {
  if (!(error instanceof AppError && error.code === OfficeErrorCodes.converterMissing)) throw error
  console.warn(error.message) // 缺 LibreOffice：由宿主界面引导用户安装
}

// 挂成模型程序里可以 import 的 velaros:office
export const officeModule = createCapabilityModule({
  surface: VelarOfficeModule,
  implementation: officeOperations,
  instanceId: 'workspace-office',
  // 不给 outputPath 的 preview 与 toMarkdown 只是读，经 recordEffect 记成没有效果
  context: (call) => ({ abortSignal: call.signal, office, recordEffect: call.recordEffect }),
})
```

Document Renderer 渲染 PDF 的一页：

```ts
import { officeDocumentRenderer } from '@velaros-ai/velaros/office/renderer'

declare const pdfPath: string
const page = await officeDocumentRenderer.renderPdfPagePng({ inputPath: pdfPath, page: 1, scale: 2 })
console.log(page.width, page.height, page.pageCount, page.buffer.byteLength)
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/office` | Node | `officeOperations`、MarkItDown 定位器 `createMarkItDownLocator`、空间端口 `OfficeSpacePort`、资源端口与调用上下文 |
| `@velaros-ai/velaros/office/contracts` | 任何进程 | 错误码 `OfficeErrorCodes`、环境变量表 `OfficeEnvironmentVariables`、上限表、入参与回执、模型面 `VelarOfficeModule` |
| `@velaros-ai/velaros/office/renderer` | Node（Document Renderer） | `officeDocumentRenderer`：解析预览、拼预览 HTML、画预览 PNG、渲染 PDF 单页；宿主产品不引它 |

## 约定

- 路径相对端口给的 `getRootPath()`，也可以写根里面的绝对路径；端口给了 `resolvePath` 就先经它换成绝对路径（比如系统空间把 `~` 展开到家目录、相对路径按系统工作区算）。按解开符号链接后的真实路径判断，出了根抛 `OFFICE_PATH_OUTSIDE_PROJECT`，不读不写。写盘不问人，这就是全部边界。
- 目标已在又没传 `overwrite: true` 抛 `OFFICE_OUTPUT_EXISTS`，原文件一个字节不动；只有 `createWord` 的 `appendMode` 例外。
- 入参在做事之前整份核对，不对抛 `VALIDATION`（message 点名字段），端口一次都不调；正文 `content` 与结构化的 `blocks`、`slides`、`sheets` 只能给一样。
- 外部转换器只经端口的 `runCommand` 按原生 argv 执行，本单元不拼 shell 串、不自己起进程、不装东西；超时由本单元在命令选项里给，进程怎么起、怎么收由宿主的 `runCommand` 负责。
- 缺 LibreOffice 或 LaTeX 编译器抛 `OFFICE_CONVERTER_MISSING`，MarkItDown 没装或被停用抛 `OFFICE_MARKITDOWN_UNAVAILABLE`；装什么、怎么装由宿主界面回答。命令失败或跑完没产出抛 `OFFICE_CONVERSION_FAILED`，message 带输出结尾，LaTeX 的 .tex 留在原处可改。
- 端口不实现 `locateMarkItDown` 时回落到只按平台约定找资源的缺省定位器，用户的停用开关就到不了本单元；要认开关，照上面用 `createMarkItDownLocator({ resources })` 接上。
- 截断如实标记：`toMarkdown` 看 `truncated`，`preview` 看 `contentTruncated`，预览的 `summary` 报文档里的真实数量、条目按 `maxItems` 截。
- 模型模板生成报告或表格后，用 `preview` 解析真实产物，分别交付写入回执与结构计数、摘录范围。结构可解析只证明对应检查范围；布局与具体内容按任务要求核查。
- `readPdf` 只取文本型 PDF 的可选择文字，不做 OCR；`editPdf` 的文字戳用 PDF 标准字体，只写得了西文，中文当场 `VALIDATION`。
- 操作是整个进程一份的无状态单例，没有跨调用的状态；转换用的临时目录用完即删。
- 环境变量只认 `OfficeEnvironmentVariables` 里的两个：MarkItDown 的额外资源根、pdfjs 标准字体目录（打包产物挪了字体位置时用）。
- `./office/renderer` 只读输入文件、只交回内存里的结果，落盘由调用方决定；页码、倍率不对或超过像素上限抛 `OfficeErrorCodes` 里 `pdfPage*`、`pdfRender*` 那几个码。
