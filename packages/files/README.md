# @velaros-ai/files

所有空间共用的文件能力：代码面 `velar:files` 的三个操作。

- `read`：整份读文本文件，保留原编码与换行，带版本号；一批最多 20 个，单个最大 20 MB。
- `view`：把图片交到模型眼前；在上限以内原样给，超了才请空间压，要了 region 才请空间裁。
- `edit`：整份写入（`newText`）或回到改动前的版本（`restore`），一批一次成败，带版本核对。

能力不绑空间：每个空间注入自己的 `FileSpacePort`——路径怎么解析、哪些要先问用户、怎么落盘（逐个原子替换还是一个事务），
都由端口说了算。读字节、认编码、核版本、留版本、压图、一批的成败这些所有空间都一样的事，在这里只做一份。

模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)，代码模版见 [templates/files.js](./templates/files.js)。
