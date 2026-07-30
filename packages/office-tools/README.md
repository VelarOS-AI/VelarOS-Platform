# @velaros-ai/office-tools

**面向 agent 的办公文档产出工具**(capabilities 域,住 `packages/office-tools`;
2026-07-30 QI 批从 `packages/capabilities/` 提到顶层)。
模型说「做一份季度总结的 Word」,落地成一个 `.docx` 文件的那一段,就是这个包。

## 分区

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/office-tools` | 工具集合 `officeTools`、契约类型、平台兼容、资源运行时、kernel module |
| `@velaros-ai/office-tools/cli` | `runOfficeToolsCli`,以及 bin `velaros-office` |

## 工具面

| 工具 | 产出 |
| --- | --- |
| `create_word_document` | `.docx`(纯 JS,`docx` 库) |
| `create_presentation` | `.pptx`(纯 JS,`pptxgenjs`) |
| `create_spreadsheet` | `.xlsx`(纯 JS,`exceljs`) |
| `create_latex_pdf` | LaTeX → PDF(需宿主有 LaTeX 工具链) |
| `convert_word_to_pdf` | Word → PDF(需 LibreOffice) |
| `convert_pdf_to_word` | PDF → Word |
| `edit_pdf_document` | 改 PDF 元数据 / 盖文字戳(`pdf-lib`) |
| `preview_office_document` | 生成可预览产物 |
| `convert_document_to_markdown` | 任意文档 → Markdown(需 MarkItDown) |

**纯 JS 创建能力不依赖任何外部命令**;转换类能力才需要宿主提供
LibreOffice / LaTeX / MarkItDown。缺了不会崩——工具返回结构化的
「缺少系统工具」结果,并给出安装建议与在线替代方案。

## 核心概念

- **`OfficeToolContext`** —— 一次调用要的全部宿主能力,只有四项:
  `abortSignal`、`hasWorkspaceRoot()`、`workspace`(授权与路径)、`system`(环境探测与命令执行)。
  **第三方不需要装 `@velaros-ai/workspace` 或 `@velaros-ai/system-tools`**,
  给一个结构兼容的 adapter 就行。
- **`OfficeRuntimePlatform`** —— 宿主平台标识。它是
  `'darwin' | 'linux' | … | (string & {})` 这种**开放联合**:
  常见值在编辑器里仍可发现,第三方 / 未来运行时也结构兼容。
  这个公开契约**刻意不依赖 `NodeJS` ambient namespace**——
  浏览器桥接、远程执行器、自定义运行时都能直接报自己的平台名,
  Office 不会把宿主端口重新收窄回某个 Node.js 版本的枚举。
- **`OfficeEnvironmentInspection`** —— 宿主注入的系统 / shell / 工作区 / 命令可用性快照。
- **`MarkItDownBinaryResolver`** —— 按资源根解析可选转换器。
- **`OfficeResourceRuntimeRegistry`** —— 宿主持有的可选资源注册表。
  默认单例仍导出,但那只是兼容面,新代码显式构造自己的实例。
- **`OfficePlatformCompatibility`** —— 显式平台下的 shell 参数处理。
- **`OfficeOutput`** —— 所有文档写入的统一结果形状。
- **`createOfficeToolsKernelModule()`** —— 把工具集合适配成 Kernel callable capability
  (`velaros.office.tools`),context 通过 `resolveContext(scope, signal)` 延迟解析。

## 典型用法

```ts
import { officeTools, type OfficeToolContext } from '@velaros-ai/office-tools'

const context: OfficeToolContext = {
  abortSignal: new AbortController().signal,
  hasWorkspaceRoot: () => true,
  workspace: createOfficeWorkspaceAdapter('/srv/customer-project'),
  system: createOfficeSystemAdapter(),
}

const createWord = officeTools.create_word_document
const input = createWord.schema.parse({
  outputPath: 'reports/summary.docx',
  title: '季度总结',
  blocks: [{ kind: 'paragraph', text: '由第三方应用生成。' }],
})
const output = await createWord.execute(input, context)
```

宿主端口可以保留自己更窄或更宽的平台类型,不必和 Office 的联合完全一致:

```ts
import type { OfficeEnvironmentInspection, OfficeSystemApi } from '@velaros-ai/office-tools'

type HostInspection = Omit<OfficeEnvironmentInspection, 'os'> & {
  os: Omit<OfficeEnvironmentInspection['os'], 'platform'> & {
    platform: 'darwin' | 'linux' | (string & {})
  }
}

const officeSystemAdapter: Pick<OfficeSystemApi, 'inspectEnvironment'> = { inspectEnvironment }
```

## 生命周期与并发

工具定义**无状态**;每次调用用独立 context 与 AbortSignal。
转换器进程的生命周期只属于那一次调用。
不同输出文件可以并发处理;**同一文件的写入冲突应由宿主的 workspace 端口挡住或排队**,
本包不做跨调用的写锁。

## 错误模型

输入 schema 在最外层校验。领域错误用 `AppError`,常见类别:
validation / permission / not found / platform / execution failed。
外部命令结果保留 `exitCode` / `stdout` / `stderr` 原样上浮——
多转换几层就会丢诊断信息,所以不转。

## 边界:本包不负责什么

不拥有 workspace 授权**策略**、产品 IPC、渲染层 UI 或 agent 执行。
它通过 tool context 接收 workspace / system 行为,返回文件产出交给宿主去呈现。
公开的 Office 契约不依赖 `NodeJS` ambient namespace,也不依赖 System Tools。

**加新格式的姿势**:保持「schema + tool + 输入/输出类型」这一组,复用 `OfficeToolContext`;
外部转换器走 resolver 或 system adapter 接入,**不要把某个产品的安装目录写进工具模块**。

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core` | 工具契约(`defineToolRuntimeSpec`)、`AppError`、kernel abi |
| `@velaros-ai/cli` | 把 `runOfficeToolsCli` 注册成 `velaros office` 命名空间 |
| `@velaros-ai/workspace` / `system-tools` | **不是依赖**,只是宿主最常用来实现 `OfficeToolContext` 的两个包 |

## 门

`check:capabilities-arch`、`check:capabilities-schemas`。
