# @velaros-ai/office

Office 是 `@velaros-ai` 品牌下的办公文档能力聚合包。它负责创建、转换、编辑和预览办公文件，
不拥有项目授权、系统命令策略、产品 IPC、渲染 UI 或 Agent 调度。

## 职责入口

| 入口 | 职责 |
| --- | --- |
| `@velaros-ai/office/tools` | 模型工具集合 `officeTools` |
| `@velaros-ai/office/contracts` | 宿主端口和工具上下文类型 |
| `@velaros-ai/office/runtime` | MarkItDown 与可选资源运行时 |
| `@velaros-ai/office/composition` | Kernel module 组合入口 |
| `@velaros-ai/office` | 上述职责入口的聚合导出 |

业务代码应依赖最窄的职责入口，只有需要完整 Office 空间时才使用根聚合入口。

## 模型工具

```text
office:create_word_document
office:create_presentation
office:create_spreadsheet
office:create_latex_pdf
office:convert_word_to_pdf
office:convert_pdf_to_word
office:edit_pdf_document
office:preview_document
office:convert_document_to_markdown
```

纯 JavaScript 创建能力不依赖外部命令。转换能力通过宿主注入的 System 端口发现并运行
LibreOffice、LaTeX 或 MarkItDown；依赖缺失时返回结构化诊断，不隐藏成通用执行错误。

## 宿主契约

一次工具调用只接收 `OfficeToolContext`：

- `abortSignal`：取消当前调用。
- `hasProjectRoot()`：确认是否绑定项目。
- `project`：授权并解析项目内输出路径。
- `system`：检查环境并执行必要的外部转换器。

Office 只依赖这些结构化端口，不依赖 Project 或 System 的具体实现。宿主可以用本地、远程或
浏览器桥接实现同一契约。

```ts
import type { OfficeToolContext } from '@velaros-ai/office/contracts'
import { officeTools } from '@velaros-ai/office/tools'

const context: OfficeToolContext = {
  abortSignal: new AbortController().signal,
  hasProjectRoot: () => true,
  project: createOfficeProjectAdapter('/srv/customer-project'),
  system: createOfficeSystemAdapter(),
}

const tool = officeTools['office:create_word_document']
const input = tool.schema.parse({
  outputPath: 'reports/summary.docx',
  title: '季度总结',
  blocks: [{ kind: 'paragraph', text: '由 VelarOS 生成。' }],
})
await tool.execute(input, context)
```

工具定义无状态。不同文件可以并发处理；同一文件的互斥和授权由 Project 端口负责。
包内不提供 CLI，因为这些模型工具不是对已有命令行能力的重复包装。
