# @velaros-ai/text-files

磁盘上文本文件的无损读写，system 空间、project 空间共用一份：

- `textCodec.detect(bytes)` / `textCodec.decode(bytes)`：认编码（BOM → 无 BOM 的 UTF-16 → 读到 NUL 算二进制 → 严格 UTF-8 → GB18030）并严格解码；认不出、有非法字节的不当文本，不会用替换字符凑出一段文字。
- `textCodec.encode(content, encoding)` / `textCodec.encodePreserving(original, before, after, encoding)`：按原编码写回字节，孤立代理项、GB18030 表示不了的字符一律拒绝；GB18030 下没改的片段沿用原字节。
- `textFileIo.writeBytes` / `textFileIo.writeText`：同目录临时文件加改名的原子替换，写完 fsync，已有文件的权限位精确恢复，符号链接写到它指向的文件，多硬链接的文件拒写；可以带写前核对的原字节。
- `textFileIo.readBounded` / `readHead` / `readTextChunks` / `readText` / `assertUnchanged`：有界读、读文件头、流式读正文、核对原字节。

支持的编码：`utf8`、`utf8-bom`、`utf16le`、`utf16be`、`utf16le-nobom`、`utf16be-nobom`、`gb18030`（覆盖 GBK 与 GB2312）。

失败一律抛 `AppError`，`code` 是 `TextFileErrorCodes` 里的码，调用方按码翻成自己的错误；文件系统自己的 errno 错误原样抛出。
根入口给 Node 宿主；`./contracts` 只有常量与可移植数据类型，浏览器和渲染进程也能加载。

模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)。
