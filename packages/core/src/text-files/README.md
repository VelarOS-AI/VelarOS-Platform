# @velaros-ai/core/text-files

磁盘文本的无损读写：认出编码（BOM、无 BOM 的 UTF-16、UTF-8、GB18030）并严格解码，按原编码写回，原子替换写入、有界读与流式读。给要读写用户文本文件的 Node 宿主与能力包，同一份字节在各处判定一致。

## 用法

```ts
import { AppError } from '@velaros-ai/core/error'
import { textCodec, TextFileErrorCodes, textFileIo } from '@velaros-ai/core/text-files'

// 路径能不能碰由调用方先判过
declare const path: string

// 有界读：不存在返回 undefined，超过上限抛 TEXT_FILE_TOO_LARGE；认不出编码时 decode 返回 null
const original = await textFileIo.readBounded(path, 4 * 1024 * 1024)
const decoded = original && textCodec.decode(original)
if (original && decoded) {
  const after = decoded.content.replace('TODO', 'DONE')
  // 按原编码写回，没改的片段沿用原字节；写前核对磁盘上还是读到的那一份
  const bytes = textCodec.encodePreserving(original, decoded.content, after, decoded.encoding)
  try {
    await textFileIo.writeBytes(path, bytes, { expected: { exists: true, bytes: original } })
  } catch (error) {
    if (!(error instanceof AppError && error.code === TextFileErrorCodes.externalEdit)) throw error
    // 读完之后被外部改过：什么都没写，重新读再改
  }
}

// 整份写：已有文件沿用它的编码（连同 BOM），新文件用 fallbackEncoding
await textFileIo.writeText(path, '第一行\n第二行\n', { fallbackEncoding: 'utf8' })

// 大文件流式读：先认完整个文件的编码，被块边界切开的字符不会坏
for await (const chunk of textFileIo.readTextChunks(path)) console.log(chunk.byteOffset, chunk.content.length)
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/core/text-files` | Node | 编解码 `textCodec`（认编码、严格解码、按块解码器、按原字节保留编码）、文件读写 `textFileIo` |
| `@velaros-ai/core/text-files/contracts` | 任何进程 | 编码名表 `TextEncodings`、错误码 `TextFileErrorCodes`，解码结果、写前核对的原字节、流式文本块这些数据 |

## 约定

- 失败一律抛 `AppError`，`code` 是 `TextFileErrorCodes` 里的码，`context` 带 path 与细节（`lossy` 带 `offset`、`codeUnit`，`tooLarge` 带 `size`、`maxBytes`）；文字里不拼路径，调用方按码翻成自己的错误。文件系统自己的错误（ENOENT、EACCES 这类）原样抛出。
- 解码是严格的：非法字节、认不出编码、UTF-16 字节数不齐都不当文本（`decode`、`detect` 返回 `null`，流式读抛 `notText`），不用替换字符凑文字；正文写不成目标编码时抛 `lossy`，不静默替换。
- 写入是原子替换：失败时磁盘一个字节都不动、不留临时文件；已有文件的权限位精确保留，符号链接写到它指向的文件，有多个硬链接的文件拒写（`notRegular`）。
- 只管字节与编码：换行、行号、编码转换的产品语义归调用方；Latin-1、Shift-JIS 这类单字节旧编码不认，能按 GB18030 解开的当 GB18030，解不开的当二进制。
