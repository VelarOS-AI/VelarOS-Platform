# @velaros-ai/office-tools 中文接口文档

## 定位与非目标

本包提供 Word、PowerPoint、Spreadsheet、PDF、LaTeX、预览和 MarkItDown 转换工具。文件授权、命令执行和外部工具安装均通过宿主端口注入。

本包不拥有 Workspace 注册表、产品 IPC、Agent 循环或 UI，也不会在导入时启动转换进程。

## 安装

```bash
npm install @velaros-ai/office-tools
```

要求 Node.js 20 及以上。部分转换能力需要宿主提供 LibreOffice、LaTeX 或 MarkItDown；纯 JS 文档创建能力不依赖这些命令。

## 公共入口

```ts
import {
  officeTools,
  MarkItDownBinaryResolver,
  OfficePlatformCompatibility,
  OfficeResourceRuntimeRegistry,
  createOfficeToolsKernelModule,
  type OfficeEnvironmentInspection,
  type OfficeRuntimePlatform,
  type OfficeToolContext,
  type OfficeOutput,
} from '@velaros-ai/office-tools'

import { runOfficeToolsCli } from '@velaros-ai/office-tools/cli'
```

## 核心类与接口

- `officeTools`：全部 Office 工具定义的公共集合。
- `OfficeToolContext`：工作区授权与系统命令的最小宿主端口。
- `OfficeRuntimePlatform`：宿主平台标识；保留常见平台字面量提示，同时接受第三方或未来平台。
- `OfficeEnvironmentInspection`：宿主注入的系统、Shell、工作区和命令可用性快照。
- `MarkItDownBinaryResolver`：按资源根解析可选转换器。
- `OfficeResourceRuntimeRegistry`：宿主拥有的可选资源注册表。
- `OfficePlatformCompatibility`：显式平台的 shell 参数处理。
- `OfficeOutput`：文档写入的统一结果。
- `createOfficeToolsKernelModule()`：把工具集合适配为 Kernel callable capability。

具体输入类型如 `CreateWordDocumentInput`、`CreatePresentationInput`、`CreateSpreadsheetInput` 和 `EditPdfDocumentInput` 均从根入口导出。

## 生命周期/并发

工具定义无状态；每次调用使用独立 context 和 AbortSignal。转换器进程生命周期属于单次调用。资源注册表应由应用组合根持有，默认单例仅为兼容保留。

不同输出文件可以并发处理；同一文件的写入冲突应由宿主 Workspace 端口阻止或排队。

## 依赖注入

`OfficeToolContext` 只要求：

- 工作区根、目录内执行和写入授权；
- 环境检查、安装建议和受控命令执行；
- AbortSignal。

第三方无需安装 `@velaros-ai/workspace` 或 `@velaros-ai/system-tools`，只需提供结构兼容的 adapter。
公开的 `OfficeRuntimePlatform` 是 host-neutral 的字符串契约，不依赖 `NodeJS.Platform`
或任何 Node.js ambient namespace。Node、浏览器桥接、远程执行器和自定义运行时都可以
直接返回自己的平台标识；Office 不会把宿主端口重新收窄到某个 Node.js 版本的枚举。

## 错误模型

输入 schema 在最外层校验。领域错误使用 `AppError`，常见类别包括 validation、permission、not found、platform 和 execution failed。外部命令结果保持 exitCode/stdout/stderr，避免多次转换后丢失诊断。

## 最小第三方示例

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

宿主环境端口可以保持自己的前向兼容平台类型：

```ts
import type {
  OfficeEnvironmentInspection,
  OfficeSystemApi,
} from '@velaros-ai/office-tools'

type HostInspection = Omit<OfficeEnvironmentInspection, 'os'> & {
  os: Omit<OfficeEnvironmentInspection['os'], 'platform'> & {
    platform: 'darwin' | 'linux' | (string & {})
  }
}

declare const inspectEnvironment: () => Promise<HostInspection>

const officeSystemAdapter: Pick<OfficeSystemApi, 'inspectEnvironment'> = {
  inspectEnvironment,
}
```

## 扩展点

新增文档格式应保持“schema + tool + 输入/输出类型”组合，并复用 `OfficeToolContext`。外部转换器通过 resolver 或 system adapter 接入，不应在工具模块中加入某个产品的安装目录。

## 兼容策略

现有工具名、输入类型和 CLI 子入口保持兼容。`0.2.7` 将环境检查中的平台字段从
Node.js ambient 枚举扩展为 Office 自有的前向兼容契约；已有标准 Node 平台值无需修改。
默认单例继续导出但标记为兼容面；新代码应显式创建 platform compatibility 与 resource
registry。破坏文档格式或 schema 的变更需要新的主版本。
