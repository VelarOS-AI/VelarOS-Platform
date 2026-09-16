# @velaros-ai/office

Office 是 `@velaros-ai` 品牌下的办公文档能力聚合包。它负责创建、转换、编辑和预览办公文件，
不拥有项目授权、系统命令策略、产品 IPC、渲染 UI 或 Agent 调度。

## 职责入口

| 入口 | 职责 |
| --- | --- |
| `@velaros-ai/office/tools` | 模型工具集合 `officeTools` |
| `@velaros-ai/office/contracts` | 宿主端口和工具上下文类型 |
| `@velaros-ai/office/runtime` | MarkItDown 定位器（`createMarkItDownLocator`）|
| `@velaros-ai/office/renderer` | 独立文档渲染产品使用的窄解析与渲染原语 |
| `@velaros-ai/office/composition` | Kernel module 组合入口 |
| `@velaros-ai/office` | 上述职责入口的聚合导出 |

业务代码应依赖最窄的职责入口，只有需要完整 Office 空间时才使用根聚合入口。
`renderer` 入口不代表宿主内置渲染；它只供独立安装、独立发布的 Document Renderer
命令能力包消费。VelarOS Terminal 不依赖此入口，也不注册 Office/PDF 渲染工具。

## 模型工具

```text
office:create_word_document
office:create_presentation
office:create_spreadsheet
office:extract_pdf_text
office:create_latex_pdf
office:convert_word_to_pdf
office:convert_pdf_to_word
office:edit_pdf_document
office:preview_document
office:convert_document_to_markdown
```

纯 JavaScript 创建能力不依赖外部命令。转换能力通过宿主端口发现并运行 LibreOffice、LaTeX
或 MarkItDown；依赖缺失时返回带 `OfficeErrorCodes.converterMissing` 的结构化结果（缺哪个命令、
为什么要它），不隐藏成通用执行错误。安装建议卡与替代方案由宿主按这几项自己拼，本包不碰界面文案。

## 宿主契约

一次工具调用只接收 `OfficeToolContext`：`abortSignal` 与扁平一层的宿主端口 `office`。
端口上只有工具真会调的方法：

- `getRootPath()`：当前可写的工作区根，产物只能落在它里面。
- `runInDirectory(cwd, action)`：在 `cwd` 下临时执行；只服务十个工具的 `cwd` 参数。
- `prepareMutation(request)`：写盘前申请一次写入授权，被拒时工具一个字节都不写。
- `inspectEnvironment(commands?)`：探测外部转换器在本机可不可用。
- `runCommand(command, options)`：执行一条原生 argv 命令，本包不拼 shell 串。
- `locateMarkItDown?()`：可选；宿主按自己的插件状态回答 MarkItDown 装没装。

Office 只依赖这个结构化端口，不依赖 Project 或 System 的具体实现。宿主可以用本地、远程或
浏览器桥接实现同一契约。

```ts
import type { OfficeToolContext } from '@velaros-ai/office/contracts'
import { officeTools } from '@velaros-ai/office/tools'

const context: OfficeToolContext = {
  abortSignal: new AbortController().signal,
  office: createOfficeHostAdapter('/srv/customer-project'),
}

const tool = officeTools['office:create_word_document']
const input = tool.schema.parse({
  outputPath: 'reports/summary.docx',
  title: '季度总结',
  blocks: [{ kind: 'paragraph', text: '由 VelarOS 生成。' }],
})
await tool.execute(input, context)
```

工具定义无状态。不同文件可以并发处理；同一文件的互斥和授权由宿主端口负责。
包内不提供 CLI，因为这些模型工具不是对已有命令行能力的重复包装。
