# 文本文件公共件不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 解码是严格的：认不出编码、有非法字节、UTF-16 字节数不齐的一律不当文本（decode 返回 null，流式读抛 `TEXT_FILE_NOT_TEXT`），不用替换字符凑出一段文字；七种编码写出再读回，正文一个字不差 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 编码是无损的：正文里有孤立代理项、或有 GB18030 表示不了的字符时抛 `TEXT_FILE_LOSSY` 并给出位置，不静默替换；GB18030 下按原字节保留编码时没改的片段沿用原字节，拼出的字节读回来必须就是目标正文 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 写入是原子替换：先写同目录临时文件再改名，编码失败或核对失败时磁盘一个字节都不动、也不留临时文件；已有文件的权限位精确恢复（新文件给了权限就精确设上，不给由 umask 定）；符号链接写到它指向的文件、链接本身不变；有多个硬链接的文件拒写（`TEXT_FILE_NOT_REGULAR`） | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 给了写前要核对的原字节时，磁盘上多一个字节、少一个字节、内容不同、从有到无或从无到有，一律抛 `TEXT_FILE_EXTERNAL_EDIT`，什么都不写 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 有界读不会被文件撑爆：超过上限抛 `TEXT_FILE_TOO_LARGE`、不分配超大缓冲，读的过程中变长抛 `TEXT_FILE_EXTERNAL_EDIT`；目录、命名管道这类不是普通文件的抛 `TEXT_FILE_NOT_REGULAR`，命名管道不会把调用卡住 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 流式读与整读逐字一致：认编码看完整个文件（很长的 ASCII 开头不会让后面的 GB18030 被误当成 UTF-8），被块边界切开的多字节字符不会被切坏 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-8 | `writeBytes` / `writeText` 可接收取消信号：开始准备和最终 rename 前核对；异步准备期间取消不覆盖目标，清理临时文件；rename 已完成后不因迟到取消推翻提交事实 | 测试 | `test/text-file-io.test.ts` |
