# @velaros-ai/velaros/files

本机文件的读写能力：代码面 `velaros:files` 的 `read`（读出连续的正文）、`edit`（按路径整份写，或把一段原文换掉）、`undo`（整次撤回）。系统空间挂它；项目里的文件走 `@velaros-ai/velaros/project`，看图走 `@velaros-ai/velaros/images`。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import { fileOperations, type FileOperationContext } from '@velaros-ai/velaros/files'
import { VelarFilesModule } from '@velaros-ai/velaros/files/contracts'
import { createLocalFilePort } from '@velaros-ai/velaros/files/local'

// 路径怎么解析由宿主定：系统空间把 ~ 展开到家目录、相对路径相对工作目录
declare function resolveSystemPath(path: string): string
const files = createLocalFilePort({ resolvePath: resolveSystemPath })

// 宿主自己调用（界面、测试）
const context: FileOperationContext = { abortSignal: new AbortController().signal, files }
const result = await fileOperations.read({ files: [{ path: '~/notes.md' }] }, context)
for (const file of result.files) {
  if ('error' in file) console.warn(file.path, file.error)
  else console.log(file.startLine, file.text)
}

// 挂成模型程序里可以 import 的 velaros:files
export const filesModule = createCapabilityModule({
  surface: VelarFilesModule,
  implementation: fileOperations,
  instanceId: 'system-files',
  context: (call) => ({ abortSignal: call.signal, files }),
})
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/files` | Node | `fileOperations`、空间端口 `FileSpacePort` 与调用上下文 |
| `@velaros-ai/velaros/files/contracts` | 任何进程 | 上限 `FileLimits`、错误码 `FileErrorCodes`、可移植数据、模型面 `VelarFilesModule` |
| `@velaros-ai/velaros/files/local` | Node | 本机端口 `createLocalFilePort`，给宿主界面的全局搜索 `createLocalFileSearch` |

## 约定

- 路径解析、越界与落盘都由空间的 `FileSpacePort` 决定；本机端口不设范围，解开符号链接读写真实文件，写是逐个原子替换。
- `edit` 的几步先在内存里按顺序改好（同一个文件的后一步按前一步改完的算），整次核对再落盘：原文找不到或不唯一、不是文本、编不回原编码这类问题抛 `FILES_EDIT_UNRESOLVED`，越界或没有权限抛 `FILES_EDIT_DENIED`，两种都是一个文件都没写。落盘途中出错时，错误里点名已写的文件并给出撤回用的改动号。
- `undo` 只在内存里留最近 `FileLimits.undoChanges` 次改动，进程退出就没了；那次改动之后文件又被改过时抛 `FILES_UNDO_CONFLICT`。
- `read` 一批最多 `FileLimits.readFiles` 个文件，一批里某个文件失败只标记那一项，全部失败才整个报错；`edit` 一次最多 `FileLimits.editSteps` 步、`FileLimits.editFiles` 个文件；单个文件最大 `FileLimits.fileBytes` 字节。
